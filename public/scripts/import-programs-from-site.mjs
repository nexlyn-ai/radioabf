/**
 * Import RadioABF schedule from https://radioabf.com/programs into Directus
 *
 * Env vars required:
 *  - DIRECTUS_URL   (ex: https://cms.radioabf.com)
 *  - DIRECTUS_TOKEN (static token with rights)
 *
 * Optional:
 *  - SOURCE_URL (default: https://radioabf.com/programs)
 *
 * Node 18+ recommended.
 */

import { writeFile } from "node:fs/promises";

const DIRECTUS_URL = process.env.DIRECTUS_URL;
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN;
const SOURCE_URL = process.env.SOURCE_URL || "https://radioabf.com/programs";

if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
  console.error("❌ Missing env vars: DIRECTUS_URL and/or DIRECTUS_TOKEN");
  process.exit(1);
}

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function slugify(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function absUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return new URL(s, SOURCE_URL).toString();
  return new URL("/" + s, SOURCE_URL).toString();
}

function toStartTime(timeStr) {
  // Accept:
  //  - "20h00" -> "20:00:00"
  //  - "18:00" -> "18:00:00"
  //  - "18:00:00" -> "18:00:00"
  //  - "18:00 (CET)" -> "18:00:00"
  const s = String(timeStr || "").trim();

  let m = s.match(/^(\d{1,2})\s*h\s*(\d{2})$/i);
  if (m) return `${m[1].padStart(2, "0")}:${m[2].padStart(2, "0")}:00`;

  m = s.match(/^(\d{1,2})\s*:\s*(\d{2})(?::\s*(\d{2}))?/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2].padStart(2, "0")}:${(m[3] || "00").padStart(2, "0")}`;

  return "00:00:00";
}

async function httpText(url) {
  const res = await fetch(url, { headers: { "user-agent": "radioabf-schedule-import/1.0" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

async function dFetch(endpoint, { method = "GET", body, isForm = false } = {}) {
  const url = `${DIRECTUS_URL.replace(/\/$/, "")}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${DIRECTUS_TOKEN}`,
  };

  if (!isForm) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not json
  }

  if (!res.ok) {
    throw new Error(`Directus ${method} ${endpoint} ${res.status}: ${text}`);
  }
  return json;
}

async function findProgramBySlug(slug) {
  const q =
    `/items/programs?limit=1` +
    `&filter[slug][_eq]=${encodeURIComponent(slug)}` +
    `&fields=id,slug,title,description,status,cover,hero`;
  const r = await dFetch(q);
  return r?.data?.[0] || null;
}

async function upsertProgram({ title, desc, coverFileId }) {
  const slug = slugify(title);
  if (!slug) throw new Error(`Invalid title for slug: "${title}"`);

  const existing = await findProgramBySlug(slug);

  // Only set cover if we have one AND existing cover is empty
  const nextCover =
    coverFileId && (!existing?.cover || existing.cover === null || existing.cover === "")
      ? coverFileId
      : undefined;

  const payload = {
    status: "published",
    title,
    slug,
    description: desc || "",
    ...(nextCover ? { cover: nextCover } : {}),
  };

  if (existing?.id) {
    const r = await dFetch(`/items/programs/${existing.id}`, { method: "PATCH", body: payload });
    return r?.data || existing;
  } else {
    const r = await dFetch(`/items/programs`, { method: "POST", body: payload });
    return r?.data;
  }
}

async function occurrenceExists(day, start_time, programId) {
  const q =
    `/items/program_occurrences?limit=1` +
    `&filter[day_of_week][_eq]=${encodeURIComponent(day)}` +
    `&filter[start_time][_eq]=${encodeURIComponent(start_time)}` +
    `&filter[program][_eq]=${encodeURIComponent(programId)}` +
    `&fields=id`;
  const r = await dFetch(q);
  return Boolean(r?.data?.[0]?.id);
}

async function createOccurrence({ day, start_time, programId }) {
  const payload = {
    status: "published",
    day_of_week: day,
    start_time,
    program: programId,
  };
  const r = await dFetch(`/items/program_occurrences`, { method: "POST", body: payload });
  return r?.data;
}

async function uploadFileFromUrl(fileUrl) {
  // Upload remote image into Directus Files
  const res = await fetch(fileUrl, { headers: { "user-agent": "radioabf-schedule-import/1.0" } });
  if (!res.ok) throw new Error(`Image fetch failed ${res.status} for ${fileUrl}`);

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const arr = new Uint8Array(await res.arrayBuffer());

  const filenameGuess = (() => {
    try {
      const u = new URL(fileUrl);
      const last = u.pathname.split("/").pop() || "image";
      return last.includes(".") ? last : `${last}.jpg`;
    } catch {
      return "image.jpg";
    }
  })();

  const form = new FormData();
  form.append("file", new Blob([arr], { type: contentType }), filenameGuess);

  const r = await dFetch(`/files`, { method: "POST", body: form, isForm: true });
  return r?.data?.id || null;
}

/**
 * --------- HTML SCRAPER ----------
 * We try multiple strategies because HTML can vary.
 *
 * Strategy A: Find day sections with data-day="mon" ... "sun" and parse cards inside each section.
 * Strategy B: Parse cards in order and assign to days if we can detect boundaries (fallback).
 */
function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s) {
  return decodeHtmlEntities(String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function parseCardsFromChunk(chunk) {
  // Tries to extract cards with time + title + desc + img
  // Works with many markup variations:
  //  - time badge containing "00h00" or "18:00" etc
  //  - title in a heading/div
  //  - desc in a paragraph/div
  //  - img src in <img src="...">
  const cards = [];

  // Split by article (most likely)
  const articleParts = chunk.split(/<article\b/i);
  for (let i = 1; i < articleParts.length; i++) {
    const part = "<article" + articleParts[i];

    // Time: first match of HHhMM or HH:MM
    const timeMatch = part.match(/(\b\d{1,2}\s*h\s*\d{2}\b|\b\d{1,2}\s*:\s*\d{2}\b)/i);
    const time = timeMatch ? timeMatch[1].replace(/\s+/g, "") : "";

    // Img
    const imgMatch = part.match(/<img[^>]+src=["']([^"']+)["']/i);
    const img = imgMatch ? imgMatch[1] : "";

    // Title: try common patterns
    let title = "";
    const titleMatch =
      part.match(/class=["'][^"']*font-semibold[^"']*["'][^>]*>(.*?)<\/div>/i) ||
      part.match(/<h\d[^>]*>(.*?)<\/h\d>/i) ||
      part.match(/alt=["']([^"']+)["']/i);
    if (titleMatch) title = stripTags(titleMatch[1]);

    // Desc
    let desc = "";
    const descMatch =
      part.match(/class=["'][^"']*text-white\/70[^"']*["'][^>]*>(.*?)<\/div>/i) ||
      part.match(/class=["'][^"']*text-white\/65[^"']*["'][^>]*>(.*?)<\/p>/i);
    if (descMatch) desc = stripTags(descMatch[1]);

    if (time && title) {
      cards.push({ time, title, desc, img });
    }
  }

  // If no <article>, try a fallback using "Image:" alt text blocks (SEO text)
  if (cards.length === 0) {
    // Very rough fallback: "00h00 ... Image: TITLE ... TITLE ... DESC"
    // We'll search repeated time blocks then an "Image:" alt label
    const timeRe = /(\b\d{1,2}h\d{2}\b|\b\d{1,2}:\d{2}\b)/g;
    let m;
    const times = [];
    while ((m = timeRe.exec(chunk))) times.push({ idx: m.index, time: m[1] });

    // alt labels
    const altRe = /Image:\s*([^<\n\r]+)/g;
    const alts = [];
    while ((m = altRe.exec(chunk))) alts.push({ idx: m.index, title: stripTags(m[1]) });

    // Pair each time with the next alt
    for (const t of times) {
      const nextAlt = alts.find(a => a.idx > t.idx);
      if (!nextAlt) continue;
      cards.push({ time: t.time, title: nextAlt.title, desc: "", img: "" });
    }
  }

  // Normalize time like "00h00" etc (keep as-is; conversion happens later)
  return cards;
}

function scrapeScheduleFromHtml(html) {
  const schedule = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

  // Strategy A: data-day sections
  const hasDataDay = /data-day=["']mon["']/.test(html) && /data-day=["']sun["']/.test(html);
  if (hasDataDay) {
    for (let i = 0; i < DAY_KEYS.length; i++) {
      const day = DAY_KEYS[i];
      const nextDay = DAY_KEYS[i + 1];

      // Take chunk from this day marker to next day marker (or end)
      const startIdx = html.search(new RegExp(`data-day=["']${day}["']`, "i"));
      if (startIdx < 0) continue;
      let endIdx = html.length;
      if (nextDay) {
        const ni = html.slice(startIdx + 1).search(new RegExp(`data-day=["']${nextDay}["']`, "i"));
        if (ni >= 0) endIdx = startIdx + 1 + ni;
      }

      const chunk = html.slice(startIdx, endIdx);
      const cards = parseCardsFromChunk(chunk);

      // De-duplicate by (time+title)
      const seen = new Set();
      for (const c of cards) {
        const key = `${c.time}__${c.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        schedule[day].push(c);
      }
    }
    return schedule;
  }

  // Strategy B: No data-day; parse full page and then split by day tabs order (best-effort)
  // We'll parse all cards, then assign sequentially into days using a heuristic:
  // - we detect a "reset" when we see the first weekday block begin repeating.
  const all = parseCardsFromChunk(html);

  // If nothing, return empty
  if (!all.length) return schedule;

  // Heuristic: group by repeating pattern of the first title at the beginning of a day
  // Usually "ABF PLAYLIST..." at 00h00 repeats for Mon-Thu/Fri.
  const anchorTitle = all[0]?.title || "";
  let dayIndex = 0;
  let firstSeen = false;

  for (const item of all) {
    if (dayIndex >= DAY_KEYS.length) break;

    if (item.title === anchorTitle && item.time.replace(/\s+/g, "").startsWith("00") ) {
      if (!firstSeen) {
        firstSeen = true;
      } else if (schedule[DAY_KEYS[dayIndex]]?.length) {
        // new day boundary
        dayIndex++;
        if (dayIndex >= DAY_KEYS.length) break;
      }
    }

    schedule[DAY_KEYS[dayIndex]].push(item);
  }

  // De-dupe each day
  for (const day of DAY_KEYS) {
    const seen = new Set();
    schedule[day] = schedule[day].filter(c => {
      const key = `${c.time}__${c.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return schedule;
}

async function main() {
  console.log(`🌐 Fetching schedule from: ${SOURCE_URL}`);
  const html = await httpText(SOURCE_URL);

  const schedule = scrapeScheduleFromHtml(html);

  // Save a local snapshot for audit/debug
  await writeFile("scripts/_scraped_schedule_snapshot.json", JSON.stringify(schedule, null, 2), "utf8");
  console.log("📝 Saved snapshot: scripts/_scraped_schedule_snapshot.json");

  // Quick stats
  for (const d of DAY_KEYS) console.log(`- ${d}: ${schedule[d].length} items`);

  let createdPrograms = 0;
  let createdOccurrences = 0;
  let uploadedFiles = 0;

  for (const day of DAY_KEYS) {
    for (const item of schedule[day]) {
      const title = String(item?.title || "").trim();
      if (!title) continue;

      const desc = String(item?.desc || "").trim();
      const start_time = toStartTime(item?.time);

      // Upload image -> directus_files id (best-effort)
      let coverFileId = null;
      const imgUrl = absUrl(item?.img);
      if (imgUrl) {
        try {
          coverFileId = await uploadFileFromUrl(imgUrl);
          if (coverFileId) uploadedFiles++;
        } catch (e) {
          console.warn(`⚠️ Image upload failed for "${title}" (${imgUrl}): ${String(e.message || e)}`);
        }
      }

      // Upsert program
      const before = await findProgramBySlug(slugify(title));
      const program = await upsertProgram({ title, desc, coverFileId });
      if (!before?.id) createdPrograms++;

      // Create occurrence if missing
      const exists = await occurrenceExists(day, start_time, program.id);
      if (!exists) {
        await createOccurrence({ day, start_time, programId: program.id });
        createdOccurrences++;
      }
    }
  }

  console.log("✅ Import finished.");
  console.log(`Programs created: ${createdPrograms}`);
  console.log(`Occurrences created: ${createdOccurrences}`);
  console.log(`Files uploaded: ${uploadedFiles}`);
}

main().catch((e) => {
  console.error("❌ Import failed:", e);
  process.exit(1);
});