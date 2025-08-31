// functions/api/upload.js
// Stores files in R2 with new naming and metadata.
// Filename: <PodfyID(8 Crockford)>_<YYYYMMDD>_<HHmm>_<CompanySlug>[_<Reference>].ext
// Also stores customMetadata: { podfy_id, reference, slug_active, slug_original, ... }
// Includes a HEAD collision check: regenerates ID if the key already exists.

export const onRequestPost = async ({ request, env }) => {
  try {
    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("multipart/form-data")) {
      return new Response("Bad Request", { status: 400 });
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!file) return new Response("Missing file", { status: 400 });

    // --- Slug handling -------------------------------------------------------
    const providedSlug = String(form.get("slug_original") || form.get("brand") || "").trim();
    const originalSlug = providedSlug.toLowerCase().replace(/[^a-z0-9-]/g, "");
    const slugKnown    = String(form.get("slug_known") || "").trim() === "1";

    // Optional reference from the form (posted by public/main.js)
    const referenceRaw = String(form.get("reference") || "").trim();
    const reference    = referenceRaw.replace(/[^A-Za-z0-9._-]/g, ""); // filename-safe

    // Uploader email (optional)
    const emailCopy = String(form.get("email") || "").trim();

    // Optional client geo from the form
    const lat    = form.get("lat") || "";
    const lon    = form.get("lon") || "";
    const acc    = form.get("acc") || "";
    const loc_ts = form.get("loc_ts") || "";

    // --- Server-side approximate geo (from Cloudflare) -----------------------
    const cf = request.cf || {};
    const ip_lat = cf.latitude ? String(cf.latitude) : "";
    const ip_lon = cf.longitude ? String(cf.longitude) : "";
    const ip_city = cf.city || "";
    const ip_country = cf.country || "";
    const ip_region = cf.region || "";
    const ip_continent = cf.continent || "";
    const ip_co = cf.colo || "";

    // --- Load per-slug config for mail routing/theme -------------------------
    const themesRes = await fetch(new URL("/themes.json", request.url));
    const themes = await themesRes.json();
    const activeSlug = themes[originalSlug] ? originalSlug : "default";
    const mailTo = (themes[activeSlug] && themes[activeSlug].mailTo) || env.MAIL_TO || "";

    // --- Naming helpers ------------------------------------------------------
    const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I,L,O,U
    function genPodfyId(len = 8) {
      // crypto.getRandomValues is available in workers
      const bytes = new Uint8Array(len);
      crypto.getRandomValues(bytes);
      let out = "";
      for (let i = 0; i < len; i++) out += crockford[bytes[i] % crockford.length];
      return out;
    }
    function tsParts(d = new Date()) {
      const pad = (n, w = 2) => String(n).padStart(w, "0");
      const y = String(d.getFullYear());
      const m = pad(d.getMonth() + 1);
      const day = pad(d.getDate());
      const hh = pad(d.getHours());
      const mm = pad(d.getMinutes()); // minutes only (no seconds)
      return { ymd: `${y}${m}${day}`, hhmm: `${hh}${mm}` };
    }

    // sanitize filename
    const safeName = (file.name || "upload.bin").replace(/[^A-Za-z0-9_.-]/g, "_");
    const ext = safeName.includes(".") ? safeName.split(".").pop() : "bin";
    const contentType = file.type || "application/octet-stream";

    // Determine storage folder to keep compatibility (use activeSlug so it’s canonical)
    // If you want a flat bucket, set folder = activeSlug or simply omit folder usage below.
    const folder = activeSlug; // do NOT create extra subfolders for reference

    // Build filename:
    // <PodfyID8>_<YYYYMMDD>_<HHmm>_<CompanySlug>[_<Reference>].ext
    const { ymd, hhmm } = tsParts(new Date());

    // Compose base name with optional reference
    const makeBase = (podfyId) => {
      const parts = [podfyId, ymd, hhmm, activeSlug];
      if (reference) parts.push(reference);
      return parts.join("_");
    };

    // Compute object key with collision guard (HEAD → regenerate if exists)
    let podfyId = genPodfyId(8);
    let base = makeBase(podfyId);
    let key = `${folder}/${base}.${ext}`;

    // Up to 6 attempts is more than enough; collisions are already astronomically rare
    for (let attempt = 0; attempt < 6; attempt++) {
      const exists = await env.PODFY_BUCKET.head(key);
      if (!exists) break; // good to use
      // regenerate a new ID and rebuild key
      podfyId = genPodfyId(8);
      base = makeBase(podfyId);
      key = `${folder}/${base}.${ext}`;
    }

    // --- Store original file in R2 -------------------------------------------
    const bodyBytes = await file.arrayBuffer();
    await env.PODFY_BUCKET.put(key, bodyBytes, {
      httpMetadata: {
        contentType,
        contentDisposition: `attachment; filename="${base}.${ext}"`
      },
      customMetadata: {
        // primary identifiers
        podfy_id: podfyId,         // store the 8-char Crockford ID
        reference: reference || "",

        // storage & slugs
        folder,                     // e.g., "dsv" or "default"
        slug_active: activeSlug,    // used for routing/theme
        slug_original: originalSlug,// what the driver typed
        slug_known: String(slugKnown),

        // file
        orig_name: safeName,
        orig_type: contentType,

        // uploader
        uploader_email: emailCopy || "",

        // client GPS (if provided)
        lat: String(lat || ""),
        lon: String(lon || ""),
        acc: String(acc || ""),
        loc_ts: String(loc_ts || ""),

        // IP-based geo
        ip_lat, ip_lon, ip_city, ip_country, ip_region, ip_continent, ip_co
      }
    });

    // --- Mail notifications ---------------------------------------------------
    const fromEmail = env.MAIL_FROM || "no-reply@podfy.app";
    const subject   = `POD/CMR received — ${activeSlug}${reference ? ` — REF ${reference}` : ""}`;

    const locLineClient = (lat && lon) ? `${lat},${lon}${acc ? ` (~${acc}m)` : ""}` : "Not provided";
    const locLineIP = (ip_lat && ip_lon)
      ? `${ip_lat},${ip_lon} (${ip_city || "?"}, ${ip_region || "?"}, ${ip_country || "?"})`
      : "Not available";

    const text =
`A new POD/CMR was uploaded.

Active slug (routing): ${activeSlug}  ${slugKnown ? "(known)" : "(UNKNOWN; mapped to default)"}
Original slug (from URL): ${originalSlug || "noslug"}
Original file: ${safeName} (${contentType})

Stored: r2://${key}
Podfy ID: ${podfyId}
${reference ? `Reference: ${reference}\n` : ""}

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

    // Copy to uploader (if provided)
    if (emailCopy) {
      await send({
        personalizations: [{ to: [{ email: emailCopy }] }],
        from: { email: fromEmail, name: "PODFY" },
        reply_to: [{ email: mailTo }],
        subject: "Copy of your uploaded POD/CMR",
        content: [{ type: "text/plain", value: `Thanks. Your file has been received.\n${reference ? `Reference: ${reference}\n` : ""}Podfy ID: ${podfyId}` }]
      });
    }

    return new Response(JSON.stringify({ ok: true, key, name: `${base}.${ext}`, podfy_id: podfyId, reference }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  } catch (err) {
    return new Response("Upload failed", { status: 500 });
  }
};
