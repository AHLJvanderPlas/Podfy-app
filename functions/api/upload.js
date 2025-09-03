// functions/api/upload.js

import themes from "../../public/themes.json" assert { type: "json" };
import { resolveEmailTheme, buildHtml, pickFromAddress, sendMail } from "../_mail.js";

// --- utility helpers ---
const nowParts = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return { ymd: `${y}${m}${day}`, hhmm: `${hh}${mm}`, hhmmss: `${hh}${mm}${ss}` };
};

const randomId = (len = 8) =>
  Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[b % 26])
    .join("");

const getContentType = (file) =>
  file?.type || file?.headers?.get?.("Content-Type") || "application/octet-stream";

const asNumber = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

// Try to parse request body as form-data first; fall back to JSON
async function parseRequest(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file") || form.get("upload") || null;
    const payload = {
      brand: form.get("brand") || form.get("slug") || "default",
      reference: form.get("reference") || "",
      emailCopy: form.get("email") || form.get("uploaderEmail") || "",
      meta: {
        locationQualifier: form.get("locationQualifier") || "",
        lat: form.get("lat") || "",
        lon: form.get("lon") || "",
        locationCode: form.get("locationCode") || ""
      },
      // backend-provided identifiers (preferred)
      podfyId: form.get("podfyId") || "",
      dateTime: form.get("dateTime") || "", // "yyyy-mm-dd at hh:mm"
      // optional public preview URL (only if you expose it)
      previewUrl: form.get("previewUrl") || ""
    };
    return { mode: "form", file, payload };
  } else {
    const json = await request.json();
    return {
      mode: "json",
      file: null, // JSON mode expects you to POST file out-of-band; usually you'll use form-data.
      payload: {
        brand: json.brand || json.slug || "default",
        reference: json.reference || "",
        emailCopy: json.email || json.uploaderEmail || "",
        meta: {
          locationQualifier: json.locationQualifier || "",
          lat: json.lat || "",
          lon: json.lon || "",
          locationCode: json.locationCode || ""
        },
        podfyId: json.podfyId || "",
        dateTime: json.dateTime || "",
        previewUrl: json.previewUrl || "",
        // if JSON includes a raw base64 file (not recommended for big files), support it:
        base64: json.base64 || "",
        fileName: json.fileName || "upload.bin",
        contentType: json.contentType || "application/octet-stream"
      }
    };
  }
}

export const onRequestPost = async (context) => {
  const { env, request } = context;
  const { PODFY_BUCKET } = env;

  try {
    // 1) Parse input
    const { mode, file, payload } = await parseRequest(request);
    let { brand, reference, emailCopy, meta, podfyId, dateTime, previewUrl } = payload;
    brand = (brand || "default").toLowerCase();

    // 2) Generate identifiers if backend didn't pass them
    const { ymd, hhmm } = nowParts();
    if (!podfyId) podfyId = randomId(8);
    if (!dateTime) {
      // fallback to "yyyy-mm-dd at hh:mm" in UTC
      dateTime = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)} at ${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;
    }

    // 3) Prepare file buffers / names
    let fileName = "upload.bin";
    let contentType = "application/octet-stream";
    let arrayBuffer = null;

    if (mode === "form" && file) {
      fileName = file.name || fileName;
      contentType = getContentType(file);
      arrayBuffer = await file.arrayBuffer();
    } else if (mode === "json" && payload.base64) {
      fileName = payload.fileName;
      contentType = payload.contentType;
      arrayBuffer = Uint8Array.from(atob(payload.base64), (c) => c.charCodeAt(0)).buffer;
    } else if (mode === "json" && !payload.base64) {
      return new Response(JSON.stringify({ ok: false, error: "No file provided. Use multipart/form-data with 'file'." }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }

    const dot = fileName.lastIndexOf(".");
    const ext = dot > -1 ? fileName.slice(dot + 1).toLowerCase() : "bin";
    const base = dot > -1 ? fileName.slice(0, dot) : fileName;

    // 4) Build R2 key and upload
    const key = `uploads/${brand}/${ymd}/${hhmm}/${podfyId}_${base}.${ext}`;
    const sizeBytes = arrayBuffer.byteLength;

    await PODFY_BUCKET.put(key, arrayBuffer, {
      httpMetadata: { contentType }
    });

    // 5) Prepare email HTML
    const t = resolveEmailTheme(brand, themes);
    const imageIsInlinePreviewable = contentType.startsWith("image/");
    const imagePreviewUrl = imageIsInlinePreviewable ? (previewUrl || "") : "";

    const html = buildHtml({
      brand,
      brandName: t.brandName,
      theme: { brandColor: t.brandColor, logo: t.logo },
      fileName: `${base}.${ext}`,
      podfyId,
      dateTime, // shown as "POD upload"
      meta: {
        locationQualifier: meta?.locationQualifier || "",
        lat: meta?.lat || "",
        lon: meta?.lon || "",
        locationCode: meta?.locationCode || ""
      },
      reference: reference || "",
      imageUrlBase: env.PUBLIC_BASE_URL || "https://podfy.app",
      imagePreviewUrl
    });

    const subject =
      `New POD upload [${brand}]` +
      (reference ? ` — REF ${reference}` : "") +
      `: ${base}.${ext}`;

    // 6) Optional attachment (size guard)
    let attachment = null;
    try {
      const maxAttachMb = asNumber(env.MAX_ATTACH_MB, 8);
      if (sizeBytes <= maxAttachMb * 1024 * 1024) {
        attachment = {
          filename: `${base}.${ext}`,
          type: contentType,
          contentBase64: btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
        };
      }
    } catch (e) {
      console.error("Attachment prepare error:", e);
    }

    // 7) Recipients, From, send
    const fromEmail = pickFromAddress(env, brand);
    const toStaff = []
      .concat(t.mailTo || [])
      .concat(env.MAIL_TO || [])
      .flatMap((s) => String(s).split(","))
      .map((s) => s.trim())
      .filter(Boolean);

    // Fire staff mail
    if (toStaff.length) {
      context.waitUntil(
        sendMail(env, { fromEmail, toList: toStaff, subject, html, attachment })
      );
    }

    // Optional uploader confirmation
    if (emailCopy) {
      const confirmSubject = `We received your file${fileName ? `: ${base}.${ext}` : ""}`;
      context.waitUntil(
        sendMail(env, { fromEmail, toList: [emailCopy], subject: confirmSubject, html, attachment })
      );
    }

    // 8) Respond to client
    return new Response(
      JSON.stringify({
        ok: true,
        slug: brand,
        key,
        podfyId,
        dateTime,
        size: sizeBytes,
        contentType
      }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    console.error("Upload handler error:", err);
    return new Response(JSON.stringify({ ok: false, error: "Upload failed" }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
};
