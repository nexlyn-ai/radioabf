// src/pages/api/nowplaying.ts
import type { APIRoute } from "astro";

export const prerender = false;

const ICECAST_STATUS_URL =
  import.meta.env.ICECAST_STATUS_URL || process.env.ICECAST_STATUS_URL || "";

const DIRECTUS_URL =
  import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";

const DIRECTUS_TOKEN =
  import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || "";

// Collections
const PLAYS_COLLECTION = "plays";
const TRACKS_COLLECTION = "tracks";

// ----------------------
// Helpers
// ----------------------
function cleanNowText(s: string) {
  let out = String(s || "").trim();
  out = out.replace(/^undefined\s*-\s*/i, "");
  out = out.replace(/\s+—\s+/g, " - ");
  out = out.replace(/\s+–\s+/g, " - ");
  return out.trim();
}

function splitTrack(entry: string) {
  const cleaned = cleanNowText(entry);
  const idx = cleaned.indexOf(" - ");
  if (idx === -1) return { artist: cleaned.trim(), title: "" };
  return {
    artist: cleaned.slice(0, idx).trim(),
    title: cleaned.slice(idx + 3).trim(),
  };
}

// stable key used everywhere (tracks, votes, etc.)
function normKey(artist: string, title: string) {
  return (artist + " - " + title)
    .toLowerCase()
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, "")
    .trim();
}

function extractNowPlaying(json: any): string {
  const src = json?.icestats?.source;
  const s = Array.isArray(src) ? src[0] : src;

  const t =
    (s?.title && String(s.title)) ||
    (s?.yp_currently_playing && String(s.yp_currently_playing)) ||
    (s?.streamtitle && String(s.streamtitle)) ||
    "";

  return t.trim();
}

function toUTCms(v: any): number {
  const s = String(v || "").trim();
  if (!s) return 0;
  if (/[zZ]$/.test(s) || /[+\-]\d\d:\d\d$/.test(s)) return Date.parse(s);
  return Date.parse(s + "Z");
}

function assertEnv() {
  if (!ICECAST_STATUS_URL) throw new Error("ICECAST_STATUS_URL is missing");
  if (!DIRECTUS_URL) throw new Error("DIRECTUS_URL is missing");
  if (!DIRECTUS_TOKEN) throw new Error("DIRECTUS_TOKEN is missing");
}

async function directusFetch(path: string, init: RequestInit = {}) {
  assertEnv();
  const url = `${DIRECTUS_URL}${path}`;
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${DIRECTUS_TOKEN}`);
  headers.set("Accept", "application/json");
  return fetch(url, { ...init, headers });
}

function fileUrl(fileId?: string | null) {
  if (!fileId) return "";
  return `${DIRECTUS_URL}/assets/${fileId}`;
}

// ----------------------
// iTunes cover (memory micro-cache only)
// ----------------------
type ItunesCacheEntry = { url: string; exp: number };
const ITUNES_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const itunesMemCache: Map<string, ItunesCacheEntry> =
  (globalThis as any).__abfItunesCache || new Map();
(globalThis as any).__abfItunesCache = itunesMemCache;

async function fetchItunesCover(artist: string, title: string): Promise<string> {
  const key = normKey(artist, title);
  const now = Date.now();
  const hit = itunesMemCache.get(key);
  if (hit && hit.exp > now) return hit.url || "";

  const term = encodeURIComponent(`${artist} ${title}`);
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`;

  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) {
      itunesMemCache.set(key, { url: "", exp: now + ITUNES_CACHE_TTL_MS });
      return "";
    }
    const j = await r.json().catch(() => ({}));
    const item = j?.results?.[0];
    const art100 = String(item?.artworkUrl100 || "");
    const art600 = art100 ? art100.replace(/100x100bb\.jpg$/i, "600x600bb.jpg") : "";

    itunesMemCache.set(key, { url: art600 || "", exp: now + ITUNES_CACHE_TTL_MS });
    return art600 || "";
  } catch {
    itunesMemCache.set(key, { url: "", exp: now + ITUNES_CACHE_TTL_MS });
    return "";
  }
}

// ----------------------
// Tracks
// ----------------------
type TrackRow = {
  id: string | number;
  track_key: string;
  artist?: string;
  title?: string;
  cover_art?: string | null;
  cover_url?: string | null;        // optional if you use it
  cover_override?: boolean | null;  // optional if you use it
  cover_lock?: boolean | null;
};

async function getTrackByKey(track_key: string): Promise<TrackRow | null> {
  const fields = [
    "id",
    "track_key",
    "artist",
    "title",
    "cover_art",
    "cover_url",
    "cover_override",
    "cover_lock",
  ].join(",");

  const r = await directusFetch(
    `/items/${TRACKS_COLLECTION}?fields=${encodeURIComponent(
      fields
    )}&filter[track_key][_eq]=${encodeURIComponent(track_key)}&limit=1`,
    { method: "GET" }
  );
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j?.data?.[0] || null;
}

async function createTrack(track_key: string, artist: string, title: string) {
  const r = await directusFetch(`/items/${TRACKS_COLLECTION}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      track_key,
      artist,
      title,
      cover_lock: false,
    }),
  });

  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j?.data || null;
}

// ----------------------
// Plays
// ----------------------
async function getLastPlay() {
  const r = await directusFetch(
    `/items/${PLAYS_COLLECTION}?fields=id,track_key,played_at&sort=-played_at&limit=1`,
    { method: "GET" }
  );
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j?.data?.[0] || null;
}

async function insertPlay(payload: any) {
  await directusFetch(`/items/${PLAYS_COLLECTION}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function getHistory(limit: number) {
  const fields = [
    "id",
    "track_key",
    "artist",
    "title",
    "played_at",
    "raw",
    "track.id",
    "track.cover_art",
    "track.cover_url",
    "track.cover_override",
    "track.cover_lock",
  ].join(",");

  const r = await directusFetch(
    `/items/${PLAYS_COLLECTION}?fields=${encodeURIComponent(fields)}&sort=-played_at&limit=${limit}`,
    { method: "GET" }
  );
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j?.data) ? j.data : [];
}

// ----------------------
// Cover resolution (OPTION 1: NO UPLOAD)
// Priority:
// 1) Directus cover_art (file)
// 2) Directus cover_url (if you use it)
// 3) iTunes URL (no upload, just return url)
// ----------------------
async function resolveCoverUrlForTrack(
  trackRow: TrackRow | null,
  artist: string,
  title: string
): Promise<string> {
  // 1) directus file
  const coverId = trackRow?.cover_art || null;
  if (coverId) return fileUrl(coverId);

  // 2) direct URL fields (optional)
  const overrideOn = Boolean(trackRow?.cover_override);
  const directUrl = String(trackRow?.cover_url || "").trim();
  if (overrideOn && directUrl) return directUrl;
  if (directUrl) return directUrl;

  // 3) itunes (no upload)
  if (artist && title) return await fetchItunesCover(artist, title);
  return "";
}

// ----------------------
// API Route
// ----------------------
export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(30, Number(url.searchParams.get("limit") || "12")));

    // Icecast
    const r = await fetch(ICECAST_STATUS_URL, { cache: "no-store" });
    const json = await r.json().catch(() => ({}));
    const nowText = cleanNowText(extractNowPlaying(json));

    const { artist, title } = splitTrack(nowText);
    const track_key = normKey(artist, title);

    const played_at = new Date().toISOString();
    const played_at_ms = Date.parse(played_at);

    // Track row (create if missing)
    let trackRow = await getTrackByKey(track_key);
    if (!trackRow && artist) trackRow = await createTrack(track_key, artist, title);

    // Insert play if track changed
    const last = await getLastPlay();
    if (!last || String(last?.track_key || "") !== track_key) {
      await insertPlay({
        track_key,
        artist,
        title,
        played_at,
        raw: nowText,
        source: "icecast",
        track: trackRow?.id,
      });
    }

    // History
    const historyRaw = await getHistory(limit);

    // Build a quick cache for itunes resolves within this request
    const itunesReqCache = new Map<string, string>();

    async function resolveRowCover(rowTrack: any, a: string, t: string) {
      const fakeRow: TrackRow | null = rowTrack
        ? {
            id: rowTrack?.id,
            track_key: "",
            cover_art: rowTrack?.cover_art ?? null,
            cover_url: rowTrack?.cover_url ?? null,
            cover_override: rowTrack?.cover_override ?? null,
            cover_lock: rowTrack?.cover_lock ?? null,
          }
        : null;

      const k = normKey(a, t);
      if (itunesReqCache.has(k) && !fakeRow?.cover_art && !String(fakeRow?.cover_url || "").trim()) {
        return itunesReqCache.get(k) || "";
      }
      const u = await resolveCoverUrlForTrack(fakeRow, a, t);
      if (u && !fakeRow?.cover_art && !String(fakeRow?.cover_url || "").trim()) itunesReqCache.set(k, u);
      return u;
    }

    const history = [];
    for (const row of historyRaw) {
      const a = String(row?.artist || "").trim();
      const t = String(row?.title || "").trim();
      const coverUrl = await resolveRowCover(row?.track, a, t);

      history.push({
        id: row?.id,
        raw: String(row?.raw || `${a} - ${t}`.trim()).trim(),
        artist: a,
        title: t,
        track_key: String(row?.track_key || "").trim(),
        played_at: row?.played_at || "",
        played_at_ms: toUTCms(row?.played_at),
        cover_art: row?.track?.cover_art ?? null,
        cover_url: coverUrl || "",
      });
    }

    // Now payload
    const nowCoverUrl = await resolveCoverUrlForTrack(trackRow, artist, title);
    const nowCoverId = trackRow?.cover_art || null;

    const nowPayload = {
      raw: nowText,
      artist,
      title,
      track_key,
      played_at,
      played_at_ms,
      cover_art: nowCoverId,
      cover_url: nowCoverUrl || "",
    };

    return new Response(JSON.stringify({ ok: true, now: nowPayload, history }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "s-maxage=5, stale-while-revalidate=25",
      },
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || "Server error" }),
      {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      }
    );
  }
};
