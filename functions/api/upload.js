// functions/api/upload.js
// Stores files in R2 with new naming and metadata.
// Filename: <PodfyID(8 Crockford)>_<YYYYMMDD>_<HHmm>_<CompanySlug>[_<Reference>].ext
// Also stores customMetadata with SINGLE location + qualifier: "GPS" or "IP".
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

    // --- Client precise geo (from browser) -----------------------------------
    // Only present if the user checked the box and granted permission.
    const latPrecise = form.get("lat");
    const lonPrecise = form.get("lon");
    const accPrecise = form.get("accuracy") || form.get("acc"); // accept acc or accuracy
    const locTs      = form.get("loc_ts");

    // --- IP-based geo (Cloudflare Workers) -----------------------------------
    const cf = request.cf || {};
    const ipLat   = cf.latitude;
    const ipLon   = cf.longitude;
    const ipZip   = (cf.postalCode || "").toString();
    const ipISO2  = (cf.country || "").toString().toUpperCase(); // ISO 3166-1 alpha-2

    // Build the formal ISO2+postal-prefix code, e.g. NL37 / NL10
    const buildLocationCode = (iso2, postal) => {
      if (!iso2) return undefined;
      const digits = (postal || "").replace(/\D+/g, "");
      const prefix = digits.slice(0, 2); // first two digits if available
      return prefix ? `${iso2}${prefix}` : iso2;
    };

    // --- Load per-slug config for mail routing/theme -------------------------
    const themesRes = await fetch(new URL("/themes.json", request.url));
    const themes = await themesRes.json();
    const activeSlug = themes[originalSlug] ? originalSlug : "default";
    const mailTo = (themes[activeSlug] && themes[activeSlug].mailTo) || env.MAIL_TO || "";

    // --- Naming helpers ------------------------------------------------------
    const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I,L,O,U
    function genPodfyId(len = 8) {
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

    // Determine storage folder (keep canonical per company)
    const folder = activeSlug; // flat bucket per brand; no extra per-ref folder

    // Build filename:
    // <PodfyID8>_<YYYYMMDD>_<HHmm>_<CompanySlug>[_<Reference>].ext
    const { ymd, hhmm } = tsParts(new Date());
    const makeBase = (podfyId) => {
      const parts = [podfyId, ymd, hhmm, activeSlug];
      if (reference) parts.push(reference);
      return parts.join("_");
    };

    // Compute object key with collision guard (HEAD → regenerate if exists)
    let podfyId = genPodfyId(8);
    let base = makeBase(podfyId);
    let key = `${folder}/${base}.${ext}`;

    for (let attempt = 0; attempt < 6; attempt++) {
      const exists = await env.PODFY_BUCKET.head(key);
      if (!exists) break; // good to use
      podfyId = genPodfyId(8);
      base = makeBase(podfyId);
      key = `${folder}/${base}.${ext}`;
    }

    // --- Decide SINGLE location + qualifier (GPS preferred; else IP) ---------
    let locationMeta = null;

    if (latPrecise && lonPrecise) {
      // Use precise browser location (user-allowed)
      locationMeta = {
        locationQualifier: "GPS",
        lat: String(latPrecise),
        lon: String(lonPrecise),
        ...(accPrecise ? { accuracyM: String(accPrecise) } : {}),
        ...(locTs ? { locationTimestamp: String(locTs) } : {})
        // No postal/ISO code here (would need reverse geocoding)
      };
    } else if (ipLat && ipLon) {
      // Fallback to IP-based (Cloudflare)
      locationMeta = {
        locationQualifier: "IP",
        lat: String(ipLat),
        lon: String(ipLon),
        ...(ipISO2 ? { locationCode: buildLocationCode(ipISO2, ipZip) } : {})
      };
    }

    // --- Store original file in R2 -------------------------------------------
    const bodyBytes = await file.arrayBuffer();

    // Build minimal custom metadata (trimmed; one location only)
    const customMetadata = {
      // primary identifiers
      podfy_id: podfyId,
      reference: reference || "",

      // storage & slugs
      folder,
      slug_active: activeSlug,
      slug_original: originalSlug,
      slug_known: String(slugKnown),

      // file
      orig_name: safeName,
      orig_type: contentType,

      // uploader
      uploader_email: emailCopy || "",

      // SINGLE location (either GPS or IP)
      ...(locationMeta || {})
    };

    await env.PODFY_BUCKET.put(key, bodyBytes, {
      httpMetadata: {
        contentType,
        contentDisposition: `attachment; filename="${base}.${ext}"`
      },
      customMetadata
    });

    // --- Mail notifications ---------------------------------------------------
    const fromEmail = env.MAIL_FROM || "no-reply@podfy.app";
    const subject   = `POD/CMR received — ${activeSlug}${reference ? ` — REF ${reference}` : ""}`;

    // Compose a single readable location line for the notification
    let locationLine = "Not available";
    if (locationMeta) {
      const q = locationMeta.locationQualifier;
      if (q === "GPS") {
        const accTxt = locationMeta.accuracyM ? ` (~${locationMeta.accuracyM}m)` : "";
        locationLine = `GPS: ${locationMeta.lat},${locationMeta.lon}${accTxt}`;
      } else if (q === "IP") {
        const codeTxt = locationMeta.locationCode ? ` [${locationMeta.locationCode}]` : "";
        locationLine = `IP: ${locationMeta.lat},${locationMeta.lon}${codeTxt}`;
      }
    }

    const text =
`A new POD/CMR was uploaded.

Active slug (routing): ${activeSlug}  ${slugKnown ? "(known)" : "(UNKNOWN; mapped to default)"}
Original slug (from URL): ${originalSlug || "noslug"}
Original file: ${safeName} (${contentType})

Stored: r2://${key}
Podfy ID: ${podfyId}
${reference ? `Reference: ${reference}\n` : ""}

Uploader email copy requested: ${emailCopy ? "Yes" : "No"}
Location: ${locationLine}
`;

    const send = (msg) =>
      fetch("https://api.mailchannels.net/tx/v1/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg)
      });

    // Ops email
    if (mailTo) {
      await send({
        personalizations: [{ to: [{ email: mailTo }] }],
        from: { email: fromEmail, name: "PODFY" },
        subject,
        content: [{ type: "text/plain", value: text }]
      });
    }

    // Copy to uploader (if provided)
    if (emailCopy) {
      await send({
        personalizations: [{ to: [{ email: emailCopy }] }],
        from: { email: fromEmail, name: "PODFY" },
        reply_to: mailTo ? [{ email: mailTo }] : undefined,
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
