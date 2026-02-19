// src/pages/api/nowplaying.ts
import type { APIRoute } from "astro";

export const prerender = false;

const ICECAST_STATUS_URL =
  import.meta.env.ICECAST_STATUS_URL || process.env.ICECAST_STATUS_URL || "";

// ⚠️ IMPORTANT : mets ici l'URL du CMS (ex: https://cms.radioabf.com)
const DIRECTUS_URL_RAW =
  import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";

// ⚠️ IMPORTANT : ce token doit être celui qui a accès à plays + tracks + directus_files (api_writer)
const DIRECTUS_TOKEN =
  import.meta.env.DIRECTUS_TOKEN ||
  process.env.DIRECTUS_TOKEN ||
  "";

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
  return out.trim();
}

function splitTrack(entry: string) {
  const cleaned = cleanNowText(entry);
  const idx = cleaned.indexOf(" - ");
  if (idx === -1) return { artist: cleaned.trim(), title: "" };
  return { artist: cleaned.slice(0, idx).trim(), title: cleaned.slice(idx + 3).trim() };
}

function normKey(artist: string, title: string) {
  return (artist + " - " + title)
    .toLowerCase()
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

function stripTrailingSlash(u: string) {
  return String(u || "").replace(/\/+$/, "");
}

const DIRECTUS_URL = stripTrailingSlash(DIRECTUS_URL_RAW);

async function directusFetch(path: string, init: RequestInit = {}) {
  if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
    // on renvoie une Response "fake" pour éviter de throw partout
    return new Response(null, { status: 599, statusText: "DIRECTUS_NOT_CONFIGURED" }) as any;
  }

  const url = `${DIRECTUS_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${DIRECTUS_TOKEN}`);
  return fetch(url, { ...init, headers });
}

// ----------------------
// iTunes cover (memory micro-cache)
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

// Upload image URL to Directus (best effort)
async function uploadCoverFromUrl(imageUrl: string): Promise<string | null> {
  if (!DIRECTUS_URL || !DIRECTUS_TOKEN) return null;

  try {
    const img = await fetch(imageUrl, { cache: "no-store" });
    if (!img.ok) return null;

    const buffer = await img.arrayBuffer();
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "image/jpeg" }), "cover.jpg");

    const r = await fetch(`${DIRECTUS_URL}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DIRECTUS_TOKEN}` },
      body: form,
    });

    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    return j?.data?.id || null;
  } catch {
    return null;
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
  cover_lock?: boolean | null;
};

function fileUrl(fileId?: string | null) {
  if (!fileId || !DIRECTUS_URL) return "";
  return `${DIRECTUS_URL}/assets/${fileId}`;
}

async function getTrackByKey(track_key: string): Promise<TrackRow | null> {
  const r = await directusFetch(
    `/items/${TRACKS_COLLECTION}?fields=id,track_key,artist,title,cover_art,cover_lock&filter[track_key][_eq]=${encodeURIComponent(
      track_key
    )}&limit=1`,
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
    body: JSON.stringify({ track_key, artist, title, cover_lock: false }),
  });

  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j?.data || null;
}

async function updateTrack(id: string | number, payload: any) {
  const r = await directusFetch(`/items/${TRACKS_COLLECTION}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.ok;
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
  const r = await directusFetch(`/items/${PLAYS_COLLECTION}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.ok;
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
// API Route
// ----------------------
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(30, Number(url.searchParams.get("limit") || "12")));

  // 1) Icecast now
  let nowText = "";
  try {
    const r = await fetch(ICECAST_STATUS_URL, { cache: "no-store" });
    const json = await r.json().catch(() => ({}));
    nowText = cleanNowText(extractNowPlaying(json));
  } catch {
    nowText = "";
  }

  const { artist, title } = splitTrack(nowText);
  const track_key = normKey(artist, title);

  const played_at = new Date().toISOString();
  const played_at_ms = Date.parse(played_at);

  // 2) Directus track (best effort)
  let trackRow: TrackRow | null = null;
  if (track_key) {
    trackRow = await getTrackByKey(track_key);
    if (!trackRow && artist) trackRow = await createTrack(track_key, artist, title);
  }

  // 3) Cover resolution strategy:
  //    - If we already have cover_art -> use directus asset URL
  //    - Else -> use iTunes cover_url right now (display immediate)
  //    - And try to upload+patch cover_art (best effort) so future requests use Directus
  let nowCoverId: string | null = (trackRow?.cover_art as any) || null;
  let nowCoverUrl = fileUrl(nowCoverId);

  if (!nowCoverUrl && artist && title) {
    const it = await fetchItunesCover(artist, title);
    if (it) nowCoverUrl = it;

    // best effort persist in Directus if not locked and we have a trackRow
    if (it && trackRow && !trackRow.cover_lock && !trackRow.cover_art) {
      const fileId = await uploadCoverFromUrl(it);
      if (fileId) {
        const ok = await updateTrack(trackRow.id, { cover_art: fileId });
        if (ok) {
          nowCoverId = fileId;
          // on peut choisir de retourner l'asset Directus, ou garder iTunes
          // Directus asset => stable et cache long
          nowCoverUrl = fileUrl(fileId) || it;
        }
      }
    }
  }

  // 4) Insert play when track changes (best effort)
  if (track_key && artist) {
    const last = await getLastPlay();
    if (!last || String(last?.track_key || "") !== track_key) {
      await insertPlay({
        track_key,
        artist,
        title,
        played_at,
        raw: nowText,
        source: "icecast",
        track: trackRow?.id ?? null,
      });
    }
  }

  // 5) History (best effort)
  const historyRaw = await getHistory(limit);

  // Normalize history payload
  // IMPORTANT: si cover_art null => on met iTunes cover_url pour affichage immédiat
  const history = [];
  for (const row of historyRaw) {
    const a = String(row?.artist || "").trim();
    const t = String(row?.title || "").trim();
    const coverId = row?.track?.cover_art || null;

    let cover_url = fileUrl(coverId);
    if (!cover_url && a && t) {
      // fallback iTunes (pas besoin d'uploader ici)
      cover_url = await fetchItunesCover(a, t);
    }

    history.push({
      id: row?.id,
      raw: String(row?.raw || `${a} - ${t}`.trim()).trim(),
      artist: a,
      title: t,
      track_key: String(row?.track_key || "").trim(),
      played_at: row?.played_at || "",
      played_at_ms: toUTCms(row?.played_at),
      cover_art: coverId,
      cover_url,
    });
  }

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
};
