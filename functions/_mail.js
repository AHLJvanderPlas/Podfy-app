// functions/_mail.js

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Build the HTML body with metadata
export function buildHtml({ brand, fileName, fileSize, fileKey, uploaderEmail, extra }) {
  const rows = [
    brand ? `<tr><td><b>Brand</b></td><td>${brand}</td></tr>` : "",
    fileName ? `<tr><td><b>File name</b></td><td>${fileName}</td></tr>` : "",
    (fileSize != null) ? `<tr><td><b>File size</b></td><td>${fileSize} bytes</td></tr>` : "",
    `<tr><td><b>R2 Key</b></td><td><code>${fileKey}</code></td></tr>`,
    uploaderEmail ? `<tr><td><b>Uploader email</b></td><td>${uploaderEmail}</td></tr>` : "",
    extra ? `<tr><td><b>Meta</b></td><td><pre>${escapeHtml(JSON.stringify(extra, null, 2))}</pre></td></tr>` : ""
  ].join("");

  return `
  <div style="font-family: ui-sans-serif, system-ui;">
    <h2 style="margin:0 0 12px">New upload${brand ? ` — ${brand}` : ""}</h2>
    <table cellpadding="6" cellspacing="0" style="border-collapse: collapse;">
      ${rows}
    </table>
    <p style="color:#666; font-size:12px; margin-top:16px">
      This message was sent by Podfy after a successful upload.
    </p>
  </div>`;
}

// Pick a dynamic From (brand@podfy.app) with fallback
export function pickFromAddress(env, slug) {
  const domain = env.MAIL_DOMAIN || "podfy.app";
  const safe = (slug || "default").toLowerCase().replace(/[^a-z0-9\-_.]/g, "-");
  return `${safe}@${domain}`;
}

// Send via MailChannels (with optional attachment)
export async function sendMail(env, {
  fromEmail,
  toList,
  subject,
  html,
  text,
  attachment
}) {
  const payload = {
    personalizations: [{ to: toList.map(e => ({ email: e })) }],
    from: { email: fromEmail, name: env.MAIL_FROM || "Podfy App" },
    reply_to: env.REPLY_TO_EMAIL ? [{ email: env.REPLY_TO_EMAIL }] : undefined,
    subject,
    content: [
      { type: "text/plain", value: text || html.replace(/<[^>]+>/g, " ") },
      { type: "text/html", value: html }
    ]
  };

  if (attachment) {
    payload.attachments = [{
      filename: attachment.filename,
      type: attachment.type || "application/octet-stream",
      content: attachment.contentBase64
    }];
  }

  const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("MailChannels error", res.status, body);
  }
}
