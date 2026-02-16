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
  const url = `${DIRECTUS_URL}${path}`;
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${DIRECTUS_TOKEN}`);
  return fetch(url, { ...init, headers });
}

// ----------------------
// iTunes cover
// ----------------------
async function fetchItunesCover(artist: string, title: string): Promise<string> {
  const term = encodeURIComponent(`${artist} ${title}`);
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`;

  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return "";
    const j = await r.json().catch(() => ({}));
    const item = j?.results?.[0];
    const art100 = String(item?.artworkUrl100 || "");
    if (!art100) return "";
    return art100.replace(/100x100bb\.jpg$/i, "600x600bb.jpg");
  } catch {
    return "";
  }
}

// upload image URL to Directus
async function uploadCoverFromUrl(imageUrl: string): Promise<string | null> {
  try {
    const img = await fetch(imageUrl);
    if (!img.ok) return null;

    const buffer = await img.arrayBuffer();

    const form = new FormData();
    form.append("file", new Blob([buffer]), "cover.jpg");

    const r = await fetch(`${DIRECTUS_URL}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DIRECTUS_TOKEN}`,
      },
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
  if (!fileId) return "";
  return `${DIRECTUS_URL}/assets/${fileId}`;
}

async function getTrackByKey(track_key: string): Promise<TrackRow | null> {
  const r = await directusFetch(
    `/items/${TRACKS_COLLECTION}?fields=id,track_key,artist,title,cover_art,cover_lock&filter[track_key][_eq]=${encodeURIComponent(track_key)}&limit=1`,
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

  const r = await fetch(ICECAST_STATUS_URL, { cache: "no-store" });
  const json = await r.json().catch(() => ({}));
  const nowText = cleanNowText(extractNowPlaying(json));

  const { artist, title } = splitTrack(nowText);
  const track_key = normKey(artist, title);

  const played_at = new Date().toISOString();
  const played_at_ms = Date.parse(played_at);

  let trackRow = await getTrackByKey(track_key);
  if (!trackRow && artist) {
    trackRow = await createTrack(track_key, artist, title);
  }

  // auto cover if missing and not locked
  if (trackRow && !trackRow.cover_art && !trackRow.cover_lock) {
    const coverUrl = await fetchItunesCover(artist, title);
    if (coverUrl) {
      const fileId = await uploadCoverFromUrl(coverUrl);
      if (fileId) {
        await updateTrack(trackRow.id, { cover_art: fileId });
        trackRow.cover_art = fileId;
      }
    }
  }

  // insert play
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

  const historyRaw = await getHistory(limit);

  const history = historyRaw.map((row: any) => {
    const coverId = row?.track?.cover_art || null;
    return {
      ...row,
      played_at_ms: toUTCms(row?.played_at),
      cover_art: coverId,
      cover_url: fileUrl(coverId),
    };
  });

  const nowCoverId = trackRow?.cover_art || null;

  const now = {
    raw: nowText,
    artist,
    title,
    track_key,
    played_at,
    played_at_ms,
    cover_art: nowCoverId,
    cover_url: fileUrl(nowCoverId),
  };

  return new Response(JSON.stringify({ ok: true, now, history }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "s-maxage=5, stale-while-revalidate=25",
    },
  });
};
