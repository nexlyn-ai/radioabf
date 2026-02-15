// src/pages/api/nowplaying.ts
import type { APIRoute } from "astro";

export const prerender = false;

const ICECAST_STATUS_URL =
  import.meta.env.ICECAST_STATUS_URL || process.env.ICECAST_STATUS_URL || "";

const DIRECTUS_URL =
  import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";

const DIRECTUS_TOKEN =
  import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || "";

function cleanNowText(s: string) {
  let out = String(s || "").trim();

  // cas fréquent: "undefined - Artist - Title"
  out = out.replace(/^undefined\s*-\s*/i, "");

  // parfois: "Artist — Title"
  out = out.replace(/\s+—\s+/g, " - ");

  return out.trim();
}

function splitTrack(entry: string) {
  const cleaned = cleanNowText(entry);

  // split sur le PREMIER " - " uniquement
  const idx = cleaned.indexOf(" - ");
  if (idx === -1) return { artist: cleaned.trim(), title: "" };

  const artist = cleaned.slice(0, idx).trim();
  const title = cleaned.slice(idx + 3).trim();
  return { artist, title };
}

function normKey(artist: string, title: string) {
  return (artist + " - " + title)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, "")
    .trim();
}

// Icecast status-json.xsl varie selon config : on tente plusieurs champs
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

async function directusFetch(path: string, init: RequestInit = {}) {
  const url = `${DIRECTUS_URL}${path}`;
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${DIRECTUS_TOKEN}`);
  return fetch(url, { ...init, headers });
}

async function getLastPlay(): Promise<{ track_key?: string } | null> {
  const r = await directusFetch(
    `/items/plays?fields=track_key,played_at&sort=-played_at&limit=1`,
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
}) {
  // on force status published si tu as un champ status Directus
  await directusFetch(`/items/plays`, {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      status: "published",
    }),
  });
}

async function getHistory(limit: number) {
  const r = await directusFetch(
    `/items/plays?fields=track_key,artist,title,played_at,raw&sort=-played_at&limit=${limit}`,
    { method: "GET" }
  );
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j?.data) ? j.data : [];
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

  // 1) fetch icecast now playing
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
  const played_at = new Date().toISOString();

  // 2) insert in Directus if changed (anti-doublon)
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
        });
      }
    } catch {
      // ne bloque pas la réponse si l'insert rate
    }
  }

  // 3) read history from Directus
  const history = await getHistory(limit);

  return new Response(
    JSON.stringify({
      ok: true,
      now: {
        raw: nowText,
        artist,
        title,
        track_key,
        played_at,
      },
      history,
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "s-maxage=5, stale-while-revalidate=25",
      },
    }
  );
};
