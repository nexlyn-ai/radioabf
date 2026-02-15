// src/pages/api/nowplaying.ts
import type { APIRoute } from "astro";

export const prerender = false;

const ICECAST_STATUS_URL =
  import.meta.env.ICECAST_STATUS_URL || process.env.ICECAST_STATUS_URL || "";

const DIRECTUS_URL =
  import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";

const DIRECTUS_TOKEN =
  import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || "";

// 🔎 Debug forcé
const DEBUG = true;

// ⚠️ Si ta collection n’a pas exactement ce "key", change ici
const PLAYS_COLLECTION = "plays";

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

async function directusFetch(path: string, init: RequestInit = {}) {
  const url = `${DIRECTUS_URL}${path}`;
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${DIRECTUS_TOKEN}`);
  return fetch(url, { ...init, headers });
}

async function readJsonSafe(res: Response) {
  const txt = await res.text().catch(() => "");
  try { return { json: JSON.parse(txt), text: txt }; } catch { return { json: null, text: txt }; }
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(30, Number(url.searchParams.get("limit") || "12")));

  if (!ICECAST_STATUS_URL) {
    return new Response(JSON.stringify({ ok: false, error: "ICECAST_STATUS_URL missing" }), {
      status: 500, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "DIRECTUS_URL/DIRECTUS_TOKEN missing" }), {
      status: 500, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // 1) Icecast
  let nowText = "";
  try {
    const r = await fetch(ICECAST_STATUS_URL, { cache: "no-store" });
    if (!r.ok) {
      return new Response(JSON.stringify({ ok: false, error: `Upstream HTTP ${r.status}` }), {
        status: 502, headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    const json = await r.json().catch(() => ({}));
    nowText = cleanNowText(extractNowPlaying(json));
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "Icecast fetch failed" }), {
      status: 500, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const { artist, title } = splitTrack(nowText);
  const track_key = normKey(artist, title);
  const played_at = new Date().toISOString();

  const directus: any = {};

  // 2) Get last
  const lastRes = await directusFetch(
    `/items/${PLAYS_COLLECTION}?fields=track_key,played_at&sort=-played_at&limit=1`,
    { method: "GET" }
  );
  const lastBody = await readJsonSafe(lastRes);
  directus.last = { ok: lastRes.ok, status: lastRes.status, body: lastBody.json || lastBody.text };
  const lastKey = String(lastBody.json?.data?.[0]?.track_key || "");

  // 3) Insert if changed
  if (artist && track_key && artist.toLowerCase() !== "undefined") {
    if (!lastKey || lastKey !== track_key) {
      const insRes = await directusFetch(`/items/${PLAYS_COLLECTION}`, {
        method: "POST",
        body: JSON.stringify({ track_key, artist, title, played_at, raw: nowText, source: "icecast" }),
      });
      const insBody = await readJsonSafe(insRes);
      directus.insert = { ok: insRes.ok, status: insRes.status, body: insBody.json || insBody.text };
    } else {
      directus.insert = { ok: true, skipped: true };
    }
  } else {
    directus.insert = { ok: false, skipped: true, reason: "bad artist/title" };
  }

  // 4) Read history
  const histRes = await directusFetch(
    `/items/${PLAYS_COLLECTION}?fields=track_key,artist,title,played_at,raw&sort=-played_at&limit=${limit}`,
    { method: "GET" }
  );
  const histBody = await readJsonSafe(histRes);
  const history = Array.isArray(histBody.json?.data) ? histB
