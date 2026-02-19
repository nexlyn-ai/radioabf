// src/pages/api/nowplaying.ts
import type { APIRoute } from "astro";

export const prerender = false;

const ICECAST_STATUS_URL =
  import.meta.env.ICECAST_STATUS_URL || process.env.ICECAST_STATUS_URL || "";
const DIRECTUS_URL = import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";
const DIRECTUS_TOKEN =
  import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || "";

// Collections
const PLAYS_COLLECTION = "plays";
const TRACKS_COLLECTION = "tracks";

// Champs Directus (adapte si tu as nommé autrement)
const TRACKS_KEY_FIELD = "track_key";
const TRACKS_COVER_FIELD = "cover"; // file (directus_files)
const PLAYS_COVER_FIELD = "cover";  // file (directus_files) - optionnel
const PLAYS_COVER_URL_FIELD = "cover_url"; // string - optionnel

// Fallback iTunes (si tu veux le garder en secours)
const ENABLE_ITUNES_FALLBACK =
  (import.meta.env.ENABLE_ITUNES_FALLBACK || process.env.ENABLE_ITUNES_FALLBACK || "false") === "true";

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
  const fullUrl = `${DIRECTUS_URL}${path}`;
  const res = await fetch(fullUrl, {
    ...init,
    headers: {
      Authorization: `Bearer ${DIRECTUS_TOKEN}`,
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Directus ${path} failed: ${res.status} ${res.statusText}${txt ? ` — ${txt}` : ""}`);
  }
  return res;
}

function directusAssetUrl(fileId: string) {
  // directus sert les fichiers via /assets/<id>
  return fileId ? `${DIRECTUS_URL}/assets/${fileId}` : "";
}

/* -------------------- Cover lookup via Directus (tracks) -------------------- */

const __coverCache: Map<string, { url: string; exp: number }> =
  ((globalThis as any).__coverCache as Map<string, { url: string; exp: number }>) || new Map();

async function fetchDirectusCoverByTrackKey(track_key: string): Promise<string> {
  if (!track_key) return "";

  const now = Date.now();
  const hit = __coverCache.get(track_key);
  if (hit && hit.exp > now) return hit.url;

  // Query tracks where track_key == ...
  const params = new URLSearchParams({
    fields: `${TRACKS_COVER_FIELD}`, // ex: cover
    limit: "1",
    [`filter[${TRACKS_KEY_FIELD}][_eq]`]: track_key,
  });

  let coverUrl = "";
  try {
    const r = await directusFetch(`/items/${TRACKS_COLLECTION}?${params.toString()}`);
    const j = await r.json();
    const row = j?.data?.[0];

    // cover peut être:
    // - string (file id)
    // - object { id: "..." } si tu as un M2O ou si tu demandes fields=cover.id
    const coverVal = row?.[TRACKS_COVER_FIELD];
    const fileId =
      typeof coverVal === "string"
        ? coverVal
        : (coverVal?.id ? String(coverVal.id) : "");

    if (fileId) coverUrl = directusAssetUrl(fileId);
  } catch {
    coverUrl = "";
  }

  __coverCache.set(track_key, { url: coverUrl, exp: now + 30 * 60 * 1000 }); // 30 min
  (globalThis as any).__coverCache = __coverCache;
  return coverUrl;
}

/* -------------------- iTunes cover (fallback optionnel, sans upload) -------------------- */

const __itunesCache: Map<string, { url: string; exp: number }> =
  ((globalThis as any).__itunesCache as Map<string, { url: string; exp: number }>) || new Map();

async function fetchItunesCover(artist: string, title: string): Promise<string> {
  if (!ENABLE_ITUNES_FALLBACK) return "";
  if (!artist || !title) return "";

  const key = normKey(artist, title);
  const now = Date.now();
  const hit = __itunesCache.get(key);
  if (hit && hit.exp > now) return hit.url;

  let cover = "";
  try {
    let term = `${artist} ${title}`;
    let url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`;
    let r = await fetch(url, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const art = j?.results?.[0]?.artworkUrl100;
      if (art) cover = art.replace(/100x100bb\.jpg$/i, "600x600bb.jpg");
    }

    if (!cover) {
      const cleanTitle = stripMixSuffix(title);
      if (cleanTitle && cleanTitle !== title) {
        term = `${artist} ${cleanTitle}`;
        url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`;
        r = await fetch(url, { cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          const art = j?.results?.[0]?.artworkUrl100;
          if (art) cover = art.replace(/100x100bb\.jpg$/i, "600x600bb.jpg");
        }
      }
    }
  } catch {}

  __itunesCache.set(key, { url: cover, exp: now + 6 * 60 * 60 * 1000 });
  (globalThis as any).__itunesCache = __itunesCache;
  return cover;
}

/* -------------------- API -------------------- */

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || "12")));

    // 1) Icecast → now playing
    const ice = await fetch(ICECAST_STATUS_URL, { cache: "no-store" });
    if (!ice.ok) throw new Error(`Icecast failed: ${ice.status}`);
    const iceJson = await ice.json();
    const nowText = cleanNowText(extractNowPlaying(iceJson));
    const { artist, title } = splitTrack(nowText);
    const track_key = normKey(artist, title);

    const played_at = new Date().toISOString();
    const played_at_ms = Date.parse(played_at);

    // 2) Vérifier dernier en base + insert si changement
    const lastRes = await directusFetch(
      `/items/${PLAYS_COLLECTION}?fields=track_key&sort=-played_at&limit=1`
    );
    const lastJson = await lastRes.json();
    const last = lastJson?.data?.[0];

    let inserted = false;
    if (!last || last.track_key !== track_key) {
      await directusFetch(`/items/${PLAYS_COLLECTION}`, {
        method: "POST",
        body: JSON.stringify({
          track_key,
          artist: artist || null,
          title: title || null,
          played_at,
          raw: nowText || null,

          // IMPORTANT: on n'upload rien. On ne met pas de cover ici.
          // La cover sera résolue "à la lecture" via tracks, et/ou backfill via endpoint dédié.
        }),
        headers: { "Content-Type": "application/json" },
      });
      inserted = true;
    }

    // 3) Historique → EXCLURE le titre actuel pour éviter le doublon
    const params = new URLSearchParams({
      fields: `id,track_key,artist,title,played_at,raw,${PLAYS_COVER_FIELD},${PLAYS_COVER_URL_FIELD}`,
      sort: "-played_at",
      limit: limit.toString(),
      "filter[track_key][_neq]": track_key,
    });

    const histRes = await directusFetch(`/items/${PLAYS_COLLECTION}?${params.toString()}`);
    const histJson = await histRes.json();
    const historyRaw = histJson?.data || [];

    // 4) Resolve covers: priorité à plays.cover_url / plays.cover, sinon tracks.cover, sinon iTunes (optionnel)
    const history = await Promise.all(
      historyRaw.map(async (row: any) => {
        const a = String(row.artist || "");
        const t = String(row.title || "");
        const tk = String(row.track_key || "");

        // plays.cover_url (string) → top priority
        let cover_url = row?.[PLAYS_COVER_URL_FIELD] ? String(row[PLAYS_COVER_URL_FIELD]) : "";

        // plays.cover (file id) → second
        if (!cover_url) {
          const playCoverVal = row?.[PLAYS_COVER_FIELD];
          const playFileId =
            typeof playCoverVal === "string" ? playCoverVal : (playCoverVal?.id ? String(playCoverVal.id) : "");
          if (playFileId) cover_url = directusAssetUrl(playFileId);
        }

        // tracks.cover via track_key → third
        if (!cover_url && tk) {
          cover_url = await fetchDirectusCoverByTrackKey(tk);
        }

        // iTunes fallback (optionnel)
        if (!cover_url) {
          cover_url = await fetchItunesCover(a, t);
        }

        return {
          id: row.id,
          raw: row.raw,
          artist: a,
          title: t,
          track_key: tk,
          played_at: row.played_at,
          played_at_ms: toUTCms(row.played_at),
          cover_url,
        };
      })
    );

    // Now cover (même logique)
    let nowCover = await fetchDirectusCoverByTrackKey(track_key);
    if (!nowCover) nowCover = await fetchItunesCover(artist, title);

    return new Response(
      JSON.stringify({
        ok: true,
        inserted,
        now: {
          raw: nowText,
          artist,
          title,
          track_key,
          played_at,
          played_at_ms,
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
    return new Response(JSON.stringify({ ok: false, error: e?.message || "Server error" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
};