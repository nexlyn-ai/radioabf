// src/pages/api/podcasts.ts
import type { APIRoute } from "astro";
import { directusGet, directusAsset } from "../../lib/directus";

export const prerender = false;

type Program = {
  id: string | number;
  title?: string | null;
  description?: string | null;
  cover?: string | null;
  hero?: string | null;
  status?: string | null;
};

type Occurrence = {
  id: string | number;
  status?: string | null;
  day_of_week?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  is_live?: boolean | null;
  program?: Program | null;
};

type DirectusListResp<T> = { data: T[] };
type ArchiveIndex = Record<string, string[]>;

type PodcastItem = {
  id: string;
  date: string;
  display_date: string;
  day_key: string;
  hour: string;
  time: string;
  title: string;
  description: string;
  cover: string;
  stream_url: string;
  source: "pige";
};

const PIGE_BASE = "https://pige.radioabf.com";
const PIGE_INDEX_URL = `${PIGE_BASE}/archive-index.json`;
const PARIS_TZ = "Europe/Paris";

function safeStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeDay(v: unknown): string {
  const raw = safeStr(v).trim().toLowerCase();
  if (!raw) return "";

  const map: Record<string, string> = {
    sun: "sun",
    sunday: "sun",
    dimanche: "sun",
    0: "sun",
    7: "sun",

    mon: "mon",
    monday: "mon",
    lundi: "mon",
    1: "mon",

    tue: "tue",
    tuesday: "tue",
    mardi: "tue",
    2: "tue",

    wed: "wed",
    wednesday: "wed",
    mercredi: "wed",
    3: "wed",

    thu: "thu",
    thursday: "thu",
    jeudi: "thu",
    4: "thu",

    fri: "fri",
    friday: "fri",
    vendredi: "fri",
    5: "fri",

    sat: "sat",
    saturday: "sat",
    samedi: "sat",
    6: "sat",
  };

  if (map[raw]) return map[raw];
  const raw3 = raw.slice(0, 3);
  return map[raw3] || "";
}

function normalizeTime(v: unknown): string {
  const t = safeStr(v).trim();
  if (!t) return "";

  const m = t.match(/^(\d{1,2})\s*:\s*(\d{2})(?::\s*\d{2})?$/);
  if (!m) return "";

  const hh = m[1].padStart(2, "0");
  const mm = m[2].padStart(2, "0");
  return `${hh}:${mm}`;
}

function parseTimeToMinutes(t: string): number {
  const m = safeStr(t).match(/^(\d{2}):(\d{2})$/);
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

function hourFromTime(t: string): string {
  const m = t.match(/^(\d{2}):(\d{2})$/);
  if (!m) return "";
  return m[1];
}

function isAbfClubOccurrence(row: Occurrence): boolean {
  const title = safeStr(row.program?.title).trim().toLowerCase();
  const desc = safeStr(row.program?.description).trim().toLowerCase();
  return title.includes("abf club") || desc.includes("abf club");
}

function getCoverUrl(program: Program | null | undefined): string {
  const coverId = safeStr(program?.cover);
  const heroId = safeStr(program?.hero);
  const imgId = coverId || heroId;
  return imgId ? directusAsset(imgId) : "";
}

function buildArchiveUrl(date: string, hour: string): string {
  const [y, m, d] = date.split("-");
  return `${PIGE_BASE}/archive/${y}/${m}/${d}/${hour}.mp3`;
}

function formatDisplayDate(date: string): string {
  try {
    const dt = new Date(`${date}T12:00:00Z`);
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: PARIS_TZ,
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(dt);
  } catch {
    return date;
  }
}

function getParisNowParts() {
  const now = new Date();

  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: PARIS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const weekdayFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: PARIS_TZ,
    weekday: "short",
  });

  const hourFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: PARIS_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return {
    date: dateFmt.format(now),
    dayKey: normalizeDay(weekdayFmt.format(now).toLowerCase().slice(0, 3)),
    time: hourFmt.format(now),
    minutes: parseTimeToMinutes(hourFmt.format(now)),
  };
}

function shiftDate(date: string, deltaDays: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function findReplayDateForSlot(
  occurrenceDay: string,
  occurrenceTime: string,
  nowParts: { date: string; dayKey: string; minutes: number }
): string | null {
  const slotMinutes = parseTimeToMinutes(occurrenceTime);
  if (slotMinutes < 0) return null;

  const dayOrder = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const nowIdx = dayOrder.indexOf(nowParts.dayKey);
  const slotIdx = dayOrder.indexOf(occurrenceDay);

  if (nowIdx < 0 || slotIdx < 0) return null;

  let daysBack = (nowIdx - slotIdx + 7) % 7;

  // Same weekday but show not aired yet -> use previous week
  if (daysBack === 0 && nowParts.minutes < slotMinutes) {
    daysBack = 7;
  }

  return shiftDate(nowParts.date, -daysBack);
}

async function fetchArchiveIndex(): Promise<ArchiveIndex> {
  const res = await fetch(PIGE_INDEX_URL, {
    headers: { accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Unable to fetch archive index (${res.status})`);
  }

  const data = (await res.json()) as ArchiveIndex;
  return data && typeof data === "object" ? data : {};
}

export const GET: APIRoute = async () => {
  try {
    const fields =
      "id,status,day_of_week,start_time,end_time,is_live,program.id,program.status,program.title,program.description,program.cover,program.hero";

    const [directusResp, archiveIndex] = await Promise.all([
      directusGet<DirectusListResp<Occurrence>>(
        `/items/program_occurrences?fields=${encodeURIComponent(
          fields
        )}&filter[status][_eq]=published&filter[program][status][_eq]=published&limit=500&sort=day_of_week,start_time`
      ),
      fetchArchiveIndex(),
    ]);

    const rows = (directusResp?.data ?? []).filter(isAbfClubOccurrence);
    const nowParts = getParisNowParts();

    const items: PodcastItem[] = [];

    for (const row of rows) {
      const dayKey = normalizeDay(row.day_of_week);
      const time = normalizeTime(row.start_time);
      const hour = hourFromTime(time);

      if (!dayKey || !time || !hour) continue;

      const replayDate = findReplayDateForSlot(dayKey, time, nowParts);
      if (!replayDate) continue;

      const availableHours = Array.isArray(archiveIndex[replayDate])
        ? archiveIndex[replayDate].map((h) => String(h).padStart(2, "0"))
        : [];

      if (!availableHours.includes(hour)) continue;

      const program = row.program || null;
      const title = safeStr(program?.title) || "ABF Club";
      const description = safeStr(program?.description) || "";
      const cover = getCoverUrl(program);

      items.push({
        id: `${replayDate}-${hour}-${row.id}`,
        date: replayDate,
        display_date: formatDisplayDate(replayDate),
        day_key: dayKey,
        hour,
        time,
        title,
        description,
        cover,
        stream_url: buildArchiveUrl(replayDate, hour),
        source: "pige",
      });
    }

    items.sort((a, b) => {
      const da = `${a.date}T${a.time}:00`;
      const db = `${b.date}T${b.time}:00`;
      return db.localeCompare(da);
    });

    return new Response(
      JSON.stringify(
        {
          ok: true,
          count: items.length,
          items,
        },
        null,
        2
      ),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      }
    );
  } catch (err) {
    console.error("[api/podcasts] error:", err);

    return new Response(
      JSON.stringify(
        {
          ok: false,
          count: 0,
          items: [],
          error: "Unable to load podcasts",
        },
        null,
        2
      ),
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