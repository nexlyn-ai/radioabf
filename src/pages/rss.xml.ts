import type { APIRoute } from "astro";
import { directusGet, directusAsset } from "../lib/directus";

const SITE = import.meta.env.SITE || "https://radioabf.com";

type NewsItem = {
  title: string;
  slug: string;
  excerpt?: string | null;
  cover?: string | null;
  published_at?: string | null;
  date_created?: string | null;
};

type DirectusResp = { data: NewsItem[] };

export const GET: APIRoute = async () => {
  const resp = await directusGet<DirectusResp>(
    `/items/news?fields=title,slug,excerpt,cover,published_at,date_created&filter[status][_eq]=published&sort=-published_at,-date_created&limit=50`
  );

  const items = resp?.data ?? [];

  const feedTitle = "RadioABF — News";
  const feedDesc = "Latest updates from RadioABF.";
  const feedUrl = `${SITE}/rss.xml`;

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
    `<channel>\n` +
    `  <title>${escapeXml(feedTitle)}</title>\n` +
    `  <description>${escapeXml(feedDesc)}</description>\n` +
    `  <link>${escapeXml(SITE)}</link>\n` +
    `  <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />\n` +
    items
      .map((it) => {
        const link = `${SITE}/news/${it.slug}`;
        const pub = it.published_at || it.date_created || null;
        const pubDate = pub ? new Date(pub).toUTCString() : new Date().toUTCString();

        // optional: include image as enclosure if cover exists
        const img = it.cover ? directusAsset(it.cover, { w: 1200, h: 630, fit: "cover", quality: 85 }) : "";

        return (
          `  <item>\n` +
          `    <title>${escapeXml(it.title)}</title>\n` +
          `    <link>${escapeXml(link)}</link>\n` +
          `    <guid isPermaLink="true">${escapeXml(link)}</guid>\n` +
          `    <pubDate>${escapeXml(pubDate)}</pubDate>\n` +
          (it.excerpt ? `    <description><![CDATA[${it.excerpt}]]></description>\n` : "") +
          (img ? `    <enclosure url="${escapeXml(img)}" type="image/jpeg" />\n` : "") +
          `  </item>\n`
        );
      })
      .join("") +
    `</channel>\n</rss>\n`;

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, s-maxage=1800, stale-while-revalidate=86400",
    },
  });
};

function escapeXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&lt;").replace(/"/g, "&quot;");
}
