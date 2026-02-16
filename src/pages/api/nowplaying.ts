// src/pages/api/nowplaying.ts
import type { APIRoute } from "astro";

export const prerender = false;

const ICECAST_STATUS_URL =
  import.meta.env.ICECAST_STATUS_URL || process.env.ICECAST_STATUS_URL || "";

const DIRECTUS_URL =
  import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";

const DIRECTUS_TOKEN =
  import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || "";

const PLAYS_COLLECTION = "plays";
const TRACKS_COLLECTION = "tracks";

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
 * we assume it's UTC and force "Z" to avoid 1h offset in Paris (UTC+1 in Feb).
 */
function toUTCms(v: any): number {
  const s = String(v || "").trim();
  if (!s) return 0;

  // already has timezone -> parse as-is
  if (/[zZ]$/.test(s) || /[+\-]\d\d:\d\d$/.test(s)) return Date.parse(s);

  // no timezone -> treat as UTC and force Z
  return Date.parse(s + "Z");
}

async function directusFetch(path: string, init: RequestInit = {}) {
  const url = `${DIRECTUS_URL}${path}`;
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${DIRECTUS_TOKEN}`);
  return fetch(url, { ...init, headers });
}

async function getLastPlay() {
  const r = await directusFetch(
    `/items/${PLAYS_COLLECTION}?fields=track_key,played_at&sort=-played_at&limit=1`,
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
  // Optional relation field (if exists in plays)
  track?: string | number;
}) {
  await directusFetch(`/items/${PLAYS_COLLECTION}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function getHistory(limit: number) {
  const r = await directusFetch(
    `/items/${PLAYS_COLLECTION}?fields=track_key,artist,title,played_at,raw&sort=-played_at&limit=${limit}`,
    { method: "GET" }
  );
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j?.data) ? j.data : [];
}

/* ---------------------------
   TRACKS (covers centralized)
---------------------------- */

type TrackRow = {
  id: string | number;
  track_key: string;
  artist?: string | null;
  title?: string | null;
  cover_url?: string | null;
  cover_override?: boolean | null;
};

async function itunesCover(artist: string, title: string) {
  const a = String(artist || "").trim();
  const t = String(title || "").trim();
  if (!a || !t) return "";

  const term = encodeURIComponent(`${a} ${t}`);
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`;

  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return "";
    const j = await r.json().catch(() => ({}));
    const item = j?.results?.[0];
    if (!item) return "";
    const art100 = String(item?.artworkUrl100 || "").trim();
    if (!art100) return "";
    return art100.replace(/100x100bb\.jpg$/i, "600x600bb.jpg");
  } catch {
    return "";
  }
}

async function getTracksMapByKeys(keys: string[]) {
  const uniq = Array.from(new Set(keys.filter(Boolean)));
  if (!uniq.length) return new Map<string, TrackRow>();

  // Directus filter _in expects comma-separated list
  const inList = uniq.map((k) => encodeURIComponent(k)).join(",");

  const r = await directusFetch(
    `/items/${TRACKS_COLLECTION}?fields=id,track_key,artist,title,cover_url,cover_override&filter[track_key][_in]=${inList}&limit=${uniq.length}`,
    { method: "GET" }
  );

  if (!r.ok) return new Map<string, TrackRow>();
  const j = await r.json().catch(() => ({}));
  const rows: TrackRow[] = Array.isArray(j?.data) ? j.data : [];

  const map = new Map<string, TrackRow>();
  for (const row of rows) {
    if (row?.track_key) map.set(String(row.track_key), row);
  }
  return map;
}

async function createTrack(payload: {
  track_key: string;
  artist: string;
  title: string;
  cover_url?: string;
  cover_override?: boolean;
}) {
  const r = await directusFetch(`/items/${TRACKS_COLLECTION}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j?.data || null;
}

async function updateTrack(id: string | number, payload: Partial<TrackRow>) {
  const r = await directusFetch(`/items/${TRACKS_COLLECTION}/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j?.data || null;
}

/**
 * Ensure track exists in Directus and returns { id, cover_url }.
 * - If track exists and cover_override=true: do NOT change cover_url.
 * - If missing cover_url: try iTunes and update.
 * - If not existing: create with iTunes cover (if found).
 */
async function ensureTrack(artist: string, title: string, track_key: string, existing?: TrackRow | null) {
  const a = String(artist || "").trim();
  const t = String(title || "").trim();
  if (!track_key || !a) return { id: null as any, cover_url: "" };

  // if exists
  if (existing?.id != null) {
    const override = Boolean(existing.cover_override);
    const currentCover = String(existing.cover_url || "").trim();

    if (override) {
      return { id: existing.id, cover_url: currentCover };
    }

    if (currentCover) {
      return { id: existing.id, cover_url: currentCover };
    }

    // try fill missing cover
    const found = await itunesCover(a, t);
    if (found) {
      await updateTrack(existing.id, { cover_url: found, artist: existing.artist || a, title: existing.title || t });
      return { id: existing.id, cover_url: found };
    }
    return { id: existing.id, cover_url: "" };
  }

  // create new
  const found = await itunesCover(a, t);
  const created = await createTrack({
    track_key,
    artist: a,
    title: t,
    cover_url: found || "",
    cover_override: false,
  });

  return { id: created?.id ?? null, cover_url: String(created?.cover_url || found || "").trim() };
}

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

  // Icecast
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

  // 1) Insert play if new track_key
  let inserted = false;
  let insertedTrackId: string | number | null = null;

  if (artist && track_key && artist.toLowerCase() !== "undefined") {
    try {
      const last = await getLastPlay();
      if (!last || String(last?.track_key || "") !== track_key) {
        // Ensure track exists (and maybe fill cover)
        const existingMap = await getTracksMapByKeys([track_key]);
        const existing = existingMap.get(track_key) || null;
        const ensured = await ensureTrack(artist, title, track_key, existing);
        insertedTrackId = ensured.id;

        // Insert play (with optional relation)
        const payload: any = { track_key, artist, title, played_at, raw: nowText, source: "icecast" };
        if (ensured.id != null) payload.track = ensured.id; // works only if plays has field "track"
        await insertPlay(payload);

        inserted = true;
      }
    } catch {
      // ignore
    }
  }

  // 2) Load history from plays
  const historyRaw = await getHistory(limit);

  // 3) Collect keys (now + history)
  const keys = [track_key, ...historyRaw.map((r: any) => String(r?.track_key || "").trim())].filter(Boolean);
  const tracksMap = await getTracksMapByKeys(keys);

  // 4) Ensure NOW has track + cover (in case not inserted because same track)
  let nowCoverUrl = "";
  try {
    const existing = tracksMap.get(track_key) || null;
    const ensured = await ensureTrack(artist, title, track_key, existing);
    nowCoverUrl = ensured.cover_url || "";
    if (ensured.id != null && !tracksMap.get(track_key)) {
      // not strictly needed; map refresh is optional
    }
  } catch {
    nowCoverUrl = "";
  }

  // ✅ add played_at_ms (normalized) + cover_url for perfect client display
  const history = historyRaw.map((row: any) => {
    const k = String(row?.track_key || "").trim();
    const tr = k ? tracksMap.get(k) : null;
    return {
      ...row,
      played_at_ms: toUTCms(row?.played_at),
      cover_url: String(tr?.cover_url || "").trim(),
    };
  });

  const now = {
    raw: nowText,
    artist,
    title,
    track_key,
    played_at,
    played_at_ms,
    cover_url: nowCoverUrl,
  };

  return new Response(JSON.stringify({ ok: true, now, history, inserted, inserted_track_id: insertedTrackId }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "s-maxage=5, stale-while-revalidate=25",
    },
  });
};
