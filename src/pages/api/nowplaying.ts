// src/pages/api/nowplaying.ts
import type { APIRoute } from "astro";

export const prerender = false;

const ICECAST_STATUS_URL =
  import.meta.env.ICECAST_STATUS_URL || process.env.ICECAST_STATUS_URL || "";

const DIRECTUS_URL =
  import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";

const DIRECTUS_TOKEN =
  import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || "";

// (optionnel) si tu veux absolument uploader les covers dans Directus (files)
// sinon on stocke juste cover_url (itunes) dans tracks
const ABF_UPLOAD_COVERS =
  (import.meta.env.ABF_UPLOAD_COVERS || process.env.ABF_UPLOAD_COVERS || "")
    .toString()
    .toLowerCase() === "true";

// Collections
const PLAYS_COLLECTION = "plays";
const TRACKS_COLLECTION = "tracks";

// Cache policy
const COVER_TTL_DAYS = 60;

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

function safeStr(v: any) {
  return String(v ?? "").trim();
}

function daysBetween(a: Date, b: Date) {
  return Math.abs(a.getTime() - b.getTime()) / 86400000;
}

async function directusFetch(path: string, init: RequestInit = {}) {
  if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
    return fetch("about:blank", { method: "GET" }); // évite crash si env manquantes
  }
  const url = `${DIRECTUS_URL}${path}`;
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${DIRECTUS_TOKEN}`);
  return fetch(url, { ...init, headers, cache: "no-store" });
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
    const art600 = art100
      ? art100.replace(/100x100bb\.(jpg|png)$/i, "600x600bb.$1")
      : "";

    itunesMemCache.set(key, { url: art600 || "", exp: now + ITUNES_CACHE_TTL_MS });
    return art600 || "";
  } catch {
    itunesMemCache.set(key, { url: "", exp: now + ITUNES_CACHE_TTL_MS });
    return "";
  }
}

// upload image URL to Directus (OPTIONNEL)
async function uploadCoverFromUrl(imageUrl: string): Promise<string | null> {
  if (!DIRECTUS_URL || !DIRECTUS_TOKEN) return null;
  try {
    const img = await fetch(imageUrl);
    if (!img.ok) return null;

    const buffer = await img.arrayBuffer();

    const form = new FormData();
    form.append("file", new Blob([buffer]), "cover.jpg");

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

  // ✅ tes champs Directus existants
  cover_url?: string | null;
  cover_override?: string | null;
  cover_source?: string | null;
  cover_updated_at?: string | null;

  // file field
  cover_art?: string | null;

  // lock
  cover_lock?: boolean | null;
};

function assetUrl(fileId?: string | null) {
  if (!fileId) return "";
  return `${DIRECTUS_URL}/assets/${fileId}`;
}

function resolveCoverUrlFromTrack(track?: TrackRow | null) {
  if (!track) return "";
  // Priorité : override > cover_url > cover_art(asset)
  const override = safeStr(track.cover_override);
  if (override) return override;

  const url = safeStr(track.cover_url);
  if (url) return url;

  const fileId = safeStr(track.cover_art);
  if (fileId) return assetUrl(fileId);

  return "";
}

async function getTrackByKey(track_key: string): Promise<TrackRow | null> {
  const fields = [
    "id",
    "track_key",
    "artist",
    "title",
    "cover_url",
    "cover_override",
    "cover_source",
    "cover_updated_at",
    "cover_art",
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
      cover_source: null,
      cover_updated_at: null,
      cover_url: "",
    }),
  });

  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j?.data || null;
}

async function updateTrack(id: string | number, payload: any) {
  await directusFetch(`/items/${TRACKS_COLLECTION}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function coverIsFresh(track: TrackRow) {
  const updated = safeStr(track.cover_updated_at);
  if (!updated) return false;
  const d = new Date(updated);
  if (Number.isNaN(d.getTime())) return false;
  return daysBetween(new Date(), d) <= COVER_TTL_DAYS;
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
  // ✅ on récupère aussi les nouvelles colonnes cover_* depuis track
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
    "track.cover_updated_at",
    "track.cover_source",
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
  const r = await fetch(ICECAST_STATUS_URL, { cache: "no-store" });
  const json = await r.json().catch(() => ({}));
  const nowText = cleanNowText(extractNowPlaying(json));

  const { artist, title } = splitTrack(nowText);
  const track_key = normKey(artist, title);

  const played_at = new Date().toISOString();
  const played_at_ms = Date.parse(played_at);

  // 2) Track row (Directus)
  let trackRow = await getTrackByKey(track_key);
  if (!trackRow && artist) trackRow = await createTrack(track_key, artist, title);

  // 3) Auto cover (✅ solution simple : remplir cover_url)
  //    - respecte cover_lock
  //    - respecte cover_override
  //    - respecte TTL
  if (trackRow && !trackRow.cover_lock) {
    const hasOverride = !!safeStr(trackRow.cover_override);
    const hasCover = !!resolveCoverUrlFromTrack(trackRow);

    const shouldFetch =
      !hasOverride &&
      (!hasCover || !coverIsFresh(trackRow)) &&
      safeStr(artist) &&
      safeStr(title);

    if (shouldFetch) {
      const coverUrl = await fetchItunesCover(artist, title);

      if (coverUrl) {
        // ✅ le fix principal : stocker cover_url dans tracks
        const patch: any = {
          cover_url: coverUrl,
          cover_source: "itunes",
          cover_updated_at: new Date().toISOString(),
        };

        // OPTIONNEL : upload Directus file (désactivé par défaut)
        if (ABF_UPLOAD_COVERS) {
          const fileId = await uploadCoverFromUrl(coverUrl);
          if (fileId) patch.cover_art = fileId;
        }

        await updateTrack(trackRow.id, patch);

        // sync local copy
        trackRow.cover_url = patch.cover_url;
        trackRow.cover_source = patch.cover_source;
        trackRow.cover_updated_at = patch.cover_updated_at;
        if (patch.cover_art) trackRow.cover_art = patch.cover_art;
      } else {
        // évite de spammer iTunes si introuvable
        await updateTrack(trackRow.id, {
          cover_source: "itunes",
          cover_updated_at: new Date().toISOString(),
        });
        trackRow.cover_source = "itunes";
        trackRow.cover_updated_at = new Date().toISOString();
      }
    }
  }

  // 4) Insert play if track changed
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

  // 5) History
  const historyRaw = await getHistory(limit);

  const history = historyRaw.map((row: any) => {
    const t: TrackRow | null = row?.track
      ? {
          id: row?.track?.id,
          track_key: row?.track_key,
          cover_art: row?.track?.cover_art ?? null,
          cover_url: row?.track?.cover_url ?? "",
          cover_override: row?.track?.cover_override ?? "",
          cover_lock: row?.track?.cover_lock ?? false,
          cover_updated_at: row?.track?.cover_updated_at ?? null,
          cover_source: row?.track?.cover_source ?? null,
        }
      : null;

    const cover_url = resolveCoverUrlFromTrack(t);

    return {
      id: row?.id,
      raw: String(row?.raw || `${row?.artist || ""} - ${row?.title || ""}`.trim()).trim(),
      artist: String(row?.artist || "").trim(),
      title: String(row?.title || "").trim(),
      track_key: String(row?.track_key || "").trim(),
      played_at: row?.played_at || "",
      played_at_ms: toUTCms(row?.played_at),
      cover_art: t?.cover_art ?? null,
      cover_url,
    };
  });

  // 6) Now payload
  const nowCoverUrl = resolveCoverUrlFromTrack(trackRow || null);
  const nowCoverId = trackRow?.cover_art || null;

  const nowPayload = {
    raw: nowText,
    artist,
    title,
    track_key,
    played_at,
    played_at_ms,
    cover_art: nowCoverId,
    cover_url: nowCoverUrl,
  };

  return new Response(JSON.stringify({ ok: true, now: nowPayload, history }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "s-maxage=5, stale-while-revalidate=25",
    },
  });
};
