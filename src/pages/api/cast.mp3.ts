import type { APIRoute } from "astro";

/**
 * Cast-safe proxy for Icecast/MP3 streams:
 * - requests no ICY metadata
 * - forces audio/mpeg
 * - strips icy headers
 * - no cache
 */
export const GET: APIRoute = async ({ url }) => {
  const q = (url.searchParams.get("q") || "hd").toLowerCase();

  // ✅ choisis UNIQUEMENT des URLs MP3 ici (pas AAC, pas FLAC pour Default Receiver)
  const UPSTREAM =
    q === "sd"
      ? "https://stream.radioabf.com/abf-sd.mp3"
      : "https://stream.radioabf.com/abf-hd.mp3";

  // Important: demander au serveur de NE PAS envoyer d'ICY metadata
  const upstreamResp = await fetch(UPSTREAM, {
    headers: {
      "Icy-MetaData": "0",
      "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
      "User-Agent": "RadioABF-CastProxy/1.0"
    },
    // pas de cache côté fetch
    cache: "no-store"
  });

  if (!upstreamResp.ok || !upstreamResp.body) {
    return new Response("Upstream stream unavailable", { status: 502 });
  }

  // Copie headers utiles, mais on nettoie ce qui peut perturber Cast
  const headers = new Headers();

  headers.set("Content-Type", "audio/mpeg");
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");

  // Optionnel mais safe: empêcher certains “range” bizarres
  headers.set("Accept-Ranges", "none");

  // Laisser passer certaines infos si présentes
  const br = upstreamResp.headers.get("icy-br");
  if (br) headers.set("icy-br", br);

  // ⚠️ on NE retransmet PAS icy-metaint / icy-name / icy-genre etc. (parfois ça casse)
  // Si tu veux, on pourra les remettre plus tard une fois que ça joue.

  return new Response(upstreamResp.body, {
    status: 200,
    headers
  });
};