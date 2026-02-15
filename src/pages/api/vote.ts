// src/pages/api/vote.ts
import type { APIRoute } from "astro";

export const prerender = false;

const DIRECTUS_URL =
  import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";

const TOKEN =
  import.meta.env.DIRECTUS_VOTES_TOKEN || process.env.DIRECTUS_VOTES_TOKEN || "";

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

function bad(status: number, message: string, extra?: Record<string, any>) {
  return json({ ok: false, error: message, ...(extra || {}) }, status);
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

// --- ISO week id: "YYYY-W07"
function isoWeekId(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function pickWeek(input?: string | null) {
  const w = String(input || "").trim();
  return w || isoWeekId();
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Simple deterministic IP hash (NOT cryptographic)
async function ipHash(ip: string) {
  const enc = new TextEncoder().encode(ip || "0.0.0.0");
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function getClientIp(request: Request) {
  const xff = request.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "0.0.0.0";
}

// -------- GET /api/vote?week=YYYY-WNN --------
export const GET: APIRoute = async ({ url }) => {
  try {
    const week = pickWeek(url.searchParams.get("week"));
    const fields = ["week", "track_key", "count"].join(",");

    const res = await dFetch(
      `/items/${COLLECTION}?fields=${encodeURIComponent(fields)}&filter[week][_eq]=${encodeURIComponent(
        week
      )}&limit=2000`
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return bad(res.status, `Directus GET failed: ${txt}`);
    }

    const data = (await res.json()) as { data?: any[] };
    const rows = Array.isArray(data?.data) ? data.data : [];

    const map = new Map<string, number>();
    for (const r of rows) {
      const k = String(r.track_key || "").trim();
      if (!k) continue;
      const c = Number(r.count ?? 1) || 1;
      map.set(k, (map.get(k) || 0) + c);
    }

    const top = Array.from(map.entries())
      .map(([track_key, count]) => ({ track_key, count }))
      .sort((a, b) => b.count - a.count);

    return json({ ok: true, week, top });
  } catch (e: any) {
    return bad(500, e?.message || "Server error");
  }
};

// -------- POST /api/vote --------
// Body: { week?, track_key }
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => null);

    const week = pickWeek(body?.week);
    const track_key = String(body?.track_key || "").trim();
    if (!track_key) return bad(400, "Missing track_key");

    // 1 vote / day / IP / week / track_key
    const ip = getClientIp(request);
    const iph = await ipHash(ip);
    const vote_day = todayISO();

    // ✅ FIX: include track_key in dedupe check (per-track cooldown)
    const checkFields = ["id"].join(",");
    const checkRes = await dFetch(
      `/items/${COLLECTION}?fields=${encodeURIComponent(checkFields)}`
        + `&filter[week][_eq]=${encodeURIComponent(week)}`
        + `&filter[vote_day][_eq]=${encodeURIComponent(vote_day)}`
        + `&filter[ip_hash][_eq]=${encodeURIComponent(iph)}`
        + `&filter[track_key][_eq]=${encodeURIComponent(track_key)}`
        + `&limit=1`
    );

    if (!checkRes.ok) {
      const txt = await checkRes.text().catch(() => "");
      return bad(checkRes.status, `Directus check failed: ${txt}`);
    }

    const checkJson = (await checkRes.json().catch(() => ({}))) as any;
    const already = Array.isArray(checkJson?.data) && checkJson.data.length > 0;

    if (already) {
      // ✅ Better semantics than 429
      return bad(409, "Already voted for this track today.", { reason: "cooldown" });
    }

    const res = await dFetch(`/items/${COLLECTION}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        week,
        track_key,
        ip_hash: iph,
        vote_day,
        count: 1,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return bad(res.status, `Directus POST failed: ${txt}`);
    }

    return json({ ok: true, week });
  } catch (e: any) {
    return bad(500, e?.message || "Server error");
  }
};
