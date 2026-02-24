import type { APIRoute } from "astro";

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();

    const name = String(body?.name || "").trim();
    const email = String(body?.email || "").trim();
    const subject = String(body?.subject || "").trim() || "Website contact";
    const message = String(body?.message || "").trim();
    const page = String(body?.page || "").trim();

    if (!name || !email || !message) {
      return json(400, { ok: false, error: "Missing required fields." });
    }
    if (!email.includes("@")) {
      return json(400, { ok: false, error: "Invalid email." });
    }

    const apiKey = import.meta.env.BREVO_API_KEY as string;
    const to = (import.meta.env.CONTACT_TO as string) || "contact@radioabf.com";
    const fromEmail = (import.meta.env.BREVO_FROM_EMAIL as string) || to;
    const fromName = (import.meta.env.BREVO_FROM_NAME as string) || "RadioABF";

    if (!apiKey) return json(500, { ok: false, error: "Server email is not configured." });

    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify({
        sender: { name: fromName, email: fromEmail },
        to: [{ email: to, name: "RadioABF" }],
        replyTo: { email, name },
        subject: `📩 Contact — ${subject}`,
        htmlContent: `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;line-height:1.5">
            <h2 style="margin:0 0 12px">New contact message</h2>
            <p style="margin:0 0 8px">
              <strong>Name:</strong> ${esc(name)}<br/>
              <strong>Email:</strong> ${esc(email)}<br/>
              <strong>Page:</strong> ${esc(page)}
            </p>
            <h3 style="margin:16px 0 8px">Message</h3>
            <pre style="white-space:pre-wrap;margin:0;padding:12px;border-radius:12px;background:#f6f7f9;border:1px solid #e6e7eb">${esc(message)}</pre>
          </div>
        `,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return json(500, { ok: false, error: "Email sending failed.", details: txt.slice(0, 300) });
    }

    return json(200, { ok: true });
  } catch {
    return json(500, { ok: false, error: "Email sending failed." });
  }
};

function json(status: number, data: any) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function esc(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}