import type { APIRoute } from "astro";

export const GET: APIRoute = ({ url }) => {
  const title = (url.searchParams.get("title") || "RadioABF — News").slice(0, 140);
  const date = (url.searchParams.get("date") || "").slice(0, 40);

  const safe = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0A1F33"/>
      <stop offset="1" stop-color="#0B1227"/>
    </linearGradient>
    <radialGradient id="glow1" cx="25%" cy="20%" r="55%">
      <stop offset="0" stop-color="#22d3ee" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#22d3ee" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="85%" cy="85%" r="60%">
      <stop offset="0" stop-color="#3b82f6" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#3b82f6" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow1)"/>
  <rect width="1200" height="630" fill="url(#glow2)"/>

  <g opacity="0.22">
    <path d="M0 460 C 240 410, 420 520, 650 475 C 880 430, 1020 360, 1200 390 L1200 630 L0 630 Z" fill="#22d3ee"/>
    <path d="M0 520 C 260 470, 470 610, 740 540 C 950 485, 1080 440, 1200 470 L1200 630 L0 630 Z" fill="#3b82f6"/>
  </g>

  <g font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial" fill="#ffffff">
    <text x="72" y="108" font-size="28" opacity="0.82" letter-spacing="2">RADIOABF • NEWS</text>

    <foreignObject x="72" y="150" width="1056" height="330">
      <div xmlns="http://www.w3.org/1999/xhtml"
           style="font-size:64px; font-weight:900; line-height:1.12; color:#fff;">
        ${safe(title)}
      </div>
    </foreignObject>

    <text x="72" y="560" font-size="28" opacity="0.78">${safe(date)}</text>
    <text x="72" y="600" font-size="22" opacity="0.60">The DJs’ Frequency — radioabf.com</text>
  </g>
</svg>`;

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // ✅ Vercel CDN cache: 1 day fresh, 7 days stale while revalidate
      "cache-control": "public, s-maxage=86400, stale-while-revalidate=604800",
    },
  });
};
