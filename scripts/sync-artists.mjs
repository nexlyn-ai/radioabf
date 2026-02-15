// scripts/sync-artists.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import * as cheerio from "cheerio";

/**
 * Sync artists from https://radioabf.com/artists
 * - Collect slugs
 * - Fetch each /artists/:slug
 * - Extract:
 *   - name
 *   - categories (resident/guest/team) from genres hashtags
 *   - portrait (from .artist-header .img)  ✅ (thumb => unthumb => full)
 *   - hero/banner (from .artist-header .bg) optional
 *   - bio HTML (div.bio)
 * - Rewrite bio HTML:
 *   - download every <img src="https://radioabf.com/..."> (and also /uploads paths)
 *   - replace src to local /artists/bio/<slug>/<file>
 * - Download portraits to public/artists/<slug>.<ext>
 * - Write:
 *   - src/data/artists.json
 *   - src/content/artists/<slug>.md (frontmatter + bio html)
 */

const DOMAIN = "https://radioabf.com";
const LIST_URL = `${DOMAIN}/artists`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root (scripts/..)
const ROOT = path.resolve(__dirname, "..");

const OUT_JSON = path.join(ROOT, "src", "data", "artists.json");
const OUT_CONTENT_DIR = path.join(ROOT, "src", "content", "artists");
const OUT_PUBLIC_PORTRAITS = path.join(ROOT, "public", "artists");
const OUT_PUBLIC_BIO = path.join(ROOT, "public", "artists", "bio");
const OUT_PUBLIC_HERO = path.join(ROOT, "public", "artists", "hero"); // optional

// Safety: do not hammer
const WAIT_MS = 80;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function absUrl(u) {
  if (!u) return "";
  try {
    // if already absolute
    new URL(u);
    return u;
  } catch {
    return new URL(u, DOMAIN).toString();
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function bgUrlFromStyle(style) {
  const s = String(style || "");
  const m = s.match(/background-image\s*:\s*url\(([^)]+)\)/i);
  if (!m) return "";
  return String(m[1] || "").trim().replace(/^["']|["']$/g, "");
}

function unthumb(u) {
  // /artists/thumb_176831...jpg -> /artists/176831...jpg
  const url = String(u || "");
  return url.replace(/\/thumb_([^/?#]+)([?#].*)?$/i, "/$1$2");
}

function safeSlugFromUrl(u) {
  // https://radioabf.com/artists/arnaud-joachim -> arnaud-joachim
  const m = String(u || "").match(/\/artists\/([^/?#]+)/i);
  return m ? m[1] : "";
}

function normalizeCategoriesFromGenres(genreTexts = []) {
  const cats = new Set();
  for (const raw of genreTexts) {
    const t = String(raw || "").toLowerCase();
    if (t.includes("resident")) cats.add("resident");
    if (t.includes("guest")) cats.add("guest");
    if (t.includes("team")) cats.add("team");
  }
  return Array.from(cats);
}

function pickArtistImages($) {
  // ✅ Portrait DJ (NOT the zoomed header cover)
  const portraitStyle = $(".artist-header .img").attr("style");
  const portraitRaw = bgUrlFromStyle(portraitStyle);
  const portrait = portraitRaw ? absUrl(unthumb(portraitRaw)) : "";

  // Optional hero/banner
  const heroStyle = $(".artist-header .bg").attr("style");
  const heroRaw = bgUrlFromStyle(heroStyle);
  const hero = heroRaw ? absUrl(heroRaw) : "";

  return { portrait, hero };
}

function getFileNameFromUrl(u) {
  try {
    const url = new URL(u);
    const base = path.basename(url.pathname);
    if (base && base.includes(".")) return base;
  } catch {}
  // fallback hashed
  const h = crypto.createHash("sha1").update(String(u)).digest("hex").slice(0, 10);
  return `${h}.jpg`;
}

async function downloadTo(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await ensureDir(path.dirname(outPath));
  await fsp.writeFile(outPath, buf);
  return outPath;
}

function relPublicPath(absFsPath) {
  // Convert /.../public/xxxx -> /xxxx (web path)
  const pub = path.join(ROOT, "public");
  const rel = path.relative(pub, absFsPath).split(path.sep).join("/");
  return "/" + rel;
}

function stripText($el) {
  // clone and remove children we don't want, then text
  const c = $el.clone();
  c.find("img").remove();
  return c.text().replace(/\s+/g, " ").trim();
}

async function rewriteBioHtmlAndDownloadImages(slug, bioHtml) {
  if (!bioHtml || !bioHtml.trim()) return { html: "", downloaded: 0 };

  const $ = cheerio.load(`<div id="__bio__">${bioHtml}</div>`, {
    decodeEntities: false,
  });

  let downloaded = 0;

  // Handle <img src="...">
  const imgs = $("#__bio__ img").toArray();

  for (const img of imgs) {
    const el = $(img);
    const src = el.attr("src") || "";
    if (!src) continue;

    const absolute = absUrl(src);

    // Only mirror radioabf.com (or relative /uploads)
    let ok =
      absolute.startsWith("https://radioabf.com/") ||
      absolute.startsWith("http://radioabf.com/") ||
      src.startsWith("/uploads/") ||
      src.startsWith("uploads/");

    if (!ok) continue;

    const filename = getFileNameFromUrl(absolute);
    const outFs = path.join(OUT_PUBLIC_BIO, slug, filename);

    try {
      await downloadTo(absolute, outFs);
      el.attr("src", relPublicPath(outFs));
      // remove srcset if exists to avoid mixed remote assets
      if (el.attr("srcset")) el.removeAttr("srcset");
      downloaded++;
      await sleep(WAIT_MS);
    } catch (e) {
      // keep original src on failure
      // eslint-disable-next-line no-console
      console.warn(`  ! bio img download failed for ${slug}: ${absolute}`);
    }
  }

  // Optional: force external links new tab in bios
  $("#__bio__ a").each((_, a) => {
    const el = $(a);
    const href = (el.attr("href") || "").trim();
    if (!href) return;
    const isExternal = /^https?:\/\//i.test(href) && !href.startsWith(DOMAIN);
    if (isExternal) {
      el.attr("target", "_blank");
      el.attr("rel", "noopener noreferrer");
    }
  });

  const html = $("#__bio__").html() || "";
  return { html, downloaded };
}

async function collectSlugs() {
  console.log("→ Collect slugs…");
  const slugs = new Set();

  // Strategy: paginate until no results
  // Many CMS use ?page=1 etc. We’ll try:
  // - /artists
  // - /artists?page=2 ...
  // Stop when a page yields 0 new slugs.
  let page = 1;
  let emptyHits = 0;

  while (page <= 20 && emptyHits < 2) {
    const url = page === 1 ? LIST_URL : `${LIST_URL}?page=${page}`;
    const html = await fetchText(url).catch(() => "");
    if (!html) break;

    const $ = cheerio.load(html);

    // Pick links that look like /artists/:slug, but not:
    // /artists/genre/... or /artists?page=...
    const links = $("a[href*='/artists/']")
      .map((_, a) => $(a).attr("href"))
      .get()
      .filter(Boolean)
      .map((h) => absUrl(h));

    const found = new Set();
    for (const href of links) {
      const slug = safeSlugFromUrl(href);
      if (!slug) continue;
      if (slug.toLowerCase() === "artists") continue;
      if (slug.toLowerCase() === "genre") continue;
      // exclude subpages /artists/:slug/news etc by ensuring only one segment after /artists/
      const u = new URL(href);
      const parts = u.pathname.split("/").filter(Boolean);
      const idx = parts.indexOf("artists");
      const maybe = parts[idx + 1] || "";
      const extra = parts[idx + 2] || "";
      if (!maybe || extra) continue; // keep only /artists/:slug
      found.add(maybe);
    }

    // add
    let newCount = 0;
    for (const s of found) {
      if (!slugs.has(s)) {
        slugs.add(s);
        newCount++;
      }
    }

    if (page === 1) {
      console.log(`Found on page 1: ${found.size}`);
    } else {
      console.log(`Scanning page ${page}... (+${newCount} new)`);
    }

    if (newCount === 0) emptyHits++;
    else emptyHits = 0;

    page++;
    await sleep(WAIT_MS);
  }

  return Array.from(slugs);
}

async function mirrorOneArtist(slug) {
  const url = `${DOMAIN}/artists/${slug}`;
  const html = await fetchText(url);
  const $ = cheerio.load(html, { decodeEntities: false });

  // Name: h1.name (remove flag img)
  const nameEl = $(".artist-header h1.name").first();
  nameEl.find("img").remove();
  const name = nameEl.text().replace(/\s+/g, " ").trim() || slug;

  // Genres => categories
  const genres = $(".artist-header .genres a")
    .map((_, a) => stripText($(a)))
    .get()
    .filter(Boolean);

  const categories = normalizeCategoriesFromGenres(genres);

  // ✅ Correct images (portrait from .img, hero from .bg)
  const { portrait: portraitUrl, hero: heroUrl } = pickArtistImages($);

  // Bio HTML
  const bioHtml = $(".bio").first().html() || "";

  // Rewrite bio and download inline images
  const { html: bioHtmlRewritten, downloaded: bioImgs } =
    await rewriteBioHtmlAndDownloadImages(slug, bioHtml);

  // Download portrait (DJ pic)
  let portraitLocal = "";
  if (portraitUrl) {
    const fn = getFileNameFromUrl(portraitUrl);
    const ext = path.extname(fn) || ".jpg";
    const outFs = path.join(OUT_PUBLIC_PORTRAITS, `${slug}${ext}`);

    try {
      await downloadTo(portraitUrl, outFs);
      portraitLocal = relPublicPath(outFs);
    } catch {
      // keep empty
    }
  }

  // Optional hero download (banner)
  let heroLocal = "";
  if (heroUrl) {
    const fn = getFileNameFromUrl(heroUrl);
    const ext = path.extname(fn) || ".jpg";
    const outFs = path.join(OUT_PUBLIC_HERO, `${slug}${ext}`);
    try {
      await downloadTo(heroUrl, outFs);
      heroLocal = relPublicPath(outFs);
    } catch {}
  }

  // Write content markdown (raw html works in Astro markdown)
  // If your collection expects .md, this is safe.
  const md = `---
slug: "${slug}"
name: "${name.replace(/"/g, '\\"')}"
categories: ${JSON.stringify(categories)}
portrait: "${portraitLocal}"
hero: "${heroLocal}"
source: "${url}"
---

${bioHtmlRewritten || ""}
`;

  await ensureDir(OUT_CONTENT_DIR);
  await fsp.writeFile(path.join(OUT_CONTENT_DIR, `${slug}.md`), md, "utf8");

  return {
    slug,
    name,
    categories,
    genres,
    portrait: portraitLocal,
    hero: heroLocal,
    source: url,
    bio_images_count: bioImgs,
  };
}

async function main() {
  await ensureDir(path.dirname(OUT_JSON));
  await ensureDir(OUT_CONTENT_DIR);
  await ensureDir(OUT_PUBLIC_PORTRAITS);
  await ensureDir(OUT_PUBLIC_BIO);
  await ensureDir(OUT_PUBLIC_HERO);

  const slugs = await collectSlugs();

  console.log("→ Collect categories…"); // (we infer them while mirroring)
  console.log(`→ Mirror ${slugs.length} artists (bios + inline images)…`);

  const out = [];
  for (const slug of slugs) {
    process.stdout.write(`  → ${slug}\n`);
    try {
      const item = await mirrorOneArtist(slug);

      const cats = item.categories?.length ? ` (${item.categories.join(",")})` : "";
      process.stdout.write(`  ✓ ${slug}${cats}\n`);

      out.push(item);
      await sleep(WAIT_MS);
    } catch (e) {
      process.stdout.write(`  ! ${slug} failed\n`);
      // eslint-disable-next-line no-console
      console.warn(e?.message || e);
    }
  }

  // Sort stable
  out.sort((a, b) => a.name.localeCompare(b.name));

  await fsp.writeFile(OUT_JSON, JSON.stringify(out, null, 2), "utf8");

  console.log(`✅ Written: ${OUT_JSON}`);
  console.log(`✅ Bios: ${OUT_CONTENT_DIR}`);
  console.log(`✅ Bio inline images: ${OUT_PUBLIC_BIO}`);
  console.log(`✅ Portraits: ${OUT_PUBLIC_PORTRAITS}`);
  console.log("✅ Done");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("Fatal:", e);
  process.exit(1);
});
