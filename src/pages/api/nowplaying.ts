// src/pages/api/nowplaying.ts
import type { APIRoute } from "astro";

export const prerender = false;

const ICECAST_STATUS_URL =
  import.meta.env.ICECAST_STATUS_URL || process.env.ICECAST_STATUS_URL || "";

const DIRECTUS_URL =
  import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";

const DIRECTUS_TOKEN =
  import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || "";

// 🔎 active le debug via env si tu veux (optionnel)
const DEBUG =
  (import.meta.env.DIRECTUS_DEBUG || process.env.DIRECTUS_DEBUG || "") === "1";

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
  return {
    artist: cleaned.slice(0, idx).trim(),
    title: cleaned.slice(idx + 3).trim(),
  };
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
  return (
    (s?.title && String(s.title)) ||
    (s?.yp_currently_playing && String(s.yp_currently_playing)) ||
    (s?.streamtitle && String(s.streamtitle)) ||
    ""
  ).trim();
}

async function directusFetch(path: string, init: RequestInit = {}) {
  const url = `${DIRECTUS_URL}${path}`;
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${DIRECTUS_TOKEN}`);
  return fetch(url, { ...init, headers });
}

async function getLastPlayDebug() {
  const path =
    `/items/plays?fields=track_key,played_at&sort=-played_at` +
    `&filter[status][_eq]=published&limit=1`;

  const r = await directusFetch(path, { method: "GET" });
  const text = await r.text().catch(() => "");
  let json: any = null;
  try { json = JSON.parse(text); } catch {}

  return {
    ok: r.ok,
    status: r.status,
    body: DEBUG ? (json || text) : undefined,
    last: json?.data?.[0] || null,
  };
}

async function insertPlayDebug(payload: any) {
  const r = await directusFetch(`/items/plays`, {
    method: "POST",
    body: JSON.stringify({ ...payload, status: "published" }),
  });

  const text = await r.text().catch(() => "");
  let json: any = null;
  try { json = JSON.parse(text); } catch {}

  return {
    ok: r.ok,
    status: r.status,
    body: DEBUG ? (json || text) : undefined,
  };
}

async function getHistoryDebug(limit: number) {
  const path =
    `/items/plays?fields=track_key,artist,title,played_at,raw,status&sort=-played_at` +
    `&filter[status][_eq]=published&limit=${limit}`;

  const r = await directusFetch(path, { method: "GET" });
  const text = await r.text().catch(() => "");
  let json: any = null;
  try { json = JSON.parse(text); } catch {}

  return {
    ok: r.ok,
    status: r.status,
    body: DEBUG ? (json || text) : undefined,
    history: Array.isArray(json?.data) ? json.data : [],
  };
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const limit = Math.max(
    1,
    Math.min(30, Number(url.searchParams.get("limit") || "12"))
  );

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

  const directusDebug: any = {};

  // 2) Insert Directus (si track change)
  if (artist && track_key && artist.toLowerCase() !== "undefined") {
    try {
      const lastRes = await getLastPlayDebug();
      directusDebug.last = { ok: lastRes.ok, status: lastRes.status, body: lastRes.body };

      const lastKey = String(lastRes.last?.track_key || "");
      if (!lastKey || lastKey !== track_key) {
        const ins = await insertPlayDebug({
          track_key,
          artist,
          title,
          played_at,
          raw: nowText,
          source: "icecast",
        });
        directusDebug.insert = ins;
      } else {
        directusDebug.insert = { ok: true, skipped: true };
      }
    } catch (e: any) {
      directusDebug.insert = { ok: false, error: e?.message || "insert failed" };
    }
  } else {
    directusDebug.insert = { ok: false, skipped: true, reason: "bad artist/title" };
  }

  // 3) Read history Directus
  let history: any[] = [];
  try {
    const histRes = await getHistoryDebug(limit);
    directusDebug.read = { ok: histRes.ok, status: histRes.status, body: histRes.body };
    history = histRes.history;
  } catch (e: any) {
    directusDebug.read = { ok: false, error: e?.message || "read failed" };
  }

  return new Response(
    JSON.stringify({
      ok: true,
      now: { raw: nowText, artist, title, track_key, played_at },
      history,
      // ✅ visible uniquement si DEBUG=1, sinon ça reste minimal
      ...(DEBUG ? { directus: directusDebug } : {}),
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  );
};
