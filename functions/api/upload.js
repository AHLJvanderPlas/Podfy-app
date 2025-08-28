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

    const emailCopy = form.get("email") ? String(form.get("email")) : "";
    const lat = form.get("lat") || "";
    const lon = form.get("lon") || "";
    const acc = form.get("acc") || "";
    const loc_ts = form.get("loc_ts") || "";

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
    const origExt = safeName.includes(".") ? safeName.split(".").pop() : "bin";
    const origType = file.type || "application/octet-stream";

    // Decide whether to convert to PDF
    const isPdf = origType === "application/pdf" || /\.pdf$/i.test(safeName);
    const isPng = origType === "image/png" || /\.png$/i.test(safeName);
    const isJpg = origType === "image/jpeg" || /\.jpe?g$/i.test(safeName);

    // Try to import pdf-lib, but fall back gracefully if unavailable
    let PDFDocument = null;
    try {
      ({ PDFDocument } = await import("pdf-lib"));
    } catch {
      // no-op: conversion will be skipped
    }

    let bodyToStore;            // ArrayBuffer | Uint8Array
    let storedMime;             // string
    let storedExt;              // string
    let conversionNote = "";    // for email text

    const originalBytes = await file.arrayBuffer();

    if (isPdf) {
      // Pass-through
      bodyToStore = originalBytes;
      storedMime = "application/pdf";
      storedExt = "pdf";
      conversionNote = "No conversion (already PDF).";
    } else if ((isPng || isJpg) && PDFDocument) {
      // Convert single image → single-page PDF using pdf-lib
      const imgBytes = new Uint8Array(originalBytes);
      const pdfDoc = await PDFDocument.create();
      const image = isPng ? await pdfDoc.embedPng(imgBytes) : await pdfDoc.embedJpg(imgBytes);
      const width = image.width;
      const height = image.height;
      const page = pdfDoc.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });
      const pdfBytes = await pdfDoc.save();
      bodyToStore = pdfBytes;               // Uint8Array
      storedMime = "application/pdf";
      storedExt = "pdf";
      conversionNote = `Converted ${isPng ? "PNG" : "JPEG"} → PDF.`;
    } else {
      // Pass-through for other types OR when pdf-lib is not available
      bodyToStore = originalBytes;
      storedMime = origType;
      storedExt = origExt;
      conversionNote = isPng || isJpg
        ? "No conversion (pdf-lib unavailable)."
        : "No conversion (unsupported type).";
    }

    const base = `${slug || "pod"}_${ymd}_${hms}_${id}`;
    const key = `${y}/${m}/${base}.${storedExt}`;

    // Store in R2 with metadata
    await env.PODFY_BUCKET.put(key, bodyToStore, {
      httpMetadata: {
        contentType: storedMime,
        contentDisposition: `attachment; filename="${base}.${storedExt}"`
      },
      customMetadata: {
        slug,
        slug_original: slugOriginal,
        slug_known: String(slugKnown),
        orig_name: safeName,
        orig_type: origType,
        converted_to: storedMime,
        conversion_note: conversionNote,
        uploader_email: emailCopy || "",
        lat: String(lat || ""),
        lon: String(lon || ""),
        acc: String(acc || ""),
        loc_ts: String(loc_ts || "")
      }
    });

    // Email via MailChannels
    const fromEmail = env.MAIL_FROM || `noreply@${env.MAIL_DOMAIN || "podfy.app"}`;
    const subject =
      `[PODFY] ${slug.toUpperCase()} ${ymd} ${hms} (${safeName})` +
      (slugKnown ? "" : ` [UNKNOWN:${slugOriginal}]`);
    const text =
`A new POD/CMR was uploaded.

Slug used: ${slug}
Original slug: ${slugOriginal} (${slugKnown ? "known" : "UNKNOWN"})
Original file: ${safeName} (${origType})
Stored: r2://${key}
Conversion: ${conversionNote}

Email copy requested: ${emailCopy ? "Yes" : "No"}
Location: ${lat && lon ? `${lat},${lon} (±${acc || "?"} m) at ${loc_ts || "?"}` : "Not provided"}
`;

    const send = (msg) =>
      fetch("https://api.mailchannels.net/tx/v1/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg)
      });

    await send({
      personalizations: [{ to: [{ email: mailTo }] }],
      from: { email: fromEmail, name: "PODFY" },
      subject,
      content: [{ type: "text/plain", value: text }]
    });

    if (emailCopy) {
      await send({
        personalizations: [{ to: [{ email: emailCopy }] }],
        from: { email: fromEmail, name: theme.brandName || "PODFY" },
        subject: "Copy of your uploaded POD/CMR",
        content: [{ type: "text/plain", value: `Thanks. Your file has been received.\nReference: ${base}` }]
      });
    }

    return new Response(JSON.stringify({ ok: true, key, name: `${base}.${storedExt}` }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  } catch (err) {
    // console.error(err); // (optional) log in Workers dashboard
    return new Response("Upload failed", { status: 500 });
  }
};
