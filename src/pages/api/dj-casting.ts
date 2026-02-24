export const prerender = false;

type CastingPayload = {
  name?: string;
  email?: string;
  country_code?: string;
  mix_link?: string;

  facebook?: string;
  instagram?: string;
  soundcloud?: string;
  mixcloud?: string;
  youtube?: string;
  x?: string;
  website?: string;

  message?: string;

  // honeypot
  company?: string;

  // consent checkbox
  consent?: string | boolean;
};

function isUrlLike(s: string) {
  try {
    // allow blank
    if (!s.trim()) return true;
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function POST({ request }: { request: Request }) {
  const DIRECTUS_URL = import.meta.env.DIRECTUS_URL || import.meta.env.PUBLIC_DIRECTUS_URL;
  const DIRECTUS_TOKEN = import.meta.env.DIRECTUS_TOKEN;
  const COLLECTION = import.meta.env.DIRECTUS_DJ_CASTING_COLLECTION || "dj_casting";

  if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
    return new Response(JSON.stringify({ error: "Server not configured (Directus env missing)." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: CastingPayload = {};
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // honeypot
  if (String(body.company || "").trim()) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const mix_link = String(body.mix_link || "").trim();

  if (!name || !email || !mix_link) {
    return new Response(JSON.stringify({ error: "Missing required fields." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const socials = {
    facebook: String(body.facebook || "").trim(),
    instagram: String(body.instagram || "").trim(),
    x: String(body.x || "").trim(),
    website: String(body.website || "").trim(),
    soundcloud: String(body.soundcloud || "").trim(),
    mixcloud: String(body.mixcloud || "").trim(),
    youtube: String(body.youtube || "").trim(),
  };

  const hasOneSocial = Object.values(socials).some((v) => v.length > 0);
  if (!hasOneSocial) {
    return new Response(JSON.stringify({ error: "At least one social link is required." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // basic URL validation
  const urlFields = [mix_link, ...Object.values(socials)];
  if (!urlFields.every(isUrlLike)) {
    return new Response(JSON.stringify({ error: "One or more links are invalid URLs." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const country_code = String(body.country_code || "").trim().toUpperCase().slice(0, 2);
  const message = String(body.message || "").trim().slice(0, 1200);

const payload = {
  name,
  email,
  country_code: country_code || null,
  mix_link,
  ...socials,
  message: message || null,
};

  const url = `${String(DIRECTUS_URL).replace(/\/+$/, "")}/items/${encodeURIComponent(COLLECTION)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DIRECTUS_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return new Response(JSON.stringify({ error: "Directus rejected the submission.", details: text.slice(0, 300) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}