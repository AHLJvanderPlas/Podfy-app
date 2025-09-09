// functions/_mail.js

/* ===========================
   Small utilities
   =========================== */

const escapeHtml = (s = "") =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toBase64(ab) {
  const CHUNK = 0x8000;
  const bytes = new Uint8Array(ab);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
// Pick brand theme from themes.json
export function resolveEmailTheme(slug, themes) {
  const t = (themes && themes[slug]) || (themes && themes.default) || {};

  const brandName  = t.brandName || themes?.default?.brandName || "PODFY";
  const brandColor = t.header?.bg || t.colors?.primary || themes?.default?.header?.bg || "#D3D3D3";
  const logo       = t.logo || themes?.default?.logo || "/logos/podfy.png";
  const mailTo     = t.mailTo || themes?.default?.mailTo || "";
  const favicon    = t.favicon || themes?.default?.favicon || "/logos/podfy-favicon.png";

  return { slug, brandName, brandColor, logo, mailTo, favicon };
}
async function fetchBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`logo fetch failed: ${r.status} ${url}`);
  const buf = await r.arrayBuffer();
  return toBase64(buf);
}

/* ===========================
   HTML builder
   =========================== */

export function buildHtml({
  brand,
  brandName,
  theme,
  fileName,
  podfyId,
  dateTime,
  meta,
  reference,
  imageUrlBase,
  inlineCids, // { bannerCid, footerCid }
}) {
  const color = theme?.brandColor || "#D3D3D3";
  const base = (imageUrlBase || "https://podfy.app").replace(/\/+$/, "");
  const bannerSrc = inlineCids?.bannerCid ? `cid:${inlineCids.bannerCid}` : `${base}/logo/${encodeURIComponent(brand || "default")}.png`;
  const footerSrc = inlineCids?.footerCid ? `cid:${inlineCids.footerCid}` : `${base}/logo/default.png`;

  const lat = meta?.lat || "";
  const lon = meta?.lon || "";
  const mapsHref = (lat && lon) ? `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lon}`)}` : "";

  const referenceHtml = reference
    ? `<p style="margin:20px 0 20px 0; line-height:1.5; color:#111827;">The reference of this shipment is <b>${escapeHtml(reference)}</b>.</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="x-apple-disable-message-reformatting">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>POD Notification — ${escapeHtml(brandName || brand || "PODFY")}</title>
</head>
<body style="margin:0; padding:20px; background:#f5f5f5; font-family:-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%; max-width:680px; margin:0 auto;">
    <tr>
      <td style="background:${color}; border-radius:12px 12px 0 0; padding:14px 18px;">
        <img src="${bannerSrc}" alt="${escapeHtml(brandName || brand || "Podfy")} logo" style="display:block; height:28px;">
      </td>
    </tr>
    <tr>
      <td style="background:#ffffff; border-radius:0 0 12px 12px; padding:22px;">
        <p style="margin:0 0 20px 0; line-height:1.5; color:#111827;">Dear ${escapeHtml(brandName || brand || "Customer")},</p>
        <p style="margin:0 0 20px 0; line-height:1.5; color:#111827;">We have received a new POD for your shipment as per attached.</p>
        ${referenceHtml}
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:collapse; margin-top:10px; font-size:14px; color:#374151;">
          <tr><td style="padding:6px 8px; width:200px;">POD upload</td><td style="padding:6px 8px;">${escapeHtml(dateTime || "")}</td></tr>
          <tr><td style="padding:6px 8px; width:200px;">Location qualifier</td><td style="padding:6px 8px;">${escapeHtml(meta?.locationQualifier || "")}</td></tr>
          <tr><td style="padding:6px 8px; width:200px;">Latitude, Longitude</td>
              <td style="padding:6px 8px;">${
                mapsHref
                  ? `<a href="${mapsHref}" target="_blank" rel="noopener" style="color:#1D4ED8; text-decoration:underline;">${escapeHtml(lat)}, ${escapeHtml(lon)}</a>`
                  : ""
              }</td></tr>
          <tr><td style="padding:6px 8px; width:200px;">Location code</td><td style="padding:6px 8px;">${escapeHtml(meta?.locationCode || "")}</td></tr>
        </table>
        <div style="text-align:center; padding:16px 8px 6px; margin-top:40px;">
          <span style="font-size:10px; color:#9CA3AF; display:block; margin-bottom:10px;">This POD is provided by</span>
          <a href="https://podfy.net" target="_blank" rel="noopener" style="display:inline-block;">
            <img src="${footerSrc}" alt="Podfy" style="display:block; height:18px;">
          </a>
          <div style="margin-top:8px; font-size:10px; color:#ffffff; user-select:text;">${escapeHtml(fileName || "")}</div>
        </div>
      </td>
    </tr>
  </table>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%; max-width:640px; margin:0 auto; font-size:12px; line-height:1.4; color:#374151;">
    <tr>
      <td style="padding:4px 2px; text-align:left;">
        <a href="mailto:${escapeHtml((typeof process !== "undefined" && process.env && process.env.REPLY_TO_EMAIL) || "support@podfy.net")}?subject=${encodeURIComponent("Podfy Issue " + (podfyId||""))}" style="color:#374151; text-decoration:underline;">Report an issue</a>
      </td>
      <td style="padding:4px 2px; text-align:center;">
        Podfy-id: ${escapeHtml(podfyId || "")}
      </td>
      <td style="padding:4px 2px; text-align:right;">
        <a href="https://podfy.net/terms" target="_blank" rel="noopener" style="color:#374151; text-decoration:underline;">
          Terms &amp; Conditions
        </a>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ===========================
   Transports
   =========================== */

async function sendViaResend(env, { fromEmail, toList, subject, html, attachmentsAll }) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return null;

  const payload = {
    from: env.MAIL_FROM || `Podfy <${fromEmail}>`,
    to: toList,
    subject,
    html,
    attachments: attachmentsAll?.map(a => ({
      filename: a.filename,
      content: a.contentBase64,
      contentId: a.cid || undefined,
      disposition: a.disposition || (a.cid ? "inline" : "attachment"),
    })),
  };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    if (!res.ok) { console.error("Resend error", res.status, body); return false; }
    console.log("Resend ok", res.status);
    return true;
  } catch (e) {
    console.error("Resend fetch failed", String(e));
    return false;
  }
}

async function sendViaMailchannels(env, { fromEmail, toList, subject, html, text, attachmentsAll }) {
  const headers = { "content-type": "application/json" };
  if (env.MAILCHANNELS_API_KEY) headers["X-Api-Key"] = env.MAILCHANNELS_API_KEY;

  const payload = {
    personalizations: [{ to: toList.map((e) => ({ email: e })) }],
    from: { email: fromEmail, name: env.MAIL_FROM || "Podfy App" },
    subject,
    content: [
      { type: "text/plain", value: text || html.replace(/<[^>]+>/g, " ").slice(0, 10000) },
      { type: "text/html", value: html }
    ],
    attachments: attachmentsAll?.map(a => ({
      filename: a.filename,
      type: a.type || "application/octet-stream",
      content: a.contentBase64,
      content_id: a.cid || undefined,
      content_disposition: a.disposition || (a.cid ? "inline" : "attachment"),
    })),
  };

  try {
    const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    if (!res.ok) { console.error("MailChannels error", res.status, body); return false; }
    console.log("MailChannels ok", res.status);
    return true;
  } catch (e) {
    console.error("MailChannels fetch failed", String(e));
    return false;
  }
}

/* ===========================
   Public sendMail + pickFromAddress
   =========================== */

export async function sendMail(env, args) {
  const { brand, imageUrlBase } = args;
  const base = (imageUrlBase || env.PUBLIC_BASE_URL || "https://podfy.app").replace(/\/+$/,"");

  // Prepare inline logos (CID)
  let inlineCids = null;
  let inlineLogoAttachments = [];
  try {
    const bannerCid = `${(brand || "default")}-banner@podfy`;
    const footerCid = `podfy-footer@podfy`;
    const bannerUrl = `${base}/logo/${encodeURIComponent(brand || "default")}.png`;
    const footerUrl = `${base}/logo/default.png`;

    const [bannerB64, footerB64] = await Promise.all([fetchBase64(bannerUrl), fetchBase64(footerUrl)]);

    inlineLogoAttachments = [
      { filename: `${brand || "default"}-banner.png`, type: "image/png", contentBase64: bannerB64, cid: bannerCid, disposition: "inline" },
      { filename: "podfy-footer.png",               type: "image/png", contentBase64: footerB64, cid: footerCid, disposition: "inline" },
    ];
    inlineCids = { bannerCid, footerCid };
  } catch (e) {
    console.log("Inline logo fetch failed; falling back to remote src:", String(e));
  }

  // Build final HTML (logos use cid: when available)
  const htmlFinal = buildHtml({ ...args, inlineCids });

  // Merge inline logos + original attachment
  const attachmentsAll = [
    ...inlineLogoAttachments,
    ...(args.attachment ? [args.attachment] : []),
  ];

  // Resend -> MailChannels
  const ok = await sendViaResend(env, { ...args, html: htmlFinal, attachmentsAll });
  if (ok !== null) return ok;
  return await sendViaMailchannels(env, { ...args, html: htmlFinal, attachmentsAll });
}

// keep this exported – upload.js still imports it
export function pickFromAddress(env, slug) {
  const domain = env.MAIL_DOMAIN || "podfy.app";
  const safe = (slug || "default").toLowerCase().replace(/[^a-z0-9\-_.]/g, "-");
  const dyn = `${safe}@${domain}`;
  const fallback = `noreply@${domain}`;
  return dyn || fallback;
}
