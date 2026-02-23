// src/lib/programsSchedule.ts
import { directusGet, directusAsset } from "./directus";

type Program = {
  id: string | number;
  title?: string | null;
  description?: string | null;
  cover?: string | null;   // ✅ chez toi c’est "Cover"
  hero?: string | null;
  status?: string | null;
};

type Occurrence = {
  id: string | number;
  status?: string | null;
  day_of_week?: string | null;   // ✅ champs directus: day_of_week
  start_time?: string | null;    // ✅ start_time
  end_time?: string | null;
  is_live?: boolean | null;
  program?: Program | null;
};

type DirectusListResp<T> = { data: T[] };

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function safeStr(v: any): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeDay(v: any): string {
  const d = safeStr(v).toLowerCase().trim();
  return DAY_KEYS.includes(d as any) ? d : "";
}

function normalizeTimeFromDirectus(v: any): string {
  // Directus time often: "18:00:00" -> display "18:00 (CET)" handled client-side if you want
  const t = safeStr(v).trim();
  if (!t) return "";
  const m = t.match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
  if (m) return `${m[1]}:${m[2]}`; // keep ":" format; your UI can append (CET)
  return t;
}

export function buildScheduleFromOccurrences(rows: Occurrence[]) {
  const schedule: Record<string, any[]> = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

  for (const row of rows || []) {
    const day = normalizeDay(row.day_of_week);
    if (!day) continue;

    const time = normalizeTimeFromDirectus(row.start_time) || "00:00";
    const p = row.program || null;

    const title = safeStr(p?.title) || "Untitled program";
    const desc  = safeStr(p?.description) || "";

    // ✅ images: chez toi c’est Cover/Hero sur programs
    const coverId = safeStr(p?.cover);
    const imgUrl  = coverId ? directusAsset(coverId) : "";

    schedule[day].push({ time, img: imgUrl, title, desc });
  }

  return schedule;
}

export async function fetchDirectusSchedule() {
  // ⚠️ Important: fields doivent correspondre à tes champs réels
  // program_occurrences: day_of_week, start_time, program
  // programs: title, description, cover
  const fields =
    "id,status,day_of_week,start_time,end_time,is_live," +
    "program.id,program.status,program.title,program.description,program.cover";

  const resp = await directusGet<DirectusListResp<Occurrence>>(
    `/items/program_occurrences?fields=${encodeURIComponent(fields)}&filter[status][_eq]=published&filter[program][status][_eq]=published&limit=500&sort=day_of_week,start_time`
  );

  const rows = resp?.data ?? [];
  return buildScheduleFromOccurrences(rows);
}