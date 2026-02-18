// scripts/clean-news.mjs
import fs from "node:fs";
import path from "node:path";

const IN_PATH = path.resolve("news_export/news.json");
const OUT_PATH = path.resolve("news_export/news.cleaned.json");

function removeShareBlock(html) {
  // enlève le bloc <div class="share"> ... </div>
  return html.replace(/<div class="share">[\s\S]*?<\/div>\s*/gi, "");
}

function removeCopyBtn(html) {
  return html.replace(/<button[^>]*id="copyUrl"[\s\S]*?<\/button>\s*/gi, "");
}

function removeFbEmojiImgs(html) {
  // enlève les <img ...static.xx.fbcdn.net...>
  return html.replace(/<img[^>]+static\.xx\.fbcdn\.net[^>]*>\s*/gi, "");
}

function keepOnlyDetailsIfPresent(html) {
  // si on trouve <div class="details ..."> ... </div>, on garde uniquement ça (contenu principal)
  const m = html.match(/<div class="details[^"]*">([\s\S]*?)<\/div>\s*$/i);
  if (!m) return html;
  return `<div class="details">${m[1].trim()}</div>`;
}

function cleanHtml(html) {
  if (!html) return "";
  let out = html;

  out = removeShareBlock(out);
  out = removeCopyBtn(out);
  out = removeFbEmojiImgs(out);

  // option : réduire aux "details" si présent (souvent le vrai article)
  out = keepOnlyDetailsIfPresent(out);

  // petit clean whitespace
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

function firstNText(s, n) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1).trim() + "…";
}

function stripTags(html) {
  return (html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function main() {
  const raw = fs.readFileSync(IN_PATH, "utf-8");
  const items = JSON.parse(raw);

  const cleaned = items.map((it) => {
    const content_html = cleanHtml(it.content_html);
    const content_text = stripTags(content_html);
    const excerpt = it.excerpt && it.excerpt.length > 20 ? it.excerpt : firstNText(content_text, 180);

    return {
      ...it,
      content_html,
      content_text,
      excerpt,
    };
  });

  fs.writeFileSync(OUT_PATH, JSON.stringify(cleaned, null, 2), "utf-8");
  console.log(`Done: ${cleaned.length} articles -> ${OUT_PATH}`);
}

main();
