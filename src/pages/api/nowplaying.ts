// src/pages/api/nowplaying.ts
import type { APIRoute } from "astro";

export const prerender = false;

const ICECAST_STATUS_URL = import.meta.env.ICECAST_STATUS_URL || process.env.ICECAST_STATUS_URL || "";
const DIRECTUS_URL = import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";
const DIRECTUS_TOKEN = import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || "";
const PLAYS_COLLECTION = "plays";

/* -------------------- Helpers (inchangés) -------------------- */

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
  try {
    const res = await fetch(fullUrl, {
      ...init,
      headers: {
        Authorization: `Bearer ${DIRECTUS_TOKEN}`,
        Accept: "application/json",
        ...(init.headers || {}),
      },
    });
    return res;
  } catch (err) {
    throw new Error(`Directus fetch failed for ${fullUrl}: ${err}`);
  }
}

async function fetchItunesCover(artist: string, title: string): Promise<string> {
  const key = normKey(artist, title);
  const now = Date.now();
  const hit = (globalThis as any).__itunesCache?.get(key);
  if (hit && hit.exp > now) return hit.url;

  let cover = "";
  try {
    const term = `${artist} ${title}`;
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`;
    const r = await fetch(url, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const art100 = j?.results?.[0]?.artworkUrl100;
      if (art100) cover = art100.replace(/100x100bb\.jpg$/i, "600x600bb.jpg");
    }
    if (!cover) {
      const cleanTitle = stripMixSuffix(title);
      if (cleanTitle && cleanTitle !== title) {
        const url2 = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${cleanTitle}`)}&entity=song&limit=1`;
        const r2 = await fetch(url2, { cache: "no-store" });
        if (r2.ok) {
          const j2 = await r2.json();
          const art100 = j2?.results?.[0]?.artworkUrl100;
          if (art100) cover = art100.replace(/100x100bb\.jpg$/i, "600x600bb.jpg");
        }
      }
    }
  } catch {}

  const cache = (globalThis as any).__itunesCache || new Map();
  cache.set(key, { url: cover, exp: now + 6 * 60 * 60 * 1000 });
  (globalThis as any).__itunesCache = cache;

  return cover;
}

/* -------------------- API -------------------- */

export const GET: APIRoute = async ({ request }) => {
  const debug: Record<string, any> = { steps: [] };

  try {
    const url = new URL(request.url);
    const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || "12")));

    // 1. Icecast
    debug.steps.push("fetch_icecast");
    const ice = await fetch(ICECAST_STATUS_URL, { cache: "no-store" });
    if (!ice.ok) throw new Error(`Icecast status ${ice.status}`);
    const iceJson = await ice.json();
    const nowText = cleanNowText(extractNowPlaying(iceJson));
    const { artist, title } = splitTrack(nowText);
    const track_key = normKey(artist, title);
    const played_at = new Date().toISOString();
    const played_at_ms = Date.parse(played_at);

    debug.now = { raw: nowText, artist, title, track_key, played_at };

    // 2. Dernier play en base
    debug.steps.push("fetch_last_play");
    const lastRes = await directusFetch(
      `/items/${PLAYS_COLLECTION}?fields=track_key&sort=-played_at&limit=1`
    );
    if (!lastRes.ok) {
      debug.last_fetch_error = `${lastRes.status} ${lastRes.statusText}`;
      throw new Error(`Last play fetch failed: ${lastRes.status}`);
    }
    const lastJson = await lastRes.json();
    const last = lastJson?.data?.[0];
    debug.last_in_db = last || null;

    let inserted = false;
    let insertError = null;

    if (!last || last.track_key !== track_key) {
      debug.steps.push("attempt_insert");
      try {
        const createRes = await directusFetch(`/items/${PLAYS_COLLECTION}`, {
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

        if (!createRes.ok) {
          let errBody = "";
          try { errBody = await createRes.text(); } catch {}
          insertError = `${createRes.status} - ${errBody || createRes.statusText}`;
          throw new Error(`Insert failed: ${insertError}`);
        }

        inserted = true;
        debug.inserted = true;
      } catch (insErr) {
        insertError = insErr.message;
        debug.insert_error = insertError;
      }
    } else {
      debug.steps.push("skip_insert_same_track");
    }

    // 3. Historique
    debug.steps.push("fetch_history");
    const histRes = await directusFetch(
      `/items/${PLAYS_COLLECTION}?fields=id,track_key,artist,title,played_at,raw&sort=-played_at&limit=${limit}`
    );
    if (!histRes.ok) throw new Error(`History fetch ${histRes.status}`);
    const histJson = await histRes.json();
    const historyRaw = histJson?.data || [];

    const history = await Promise.all(
      historyRaw.map(async (row: any) => {
        const a = String(row.artist || "");
        const t = String(row.title || "");
        const cover = await fetchItunesCover(a, t);
        return {
          id: row.id,
          raw: row.raw,
          artist: a,
          title: t,
          track_key: row.track_key,
          played_at: row.played_at,
          played_at_ms: toUTCms(row.played_at),
          cover_url: cover,
        };
      })
    );

    const nowCover = await fetchItunesCover(artist, title);

    return new Response(
      JSON.stringify({
        ok: true,
        debug,           // ← regarde ça dans la réponse JSON !
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
          "cache-control": "no-cache", // ← temporaire pour debug
        },
      }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: e?.message || "Server error",
        debug,
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
};