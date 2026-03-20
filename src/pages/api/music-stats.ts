import type { APIRoute } from "astro";

export const prerender = false;

const DIRECTUS_URL =
  import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";

const DIRECTUS_TOKEN =
  import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || "";

const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";
const FETCH_TIMEOUT_MS = 8000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": CACHE_CONTROL,
    },
  });
}

function assertEnv() {
  if (!DIRECTUS_URL) throw new Error("Missing DIRECTUS_URL");
  if (!DIRECTUS_TOKEN) throw new Error("Missing DIRECTUS_TOKEN");
}

async function directusFetch(path: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${DIRECTUS_URL}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${DIRECTUS_TOKEN}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Directus failed: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error("Directus request timed out");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function readAggregateCount(payload: any): number {
  const row = Array.isArray(payload?.data)
    ? payload.data[0] || {}
    : payload?.data || {};

  const raw =
    row?.count ??
    row?.["count"] ??
    row?.["count(*)"] ??
    row?.["count_all"] ??
    0;

  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export const GET: APIRoute = async () => {
  try {
    assertEnv();

    const [tracksJson, playsJson] = await Promise.all([
      directusFetch(`/items/tracks?aggregate[count]=*`),
      directusFetch(`/items/plays?aggregate[count]=*`),
    ]);

    const tracks = readAggregateCount(tracksJson);
    const airplays = readAggregateCount(playsJson);

    return json({
      ok: true,
      tracks,
      airplays,
    });
  } catch (e: any) {
    return json(
      {
        ok: false,
        tracks: 0,
        airplays: 0,
        error: e?.message || "Server error",
      },
      500
    );
  }
};