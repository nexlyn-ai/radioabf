// src/pages/api/vote.ts
import type { APIRoute } from "astro";

export const prerender = false;

const DIRECTUS_URL =
  import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";

const TOKEN =
  import.meta.env.DIRECTUS_VOTES_TOKEN || process.env.DIRECTUS_VOTES_TOKEN || "";

const COLLECTION = "votes";
const TRACKS_COLLECTION = "tracks";

// ----------------------
// Response helpers
// ----------------------
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

// ----------------------
// Week helpers
// ----------------------
// ISO week id: "YYYY-W07"
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

function splitFromTrackKey(track_key: string) {
  const s = String(track_key || "").trim();
  const idx = s.indexOf(" - ");
  if (idx === -1) return { artist: s, title: "" };
  return {
    artist: s.slice(0, idx).trim(),
    title: s.slice(idx + 3).trim(),
  };
}

// ----------------------
// Simple deterministic IP hash (NOT cryptographic)
// ----------------------
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

// ----------------------
// Cover resolution
// ----------------------
function fileUrl(fileId?: string | null) {
  if (!fileId) return "";
  // Directus assets endpoint
  return `${DIRECTUS_URL}/assets/${fileId}`;
}

// iTunes micro-cache (memory)
type ItunesCacheEntry = { url: string; exp: number };
const ITUNES_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const itunesMemCache: Map<string, ItunesCacheEntry> =
  (globalThis as any).__abfItunesVoteCache || new Map();
(globalThis as any).__abfItunesVoteCache = itunesMemCache;

async function fetchItunesCover(artist: string, title: string): Promise<string> {
  const key = normTrackKey(`${artist} - ${title}`);
  const now = Date.now();
  const hit = itunesMemCache.get(key);
  if (hit && hit.exp > now) return hit.url || "";

  const term = encodeURIComponent(`${artist} ${title}`.trim());
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`;

  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) {
      itunesMemCache.set(key, { url: "", exp: now + ITUNES_CACHE_TTL_MS });
      return "";
    }
    const j = await r.json().catch(() => ({} as any));
    const item = (j as any)?.results?.[0];
    const art100 = String(item?.artworkUrl100 || "");
    const art600 = art100
      ? art100.replace(/100x100bb\.jpg$/i, "600x600bb.jpg")
      : "";

    itunesMemCache.set(key, { url: art600 || "", exp: now + ITUNES_CACHE_TTL_MS });
    return art600 || "";
  } catch {
    itunesMemCache.set(key, { url: "", exp: now + ITUNES_CACHE_TTL_MS });
    return "";
  }
}

type TrackRow = {
  id: string | number;
  track_key: string;
  artist?: string | null;
  title?: string | null;
  // ✅ on stocke l'ID final du fichier cover (string) pour éviter [object Object]
  cover_art: string | null;
};

// ✅ FIX CRITIQUE:
// - abandon du filter[_in] (cassé dès qu'il y a des virgules dans track_key)
// - utilise filter[_or][i][track_key][_eq]=... (safe)
// - demande cover_art.id pour supporter relations File
async function getTracksByKeys(keys: string[]): Promise<Map<string, TrackRow>> {
  const map = new Map<string, TrackRow>();
  const clean = (keys || []).map(normTrackKey).filter(Boolean);
  if (!clean.length) return map;

  // Evite URL trop longue
  const slice = clean.slice(0, 200);

  const params = new URLSearchParams();
  params.set("fields", "id,track_key,artist,title,cover_art,cover_art.id");
  params.set("limit", String(Math.min(500, slice.length)));

  slice.forEach((tk, i) => {
    params.set(`filter[_or][${i}][track_key][_eq]`, tk);
  });

  const res = await dFetch(`/items/${TRACKS_COLLECTION}?${params.toString()}`);
  if (!res.ok) return map;

  const j = (await res.json().catch(() => ({}))) as any;
  const rows = Array.isArray(j?.data) ? j.data : [];

  for (const r of rows) {
    const tk = normTrackKey(r?.track_key || "");
    if (!tk) continue;

    const coverVal = r?.cover_art;
    const coverId =
      typeof coverVal === "string"
        ? coverVal
        : (coverVal?.id ? String(coverVal.id) : "");

    map.set(tk, {
      id: r?.id,
      track_key: String(r?.track_key || ""),
      artist: r?.artist ?? null,
      title: r?.title ?? null,
      cover_art: coverId || null,
    });
  }

  return map;
}

// -------- GET /api/vote?week=YYYY-WNN (week optional) --------
export const GET: APIRoute = async ({ url }) => {
  try {
    const week = pickWeek(url.searchParams.get("week"));

    // 1) Read votes rows
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

    // 2) Aggregate by normalized track_key
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

    const topRaw = Array.from(map.entries())
      .map(([nk, v]) => ({ nk, ...v }))
      .sort((a, b) => b.count - a.count);

    // 3) Fetch tracks to resolve cover_art (and maybe artist/title)
    const trackKeyList = topRaw.map((x) => x.nk);
    const tracksByKey = await getTracksByKeys(trackKeyList);

    // 4) Build response items with cover_url
    const top = await Promise.all(
      topRaw.map(async (row) => {
        const tkNorm = row.nk;
        const trow = tracksByKey.get(tkNorm);

        const displayTrackKey = String(row.track_key || "").trim() || tkNorm;

        const split = splitFromTrackKey(displayTrackKey);
        const artist =
          String(trow?.artist || "").trim() || String(split.artist || "").trim();
        const title =
          String(trow?.title || "").trim() || String(split.title || "").trim();

        const cover_art = trow?.cover_art ?? null;
        let cover_url = cover_art ? fileUrl(cover_art) : "";

        // Fallback iTunes (only if Directus cover missing)
        if (!cover_url && artist && title) {
          cover_url = await fetchItunesCover(artist, title);
        }

        return {
          track_key: displayTrackKey,
          artist,
          title,
          count: row.count,
          cover_art,
          cover_url,
        };
      })
    );

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

    // Normalize before storage / check
    const track_key = normTrackKey(track_key_raw);
    if (!track_key) return bad(400, "Invalid track_key");

    // Rate limiting: 1 vote per track per day per IP
    const ip = getClientIp(request);
    const iph = await ipHash(ip);
    const vote_day = todayISO();

    // Check existing vote (ip + day + week + track)
    const checkFields = ["id"].join(",");
    const checkRes = await dFetch(
      `/items/${COLLECTION}?fields=${encodeURIComponent(checkFields)}` +
        `&filter[week][_eq]=${encodeURIComponent(week)}` +
        `&filter[vote_day][_eq]=${encodeURIComponent(vote_day)}` +
        `&filter[ip_hash][_eq]=${encodeURIComponent(iph)}` +
        `&filter[track_key][_eq]=${encodeURIComponent(track_key)}` +
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

    // Insert vote
    const res = await dFetch(`/items/${COLLECTION}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        week,
        track_key, // stored normalized
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