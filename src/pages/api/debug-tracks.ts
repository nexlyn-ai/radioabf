// src/pages/api/debug-tracks.ts
import type { APIRoute } from "astro";
export const prerender = false;

const DIRECTUS_URL = import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";
const TOKEN = import.meta.env.DIRECTUS_VOTES_TOKEN || process.env.DIRECTUS_VOTES_TOKEN || "";

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function assertEnv() {
  if (!DIRECTUS_URL) throw new Error("DIRECTUS_URL missing");
  if (!TOKEN) throw new Error("DIRECTUS_VOTES_TOKEN missing");
}

function dUrl(path: string) {
  return `${DIRECTUS_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function call(path: string) {
  assertEnv();
  const res = await fetch(dUrl(path), {
    headers: { Accept: "application/json", Authorization: `Bearer ${TOKEN}` },
  });
  const text = await res.text().catch(() => "");
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, body };
}

export const GET: APIRoute = async ({ url }) => {
  try {
    const q = String(url.searchParams.get("q") || "blue 6 - sweeter love (sax mix)").trim();

    const list = await call(`/items/tracks?limit=1&fields=id,track_key,cover_art`);
    const eq = await call(`/items/tracks?limit=5&fields=id,track_key,cover_art&filter[track_key][_eq]=${encodeURIComponent(q)}`);

    return json({ ok: true, q, list, eq });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || "Server error" }, 500);
  }
};