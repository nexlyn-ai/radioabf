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

async function directusFetch(path: string, init: RequestInit = {}) {
  if (!DIRECTUS_URL) throw new Error("DIRECTUS_URL is missing");
  const url = `${DIRECTUS_URL}${path}`;
  const headers = new Headers(init.headers || {});
  if (DIRECTUS_TOKEN) headers.set("Authorization", `Bearer ${DIRECTUS_TOKEN}`);
  return fetch(url, { ...init, headers });
}

// ----------------------
// iTunes cover (memory micro-cache)
// -> utilisé seulement si cover_art absent (et pas lock)
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

// upload image URL to Directus files -> retourne fileId
async function uploadCoverFromUrl(imageUrl: string): Promise<string | null> {
  try {
    const img = await fetch(imageUrl, { cache: "no-store" });
    if (!img.ok) return null;

    const buffer = await img.arrayBuffer();

    const form = new FormData();
    form.append("file", new Blob([buffer]), "cover.jpg");

    const r = await fetch(`${DIRECTUS_URL}/files`, {
      method: "POST",
      headers: DIRECTUS_TOKEN ? { Authorization: `Bearer ${DIRECTUS_TOKEN}` } : undefined,
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

  // priorité : fichier directus
  cover_art?: string | null;

  // fallback / options
  cover_url?: string | null;
  cover_override?: string | null;
  cover_lock?: boolean | null;
};

function fileUrl(fileId?: string | null) {
  if (!fileId) return "";
  // directus assets endpoint (public if configured; otherwise token used elsewhere)
  return `${DIRECTUS_URL}/assets/${fileId}`;
}

function resolveCoverUrl(track: Partial<TrackRow> | null | undefined): string {
  if (!track) return "";
  // ✅ PRIORITÉ : cover_art
  if (track.cover_art) return fileUrl(track.cover_art);
  // fallback : override puis url
  const ovr = String(track.cover_override || "").trim();
  if (ovr) return ovr;
  const u = String(track.cover_url || "").trim();
  if (u) return u;
  return "";
}

async function getTrackByKey(track_key: string): Promise<TrackRow | null> {
  const r = await directusFetch(
    `/items/${TRACKS_COLLECTION}?fields=id,track_key,artist,title,cover_art,cover_url,cover_override,cover_lock&filter[track_key][_eq]=${encodeURIComponent(
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

async function updateTrack(id: string | number, payload: any) {
  await directusFetch(`/items/${TRACKS_COLLECTION}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
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
  // ✅ IMPORTANT : on récupère bien les champs track.cover_art etc.
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
// API Route
// ----------------------
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(30, Number(url.searchParams.get("limit") || "12")));

  // 1) icecast
  const r = await fetch(ICECAST_STATUS_URL, { cache: "no-store" });
  const json = await r.json().catch(() => ({}));
  const nowText = cleanNowText(extractNowPlaying(json));

  const { artist, title } = splitTrack(nowText);
  const track_key = normKey(artist, title);

  const played_at = new Date().toISOString();
  const played_at_ms = Date.parse(played_at);

  // 2) track row
  let trackRow = await getTrackByKey(track_key);
  if (!trackRow && artist) trackRow = await createTrack(track_key, artist, title);

  // 3) auto-cover (uniquement si cover_art absent et pas lock)
  // -> ici on essaye iTunes, puis on UPLOAD et on set cover_art
  if (trackRow && !trackRow.cover_art && !trackRow.cover_lock && artist && title) {
    const remoteCoverUrl = await fetchItunesCover(artist, title);
    if (remoteCoverUrl) {
      const fileId = await uploadCoverFromUrl(remoteCoverUrl);
      if (fileId) {
        await updateTrack(trackRow.id, { cover_art: fileId });
        trackRow.cover_art = fileId;
      } else {
        // fallback soft : si upload échoue, on peut au moins stocker l’url distante
        // (optionnel, tu peux supprimer ce bloc si tu ne veux pas)
        await updateTrack(trackRow.id, { cover_url: remoteCoverUrl });
        trackRow.cover_url = remoteCoverUrl;
      }
    }
  }

  // 4) insert play si changement de track
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

  // 5) history
  const historyRaw = await getHistory(limit);

  const history = historyRaw.map((row: any) => {
    const track = row?.track || null;

    return {
      id: row?.id,
      raw: String(row?.raw || `${row?.artist || ""} - ${row?.title || ""}`.trim()).trim(),
      artist: String(row?.artist || "").trim(),
      title: String(row?.title || "").trim(),
      track_key: String(row?.track_key || "").trim(),
      played_at: row?.played_at || "",
      played_at_ms: toUTCms(row?.played_at),

      // on renvoie l'id cover_art si dispo
      cover_art: track?.cover_art || null,

      // ✅ cover_url = cover_art en priorité
      cover_url: resolveCoverUrl(track),
    };
  });

  const nowPayload = {
    raw: nowText,
    artist,
    title,
    track_key,
    played_at,
    played_at_ms,
    cover_art: trackRow?.cover_art || null,
    cover_url: resolveCoverUrl(trackRow),
  };

  return new Response(JSON.stringify({ ok: true, now: nowPayload, history }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "s-maxage=5, stale-while-revalidate=25",
    },
  });
};
