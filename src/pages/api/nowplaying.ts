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

/* -------------------- Helpers -------------------- */

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

function normKey(artist: string, title: string) {
  return (artist + " - " + title)
    .toLowerCase()
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, "")
    .trim();
}

function stripMixSuffix(title: string) {
  return title
    .replace(/\((original|extended|radio|club|edit|mix)[^)]+\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractNowPlaying(json: any): string {
  const src = json?.icestats?.source;
  const s = Array.isArray(src) ? src[0] : src;
  return (
    (s?.title && String(s.title)) ||
    (s?.yp_currently_playing && String(s.yp_currently_playing)) ||
    (s?.streamtitle && String(s.streamtitle)) ||
    ""
  ).trim();
}

function toUTCms(v: any): number {
  const s = String(v || "").trim();
  if (!s) return 0;
  if (/[zZ]$/.test(s) || /[+\-]\d\d:\d\d$/.test(s)) return Date.parse(s);
  return Date.parse(s + "Z");
}

function assertEnv() {
  if (!ICECAST_STATUS_URL) throw new Error("ICECAST_STATUS_URL missing");
  if (!DIRECTUS_URL) throw new Error("DIRECTUS_URL missing");
  if (!DIRECTUS_TOKEN) throw new Error("DIRECTUS_TOKEN missing");
}

async function directusFetch(path: string, init: RequestInit = {}) {
  assertEnv();
  return fetch(`${DIRECTUS_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${DIRECTUS_TOKEN}`,
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
}

function fileUrl(fileId?: string | null) {
  if (!fileId) return "";
  return `${DIRECTUS_URL}/assets/${fileId}`;
}

/* -------------------- iTunes (NO UPLOAD) -------------------- */

type ItunesCacheEntry = { url: string; exp: number };
const CACHE_TTL = 6 * 60 * 60 * 1000;
const memCache: Map<string, ItunesCacheEntry> =
  (globalThis as any).__itunesCache || new Map();
(globalThis as any).__itunesCache = memCache;

async function searchItunes(term: string): Promise<string> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
    term
  )}&entity=song&limit=1`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return "";
    const j = await r.json();
    const item = j?.results?.[0];
    const art100 = item?.artworkUrl100;
    if (!art100) return "";
    return art100.replace(/100x100bb\.jpg$/i, "600x600bb.jpg");
  } catch {
    return "";
  }
}

async function fetchItunesCover(artist: string, title: string): Promise<string> {
  const key = normKey(artist, title);
  const now = Date.now();
  const hit = memCache.get(key);
  if (hit && hit.exp > now) return hit.url;
  // 1️⃣ Recherche complète
  let cover = await searchItunes(`${artist} ${title}`);
  // 2️⃣ Si rien → nettoyer suffixes remix
  if (!cover) {
    const cleanTitle = stripMixSuffix(title);
    if (cleanTitle && cleanTitle !== title) {
      cover = await searchItunes(`${artist} ${cleanTitle}`);
    }
  }
  memCache.set(key, { url: cover || "", exp: now + CACHE_TTL });
  return cover || "";
}

/* -------------------- API -------------------- */

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const limit = Math.min(
      30,
      Math.max(1, Number(url.searchParams.get("limit") || "12"))
    );
    const ice = await fetch(ICECAST_STATUS_URL, { cache: "no-store" });
    const iceJson = await ice.json();
    const nowText = cleanNowText(extractNowPlaying(iceJson));
    const { artist, title } = splitTrack(nowText);
    const track_key = normKey(artist, title);
    const played_at = new Date().toISOString();
    const played_at_ms = Date.parse(played_at);

    // Vérifier si ce track_key existe déjà en tête de l'historique
    const lastRes = await directusFetch(
      `/items/${PLAYS_COLLECTION}?fields=track_key,played_at&sort=-played_at&limit=1`
    );
    const lastJson = await lastRes.json();
    const last = lastJson?.data?.[0];

    if (!last || last.track_key !== track_key) {
      // Nouveau titre → on insère
      await directusFetch(`/items/${PLAYS_COLLECTION}`, {
        method: "POST",
        body: JSON.stringify({
          track_key,
          artist,
          title,
          played_at,
          raw: nowText,
        }),
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    // History from Directus
    const histRes = await directusFetch(
      `/items/${PLAYS_COLLECTION}?fields=id,track_key,artist,title,played_at,raw&sort=-played_at&limit=${limit}`
    );
    const histJson = await histRes.json();
    const historyRaw = histJson?.data || [];
    const history = [];
    for (const row of historyRaw) {
      const a = String(row.artist || "");
      const t = String(row.title || "");
      const cover = await fetchItunesCover(a, t);
      history.push({
        id: row.id,
        raw: row.raw,
        artist: a,
        title: t,
        track_key: row.track_key,
        played_at: row.played_at,
        played_at_ms: toUTCms(row.played_at),
        cover_art: null,
        cover_url: cover,
      });
    }

    const nowCover = await fetchItunesCover(artist, title);

    return new Response(
      JSON.stringify({
        ok: true,
        now: {
          raw: nowText,
          artist,
          title,
          track_key,
          played_at,
          played_at_ms,
          cover_art: null,
          cover_url: nowCover,
        },
        history,
      }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "s-maxage=5, stale-while-revalidate=20",
        },
      }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || "Server error" }),
      { status: 500 }
    );
  }
};