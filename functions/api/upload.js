// functions/api/upload.js
export const onRequestPost = async ({ request, env }) => {
  try {
    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("multipart/form-data")) {
      return new Response("Bad Request", { status: 400 });
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!file) return new Response("Missing file", { status: 400 });

    // Slug handling
    const slugOriginal = String(form.get("slug_original") || form.get("brand") || "default")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");
    const slugKnown = String(form.get("slug_known") || "").trim() === "1";
    const slug = slugKnown ? slugOriginal : "default";

    // Optional uploader email (copy)
    const emailCopy = form.get("email") ? String(form.get("email")) : "";

    // Optional client-provided GPS
    const lat = form.get("lat") || "";
    const lon = form.get("lon") || "";
    const acc = form.get("acc") || "";
    const loc_ts = form.get("loc_ts") || "";

    // Server-side approximate IP geo (no prompt)
    const cf = request.cf || {};
    const ip_lat = cf.latitude ? String(cf.latitude) : "";
    const ip_lon = cf.longitude ? String(cf.longitude) : "";
    const ip_city = cf.city || "";
    const ip_country = cf.country || "";
    const ip_region = cf.region || "";
    const ip_continent = cf.continent || "";
    const ip_co = cf.colo || "";

    // Load per-slug config
    const themesRes = await fetch(new URL("/themes.json", request.url));
    const themes = await themesRes.json();
    const theme = themes[slug] || themes["default"];
    const mailTo = theme.mailTo || env.MAIL_TO || "";

    // File naming
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const ymd = `${y}${m}${d}`;
    const hms = `${hh}${mm}${ss}`;
    const id = crypto.randomUUID().slice(0, 8);

    const safeName = (file.name || "upload.bin").replace(/[^A-Za-z0-9_.-]/g, "_");
    const ext = safeName.includes(".") ? safeName.split(".").pop() : "bin";
    const mime = file.type || "application/octet-stream";
    const base = `${slug || "pod"}_${ymd}_${hms}_${id}`;
    const key = `${y}/${m}/${base}.${ext}`;

    // Store original file as-is in R2
    await env.PODFY_BUCKET.put(key, file.stream(), {
      httpMetadata: {
        contentType: mime,
        contentDisposition: `attachment; filename="${base}.${ext}"`
      },
      customMetadata: {
        slug,
        slug_original: slugOriginal,
        slug_known: String(slugKnown),
        orig_name: safeName,
        orig_type: mime,
        uploader_email: emailCopy || "",
        // client GPS (if provided)
        lat: String(lat || ""),
        lon: String(lon || ""),
        acc: String(acc || ""),
        loc_ts: String(loc_ts || ""),
        // IP-based geo
        ip_lat, ip_lon, ip_city, ip_region, ip_country, ip_continent, ip_co
      }
    });

    // Emails (ops + optional copy)
    const fromEmail = env.MAIL_FROM || `noreply@${env.MAIL_DOMAIN || "podfy.app"}`;
    const subject =
      `[PODFY] ${slug.toUpperCase()} ${ymd} ${hms} (${safeName})` +
      (slugKnown ? "" : ` [UNKNOWN:${slugOriginal}]`);

    const locLineClient = (lat && lon)
      ? `${lat},${lon} (±${acc || "?"} m) at ${loc_ts || "?"}`
      : "Not provided";
    const locLineIP = (ip_lat && ip_lon)
      ? `${ip_lat},${ip_lon} (${ip_city || "?"}, ${ip_region || "?"}, ${ip_country || "?"})`
      : "Not available";

    const text =
`A new POD/CMR was uploaded.

Slug used: ${slug}
Original slug: ${slugOriginal} (${slugKnown ? "known" : "UNKNOWN"})
Original file: ${safeName} (${mime})
Stored: r2://${key}

Uploader email copy requested: ${emailCopy ? "Yes" : "No"}
Client GPS (permission-based): ${locLineClient}
Server IP-based location: ${locLineIP}
`;

    const send = (msg) =>
      fetch("https://api.mailchannels.net/tx/v1/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg)
      });

    // Ops email
    await send({
      personalizations: [{ to: [{ email: mailTo }] }],
      from: { email: fromEmail, name: "PODFY" },
      subject,
      content: [{ type: "text/plain", value: text }]
    });

    // Copy to uploader if provided
    if (emailCopy) {
      await send({
        personalizations: [{ to: [{ email: emailCopy }] }],
        from: { email: fromEmail, name: theme.brandName || "PODFY" },
        reply_to: [{ email: mailTo }],
        subject: "Copy of your uploaded POD/CMR",
        content: [{ type: "text/plain", value: `Thanks. Your file has been received.\nReference: ${base}` }]
      });
    }

    return new Response(JSON.stringify({ ok: true, key, name: `${base}.${ext}` }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  } catch {
    return new Response("Upload failed", { status: 500 });
  }
};
