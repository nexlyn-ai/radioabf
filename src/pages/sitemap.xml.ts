import type { APIRoute } from "astro";
import { directusGet } from "../lib/directus";

// ⚠️ Mets ton domaine final ici (ou via env)
const SITE = import.meta.env.SITE || "https://radioabf.com";

type NewsItem = {
  slug: string;
  published_at?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
};

type DirectusResp = { data: NewsItem[] };

export const GET: APIRoute = async () => {
  // On prend tous les slugs publiés (limite haute safe)
  const resp = await directusGet<DirectusResp>(
    `/items/news?fields=slug,published_at,date_created,date_updated&filter[status][_eq]=published&sort=-published_at,-date_created&limit=1000`
  );

  const items = resp?.data ?? [];

  const urls: { loc: string; lastmod?: string }[] = [
    { loc: `${SITE}/news` },
  ];

  for (const it of items) {
    if (!it.slug) continue;
    const last = it.published_at || it.date_updated || it.date_created || null;
    urls.push({
      loc: `${SITE}/news/${it.slug}`,
      lastmod: last ? new Date(last).toISOString() : undefined,
    });
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url>\n` +
          `    <loc>${escapeXml(u.loc)}</loc>\n` +
          (u.lastmod ? `    <lastmod>${escapeXml(u.lastmod)}</lastmod>\n` : "") +
          `  </url>`
      )
      .join("\n") +
    `\n</urlset>\n`;

  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
};

function escapeXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
