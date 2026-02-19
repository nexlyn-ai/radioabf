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

// ✅ iTunes OFF (pour être sûr que rien ne vienne d'iTunes)
const ENABLE_ITUNES_FALLBACK = false;

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
    // ✅ robuste: cover_art peut être string (id) OU objet { id }
    const params = new URLSearchParams({
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

/* -------------------- iTunes cover (désactivé) -------------------- */

async function fetchItunesCover(_artist: string, _title: string): Promise<string> {
  if (!ENABLE_ITUNES_FALLBACK) return "";
  // (garde la fonction au cas où tu veux réactiver via env plus tard)
  return "";
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

    // Historique → EXCLURE le titre actuel pour éviter le doublon visuel
    // ✅ IMPORTANT: fields ne demande que des champs existants dans plays
    const params = new URLSearchParams({
      fields: "id,track_key,artist,title,played_at,raw",
      sort: "-played_at",
      limit: limit.toString(),
      "filter[track_key][_neq]": track_key,
    });

    const histRes = await directusFetch(`/items/${PLAYS_COLLECTION}?${params.toString()}`);
    const histJson = await histRes.json();
    const historyRaw = histJson?.data || [];

    const history = await Promise.all(
      historyRaw.map(async (row: any) => {
        const a = String(row.artist || "");
        const t = String(row.title || "");
        const tk = String(row.track_key || "");

        // ✅ 100% Directus via tracks.cover_art
        let cover_url = await fetchDirectusCoverByTrackKey(tk);

        // (fallback iTunes désactivé)
        if (!cover_url) cover_url = await fetchItunesCover(a, t);

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

    // Now cover
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
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
};