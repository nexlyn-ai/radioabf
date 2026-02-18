// scripts/export-news.mjs
import fs from "node:fs";
import path from "node:path";

const BASE = "https://radioabf.com";

const OUT_DIR = path.resolve("news_export");
const OUT_JSON = path.join(OUT_DIR, "news.json");
const OUT_COVERS = path.join(OUT_DIR, "covers");

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(OUT_COVERS, { recursive: true });

function cleanText(s = "") {
  return s.replace(/\s+/g, " ").trim();
}

function stripTags(html = "") {
  return cleanText(html.replace(/<[^>]*>/g, " "));
}

function firstN(s, n) {
  const t = cleanText(s);
  return t.length <= n ? t : t.slice(0, n - 1).trim() + "…";
}

function safeFilename(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

async function fetchHtml(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function downloadFile(url, filepath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filepath, buf);
}

/**
 * Listing page: extract all article links (radio/music)
 * From your HTML sample:
 *   href="https://radioabf.com/news/radio/...."
 *   href="https://radioabf.com/news/music/...."
 */
function extractListingLinks(listingHtml) {
  const re = /href="(https:\/\/radioabf\.com\/news\/(radio|music)\/[^"]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(listingHtml))) {
    out.push({ url: m[1], category: m[2] });
  }
  // dedupe
  const seen = new Set();
  return out.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

/**
 * Listing page: determine max page number from pagination:
 *   href="https://radioabf.com/news?page=2"
 */
function extractMaxPage(listingHtml) {
  const re = /https:\/\/radioabf\.com\/news\?page=(\d+)/g;
  let max = 1;
  let m;
  while ((m = re.exec(listingHtml))) {
    const n = Number(m[1]);
    if (!Number.isNaN(n)) max = Math.max(max, n);
  }
  return max;
}

/**
 * Article page extraction
 * We’ll grab:
 * - title: in <h1 class="title"> ... or <div class="title"> ... (robust)
 * - date: "Posted on ..."
 * - cover: first image inside main post block, else first <img ...>
 * - content_html: best effort block for post
 */
function extractArticle(html, url, categoryHint) {
  // title: prefer <h1 ...> ... </h1>
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").trim();
  let title = cleanText(stripTags(h1));

  // fallback: first <div class="title"> inside main
  if (!title) {
    const divTitle = (html.match(/<div class="title">([\s\S]*?)<\/div>/i)?.[1] ?? "").trim();
    title = cleanText(stripTags(divTitle));
  }

  // date: Posted on ...
  const postedMatch = html.match(
    /Posted on\s+([0-9]{1,2}\s+[A-Za-z]{3}\s*,?\s*[0-9]{4})/i
  );
  const published_at = postedMatch
    ? new Date(postedMatch[1].replace(",", "")).toISOString()
    : null;

  // category shown on listing; keep hint
  const category = categoryHint || null;

  // Attempt to isolate post content:
  // Many ABF pages wrap article content in a container like "element-post" or similar.
  // We'll try a few common wrappers, else fallback to body fragment.
  let contentHtml = "";

  const block1 = html.match(/<div class="element-post">([\s\S]*?)<\/div>\s*<\/div>/i)?.[1];
  const block2 = html.match(/<div class="element-post[^"]*">([\s\S]*?)<\/div>/i)?.[1];
  const block3 = html.match(/<div class="post-content">([\s\S]*?)<\/div>/i)?.[1];

  contentHtml = (block1 || block2 || block3 || "").trim();

  // fallback: take main area
  if (!contentHtml) {
    const main = html.match(/<div id="main">([\s\S]*?)<div class="footer">/i)?.[1];
    contentHtml = (main || "").trim();
  }

  // cover image: try first <img src="...uploads.../news/...">
  const imgMatch =
    contentHtml.match(/<img[^>]+src="([^"]+uploads\/[^"]+\/news\/[^"]+)"[^>]*>/i) ||
    html.match(/<img[^>]+src="([^"]+uploads\/[^"]+\/news\/[^"]+)"[^>]*>/i) ||
    html.match(/<img[^>]+src="([^"]+)"[^>]*>/i);

  const coverUrlRaw = imgMatch?.[1] ?? null;
  const cover_url = coverUrlRaw
    ? coverUrlRaw.startsWith("http")
      ? coverUrlRaw
      : `${BASE}${coverUrlRaw}`
    : null;

  // excerpt from stripped content
  const content_text = stripTags(contentHtml);
  const excerpt = firstN(content_text, 180);

  // slug from url
  const slug = url.split("/").pop();

  return {
    title,
    slug,
    url,
    category,
    published_at,
    excerpt,
    content_html: contentHtml,
    content_text,
    cover_url,
  };
}

async function main() {
  const items = [];
  const visitedArticles = new Set();

  // First page -> get max pages
  const firstUrl = `${BASE}/news?page=1`;
  console.log("Listing:", firstUrl);
  const firstHtml = await fetchHtml(firstUrl);

  const maxPage = extractMaxPage(firstHtml);
  console.log("Max pages detected:", maxPage);

  for (let p = 1; p <= maxPage; p++) {
    const pageUrl = `${BASE}/news?page=${p}`;
    console.log("\nListing:", pageUrl);

    const listingHtml = p === 1 ? firstHtml : await fetchHtml(pageUrl);
    const links = extractListingLinks(listingHtml);

    console.log("  links found:", links.length);

    for (const link of links) {
      if (visitedArticles.has(link.url)) continue;
      visitedArticles.add(link.url);

      console.log("  Article:", link.url);
      const articleHtml = await fetchHtml(link.url);
      const art = extractArticle(articleHtml, link.url, link.category);

      // download cover
      let cover_local = null;
      if (art.cover_url) {
        const pathname = new URL(art.cover_url).pathname;
        const ext = path.extname(pathname) || ".jpg";
        const file = `${safeFilename(art.slug)}${ext}`;
        const dest = path.join(OUT_COVERS, file);

        try {
          await downloadFile(art.cover_url, dest);
          cover_local = `covers/${file}`;
        } catch (e) {
          console.warn("    cover download failed:", e.message);
        }
      }

      items.push({ ...art, cover_local });
    }
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(items, null, 2), "utf-8");
  console.log(`\nDone: ${items.length} articles -> ${OUT_JSON}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
