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

/**
 * ✅ Normalize Directus datetime strings.
 * If Directus returns "2026-02-15T18:12:00" (no TZ),
 * we assume it's UTC and force "Z".
 */
function toUTCms(v: any): number {
  const s = String(v || "").trim();
  if (!s) return 0;

  if (/[zZ]$/.test(s) || /[+\-]\d\d:\d\d$/.test(s)) return Date.parse(s);
  return Date.parse(s + "Z");
}

async function directusFetch(path: string, init: RequestInit = {}) {
  const url = `${DIRECTUS_URL}${path}`;
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${DIRECTUS_TOKEN}`);
  return fetch(url, { ...init, headers });
}

// ----------------------
// Directus: Tracks
// ----------------------
type TrackRow = {
  id: string | number;
  track_key: string;
  artist?: string;
  title?: string;
  cover_art?: string | null;   // directus file id
  cover_lock?: boolean | null;
};

function fileUrl(fileId?: string | null) {
  if (!fileId) return "";
  // directus assets URL (public)
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

async function createTrack(payload: {
  track_key: string;
  artist: string;
  title: string;
}) : Promise<TrackRow | null> {
  const r = await directusFetch(`/items/${TRACKS_COLLECTION}`, {
    method: "POST",
    body: JSON.stringify({
      track_key: payload.track_key,
      artist: payload.artist,
      title: payload.title,
      cover_lock: false,
      // cover_art: null (optionnel)
    }),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j?.data || null;
}

async function updateTrack(id: string | number, payload: Partial<TrackRow>) {
  await directusFetch(`/items/${TRACKS_COLLECTION}/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

/**
 * Upsert minimal:
 * - create if missing
 * - update artist/title if changed AND not locked (cover_lock is about cover, but we can still keep metadata in sync)
 */
async function upsertTrack(track_key: string, artist: string, title: string): Promise<TrackRow | null> {
  const existing = await getTrackByKey(track_key);
  if (!existing) {
    return await createTrack({ track_key, artist, title });
  }

  // keep metadata in sync if needed
  const needsUpdate =
    (artist && String(existing.artist || "") !== artist) ||
    (title && String(existing.title || "") !== title);

  if (needsUpdate) {
    try {
      await updateTrack(existing.id, { artist, title });
      return { ...existing, artist, title };
    } catch {
      return existing;
    }
  }

  return existing;
}

// ----------------------
// Directus: Plays
// ----------------------
async function getLastPlay() {
  const r = await directusFetch(
    `/items/${PLAYS_COLLECTION}?fields=id,track_key,played_at,track&sort=-played_at&limit=1`,
    { method: "GET" }
  );
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j?.data?.[0] || null;
}

async function insertPlay(payload: {
  track_key: string;
  artist: string;
  title: string;
  played_at: string;
  raw: string;
  source?: string;
  track?: string | number; // relation to tracks
}) {
  await directusFetch(`/items/${PLAYS_COLLECTION}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function getHistory(limit: number) {
  // include related track cover_art
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
    "track.track_key",
    "track.artist",
    "track.title",
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

  if (!ICECAST_STATUS_URL) {
    return new Response(JSON.stringify({ ok: false, error: "ICECAST_STATUS_URL missing" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "DIRECTUS_URL/DIRECTUS_TOKEN missing" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // 1) Icecast -> now playing text
  let nowText = "";
  try {
    const r = await fetch(ICECAST_STATUS_URL, { cache: "no-store" });
    if (!r.ok) {
      return new Response(JSON.stringify({ ok: false, error: `Upstream HTTP ${r.status}` }), {
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    const json = await r.json().catch(() => ({}));
    nowText = cleanNowText(extractNowPlaying(json));
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "Icecast fetch failed" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const { artist, title } = splitTrack(nowText);
  const track_key = normKey(artist, title);

  // ✅ Always UTC ISO with Z
  const played_at = new Date().toISOString();
  const played_at_ms = Date.parse(played_at);

  // 2) Upsert track (for cover_art centralization)
  let trackRow: TrackRow | null = null;
  if (artist && track_key && artist.toLowerCase() !== "undefined") {
    try {
      trackRow = await upsertTrack(track_key, artist, title);
    } catch {
      trackRow = null;
    }
  }

  // 3) Insert play only if new track_key
  if (artist && track_key && artist.toLowerCase() !== "undefined") {
    try {
      const last = await getLastPlay();
      if (!last || String(last?.track_key || "") !== track_key) {
        await insertPlay({
          track_key,
          artist,
          title,
          played_at,
          raw: nowText,
          source: "icecast",
          track: trackRow?.id, // ✅ link play -> track
        });
      }
    } catch {}
  }

  // 4) History with track.cover_art
  const historyRaw = await getHistory(limit);

  const history = historyRaw.map((row: any) => {
    const coverId = row?.track?.cover_art || null;
    const cover_url = fileUrl(coverId);

    return {
      ...row,
      played_at_ms: toUTCms(row?.played_at),
      // normalized cover fields for frontend
      cover_art: coverId,
      cover_url,
    };
  });

  // now payload includes cover
  const nowCoverId = trackRow?.cover_art || null;
  const nowCoverUrl = fileUrl(nowCoverId);

  const now = {
    raw: nowText,
    artist,
    title,
    track_key,
    played_at,
    played_at_ms,
    cover_art: nowCoverId,
    cover_url: nowCoverUrl,
  };

  return new Response(JSON.stringify({ ok: true, now, history }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "s-maxage=5, stale-while-revalidate=25",
    },
  });
};
