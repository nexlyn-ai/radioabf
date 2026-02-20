import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ request, url }) => {
  const q = (url.searchParams.get("q") || "hd").toLowerCase();
  const upstream =
    q === "sd"
      ? "https://stream.radioabf.com/abf-sd.mp3"
      : "https://stream.radioabf.com/abf-hd.mp3";

  // ⚠️ Chromecast peut envoyer Range; sur live ça peut provoquer des boucles.
  // On ignore Range => flux live continu.
  const headers = new Headers();
  headers.set("Icy-MetaData", "0");
  headers.set("Accept", "audio/mpeg,audio/*;q=0.9,*/*;q=0.8");
  headers.set("Accept-Encoding", "identity"); // pas de gzip/br
  headers.set("User-Agent", "RadioABF-CastProxy/1.0");

  const upstreamResp = await fetch(upstream, {
    method: "GET",
    headers,
    cache: "no-store",
  });

  if (!upstreamResp.ok || !upstreamResp.body) {
    return new Response("Upstream stream unavailable", { status: 502 });
  }

  const out = new Headers();
  out.set("Content-Type", "audio/mpeg");
  out.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  out.set("Pragma", "no-cache");
  out.set("Expires", "0");
  out.set("Access-Control-Allow-Origin", "*");

  // Live: pas de range (Cast aime bien un flux continu)
  out.set("Accept-Ranges", "none");

  return new Response(upstreamResp.body, { status: 200, headers: out });
};