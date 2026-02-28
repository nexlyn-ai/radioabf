// src/pages/api/nowplaying.ts
import type { APIRoute } from "astro";

export const prerender = false;

const ICECAST_STATUS_URL =
  import.meta.env.ICECAST_STATUS_URL || process.env.ICECAST_STATUS_URL || "";
const DIRECTUS_URL = import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";
const DIRECTUS_TOKEN =
  import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || "";

const PLAYS_COLLECTION = "plays";
const TRACKS_COLLECTION = "tracks";

// ✅ ton schéma Directus
const TRACKS_KEY_FIELD = "track_key";
const TRACKS_COVER_FIELD = "cover_art";

// ✅ iTunes fallback ON (uniquement si pas de cover Directus)
const ENABLE_ITUNES_FALLBACK =
  (import.meta.env.ENABLE_ITUNES_FALLBACK || process.env.ENABLE_ITUNES_FALLBACK || "true") === "true";

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
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${DIRECTUS_TOKEN}`,
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `Directus ${path} failed: ${res.status} ${res.statusText}${txt ? ` — ${txt}` : ""}`
    );
  }
  return res;
}

function directusAssetUrl(fileId: string) {
  return fileId ? `${DIRECTUS_URL}/assets/${fileId}` : "";
}

/* -------------------- Cover lookup (tracks.cover_art) -------------------- */

const __coverCache: Map<string, { url: string; exp: number }> =
  ((globalThis as any).__coverCache as Map<string, { url: string; exp: number }>) || new Map();

async function fetchDirectusCoverByTrackKey(track_key: string): Promise<string> {
  if (!track_key) return "";

  const now = Date.now();
  const hit = __coverCache.get(track_key);
  if (hit && hit.exp > now) return hit.url;

  let coverUrl = "";

  try {
    const params = new URLSearchParams({
      // ✅ robuste: cover_art peut être string (id) OU objet { id }
      fields: `${TRACKS_COVER_FIELD},${TRACKS_COVER_FIELD}.id`,
      limit: "1",
      [`filter[${TRACKS_KEY_FIELD}][_eq]`]: track_key,
    });

    const r = await directusFetch(`/items/${TRACKS_COLLECTION}?${params.toString()}`);
    const j = await r.json();
    const row = j?.data?.[0];

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

/* -------------------- iTunes cover (fallback) -------------------- */

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
    // try exact
    let term = `${artist} ${title}`;
    let url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`;
    let r = await fetch(url, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const art = j?.results?.[0]?.artworkUrl100;
      if (art) cover = art.replace(/100x100bb\.jpg$/i, "600x600bb.jpg");
    }

    // try cleaned title
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

  __itunesCache.set(key, { url: cover, exp: now + 6 * 60 * 60 * 1000 }); // 6h
  (globalThis as any).__itunesCache = __itunesCache;
  return cover;
}

/* -------------------- API -------------------- */

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || "12")));

    // Icecast → now playing
    const ice = await fetch(ICECAST_STATUS_URL, { cache: "no-store" });
    if (!ice.ok) throw new Error(`Icecast failed: ${ice.status}`);
    const iceJson = await ice.json();

    const nowText = cleanNowText(extractNowPlaying(iceJson));
    const { artist, title } = splitTrack(nowText);
    const track_key = normKey(artist, title);

    const played_at = new Date().toISOString();
    const played_at_ms = Date.parse(played_at);

    // Vérifier dernier en base + insert si changement
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
        }),
        headers: { "Content-Type": "application/json" },
      });
      inserted = true;
    }

    // Historique → on récupère large puis on dédoublonne proprement côté API
    const params = new URLSearchParams({
      fields: "id,track_key,artist,title,played_at,raw",
      sort: "-played_at",
      limit: String(limit + 20), // ✅ marge pour compenser les doublons
    });

    const histRes = await directusFetch(`/items/${PLAYS_COLLECTION}?${params.toString()}`);
    const histJson = await histRes.json();
    const historyRaw = histJson?.data || [];

    const historyItems = await Promise.all(
      historyRaw.map(async (row: any) => {
        const a = String(row.artist || "");
        const t = String(row.title || "");
        const tk = String(row.track_key || "");
        const raw = String(row.raw || `${a} - ${t}`.trim()).trim();
        const ts = toUTCms(row.played_at);

        // ✅ priorité Directus, fallback iTunes uniquement si vide
        let cover_url = await fetchDirectusCoverByTrackKey(tk);
        let cover_source = cover_url ? "directus" : "";
        if (!cover_url) {
          cover_url = await fetchItunesCover(a, t);
          if (cover_url) cover_source = "itunes";
        }

        return { t: raw, ts, cover_url, cover_source, track_key: tk };
      })
    );

    // ✅ retire seulement l'entrée en cours (une seule fois) puis dédoublonne (track+ts)
    const seen = new Set<string>();
    const history: Array<{ t: string; ts: number; cover_url: string; cover_source: string }> = [];
    for (const it of historyItems) {
      if (!it.t || !it.ts) continue;

      // exclude current NOW once (same track_key and ts within 2 min)
      if (it.track_key === track_key && Math.abs(it.ts - played_at_ms) < 2 * 60 * 1000) continue;

      const key = `${String(it.t).toLowerCase()}__${Number(it.ts)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      history.push({ t: it.t, ts: it.ts, cover_url: it.cover_url, cover_source: it.cover_source });
      if (history.length >= limit) break;
    }

    // Now cover
    let nowCover = await fetchDirectusCoverByTrackKey(track_key);
    let nowCoverSource = nowCover ? "directus" : "";
    if (!nowCover) {
      nowCover = await fetchItunesCover(artist, title);
      if (nowCover) nowCoverSource = "itunes";
    }

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
          cover_source: nowCoverSource,
          // ✅ format front-friendly too
          t: nowText,
          ts: played_at_ms,
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
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
};