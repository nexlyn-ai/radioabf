import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

const DIRECTUS_URL = (process.env.DIRECTUS_URL || "").replace(/\/+$/, "");
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN || "";

if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
  console.error("Missing env. Please set DIRECTUS_URL and DIRECTUS_TOKEN in .env");
  process.exit(1);
}

const ROOT = process.cwd();

// Adjust if your paths differ
const ARTISTS_JSON = path.join(ROOT, "src", "data", "artists.json");
const BIOS_DIR = path.join(ROOT, "src", "content", "artists");

// Your current JSON uses /images/... which usually lives in /public/images/...
const PUBLIC_DIR = path.join(ROOT, "public");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${DIRECTUS_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${DIRECTUS_TOKEN}`,
      ...headers,
    },
    body,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep as text
  }

  if (!res.ok) {
    const msg = json ? JSON.stringify(json) : text;
    throw new Error(`${method} ${pathname} -> ${res.status} ${res.statusText}\n${msg}`);
  }

  return json;
}

function fileExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolvePublicFile(webPath) {
  // webPath like "/images/artists/xxx.jpg"
  const clean = String(webPath || "").trim();
  if (!clean || !clean.startsWith("/")) return null;
  return path.join(PUBLIC_DIR, clean.replace(/^\/+/, ""));
}

async function uploadFile(localPath) {
  const filename = path.basename(localPath);
  const buf = fs.readFileSync(localPath);

  const form = new FormData();
  form.append("file", new Blob([buf]), filename);

  // You can also add "title" or "folder" if needed:
  // form.append("title", filename);

  const json = await api("/files", { method: "POST", body: form });
  // Directus returns { data: { id: "uuid", ... } }
  const id = json?.data?.id;
  if (!id) throw new Error(`Upload succeeded but no file id returned for ${filename}`);
  return id;
}

async function findArtistBySlug(slug) {
  const fields = encodeURIComponent("id,slug");
  const json = await api(
    `/items/artists?fields=${fields}&filter[slug][_eq]=${encodeURIComponent(slug)}&limit=1`
  );
  const item = json?.data?.[0] || null;
  return item;
}

async function createArtist(payload) {
  return api("/items/artists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function updateArtist(id, payload) {
  return api(`/items/artists/${encodeURIComponent(String(id))}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function readBioHtml(slug) {
  const p = path.join(BIOS_DIR, `${slug}.html`);
  if (!fileExists(p)) return "";
  return fs.readFileSync(p, "utf8");
}

async function main() {
  if (!fileExists(ARTISTS_JSON)) {
    console.error("artists.json not found at:", ARTISTS_JSON);
    process.exit(1);
  }

  const list = JSON.parse(fs.readFileSync(ARTISTS_JSON, "utf8"));
  if (!Array.isArray(list)) {
    console.error("artists.json must be an array");
    process.exit(1);
  }

  console.log(`Found ${list.length} artists in JSON.`);
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const a of list) {
    const slug = String(a?.slug || "").trim();
    const name = String(a?.name || "").trim();

    if (!slug || !name) {
      console.log("SKIP (missing slug/name):", a);
      skipped++;
      continue;
    }

    // Load bio from local HTML if present; otherwise keep existing JSON "bio" if any
    const bioHtml = readBioHtml(slug);

    // Upload portrait/hero if local files exist
    let portraitId = null;
    let heroId = null;

    const portraitLocal = resolvePublicFile(a?.portrait);
    if (portraitLocal && fileExists(portraitLocal)) {
      portraitId = await uploadFile(portraitLocal);
      console.log(`Uploaded portrait for ${slug}: ${portraitId}`);
      await sleep(120);
    } else if (a?.portrait) {
      console.log(`Portrait file missing locally for ${slug}: ${a.portrait}`);
    }

    const heroLocal = resolvePublicFile(a?.hero);
    if (heroLocal && fileExists(heroLocal)) {
      heroId = await uploadFile(heroLocal);
      console.log(`Uploaded hero for ${slug}: ${heroId}`);
      await sleep(120);
    } else if (a?.hero) {
      console.log(`Hero file missing locally for ${slug}: ${a.hero}`);
    }

    const payload = {
      status: "published",
      slug,
      name,
      categories: Array.isArray(a?.categories) ? a.categories : [],
      genres: Array.isArray(a?.genres) ? a.genres : [],
      portrait: portraitId,
      hero: heroId,
      bio: bioHtml || "",
      instagram: a?.instagram || "",
      facebook: a?.facebook || "",
      soundcloud: a?.soundcloud || "",
      mixcloud: a?.mixcloud || "",
      youtube: a?.youtube || "",
      x: a?.x || "",
      website: a?.website || "",
    };

    // If you prefer: do NOT overwrite bio if empty, etc. (keep it simple now)
    const existing = await findArtistBySlug(slug);

    if (!existing) {
      await createArtist(payload);
      console.log(`CREATED: ${slug}`);
      created++;
    } else {
      await updateArtist(existing.id, payload);
      console.log(`UPDATED: ${slug} (id=${existing.id})`);
      updated++;
    }

    // be polite with the API
    await sleep(180);
  }

  console.log("DONE.");
  console.log({ created, updated, skipped });
}

main().catch((e) => {
  console.error("\nIMPORT FAILED:\n", e?.message || e);
  process.exit(1);
});