// functions/_mail.js

/* ============================================================
   Utilities
   ============================================================ */

const escapeHtml = (s = "") =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Convert ArrayBuffer to base64 in chunks (prevents stack overflow on big files)
function toBase64(arrayBuffer) {
  const CHUNK = 0x8000; // 32KB
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Ensure absolute URL if you pass root-relative paths
const fullUrl = (base, path) => {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const b = (base || "").replace(/\/+$/, "");
  return path.startsWith("/") ? `${b}${path}` : `${b}/${path}`;
};

// Some email clients dislike SVG logos. Prefer PNG.
const pickLogoUrl = (imageBase, urlFromTheme) => {
  const fallback = "/logos/podfy.png";
  let u = urlFromTheme || fallback;
  if (!/\.(svg|png|jpg|jpeg)(\?.*)?$/i.test(u)) u = `${u}.png`;        // NEW: add .png if no ext
  if (/\.svg(\?.*)?$/i.test(u)) u = u.replace(/\.svg(\?.*)?$/i, ".png$1");
  return fullUrl(imageBase, u);
};

/* ============================================================
   Theme resolver (themes.json shape)
   ============================================================ */

export function resolveEmailTheme(slug, themes) {
  const t = (themes && themes[slug]) || (themes && themes.default) || {};
  const podfyDefaultColor = themes?.default?.header?.bg || "#D3D3D3";
  const podfyDefaultLogo  = themes?.default?.logo       || "/logos/podfy.png";

  return {
    slug,
    brandName: t.brandName || themes?.default?.brandName || "PODFY",
    brandColor: t.header?.bg || t.colors?.primary || podfyDefaultColor,
    logo: t.logo || podfyDefaultLogo,
    mailTo: t.mailTo || themes?.default?.mailTo || ""
  };
}

/* ============================================================
   HTML builder — tuned for Outlook/Gmail
   - Inline styles everywhere
   - Encoded maps link (`,` => %2C)
   - PNG logos preferred (no inline image embedding for now)
   ============================================================ */

export function buildHtml({
  brand,               // slug
  brandName,           // resolved display name
  theme,               // { brandColor, logo }
  fileName,            // "20250904_0011_ABCDEFGH_default_ref_orig-name.jpg"
  podfyId,             // 8-char
  dateTime,            // "yyyy-mm-dd at hh:mm"
  meta,                // { locationQualifier, lat, lon, locationCode }
  reference,           // optional
  imageUrlBase,        // e.g. env.PUBLIC_BASE_URL
}) {
  const color        = theme?.brandColor || "#D3D3D3";
  const logoUrl      = pickLogoUrl(imageUrlBase, theme?.logo);
  const podfyLogoUrl = fullUrl(imageUrlBase || "", "/logos/podfy.png");

  const lat = meta?.lat || "";
  const lon = meta?.lon || "";
  const hasCoords = lat && lon;
  const mapsHref = hasCoords
    ? `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lon}`)}`
    : "";

  const referenceHtml = reference
    ? `<p style="margin:20px 0 20px 0; line-height:1.5; color:#111827;">The reference of this shipment is <b>${escapeHtml(reference)}</b>.</p>`
    : "";

  // Email body
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="x-apple-disable-message-reformatting">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>POD Notification — ${escapeHtml(brandName || brand || "PODFY")}</title>
</head>
<body style="margin:0; padding:20px; background:#f5f5f5; font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%; max-width:680px; margin:0 auto;">
    <tr>
      <td style="background:${color}; border-radius:12px 12px 0 0; padding:14px 18px;">
        <img
           src="${logoUrl}" alt="${escapeHtml(brandName || brand || "PODFY")} logo" width="147"
           style="display:block;border:0;outline:0;text-decoration:none;width:147px;height:auto;-ms-interpolation-mode:bicubic;">
      </td>
    </tr>

    <tr>
      <td style="background:#ffffff; border-radius:0 0 12px 12px; padding:22px;">
        <p style="margin:0 0 20px 0; line-height:1.5; color:#111827;">Dear ${escapeHtml(brandName || brand || "Customer")},</p>

        <p style="margin:0 0 20px 0; line-height:1.5; color:#111827;">We have received a new POD for your shipment as per attached.</p>

        ${referenceHtml}

        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:collapse; margin-top:10px; font-size:14px; color:#374151;">
          <tr>
            <td style="padding:6px 8px; width:200px;">POD upload</td>
            <td style="padding:6px 8px;">${escapeHtml(dateTime || "")}</td>
          </tr>
          <tr>
            <td style="padding:6px 8px; width:200px;">Location qualifier</td>
            <td style="padding:6px 8px;">${escapeHtml(meta?.locationQualifier || "")}</td>
          </tr>
          <tr>
            <td style="padding:6px 8px; width:200px;">Latitude, Longitude</td>
            <td style="padding:6px 8px;">
              ${hasCoords
                ? `<a href="${mapsHref}" target="_blank" rel="noopener" style="color:#1D4ED8; text-decoration:underline;">${escapeHtml(lat)}, ${escapeHtml(lon)}</a>`
                : ""}
            </td>
          </tr>
          <tr>
            <td style="padding:6px 8px; width:200px;">Location code</td>
            <td style="padding:6px 8px;">${escapeHtml(meta?.locationCode || "")}</td>
          </tr>
        </table>

        <!-- footer inside card -->
        <div style="text-align:center; padding:16px 8px 6px; margin-top:40px;">
          <span style="font-size:10px; color:#9CA3AF; display:block; margin-bottom:10px;">This POD is provided by</span>
          <a href="https://podfy.net" target="_blank" rel="noopener" style="display:inline-block;">
            <img src="${podfyLogoUrl}" alt="Podfy" width="72"
              style="display:block;border:0;outline:0;text-decoration:none;width:72px;height:auto;-ms-interpolation-mode:bicubic;">
          </a>
          <div style="margin-top:8px; font-size:10px; color:#ffffff; user-select:text;">${escapeHtml(fileName || "")}</div>
        </div>
      </td>
    </tr>
  </table>

  <!-- bottom bar -->
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%; max-width:680px; margin:0 auto; font-size:10px; color:#374151;">
    <tr>
      <td style="padding:0 22px; text-align:left;">
        <a href="mailto:${escapeHtml((typeof process !== "undefined" && process.env && process.env.REPLY_TO_EMAIL) || "support@podfy.net")}?subject=${encodeURIComponent("Podfy Issue " + (podfyId||""))}" style="color:#374151; text-decoration:underline;">Report an issue</a>
      </td>
      <td style="padding:0 22px; text-align:center;">
        <a href="https://podfy.net/terms" target="_blank" rel="noopener" style="color:#374151; text-decoration:underline;">Terms &amp; Conditions</a>
      </td>
      <td style="padding:0 22px; text-align:right;">
        Podfy-id: ${escapeHtml(podfyId || "")}
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ============================================================
   From address (envelope)
   ============================================================ */

export function pickFromAddress(env, slug) {
  const domain = env.MAIL_DOMAIN || "podfy.app";
  const safe = (slug || "default").toLowerCase().replace(/[^a-z0-9\-_.]/g, "-");
  return `${safe}@${domain}` || `noreply@${domain}`;
}

/* ============================================================
   Transport: Resend first, MailChannels fallback
   ============================================================ */

// Resend
async function sendViaResend(env, { fromEmail, toList, subject, html, attachment }) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return null; // not configured, fall back

  try {
    console.log("Resend: preparing", { from: fromEmail, to: toList, subject, hasAttachment: !!attachment });

    const payload = {
      from: env.MAIL_FROM || `Podfy <${fromEmail}>`, // display name + envelope
      to: toList,
      subject,
      html,
      attachments: attachment
        ? [{ filename: attachment.filename, content: (attachment.contentBase64 instanceof ArrayBuffer) ? toBase64(attachment.contentBase64) : attachment.contentBase64 }]
        : undefined
    };

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
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

// MailChannels (requires API key + domain lockdown nowadays)
async function sendViaMailchannels(env, { fromEmail, toList, subject, html, text, attachment }) {
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
    attachments: attachment
      ? [{
          filename: attachment.filename,
          type: attachment.type || "application/octet-stream",
          content: (attachment.contentBase64 instanceof ArrayBuffer)
            ? toBase64(attachment.contentBase64)
            : attachment.contentBase64
        }]
      : undefined
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

/* ============================================================
   Public sender
   ============================================================ */

export async function sendMail(env, args) {
  // 1) Try Resend if available
  const r = await sendViaResend(env, args);
  if (r !== null) return r;

  // 2) Otherwise try MailChannels
  return await sendViaMailchannels(env, args);
}
