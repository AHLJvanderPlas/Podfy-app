// functions/api/upload.js

import themes from "../../public/themes.json" assert { type: "json" };
import { resolveEmailTheme, buildHtml, pickFromAddress, sendMail } from "../_mail.js";

/* ------------------------------ helpers ------------------------------ */

// random 8-char Podfy ID (Crockford alphabet: no I/L/O/U)
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const randomId = (len = 8) =>
  Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map((b) => crockford[b % crockford.length])
    .join("");

// format date/time in a specific IANA timezone (e.g., "Europe/Amsterdam")
function formatLocalDateTime(date = new Date(), timeZone = "UTC") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return {
    ymd: `${parts.year}${parts.month}${parts.day}`, // for filename
    hhmm: `${parts.hour}${parts.minute}`,           // for filename
    display: `${parts.year}-${parts.month}-${parts.day} at ${parts.hour}:${parts.minute}`, // email
  };
}

// Safe base64 encoder (prevents "Maximum call stack size exceeded")
function abToBase64(arrayBuffer) {
  const CHUNK = 0x8000; // 32 KB
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// split `Name <email@domain>` or `email@domain` → { name, email }
function parseFromNameAddr(str, fallbackDomain = "podfy.app") {
  if (!str) return { name: "Podfy App", email: `noreply@${fallbackDomain}` };
  const m = String(str).match(/^\s*(.+?)\s*<\s*([^>]+)\s*>\s*$/);
  if (m) return { name: m[1], email: m[2] };
  if (str.includes("@")) return { name: "Podfy App", email: str.trim() };
  return { name: "Podfy App", email: `noreply@${fallbackDomain}` };
}

// optional: HMAC signing for preview URLs
const enc = new TextEncoder();
async function hmacSHA256(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

// parse request (form-data preferred; JSON supported for testing)
async function parseRequest(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file") || form.get("upload");
    if (!file) throw new Error("Missing file");

    return {
      mode: "form",
      file,
      fields: {
        brand: (form.get("brand") || form.get("slug") || "default").toString(),
        reference: (form.get("reference") || "").toString(),
        emailCopy: (form.get("email") || form.get("uploaderEmail") || "").toString(),

        // precise (browser) geo
        lat: (form.get("lat") || "").toString(),
        lon: (form.get("lon") || "").toString(),
        accuracy: (form.get("accuracy") || form.get("acc") || "").toString(),
        locTs: (form.get("loc_ts") || "").toString(),

        // backend-provided (preferred)
        podfyId: (form.get("podfyId") || "").toString(),
        dateTime: (form.get("dateTime") || "").toString(), // "yyyy-mm-dd at hh:mm"

        // if you already expose a preview URL, you may provide it
        previewUrl: (form.get("previewUrl") || "").toString(),
      },
    };
  }

  const json = await request.json();
  return {
    mode: "json",
    file: null,
    fields: {
      brand: (json.brand || json.slug || "default"),
      reference: (json.reference || ""),
      emailCopy: (json.email || json.uploaderEmail || ""),
      lat: (json.lat || ""),
      lon: (json.lon || ""),
      accuracy: (json.accuracy || json.acc || ""),
      locTs: (json.loc_ts || ""),
      podfyId: (json.podfyId || ""),
      dateTime: (json.dateTime || ""),
      previewUrl: (json.previewUrl || ""),
      base64: (json.base64 || ""), // optional for tests only
      fileName: (json.fileName || "upload.bin"),
      contentType: (json.contentType || "application/octet-stream"),
    },
  };
}

/* ------------------------------ handler ------------------------------ */

export const onRequestPost = async ({ request, env }) => {
  const { PODFY_BUCKET } = env;

  try {
    const { mode, file, fields } = await parseRequest(request);
    let { brand, reference, emailCopy, lat, lon, accuracy, locTs, podfyId, dateTime, previewUrl } = fields;
// --- Brand resolution (form -> Referer -> URL), then validate against themes.json
function firstPathSegment(u) {
  try {
    const parts = new URL(u).pathname.split("/").filter(Boolean);
    if (!parts.length) return "";
    const skip = new Set(["api","logo","media","_assets","_static","_worker"]);
    return skip.has(parts[0].toLowerCase()) ? "" : parts[0].toLowerCase();
  } catch { return ""; }
}
function normalizeBrand(slug, themesObj) {
  const s = (slug || "").toLowerCase().replace(/[^a-z0-9-_.]/g, "-");
  return s && Object.prototype.hasOwnProperty.call(themesObj, s) ? s : "default";
}

let resolvedBrand = (brand || fields.slug || "").toLowerCase();
if (!resolvedBrand) {
  const ref = request.headers.get("referer") || "";
  resolvedBrand = firstPathSegment(ref) || firstPathSegment(request.url) || "";
}
brand = normalizeBrand(resolvedBrand, themes);
console.log("resolved brand:", brand, {
  posted: fields.brand || fields.slug || "",
  referer: request.headers.get("referer") || "",
  url: request.url
});

// Theme & routing from themes.json (now that brand is final)
const t = resolveEmailTheme(brand, themes);
    const mailToList = (t.mailTo ? [t.mailTo] : [])
      .concat(env.MAIL_TO || [])
      .flatMap((s) => String(s).split(","))
      .map((s) => s.trim())
      .filter(Boolean);

    // Timezone-aware identifiers (filename + email "POD upload")
    const tz = request.cf?.timezone || "UTC";
    const { ymd, hhmm, display } = formatLocalDateTime(new Date(), tz);

    if (!podfyId) podfyId = randomId(8);
    if (!dateTime) dateTime = display;

    // Load file
    let fileName = "upload.bin";
    let contentType = "application/octet-stream";
    let buffer;

    if (mode === "form") {
      fileName = file.name || fileName;
      contentType = file.type || contentType;
      buffer = await file.arrayBuffer();
    } else {
      if (!fields.base64) throw new Error("No file provided. Use multipart/form-data.");
      fileName = fields.fileName;
      contentType = fields.contentType;
      buffer = Uint8Array.from(atob(fields.base64), (c) => c.charCodeAt(0)).buffer;
    }

    // Sanitize name pieces
    const safeBase = (fileName.replace(/[^A-Za-z0-9_.-]/g, "_") || "upload");
    const dot = safeBase.lastIndexOf(".");
    const ext = dot > -1 ? safeBase.slice(dot + 1).toLowerCase() : "bin";
    const nameNoExt = dot > -1 ? safeBase.slice(0, dot) : safeBase;

    // Build final filename
const cleanRef = (reference || "").replace(/[^A-Za-z0-9._-]/g, "");
const baseNameParts = [ymd, hhmm, podfyId, brand];
if (cleanRef) baseNameParts.push(cleanRef); // keep ref if provided (no "REF" prefix)
const finalBase = baseNameParts.join("_");

    // Flat key: <slug>/<filename>
    const key = `${brand}/${finalBase}.${ext}`;

    // Location metadata: prefer precise (GPS), else CF IP geo
    const cf = request.cf || {};
    const ipLat = cf.latitude;
    const ipLon = cf.longitude;
    const ipPostal = (cf.postalCode || "").toString();
    const ipCountryISO2 = (cf.country || "").toString().toUpperCase();

    const buildLocationCode = (iso2, postal) => {
      if (!iso2) return "";
      const digits = (postal || "").replace(/\D+/g, "");
      const prefix = digits.slice(0, 2);
      return prefix ? `${iso2}${prefix}` : iso2;
    };

    let locationMeta = {};
    if (lat && lon) {
      locationMeta = {
        locationQualifier: "GPS",
        lat: String(lat),
        lon: String(lon),
        ...(accuracy ? { accuracyM: String(accuracy) } : {}),
        ...(locTs ? { locationTimestamp: String(locTs) } : {}),
      };
    } else if (ipLat && ipLon) {
      locationMeta = {
        locationQualifier: "IP",
        lat: String(ipLat),
        lon: String(ipLon),
        ipCountry: ipCountryISO2 || "",
        ipPostal: ipPostal || "",
        locationCode: buildLocationCode(ipCountryISO2, ipPostal),
      };
    } else {
      locationMeta = { locationQualifier: "", lat: "", lon: "", locationCode: "" };
    }

    // Store in R2
    await PODFY_BUCKET.put(key, buffer, {
      httpMetadata: {
        contentType,
        contentDisposition: `attachment; filename="${finalBase}.${ext}"`,
      },
      customMetadata: {
        podfy_id: podfyId,
        reference: cleanRef,
        slug: brand,
        orig_name: fileName,
        orig_type: contentType,
        uploader_email: emailCopy || "",
        ...locationMeta,
      },
    });

    // Optional signed preview URL for images
    let imagePreviewUrl = "";
    if (contentType.startsWith("image/") && env.SIGNED_MEDIA_SECRET) {
      const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7 days
      const sig = await hmacSHA256(env.SIGNED_MEDIA_SECRET, `${key}:${exp}`);
      const base = (env.PUBLIC_BASE_URL || "https://podfy.app").replace(/\/+$/, "");
      imagePreviewUrl = `${base}/media/${encodePath(key)}?e=${exp}&sig=${sig}`;
    } else if (contentType.startsWith("image/") && previewUrl) {
      imagePreviewUrl = previewUrl; // if provided externally
    }

    // Build HTML email
    const html = buildHtml({
      brand,
      brandName: t.brandName,
      theme: { brandColor: t.brandColor, logo: t.logo },
      fileName: `${finalBase}.${ext}`,
      podfyId,
      dateTime, // shown as "POD upload"
      meta: {
        locationQualifier: locationMeta.locationQualifier || "",
        lat: locationMeta.lat || "",
        lon: locationMeta.lon || "",
        locationCode: locationMeta.locationCode || "",
      },
      reference: cleanRef || "",
      imageUrlBase: env.PUBLIC_BASE_URL || "https://podfy.app",
      imagePreviewUrl,
    });

// Subject: POD | {Brand} (| {ref} if present) | {yyyy-mm-dd}
const brandForSubject = t.brandName || brand;
const yyyyMmDd = (dateTime || "").split(" at ")[0] || `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`;
const subject = `POD | ${brandForSubject}${cleanRef ? ` | ${cleanRef}` : ""} | ${yyyyMmDd} by Podfy`;

// Attachment guard (use chunked base64 to avoid stack overflow)
let attachment = null;
try {
  const maxMb = Number(env.MAX_ATTACH_MB || 8);
  if (buffer.byteLength <= maxMb * 1024 * 1024) {
    attachment = {
      filename: `${finalBase}.${ext}`,
      type: contentType,
      contentBase64: abToBase64(buffer),  // ← chunked encoder
    };
  } else {
    console.log("Attachment skipped (over MAX_ATTACH_MB)", {
      sizeBytes: buffer.byteLength,
      maxBytes: maxMb * 1024 * 1024
    });
  }
} catch (e) {
  console.error("Attachment prepare error:", e);
}

    // From envelope + debug
    const fromEnvelope = pickFromAddress(env, brand);
    const { name: fromName, email: fromEmail } = parseFromNameAddr(env.MAIL_FROM, env.MAIL_DOMAIN || "podfy.app");
    console.log("email from envelope:", fromEnvelope, "| display name:", fromName, "| display email:", fromEmail);

    // Send to staff (with debug)
    let okStaff = false;
if (mailToList.length) {
  okStaff = await sendMail(env, {
    fromEmail: fromEnvelope,
    toList: mailToList,
    subject,
    html, // _mail.js will rebuild HTML to use CID logos; keeping this is fine
    brand,                                        // <-- add
    imageUrlBase: env.PUBLIC_BASE_URL || "https://podfy.app", // <-- add
    attachment,
  });
  console.log("staff mail sent?", okStaff, { to: mailToList, from: fromEnvelope });
    } else {
      console.log("no staff recipients resolved");
    }

    // Optional copy to uploader (with debug)
    let okUser = false;
if (emailCopy) {
  okUser = await sendMail(env, {
    fromEmail: fromEnvelope,
    toList: [emailCopy],
    subject: `We received your file: ${finalBase}.${ext}`, // keep or use 'subject'
    html,
    brand,                                        // <-- add
    imageUrlBase: env.PUBLIC_BASE_URL || "https://podfy.app", // <-- add
    attachment,
  });
  console.log("user mail sent?", okUser, { to: emailCopy, from: fromEnvelope });
}

    return new Response(
      JSON.stringify({
        ok: true,
        key,
        filename: `${finalBase}.${ext}`,
        podfyId,
        dateTime,
        mail: { staff: okStaff, user: okUser },
      }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    console.error("Upload error:", err);
    return new Response(JSON.stringify({ ok: false, error: "Upload failed" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};
