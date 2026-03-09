// src/pages/api/nowplaying.ts
import type { APIRoute } from "astro";

export const prerender = false;

const ICECAST_STATUS_URL =
  import.meta.env.ICECAST_STATUS_URL || process.env.ICECAST_STATUS_URL || "";
const DIRECTUS_URL = import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || "";
const DIRECTUS_TOKEN =
  import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || "";

const PLAYS_COLLECTION = "plays";
const TRACKS_COLLECTION = "tracks";

// ✅ ton schéma Directus
const TRACKS_KEY_FIELD = "track_key";
const TRACKS_COVER_FIELD = "cover_art";
const TRACKS_FIRST_PLAYED_FIELD = "first_played_at";
const TRACKS_COVER_URL_FIELD = "cover_url";
const TRACKS_COVER_OVERRIDE_FIELD = "cover_override";

// ✅ iTunes fallback ON (UNIQUEMENT pour l'AFFICHAGE, jamais écrit en base)
const ENABLE_ITUNES_FALLBACK =
  (import.meta.env.ENABLE_ITUNES_FALLBACK || process.env.ENABLE_ITUNES_FALLBACK || "true") === "true";

const NEW_TRACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/* -------------------- Helpers -------------------- */

function cleanNowText(s: string) {
  let out = String(s || "").trim();
  out = out.replace(/^undefined\s*-\s*/i, "");
  out = out.replace(/\s+—\s+/g, " - ");
  out = out.replace(/\s+–\s+/g, " - ");
  return out.trim();
}

// ✅ Filter garbage / partial metadata like "ABF -", "-", "—", "Artist -"
function isBadRaw(raw: string) {
  const s = String(raw || "").trim();

  if (!s) return true;
  if (s === "-" || s === "—" || s === "–") return true;

  // "ABF -" / "ABF —" / "ABF –"
  if (/^\s*abf\s*[-—–]\s*$/i.test(s)) return true;

  // "Artist - " (empty title)
  if (/^.{1,120}\s-\s*$/.test(s)) return true;

  // "- Title" (empty artist)
  if (/^\s*-\s+.{1,200}$/.test(s)) return true;

  return false;
}

function splitTrack(entry: string) {
  const cleaned = cleanNowText(entry);
  const idx = cleaned.indexOf(" - ");
  if (idx === -1) return { artist: cleaned.trim(), title: "" };
  return {
    artist: cleaned.slice(0, idx).trim(),
    title: cleaned.slice(idx + 3).trim(),
  };
}

/**
 * ✅ Fix mojibake (UTF-8 read as Latin-1 / Win-1252)
 * Ex: "NATÃ©" -> "NATé", "FrÃ©quence" -> "Fréquence"
 */
function fixMojibake(s: string) {
  const str = String(s || "");
  if (!/[ÃÂâ€“â€”â€˜â€™â€œâ€�]/.test(str)) return str;

  try {
    const bytes = Uint8Array.from(str, (c) => c.charCodeAt(0) & 0xff);
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return decoded || str;
  } catch {
    return str;
  }
}

function normKey(artist: string, title: string) {
  return (artist + " - " + title)
    .toLowerCase()
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, "")
    .trim();
}

function stripMixSuffix(title: string) {
  return title
    .replace(/\((original|extended|radio|club|edit|mix)[^)]+\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractNowPlaying(json: any): string {
  const src = json?.icestats?.source;
  const s = Array.isArray(src) ? src[0] : src;
  return (
    (s?.title && String(s.title)) ||
    (s?.yp_currently_playing && String(s.yp_currently_playing)) ||
    (s?.streamtitle && String(s.streamtitle)) ||
    ""
  ).trim();
}

function toUTCms(v: any): number {
  const s = String(v || "").trim();
  if (!s) return 0;
  if (/[zZ]$/.test(s) || /[+\-]\d\d:\d\d$/.test(s)) return Date.parse(s);
  return Date.parse(s + "Z");
}

function isNewFromFirstPlayed(firstPlayedAt: string): boolean {
  const ts = toUTCms(firstPlayedAt);
  if (!ts) return false;
  return Date.now() - ts <= NEW_TRACK_TTL_MS;
}

function isBlockedShow(artist: string) {
  return /^abf\s*club\b/i.test(String(artist || "").trim());
}

function assertEnv() {
  if (!ICECAST_STATUS_URL) throw new Error("ICECAST_STATUS_URL missing");
  if (!DIRECTUS_URL) throw new Error("DIRECTUS_URL missing");
  if (!DIRECTUS_TOKEN) throw new Error("DIRECTUS_TOKEN missing");
}

async function directusFetch(path: string, init: RequestInit = {}) {
  assertEnv();
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${DIRECTUS_TOKEN}`,
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `Directus ${path} failed: ${res.status} ${res.statusText}${txt ? ` — ${txt}` : ""}`
    );
  }
  return res;
}

function directusAssetUrl(fileId: string) {
  return fileId ? `${DIRECTUS_URL}/assets/${fileId}` : "";
}

/* -------------------- Tracks: ensure row (RACE-SAFE) -------------------- */
/**
 * ✅ Robust fix for "track_key must be unique"
 * We try to create; if it already exists (race), we ignore.
 * No cover written. No update.
 */
async function ensureTrackRow(
  track_key: string,
  artist: string,
  title: string,
  first_played_at: string
) {
  if (!track_key) return;

  try {
    await directusFetch(`/items/${TRACKS_COLLECTION}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        [TRACKS_KEY_FIELD]: track_key,
        artist: artist || null,
        title: title || null,
        [TRACKS_FIRST_PLAYED_FIELD]: first_played_at || null,
      }),
    });
  } catch (e: any) {
    const msg = String(e?.message || e || "");

    if (/RECORD_NOT_UNIQUE|has to be unique/i.test(msg)) return;

    console.warn("[nowplaying] ensureTrackRow failed:", msg);
  }
}

/* -------------------- Cover lookup (tracks cover fields) -------------------- */

const __coverCache: Map<string, { url: string; exp: number }> =
  ((globalThis as any).__coverCache as Map<string, { url: string; exp: number }>) || new Map();

async function fetchDirectusCoverByTrackKey(track_key: string): Promise<string> {
  if (!track_key) return "";

  const now = Date.now();
  const hit = __coverCache.get(track_key);
  if (hit && hit.exp > now) return hit.url;

  let coverUrl = "";

  try {
    const params = new URLSearchParams({
      fields: [
        TRACKS_COVER_FIELD,
        `${TRACKS_COVER_FIELD}.id`,
        TRACKS_COVER_URL_FIELD,
        TRACKS_COVER_OVERRIDE_FIELD,
      ].join(","),
      limit: "1",
      [`filter[${TRACKS_KEY_FIELD}][_eq]`]: track_key,
    });

    const r = await directusFetch(`/items/${TRACKS_COLLECTION}?${params.toString()}`);
    const j = await r.json();
    const row = j?.data?.[0];

    const coverVal = row?.[TRACKS_COVER_FIELD];
    const fileId =
      typeof coverVal === "string"
        ? coverVal
        : (coverVal?.id ? String(coverVal.id) : "");

    const coverOverride = String(row?.[TRACKS_COVER_OVERRIDE_FIELD] || "").trim();
    const coverUrlField = String(row?.[TRACKS_COVER_URL_FIELD] || "").trim();

    if (fileId) {
      coverUrl = directusAssetUrl(fileId);
    } else if (coverOverride) {
      coverUrl = coverOverride;
    } else if (coverUrlField) {
      coverUrl = coverUrlField;
    }
  } catch {
    coverUrl = "";
  }

    if (coverUrl) {
    __coverCache.set(track_key, { url: coverUrl, exp: now + 30 * 60 * 1000 });
    (globalThis as any).__coverCache = __coverCache;
  } else {
    __coverCache.delete(track_key);
  }

  return coverUrl;

/* -------------------- Track meta lookup (tracks.first_played_at) -------------------- */

const __trackMetaCache: Map<string, { first_played_at: string; exp: number }> =
  ((globalThis as any).__trackMetaCache as Map<string, { first_played_at: string; exp: number }>) || new Map();

async function fetchTrackFirstPlayedAt(track_key: string): Promise<string> {
  if (!track_key) return "";

  const now = Date.now();
  const hit = __trackMetaCache.get(track_key);
  if (hit && hit.exp > now) return hit.first_played_at;

  let firstPlayedAt = "";

  try {
    const params = new URLSearchParams({
      fields: TRACKS_FIRST_PLAYED_FIELD,
      limit: "1",
      [`filter[${TRACKS_KEY_FIELD}][_eq]`]: track_key,
    });

    const r = await directusFetch(`/items/${TRACKS_COLLECTION}?${params.toString()}`);
    const j = await r.json();
    const row = j?.data?.[0];

    firstPlayedAt = String(row?.[TRACKS_FIRST_PLAYED_FIELD] || "").trim();
  } catch {
    firstPlayedAt = "";
  }

  __trackMetaCache.set(track_key, { first_played_at: firstPlayedAt, exp: now + 30 * 60 * 1000 });
  (globalThis as any).__trackMetaCache = __trackMetaCache;

  return firstPlayedAt;
}

/* -------------------- iTunes cover (fallback display-only) -------------------- */

const __itunesCache: Map<string, { url: string; exp: number }> =
  ((globalThis as any).__itunesCache as Map<string, { url: string; exp: number }>) || new Map();

async function fetchItunesCover(artist: string, title: string): Promise<string> {
  if (!ENABLE_ITUNES_FALLBACK) return "";
  if (!artist || !title) return "";

  const key = normKey(artist, title);
  const now = Date.now();
  const hit = __itunesCache.get(key);
  if (hit && hit.exp > now) return hit.url;

  let cover = "";
  try {
    let term = `${artist} ${title}`;
    let url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`;
    let r = await fetch(url, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const art = j?.results?.[0]?.artworkUrl100;
      if (art) cover = art.replace(/100x100bb\.jpg$/i, "600x600bb.jpg");
    }

    if (!cover) {
      const cleanTitle = stripMixSuffix(title);
      if (cleanTitle && cleanTitle !== title) {
        term = `${artist} ${cleanTitle}`;
        url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`;
        r = await fetch(url, { cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          const art = j?.results?.[0]?.artworkUrl100;
          if (art) cover = art.replace(/100x100bb\.jpg$/i, "600x600bb.jpg");
        }
      }
    }
  } catch {}

   if (cover) {
    __itunesCache.set(key, { url: cover, exp: now + 6 * 60 * 60 * 1000 });
    (globalThis as any).__itunesCache = __itunesCache;
  } else {
    __itunesCache.delete(key);
  }

  return cover;
}

/* -------------------- API -------------------- */

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const limit = Math.min(400, Math.max(1, Number(url.searchParams.get("limit") || "12")));

    const ice = await fetch(ICECAST_STATUS_URL, { cache: "no-store" });
    if (!ice.ok) throw new Error(`Icecast failed: ${ice.status}`);
    const iceJson = await ice.json();

    const nowRaw = extractNowPlaying(iceJson);
    const nowText = cleanNowText(fixMojibake(nowRaw));
    const nowIsBad = isBadRaw(nowText);

    const { artist, title } = splitTrack(nowText);
    const track_key = normKey(artist, title);

    const played_at = new Date().toISOString();
    const played_at_ms = Date.parse(played_at);

    const lastRes = await directusFetch(
      `/items/${PLAYS_COLLECTION}?fields=track_key&sort=-played_at&limit=1`
    );
    const lastJson = await lastRes.json();
    const last = lastJson?.data?.[0];

    let inserted = false;

    if (!nowIsBad && (!last || last.track_key !== track_key)) {
      await ensureTrackRow(track_key, artist, title, played_at);

      await directusFetch(`/items/${PLAYS_COLLECTION}`, {
        method: "POST",
        body: JSON.stringify({
          track_key,
          artist: artist || null,
          title: title || null,
          played_at,
          raw: nowText || null,
        }),
        headers: { "Content-Type": "application/json" },
      });

      inserted = true;
    }

    const oversample = Math.min(500, Math.max(limit * 20, limit + 80));

    const params = new URLSearchParams({
      fields: "id,track_key,artist,title,played_at,raw",
      sort: "-played_at",
      limit: oversample.toString(),
    });

    const histRes = await directusFetch(`/items/${PLAYS_COLLECTION}?${params.toString()}`);
    const histJson = await histRes.json();
    const historyRaw = histJson?.data || [];

    const historyMaybe = await Promise.all(
      historyRaw.map(async (row: any) => {
        const a = fixMojibake(String(row.artist || ""));
        const t = fixMojibake(String(row.title || ""));
        const tk = String(row.track_key || "");
        const raw = fixMojibake(String(row.raw || `${a} - ${t}`.trim()).trim());
        const ts = toUTCms(row.played_at);

        if (isBadRaw(raw)) return null;

        let cover_url = await fetchDirectusCoverByTrackKey(tk);
        let cover_source = cover_url ? "directus" : "";
        if (!cover_url) {
          cover_url = await fetchItunesCover(a, t);
          if (cover_url) cover_source = "itunes";
        }

        const first_played_at = await fetchTrackFirstPlayedAt(tk);
        const first_played_at_ms = toUTCms(first_played_at);
        const is_new = isBlockedShow(a) ? false : isNewFromFirstPlayed(first_played_at);

        return {
          id: row.id,
          raw,
          artist: a,
          title: t,
          track_key: tk,
          played_at: row.played_at,
          played_at_ms: ts,
          cover_url,
          cover_source,
          first_played_at,
          first_played_at_ms,
          is_new,
        };
      })
    );

    const cleaned = (historyMaybe || []).filter(Boolean) as any[];

    const seen = new Set<string>();
    const uniq: any[] = [];

    for (const it of cleaned) {
      const k = `${String(it.track_key || it.raw || "")}__${Number(it.played_at_ms || 0)}`;
      if (!it?.raw) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(it);
    }

    const history = uniq.slice(0, limit);

    let nowCover = "";
    let nowCoverSource = "";
    if (!nowIsBad) {
      nowCover = await fetchDirectusCoverByTrackKey(track_key);
      nowCoverSource = nowCover ? "directus" : "";
      if (!nowCover) {
        nowCover = await fetchItunesCover(artist, title);
        if (nowCover) nowCoverSource = "itunes";
      }
    }

    let nowFirstPlayedAt = "";
    let nowFirstPlayedAtMs = 0;
    let nowIsNew = false;

    if (!nowIsBad) {
      nowFirstPlayedAt = await fetchTrackFirstPlayedAt(track_key);
      nowFirstPlayedAtMs = toUTCms(nowFirstPlayedAt);
      nowIsNew = isBlockedShow(artist) ? false : isNewFromFirstPlayed(nowFirstPlayedAt);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        inserted,
        now: {
          raw: nowIsBad ? "" : nowText,
          artist: nowIsBad ? "" : artist,
          title: nowIsBad ? "" : title,
          track_key: nowIsBad ? "" : track_key,
          played_at,
          played_at_ms,
          cover_url: nowCover,
          cover_source: nowCoverSource,
          first_played_at: nowIsBad ? "" : nowFirstPlayedAt,
          first_played_at_ms: nowIsBad ? 0 : nowFirstPlayedAtMs,
          is_new: nowIsBad ? false : nowIsNew,
        },
        history,
      }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "s-maxage=5, stale-while-revalidate=20",
        },
      }
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "Server error" }), {
      status: 500,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
};