import type { APIRoute } from "astro";

export const prerender = false;

const DIRECTUS_URL =
  import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";
const DIRECTUS_TOKEN =
  import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || "";

async function directusFetch(path: string) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${DIRECTUS_TOKEN}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Directus failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

function readAggregateCount(json: any): number {
  const row = json?.data?.[0] || json?.data || {};
  const raw =
    row?.count ||
    row?.["count"] ||
    row?.["count(*)"] ||
    row?.["count_all"] ||
    0;

  return Number(raw || 0);
}

export const GET: APIRoute = async () => {
  try {
    if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
      throw new Error("Missing Directus environment variables");
    }

    const [tracksJson, playsJson] = await Promise.all([
      directusFetch(`/items/tracks?aggregate[count]=*`),
      directusFetch(`/items/plays?aggregate[count]=*`),
    ]);

    const tracks = readAggregateCount(tracksJson);
    const airplays = readAggregateCount(playsJson);

    return new Response(
      JSON.stringify({
        ok: true,
        tracks,
        airplays,
      }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({
        ok: false,
        tracks: 0,
        airplays: 0,
        error: e?.message || "Server error",
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      }
    );
  }
};