/**
 * Seed Directus programs + program_occurrences from a static SCHEDULE object.
 *
 * Required env:
 *  - DIRECTUS_URL   (ex: https://cms.radioabf.com)
 *  - DIRECTUS_TOKEN (Static Token with rights on programs + program_occurrences (+ directus_files if upload))
 *
 * Optional env:
 *  - IMAGE_BASE_URL (default: https://radioabf.com/images/programs/)
 *  - IMAGE_FALLBACK_BASE_URL (default: https://radioabf.com/)
 *
 * Run (PowerShell):
 *   $env:DIRECTUS_URL="https://cms.radioabf.com"
 *   $env:DIRECTUS_TOKEN="YOUR_TOKEN"
 *   node .\scripts\seed-programs-from-static.mjs
 */

const DIRECTUS_URL = process.env.DIRECTUS_URL;
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN;

const IMAGE_BASE_URL = process.env.IMAGE_BASE_URL || "https://radioabf.com/images/programs/";
const IMAGE_FALLBACK_BASE_URL = process.env.IMAGE_FALLBACK_BASE_URL || "https://radioabf.com/";

if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
  console.error("❌ Missing env vars: DIRECTUS_URL and/or DIRECTUS_TOKEN");
  process.exit(1);
}

// -------------------- STATIC SCHEDULE --------------------
const SCHEDULE = {
  mon: [
    { time:"00h00", img:"1770128201_8d78f92b917e17047c53.jpg", title:"ABF PLAYLIST - NON-STOP MUSIC!", desc:"Non-stop electro, house, tribal, deep & progressive — current hits and timeless classics, no interruptions." },
    { time:"20h00", img:"1770047761_e11655100a3832a23639.png", title:"ABF WARMUP", desc:"Fresh groovy house & electro hits — uplifting funky pre-party vibes." },
    { time:"22h00", img:"1768507170_24ed82d807a1c66d30e0.jpg", title:"ABF CLUB - JNOES", desc:"Groovy drum'n'bass & commercial house master with big room builds and festival energy." },
    { time:"23h00", img:"1768507185_5cc0873ee591d1b570eb.jpg", title:"ABF CLUB - DEGIANNY", desc:"Melodic techno & progressive specialist delivering emotional, keyboard-live journeys." }
  ],
  tue: [
    { time:"00h00", img:"1770128201_8d78f92b917e17047c53.jpg", title:"ABF PLAYLIST - NON-STOP MUSIC!", desc:"Non-stop electro, house, tribal, deep & progressive — current hits and timeless classics, no interruptions." },
    { time:"20h00", img:"1770047761_e11655100a3832a23639.png", title:"ABF WARMUP", desc:"Fresh groovy house & electro hits — uplifting funky pre-party vibes." },
    { time:"22h00", img:"1768507231_488e50db2ea8cda46b2f.jpg", title:"ABF CLUB - TECKROAD", desc:"Veteran blending psy-trance, tech house, funky classics, and warm vinyl grooves." },
    { time:"23h00", img:"1768507251_046f763d818c022f3c69.jpg", title:"ABF CLUB - THE SPYMBOYS", desc:"Alpine party king with eclectic funky/jackin' house and high-energy vibes." }
  ],
  wed: [
    { time:"00h00", img:"1770128201_8d78f92b917e17047c53.jpg", title:"ABF PLAYLIST - NON-STOP MUSIC!", desc:"Non-stop electro, house, tribal, deep & progressive — current hits and timeless classics, no interruptions." },
    { time:"20h00", img:"1770047761_e11655100a3832a23639.png", title:"ABF WARMUP", desc:"Fresh groovy house & electro hits — uplifting funky pre-party vibes." },
    { time:"22h00", img:"1768507297_9c576120fcbd38219aa9.jpg", title:"ABF CLUB - JEAN-JEROME", desc:"Paris house veteran serving authentic groovy roots and soulful club feels." },
    { time:"23h00", img:"1768507316_1261bdc48106c8579a39.jpg", title:"ABF CLUB - WILLIAM FOREST", desc:"Melodic deep/prog producer with emotional tracks and creative mashups." }
  ],
  thu: [
    { time:"00h00", img:"1770128201_8d78f92b917e17047c53.jpg", title:"ABF PLAYLIST - NON-STOP MUSIC!", desc:"Non-stop electro, house, tribal, deep & progressive — current hits and timeless classics, no interruptions." },
    { time:"20h00", img:"1770047761_e11655100a3832a23639.png", title:"ABF WARMUP", desc:"Fresh groovy house & electro hits — uplifting funky pre-party vibes." },
    { time:"22h00", img:"1770803145_3590fecff4df25a42558.jpg", title:"ABF CLUB - PIERRE DE PARIS", desc:"Real mix for real mix lovers..." },
    { time:"23h00", img:"1768507375_9f458c45cbf3edbcce4d.jpg", title:"ABF CLUB - C-DRYK", desc:"Versatile jackin' house expert with nu-disco, funky, and scratch flair." }
  ],
  fri: [
    { time:"00h00", img:"1770128201_8d78f92b917e17047c53.jpg", title:"ABF PLAYLIST - NON-STOP MUSIC!", desc:"Non-stop electro, house, tribal, deep & progressive — current hits and timeless classics, no interruptions." },
    { time:"18h00", img:"1770136551_b9cc44e800f0124bbab4.png", title:"ABF WARMUP EXTENDED", desc:"Fresh groovy house & electro hits — uplifting funky pre-party vibes." },
    { time:"22h00", img:"1768507456_050c7b9177cfce665c11.jpg", title:"ABF CLUB - BETTY MIX", desc:"Feel-good queen of sunny remixes, uplifting house, psy-trance and positive energy." },
    { time:"23h00", img:"1768507483_b656d4c2f50a3652be6f.jpg", title:"ABF CLUB - DJ JOEE", desc:"Australian house traveler with melodic deep/prog and seamless journeys." }
  ],
  sat: [
    { time:"00h00", img:"1770128100_1e3c223bf0e46a478e5d.jpg", title:"ABF PLAYLIST WE - NON-STOP MUSIC!", desc:"Non-stop electro, house, tribal, deep & progressive — current hits and timeless classics, no interruptions." },
    { time:"18h00", img:"1770048348_cb6f7ac34f65bfb50c95.png", title:"ABF WARMUP", desc:"Fresh groovy house & electro hits — uplifting funky pre-party vibes." },
    { time:"20h00", img:"1770577445_c2959a4650239906609a.jpg", title:"ABF CLUB - GUEST MIX 1", desc:"Rotating international guest delivering fresh, surprising house/techno vibes to kick off the prime time." },
    { time:"21h00", img:"1770577532_f7aae5eb0902593ac1cb.jpg", title:"ABF CLUB - GUEST MIX 2", desc:"Second rotating guest slot packed with high-energy club heat and exclusive selections." },
    { time:"22h00", img:"1768507536_07beeacfd28b4fc86c30.jpg", title:"ABF CLUB - LAURENT SCHARK", desc:"Vocal/funky house pillar bringing groovy, timeless London-Paris vibes." },
    { time:"23h00", img:"1768677347_b8fc41f1805e109d4d66.png", title:"ABF CLUB - TONY JAY", desc:"Paris club selector with energetic house, tech, and dancefloor fire." }
  ],
  sun: [
    { time:"00h00", img:"1769976420_3b4d78bf20f028487165.png", title:"ABF AFTER", desc:"Deep, driving hypnotic techno to fuel the afterhours and keep the energy high till dawn." },
    { time:"07h00", img:"1770128309_dc9e7e2e6b3e22de821f.png", title:"ABF CHILL", desc:"Lounge, chill-out & downtempo grooves — smooth beats and dreamy melodies to relax." },
    { time:"10h00", img:"1770128100_1e3c223bf0e46a478e5d.jpg", title:"ABF PLAYLIST WE - NON-STOP MUSIC!", desc:"Non-stop electro, house, tribal, deep & progressive — current hits and timeless classics, no interruptions." },
    { time:"18h00", img:"1770048348_cb6f7ac34f65bfb50c95.png", title:"ABF WARMUP", desc:"Fresh groovy house & electro hits — uplifting funky pre-party vibes." },
    { time:"20h00", img:"1768155428_bf272625d4798bd3d3f5.jpg", title:"ABF CLUB [MADE IN JAPAN] - ZEPHYR", desc:"Elegant deep/melodic house from Japan with atmospheric Ibiza touches." },
    { time:"21h00", img:"1768155467_5ed42c9a2e258587b90c.jpg", title:"ABF CLUB [MADE IN JAPAN] - HIDEKI", desc:"Funky big beat legend mixing game-soundtrack energy and club heat." },
    { time:"22h00", img:"1768155500_86865e0936bc69837bc6.jpg", title:"ABF CLUB [MADE IN JAPAN] - TAMIO YAMASHITA", desc:"Innovative house/trance producer fusing tech and emotional melodies." },
    { time:"23h00", img:"1768155543_6c967eb97fdae7bd70e3.jpg", title:"ABF CLUB [MADE IN JAPAN] - DJ DARKNESS", desc:"Veteran techno/trance/house DJ with high-energy, uplifting Japanese roots." }
  ]
};
// --------------------------------------------------------

function toStartTime(timeStr) {
  // "18h00" -> "18:00:00"
  const s = String(timeStr || "").trim();
  const m = s.match(/^(\d{1,2})\s*h\s*(\d{2})$/i);
  if (!m) return "00:00:00";
  return `${m[1].padStart(2, "0")}:${m[2].padStart(2, "0")}:00`;
}

function absUrl(base, filename) {
  const f = String(filename || "").trim();
  if (!f) return "";
  return new URL(f, base).toString();
}

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

async function dFetch(endpoint, { method = "GET", body, isForm = false } = {}) {
  const url = `${DIRECTUS_URL.replace(/\/$/, "")}${endpoint}`;
  const headers = { Authorization: `Bearer ${DIRECTUS_TOKEN}` };
  if (!isForm) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Directus ${method} ${endpoint} ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function assertToken() {
  await dFetch("/users/me"); // throws on 401
  console.log("✅ Directus token OK");
}

async function findProgramBySlug(slug) {
  const params = new URLSearchParams();
  params.set("limit", "1");
  params.set("fields", "id,slug,title,description,status,cover,hero");
  params.set("filter[slug][_eq]", String(slug));

  const r = await dFetch(`/items/programs?${params.toString()}`);
  return r?.data?.[0] || null;
}

async function upsertProgram({ title, desc, coverFileId }) {
  const slug = slugify(title);
  if (!slug) throw new Error(`Invalid title for slug: "${title}"`);

  const existing = await findProgramBySlug(slug);

  // Only set cover if provided and not already set
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
  }
  const r = await dFetch(`/items/programs`, { method: "POST", body: payload });
  return r?.data;
}

async function occurrenceExists(day, start_time, programId) {
  const params = new URLSearchParams();
  params.set("limit", "1");
  params.set("fields", "id");
  params.set("filter[day_of_week][_eq]", String(day));
  params.set("filter[start_time][_eq]", String(start_time));
  params.set("filter[program][_eq]", String(programId));

  const r = await dFetch(`/items/program_occurrences?${params.toString()}`);
  return Boolean(r?.data?.[0]?.id);
}

async function createOccurrence({ day, start_time, programId }) {
  const payload = { status: "published", day_of_week: day, start_time, program: programId };
  const r = await dFetch(`/items/program_occurrences`, { method: "POST", body: payload });
  return r?.data;
}

async function uploadFileFromUrl(fileUrl) {
  const res = await fetch(fileUrl, { headers: { "user-agent": "radioabf-seed/1.0" } });
  if (!res.ok) throw new Error(`Image fetch failed ${res.status} for ${fileUrl}`);

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const bytes = new Uint8Array(await res.arrayBuffer());

  const filename = (() => {
    try {
      const u = new URL(fileUrl);
      return u.pathname.split("/").pop() || "image.jpg";
    } catch {
      return "image.jpg";
    }
  })();

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), filename);

  const r = await dFetch(`/files`, { method: "POST", body: form, isForm: true });
  return r?.data?.id || null;
}

async function main() {
  console.log("🌱 Seeding from static SCHEDULE…");
  await assertToken();

  let programsCreated = 0;
  let programsUpdated = 0;
  let occurrencesCreated = 0;
  let filesUploaded = 0;

  for (const [day, items] of Object.entries(SCHEDULE)) {
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      const title = String(item?.title || "").trim();
      if (!title) continue;

      const desc = String(item?.desc || "").trim();
      const start_time = toStartTime(item?.time);

      // Best-effort image upload (cover)
      let coverFileId = null;
      const imgName = String(item?.img || "").trim();
      if (imgName) {
        const primary = absUrl(IMAGE_BASE_URL, imgName);
        const fallback = absUrl(IMAGE_FALLBACK_BASE_URL, imgName);

        try {
          coverFileId = await uploadFileFromUrl(primary);
        } catch {
          try {
            coverFileId = await uploadFileFromUrl(fallback);
          } catch {
            console.warn(`⚠️ Image upload failed for "${title}" (${primary} / ${fallback})`);
          }
        }

        if (coverFileId) filesUploaded++;
      }

      const slug = slugify(title);
      const before = await findProgramBySlug(slug);

      const program = await upsertProgram({ title, desc, coverFileId });
      if (before?.id) programsUpdated++;
      else programsCreated++;

      const exists = await occurrenceExists(day, start_time, program.id);
      if (!exists) {
        await createOccurrence({ day, start_time, programId: program.id });
        occurrencesCreated++;
      }
    }
  }

  console.log("✅ Done.");
  console.log(`Programs created: ${programsCreated}`);
  console.log(`Programs updated: ${programsUpdated}`);
  console.log(`Occurrences created: ${occurrencesCreated}`);
  console.log(`Files uploaded: ${filesUploaded}`);
}

main().catch((e) => {
  console.error("❌ Seed failed:", e);
  process.exit(1);
});