// src/lib/directus.ts

const BASE =
  import.meta.env.DIRECTUS_URL ||
  import.meta.env.PUBLIC_DIRECTUS_URL ||
  (typeof process !== "undefined" ? (process.env.DIRECTUS_URL as string | undefined) : undefined) ||
  "";

// ------------------------
// Micro-cache (best-effort) for Vercel SSR
// - TTL: serve fresh for a short time
// - SWR: serve stale while revalidating in background (within same runtime)
// ------------------------
type CacheEntry = {
  exp: number; // fresh until
  swr: number; // stale-while-revalidate until
  value: any;
  pending?: Promise<any>;
};

const _cache = new Map<string, CacheEntry>();

const DEFAULT_TTL_MS = 30_000; // 30s fresh
const DEFAULT_SWR_MS = 5 * 60_000; // 5 min stale allowed

export async function directusGet<T>(
  path: string,
  init?: RequestInit,
  cache?: { ttlMs?: number; swrMs?: number }
): Promise<T> {
  if (!BASE) throw new Error("DIRECTUS_URL / PUBLIC_DIRECTUS_URL is not set");

  const url = `${BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const ttlMs = cache?.ttlMs ?? DEFAULT_TTL_MS;
  const swrMs = cache?.swrMs ?? DEFAULT_SWR_MS;

  // Cache only safe GETs with no body
  const method = (init?.method || "GET").toUpperCase();
  const canCache = method === "GET" && init?.body == null;

  // If request is not cacheable, behave like before
  if (!canCache) {
    const res = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", ...(init?.headers || {}) },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Directus GET ${res.status}: ${txt}`);
    }
    return res.json() as Promise<T>;
  }

  // Key includes URL + headers (so auth/locale changes don't collide)
  const headerKey = init?.headers
    ? JSON.stringify(
        Array.from(new Headers(init.headers as HeadersInit).entries()).sort((a, b) =>
          a[0].localeCompare(b[0])
        )
      )
    : "";

  const key = `GET:${url}:${headerKey}`;
  const now = Date.now();
  const hit = _cache.get(key);

  // 1) Fresh hit
  if (hit && now < hit.exp) return hit.value as T;

  // 2) Serve stale while revalidating
  if (hit && now < hit.swr) {
    if (!hit.pending) {
      hit.pending = (async () => {
        const res = await fetch(url, {
          ...init,
          headers: { Accept: "application/json", ...(init?.headers || {}) },
        });
        if (!res.ok) {
          // keep stale if refresh fails
          const txt = await res.text().catch(() => "");
          throw new Error(`Directus GET ${res.status}: ${txt}`);
        }
        const v = (await res.json()) as T;
        _cache.set(key, {
          exp: Date.now() + ttlMs,
          swr: Date.now() + swrMs,
          value: v,
        });
        return v;
      })().finally(() => {
        const cur = _cache.get(key);
        if (cur) cur.pending = undefined;
      });
    }
    return hit.value as T;
  }

  // 3) Miss (or too stale): fetch and store
  const res = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Directus GET ${res.status}: ${txt}`);
  }

  const v = (await res.json()) as T;
  _cache.set(key, { exp: now + ttlMs, swr: now + swrMs, value: v });
  return v;
}

export function directusAsset(
  fileId?: string | null,
  opts?: { w?: number; h?: number; fit?: "cover" | "contain" | "inside" | "outside"; quality?: number }
) {
  if (!fileId) return "";
  if (!BASE) return "";

  const q = new URLSearchParams();
  if (opts?.w) q.set("width", String(opts.w));
  if (opts?.h) q.set("height", String(opts.h));
  if (opts?.fit) q.set("fit", opts.fit);
  if (opts?.quality) q.set("quality", String(opts.quality));

  const qs = q.toString();
  return `${BASE}/assets/${fileId}${qs ? `?${qs}` : ""}`;
}
