// src/pages/api/nowplaying.ts
import type { APIRoute } from "astro";

export const prerender = false;

// ✅ Mets ton URL Icecast status ici en variable d'env (recommandé)
const ICECAST_STATUS_URL =
  import.meta.env.ICECAST_STATUS_URL ||
  process.env.ICECAST_STATUS_URL ||
  ""; // ex: "https://radioabf.com:8000/status-json.xsl"

function splitTrack(entry: string) {
  const parts = String(entry || "").split(" - ");
  const artist = (parts[0] || "").trim();
  const title = (parts.slice(1).join(" - ") || "").trim();
  return { artist, title };
}

function normKey(artist: string, title: string) {
  return (artist + " - " + title)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, "")
    .trim();
}

// Icecast status-json.xsl varie selon les configs : on tente plusieurs chemins
function extractNowPlaying(json: any): string {
  const src = json?.icestats?.source;

  // source peut être un objet OU un tableau
  const s = Array.isArray(src) ? src[0] : src;

  // champs possibles
  return (
    s?.title ||
    s?.yp_currently_playing ||
    s?.artist && s?.title ? `${s.artist} - ${s.title}` : ""
  )?.trim();
}

export const GET: APIRoute = async ({ request }) => {
  if (!ICECAST_STATUS_URL) {
    return new Response(
      JSON.stringify({ ok: false, error: "ICECAST_STATUS_URL missing" }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }

  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(30, Number(url.searchParams.get("limit") || "12")));

  try {
    const r = await fetch(ICECAST_STATUS_URL, {
      // petit cache edge (évite de spam Icecast)
      headers: { "user-agent": "radioabf-nowplaying" },
    });

    if (!r.ok) {
      return new Response(JSON.stringify({ ok: false, error: `Upstream HTTP ${r.status}` }), {
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const json = await r.json();
    const nowText = extractNowPlaying(json) || "";
    const now = nowText ? { t: nowText, ts: Date.now(), ...splitTrack(nowText), key: normKey(...Object.values(splitTrack(nowText)) as any) } : null;

    // ⚠️ Icecast ne donne pas toujours un "history".
    // Donc on renvoie un tableau vide par défaut.
    // (On peut le construire côté app si tu stockes les plays en DB/Directus.)
    const history: Array<{ t: string; ts: number }> = [];

    return new Response(JSON.stringify({ ok: true, now, history: history.slice(0, limit) }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        // micro-cache Vercel (ajuste)
        "cache-control": "s-maxage=5, stale-while-revalidate=25",
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "fetch failed" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
};
