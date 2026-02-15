export const prerender = false;

const BASE =
  import.meta.env.DIRECTUS_URL ||
  import.meta.env.PUBLIC_DIRECTUS_URL ||
  "";

const TOKEN = import.meta.env.DIRECTUS_VOTES_TOKEN || "";

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function voteDayParis(): string {
  // YYYY-MM-DD in Europe/Paris
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find(p => p.type === "year")?.value ?? "1970";
  const m = parts.find(p => p.type === "month")?.value ?? "01";
  const d = parts.find(p => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

async function dFetch(path: string, init?: RequestInit) {
  if (!BASE) throw new Error("DIRECTUS_URL / PUBLIC_DIRECTUS_URL is not set");
  if (!TOKEN) throw new Error("DIRECTUS_VOTES_TOKEN is not set");

  const url = `${BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Directus ${res.status}: ${txt}`);
  }
  return res.json();
}

export async function POST({ request }: { request: Request }) {
  try {
    const body = await request.json().catch(() => null);
    const track_key = String(body?.track_key || "").trim();

    if (!track_key) return json({ ok: false, error: "Missing track_key" }, 400);

    const day = voteDayParis();
    const key = `${day}|${track_key}`;

    // 1) find existing
    const found = await dFetch(
      `/items/votes?filter[key][_eq]=${encodeURIComponent(key)}&limit=1&fields=id,count,track_key,vote_day`
    );

    const item = found?.data?.[0];

    // 2) update or create
    if (item?.id) {
      const nextCount = Number(item.count || 0) + 1;

      const upd = await dFetch(`/items/votes/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ count: nextCount }),
      });

      return json({ ok: true, day, track_key, count: upd?.data?.count ?? nextCount });
    } else {
      const created = await dFetch(`/items/votes`, {
        method: "POST",
        body: JSON.stringify({
          key,
          track_key,
          vote_day: day,
          count: 1,
        }),
      });

      return json({ ok: true, day, track_key, count: created?.data?.count ?? 1 });
    }
  } catch (e: any) {
    return json({ ok: false, error: e?.message || "Server error" }, 500);
  }
}
