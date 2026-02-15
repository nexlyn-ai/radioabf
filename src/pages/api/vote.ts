// src/pages/api/vote.ts
export const prerender = false;

const DIRECTUS_URL =
  import.meta.env.DIRECTUS_URL || import.meta.env.PUBLIC_DIRECTUS_URL;

const TOKEN = import.meta.env.DIRECTUS_VOTES_TOKEN;

// ⚠️ nom de ta collection Directus
const COLLECTION = "votes";

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function bad(status: number, message: string) {
  return json({ ok: false, error: message }, status);
}

function assertEnv() {
  if (!DIRECTUS_URL) throw new Error("DIRECTUS_URL is missing");
  if (!TOKEN) throw new Error("DIRECTUS_VOTES_TOKEN is missing");
}

function dUrl(path: string) {
  return `${DIRECTUS_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function dFetch(path: string, init?: RequestInit) {
  assertEnv();
  const res = await fetch(dUrl(path), {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(init?.headers || {}),
    },
  });
  return res;
}

// -------- GET /api/vote?week=2026-W07 --------
// Returns aggregated votes per track_key for a week
export async function GET({ url }: { url: URL }) {
  try {
    const week = (url.searchParams.get("week") || "").trim();
    if (!week) return bad(400, "Missing week");

    // We fetch items and aggregate in API (simple + works without DB views)
    // Fields expected: week, track_key, artist, title, created_at (optional)
    const fields = ["week", "track_key", "artist", "title"].join(",");

    const res = await dFetch(
      `/items/${COLLECTION}?fields=${encodeURIComponent(
        fields
      )}&filter[week][_eq]=${encodeURIComponent(week)}&limit=2000`
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return bad(res.status, `Directus GET failed: ${txt}`);
    }

    const data = (await res.json()) as { data?: any[] };
    const rows = Array.isArray(data?.data) ? data.data : [];

    // aggregate by track_key
    const map = new Map<
      string,
      { track_key: string; artist: string; title: string; count: number }
    >();

    for (const r of rows) {
      const k = String(r.track_key || "").trim();
      if (!k) continue;
      const cur = map.get(k);
      if (cur) cur.count += 1;
      else
        map.set(k, {
          track_key: k,
          artist: String(r.artist || "").trim(),
          title: String(r.title || "").trim(),
          count: 1,
        });
    }

    const top = Array.from(map.values()).sort((a, b) => b.count - a.count);

    return json({ ok: true, week, top });
  } catch (e: any) {
    return bad(500, e?.message || "Server error");
  }
}

// -------- POST /api/vote --------
// Body: { week, track_key, artist, title }
export async function POST({ request }: { request: Request }) {
  try {
    const body = await request.json().catch(() => null);
    const week = String(body?.week || "").trim();
    const track_key = String(body?.track_key || "").trim();
    const artist = String(body?.artist || "").trim();
    const title = String(body?.title || "").trim();

    if (!week) return bad(400, "Missing week");
    if (!track_key) return bad(400, "Missing track_key");

    // Create a vote row
    const res = await dFetch(`/items/${COLLECTION}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        week,
        track_key,
        artist,
        title,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return bad(res.status, `Directus POST failed: ${txt}`);
    }

    return json({ ok: true });
  } catch (e: any) {
    return bad(500, e?.message || "Server error");
  }
}
