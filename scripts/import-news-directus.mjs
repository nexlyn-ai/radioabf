// scripts/import-news-directus.mjs
import fs from "node:fs";
import path from "node:path";

// ---- load .env (simple, no dependency) ----
(function loadDotEnv() {
  const p = path.resolve(".env");
  if (!fs.existsSync(p)) return;
  const txt = fs.readFileSync(p, "utf-8");
  for (const line of txt.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i === -1) continue;
    const k = l.slice(0, i).trim();
    const v = l.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
})();

function mustEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

const DIRECTUS_URL = mustEnv("DIRECTUS_URL").replace(/\/+$/, "");
const DIRECTUS_TOKEN = mustEnv("DIRECTUS_TOKEN");
const COLLECTION = process.env.DIRECTUS_COLLECTION || "news";

const INPUT_JSON = path.resolve("news_export/news.cleaned.json");

async function api(pathname, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${DIRECTUS_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${DIRECTUS_TOKEN}`,
      ...headers,
    },
    body,
  });

  const ct = res.headers.get("content-type") || "";
  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `Directus API error ${res.status} ${res.statusText} on ${pathname}\n${text.slice(0, 1600)}`
    );
  }

  if (ct.includes("application/json")) return JSON.parse(text);
  return text;
}

function guessMime(ext) {
  const e = ext.toLowerCase();
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".png") return "image/png";
  if (e === ".webp") return "image/webp";
  if (e === ".gif") return "image/gif";
  return "application/octet-stream";
}

async function findExistingBySlug(slug) {
  const q = new URLSearchParams({
    "filter[slug][_eq]": slug,
    limit: "1",
    fields: "id,slug,cover",
  }).toString();

  const out = await api(`/items/${COLLECTION}?${q}`);
  const arr = out?.data || [];
  return arr.length ? arr[0] : null;
}

async function uploadCoverIfExists(cover_local) {
  if (!cover_local) return null;
  const abs = path.resolve("news_export", cover_local); // cover_local = "covers/xxx.jpg"
  if (!fs.existsSync(abs)) return null;

  const ext = path.extname(abs);
  const mime = guessMime(ext);
  const buf = fs.readFileSync(abs);

  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: mime }), path.basename(abs));

  const res = await api(`/files`, { method: "POST", body: fd });
  return res?.data?.id || null;
}

function mapItemToDirectusPayload(it, coverFileId) {
  // Champs EXACTS dans ta collection: title, slug, excerpt, content, cover, published_at, status
  const payload = {
    title: it.title || "",
    slug: it.slug || "",
    excerpt: it.excerpt || "",
    content: it.content_html || "",     // tu peux mettre it.content_text si tu préfères
    published_at: it.published_at || null,
    status: "published",
  };

  if (coverFileId) payload.cover = coverFileId;
  return payload;
}

async function createItem(payload) {
  const res = await api(`/items/${COLLECTION}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res?.data || null;
}

async function updateItem(id, payload) {
  const res = await api(`/items/${COLLECTION}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res?.data || null;
}

async function main() {
  if (!fs.existsSync(INPUT_JSON)) {
    console.error(`Missing input: ${INPUT_JSON}`);
    console.error(`Run: node .\\scripts\\clean-news.mjs`);
    process.exit(1);
  }

  const items = JSON.parse(fs.readFileSync(INPUT_JSON, "utf-8"));
  console.log(`Importing ${items.length} news into Directus collection "${COLLECTION}"...`);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const it of items) {
    const slug = it.slug;
    if (!slug) {
      skipped++;
      continue;
    }

    const existing = await findExistingBySlug(slug);

    // Upload cover
    let coverId = null;
    try {
      coverId = await uploadCoverIfExists(it.cover_local);
    } catch (e) {
      console.warn(`Cover upload failed for ${slug}: ${e.message}`);
    }

    const payload = mapItemToDirectusPayload(it, coverId);

    if (!existing) {
      await createItem(payload);
      created++;
      console.log(`+ created: ${slug}`);
    } else {
      await updateItem(existing.id, payload);
      updated++;
      console.log(`~ updated: ${slug}`);
    }
  }

  console.log(`\nDone.\nCreated: ${created}\nUpdated: ${updated}\nSkipped: ${skipped}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
