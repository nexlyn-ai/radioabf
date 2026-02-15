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

// --- ISO week id: "YYYY-W07"
function isoWeekId(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function pickWeek(input?: string | null) {
  const w = String(input || "").trim();
  return w || isoWeekId();
}

function todayISO() {
  // format YYYY-MM-DD
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Normalize track_key so we don't store duplicates with different casing/spaces/quotes
function normTrackKey(k: string) {
  return String(k || "")
    .trim()
    .toLowerCase()
    .replace(/\u00A0/g, " ") // nbsp -> space
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, "")
    .trim();
}

// Simple deterministic IP hash without external deps (NOT cryptographic)
// Good enough for rate limiting / dedupe.
async function ipHash(ip: string) {
  const enc = new TextEncoder().encode(ip || "0.0.0.0");
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function getClientIp(request: Request) {
  // Vercel / proxies
  const xff = request.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "0.0.0.0";
}

// -------- GET /api/vote?week=YYYY-WNN (week optional) --------
export const GET: APIRoute = async ({ url }) => {
  try {
    const week = pickWeek(url.searchParams.get("week"));
    // Align with your schema: week, track_key, count
    const fields = ["week", "track_key", "count"].join(",");
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
    // Sum counts per NORMALIZED track_key (prevents duplicates in top)
    // Keep one "display" track_key (first seen raw) so the front can still show a readable key.
    const map = new Map<string, { track_key: string; count: number }>();
    for (const r of rows) {
      const raw = String(r?.track_key || "").trim();
      if (!raw) continue;
      const nk = normTrackKey(raw);
      if (!nk) continue;
      const c = Number(r?.count ?? 1) || 1;
      const prev = map.get(nk);
      if (!prev) map.set(nk, { track_key: raw, count: c });
      else prev.count += c;
    }
    const top = Array.from(map.values()).sort((a, b) => b.count - a.count);
    return json({ ok: true, week, top });
  } catch (e: any) {
    return bad(500, e?.message || "Server error");
  }
};

// -------- POST /api/vote (week optional) --------
// Body: { week?, track_key, artist?, title? }
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => null);
    const week = pickWeek(body?.week);
    const track_key_raw = String(body?.track_key || "").trim();
    if (!track_key_raw) return bad(400, "Missing track_key");

    // Normaliser avant stockage/vérification
    const track_key = normTrackKey(track_key_raw);
    if (!track_key) return bad(400, "Invalid track_key");

    // Rate limiting : 1 vote par piste par jour par IP
    const ip = getClientIp(request);
    const iph = await ipHash(ip);
    const vote_day = todayISO();

    // Vérification d'un vote existant pour cette IP + jour + semaine + piste
    const checkFields = ["id"].join(",");
    const checkRes = await dFetch(
      `/items/${COLLECTION}?fields=${encodeURIComponent(checkFields)}` +
        `&filter[week][_eq]=${encodeURIComponent(week)}` +
        `&filter[vote_day][_eq]=${encodeURIComponent(vote_day)}` +
        `&filter[ip_hash][_eq]=${encodeURIComponent(iph)}` +
        `&filter[track_key][_eq]=${encodeURIComponent(track_key)}` + // ← Filtre ajouté
        `&limit=1`
    );

    if (!checkRes.ok) {
      const txt = await checkRes.text().catch(() => "");
      return bad(checkRes.status, `Directus check failed: ${txt}`);
    }

    const checkJson = (await checkRes.json().catch(() => ({}))) as any;
    const already = Array.isArray(checkJson?.data) && checkJson.data.length > 0;

    if (already) {
      return json(
        {
          ok: false,
          error: "You already voted for this track today.",
          reason: "cooldown",
        },
        409
      );
    }

    // Insertion du vote
    const res = await dFetch(`/items/${COLLECTION}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        week,
        track_key, // stocké normalisé
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