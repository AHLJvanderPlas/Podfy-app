// functions/_mail.js

// ---------- utils ----------
const escapeHtml = (s = "") =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fullUrl = (base, path) => {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const b = (base || "").replace(/\/+$/, "");
  return path.startsWith("/") ? `${b}${path}` : `${b}/${path}`;
};

// Chunked base64 encoder to avoid call stack overflow on big files
function toBase64(arrayBuffer) {
  const CHUNK = 0x8000; // 32KB
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

// ---------- theme resolver (uses themes.json shape) ----------
export function resolveEmailTheme(slug, themes) {
  const t = (themes && themes[slug]) || (themes && themes.default) || {};
  const podfyDefaultColor = themes?.default?.header?.bg || "#D3D3D3";
  const podfyDefaultLogo  = themes?.default?.logo       || "/logos/podfy.svg";

  return {
    slug,
    brandName: t.brandName || themes?.default?.brandName || "Podfy",
    brandColor: t.header?.bg || t.colors?.primary || podfyDefaultColor,
    logo: t.logo || podfyDefaultLogo,
    mailTo: t.mailTo || themes?.default?.mailTo || ""
  };
}

// ---------- HTML builder (unchanged) ----------
export function buildHtml({
  brand, brandName, theme, fileName, podfyId, dateTime,
  meta, reference, imageUrlBase, imagePreviewUrl,
}) {
  const color        = theme?.brandColor || "#D3D3D3";
  const logoUrl      = fullUrl(imageUrlBase || "", theme?.logo || "/logos/podfy.svg");
  const podfyLogoUrl = fullUrl(imageUrlBase || "", "/logos/podfy.svg");
  const previewUrl   = fullUrl(imageUrlBase || "", imagePreviewUrl || "");
  const hasImage     = !!imagePreviewUrl;

  const lat = meta?.lat || "";
  const lon = meta?.lon || "";
  const maps = (lat && lon)
    ? `<a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener">${lat}, ${lon}</a>`
    : "";

  const referenceHtml = reference
    ? `<p class="refline" style="margin:20px 0 20px 0">The reference of this shipment is <b>${escapeHtml(reference)}</b>.</p>`
    : "";

  const imageBlock = hasImage
    ? `<div class="preview" style="margin:10px 0 16px 0">
         <img src="${previewUrl}" alt="Uploaded image preview" style="display:block;max-width:100%;height:auto;border-radius:8px">
       </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>POD Notification — ${escapeHtml(brandName || brand || "Podfy")}</title>
<style>
:root { --pad: 22px; }
body { font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; background:#f5f5f5; margin:0; padding:20px; }
.card { max-width:680px; margin:0 auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,.06); }
.banner { background:${color}; padding:14px 18px; }
.logo { height:28px; display:block; }
.content { padding: var(--pad); }
p { margin:0 0 10px; line-height:1.5; color:#111827; }
p.dear { margin-bottom:20px; }
table.meta { width:100%; border-collapse:collapse; margin-top:10px; font-size:14px; }
table.meta td { padding:6px 8px; vertical-align:top; }
table.meta td:first-child { width:200px; color:#374151; font-weight:400; }
.footer { text-align:center; padding:16px 8px 6px; margin-top:20px; }
.footer .provided-by { font-size:10px; color:#9CA3AF; display:block; }
.podfy-logo { height:18px; display:block; margin:6px auto 0; }
.stealth-filename { font-size:10px; color:#fff; margin:6px auto 0; user-select:text; }
.idbar { max-width:680px; margin:8px auto 0; display:flex; justify-content:space-between; align-items:center; font-size:8px; color:#374151; padding:0 var(--pad); }
.idbar a { color:inherit; text-decoration:underline; }
.idbar .left  { text-align:left;  flex:1 1 0; margin-left: var(--pad); }
.idbar .center{ text-align:center;flex:1 1 0; }
.idbar .right { text-align:right; flex:1 1 0; margin-right:var(--pad); }
</style>
</head>
<body>
  <div class="card">
    <div class="banner"><img class="logo" src="${logoUrl}" alt="${escapeHtml(brandName || brand || "Podfy")} logo"></div>
    <div class="content">
      <p class="dear">Dear ${escapeHtml(brandName || brand || "Customer")},</p>
      <p>We have received a new POD for your shipment as per attached.</p>
      ${referenceHtml}
      ${imageBlock}
      <table class="meta">
        <tr><td>POD upload</td><td>${escapeHtml(dateTime || "")}</td></tr>
        <tr><td>Location qualifier</td><td>${escapeHtml(meta?.locationQualifier || "")}</td></tr>
        <tr><td>Latitude, Longitude</td><td>${maps || `${escapeHtml(lat)}, ${escapeHtml(lon)}`}</td></tr>
        <tr><td>Location code</td><td>${escapeHtml(meta?.locationCode || "")}</td></tr>
      </table>
      <div class="footer">
        <div class="stealth-filename">${escapeHtml(fileName || "")}</div>
        <span class="provided-by">This POD is provided by</span>
        <a href="https://podfy.net" target="_blank" rel="noopener"><img class="podfy-logo" src="${podfyLogoUrl}" alt="Podfy"></a>
      </div>
    </div>
  </div>
  <div class="idbar">
    <div class="left"><a href="mailto:${escapeHtml((typeof process !== "undefined" && process.env && process.env.REPLY_TO_EMAIL) || "support@podfy.net")}?subject=${encodeURIComponent("Podfy Issue " + (podfyId||""))}">Report an issue</a></div>
    <div class="center"><a href="https://podfy.net/terms" target="_blank" rel="noopener">Terms &amp; Conditions</a></div>
    <div class="right">Podfy-id: ${escapeHtml(podfyId || "")}</div>
  </div>
</body>
</html>`;
}

// ---------- From address ----------
export function pickFromAddress(env, slug) {
  const domain = env.MAIL_DOMAIN || "podfy.app";
  const safe = (slug || "default").toLowerCase().replace(/[^a-z0-9\-_.]/g, "-");
  return `${safe}@${domain}` || `noreply@${domain}`;
}

// ---------- Transport: Resend first, MailChannels fallback ----------
async function sendViaResend(env, { fromEmail, toList, subject, html, attachment }) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return null; // indicate "not configured"

  try {
    console.log("Resend: preparing", { from: fromEmail, to: toList, subject, hasAttachment: !!attachment });

    const payload = {
      from: env.MAIL_FROM || `Podfy <${fromEmail}>`, // display name + envelope
      to: toList,
      subject,
      html,
      // Resend expects attachments as [{ filename, content (base64) }]
      attachments: attachment ? [{ filename: attachment.filename, content: attachment.contentBase64 }] : undefined,
    };

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const body = await res.text();
    if (!res.ok) {
      console.error("Resend error", res.status, body);
      return false;
    }
    console.log("Resend ok", res.status, body);
    return true;
  } catch (e) {
    console.error("Resend fetch failed", String(e && e.stack) || String(e));
    return false;
  }
}

async function sendViaMailchannels(env, { fromEmail, toList, subject, html, text, attachment }) {
  // New MailChannels API typically requires an API key + lockdown.
  const headers = { "content-type": "application/json" };
  if (env.MAILCHANNELS_API_KEY) headers["X-Api-Key"] = env.MAILCHANNELS_API_KEY;

  const payload = {
    personalizations: [{ to: toList.map((e) => ({ email: e })) }],
    from: { email: fromEmail, name: env.MAIL_FROM || "Podfy App" },
    reply_to: env.REPLY_TO_EMAIL ? [{ email: env.REPLY_TO_EMAIL }] : undefined,
    subject,
    content: [
      { type: "text/plain", value: text || html.replace(/<[^>]+>/g, " ").slice(0, 10000) },
      { type: "text/html", value: html }
    ],
    attachments: attachment ? [{
      filename: attachment.filename,
      type: attachment.type || "application/octet-stream",
      content: attachment.contentBase64
    }] : undefined
  };

  let res, body;
  try {
    res = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    body = await res.text();
  } catch (e) {
    console.error("MailChannels fetch failed", String(e && e.stack) || String(e));
    return false;
  }

  if (!res.ok) {
    console.error("MailChannels error", res.status, body);
    return false;
  }
  console.log("MailChannels ok", res.status, body);
  return true;
}

// Public send function used by upload.js
export async function sendMail(env, args) {
  // Ensure attachment base64 is robust (if caller passed ArrayBuffer by mistake)
  if (args.attachment && args.attachment.contentBase64 && args.attachment.contentBase64 instanceof ArrayBuffer) {
    args.attachment.contentBase64 = toBase64(args.attachment.contentBase64);
  }

  // 1) Try Resend if configured
  const r = await sendViaResend(env, args);
  if (r !== null) return r; // true/false

  // 2) Otherwise, try MailChannels (requires API key + lockdown now)
  return await sendViaMailchannels(env, args);
}
