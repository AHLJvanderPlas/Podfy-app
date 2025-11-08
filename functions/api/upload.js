// functions/api/upload.js

import themes from "../../public/themes.json" assert { type: "json" };
import { resolveEmailTheme, buildHtml, pickFromAddress, sendMail } from "../_mail.js";
import * as exifr from 'exifr';

/* ------------------------------ helpers ------------------------------ */

// ============================================================
// === D1 TRANSACTION HELPERS (Step 2, corrected)
// ============================================================

// --- Convert JS Date → UTC parts ---
function utcParts(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return {
    upload_date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    upload_time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  };
}

// --- Optional SHA-256 checksum for file verification ---
async function sha256Hex(buffer) {
  try {
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

// --- Map internal source tags to schema values ---
function mapPresentedSource(qualifier) {
  switch (String(qualifier || "").toUpperCase()) {
    case "GPS": return "gps";
    case "IMG": return "exif";
    case "IP":  return "ip";
    case "MANUAL": return "manual";
    default: return "unknown";
  }
}

// --- Compact DB upsert routine (idempotent by podfy_id) ---
async function upsertTransaction(DB, row) {
  const sql = `
    INSERT OR REPLACE INTO transactions (
      podfy_id, slug, upload_date, upload_time,
      created_at,
      reference, presented_loc_url, presented_label, presented_source,
      picture_url, original_filename, uploaded_file_type, file_size_bytes,
      storage_bucket, storage_key, driver_copy_sent, process_status,
      invoice_group_id, subscription_code, uploader_user_id, user_agent, app_version, meta_json,
      file_checksum, delivery_issue_code, delivery_issue_notes, location_raw_json
    ) VALUES (
      ?, ?, ?, ?,
      COALESCE((SELECT created_at FROM transactions WHERE podfy_id = ?),
               strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    );
  `;

  const meta_json_text = row.meta_json ? JSON.stringify(row.meta_json) : null;
  const location_raw_json_text = row.location_raw_json ? JSON.stringify(row.location_raw_json) : null;

  const stmt = DB.prepare(sql).bind(
    row.podfy_id, row.slug, row.upload_date, row.upload_time,
    row.podfy_id,
    row.reference, row.presented_loc_url, row.presented_label, row.presented_source,
    row.picture_url, row.original_filename, row.uploaded_file_type, row.file_size_bytes,
    row.storage_bucket, row.storage_key, row.driver_copy_sent, row.process_status,
    row.invoice_group_id, row.subscription_code, row.uploader_user_id, row.user_agent, row.app_version, meta_json_text,
    row.file_checksum, row.delivery_issue_code, row.delivery_issue_notes, location_raw_json_text
  );

  await stmt.run();
  return true;
}

// --- Config ---
const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png',
  'image/heic', 'image/heif',
  'image/webp',
]);
const ALLOWED_EXT  = new Set(['pdf','jpg','jpeg','png','heic','heif','webp']);

// --- Tiny signature sniffer (magic bytes) ---
function sniffKind(bytes) {
  const b = new Uint8Array(bytes);
  const h = (i, n) => [...b.slice(i, i+n)].map(x=>x.toString(16).padStart(2,'0')).join('');
  // %PDF
  if (h(0,4) === '25504446') return 'pdf';
  // JPEG: FF D8 FF
  if (h(0,3) === 'ffd8ff') return 'jpg';
  // PNG: 89 50 4E 47
  if (h(0,4) === '89504e47') return 'png';
  // WEBP: "RIFF" .... "WEBP"
  if (h(0,4) === '52494646' && new TextDecoder().decode(b.slice(8,12)) === 'WEBP') return 'webp';
  // HEIF/HEIC family: "ftyp" with compatible brands
  if (h(4,4) === '66747970') {
    const brand = new TextDecoder().decode(b.slice(8,12)).toLowerCase();
    if (['heic','heif','mif1','hevc','hevx','heis','hevm'].includes(brand)) return 'heic';
  }
  return 'unknown';
}

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
        honeypot: (form.get("company_website") || "").toString(),   // NEW
        issuedAt: (form.get("form_issued_at") || "").toString(),    // NEW
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
      honeypot: (json.company_website || ""), // NEW (for tests only)
      issuedAt: (json.form_issued_at || ""),  // NEW (for tests only)
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

  // --- Bot checks (honeypot + form age + origin) -----------------------
    {
  // Honeypot: reject if filled
  const hp = (fields.honeypot || "").toString().trim();
  if (hp) {
    return new Response(JSON.stringify({ ok:false, error:"Rejected" }), { status: 400 });
  }

  // Form must be at least 2s old
  const t0 = parseInt((fields.issuedAt || "0").toString(), 10);
  if (!t0 || Date.now() - t0 < 2000) {
    return new Response(JSON.stringify({ ok:false, error:"Too fast" }), { status: 400 });
  }

  // Origin must match our public base URL
  const origin = request.headers.get("origin") || "";
  const allowedOrigin = (env.PUBLIC_BASE_URL || "https://podfy.app").replace(/\/+$/,"");
  if (!origin || !origin.startsWith(allowedOrigin)) {
    return new Response(JSON.stringify({ ok:false, error:"Bad origin" }), { status: 403 });
  }
}
    
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

    // --- Try EXIF GPS if browser GPS is missing ---
    let exifLat = null, exifLon = null, exifDateIso = null;
      try {
        const isImage =
          contentType.startsWith('image/') &&
          (contentType.includes('jpeg') || contentType.includes('png') || contentType.includes('webp') || contentType.includes('heic') || contentType.includes('heif'));
      if (isImage && (!lat || !lon)) {
        const exif = await exifr.parse(new Uint8Array(buffer), { gps: true, tiff: true });
      if (exif && typeof exif.latitude === 'number' && typeof exif.longitude === 'number') {
          exifLat = exif.latitude;
          exifLon = exif.longitude;
      }
        
    // Optional: if no dateTime yet, prefer EXIF original timestamp
    if (!dateTime && exif?.DateTimeOriginal instanceof Date) {
      exifDateIso = exif.DateTimeOriginal.toISOString();
    }
  }
} catch { /* ignore EXIF failures, continue */ }

// --- Choose location source: GPS (browser) → IMG (EXIF) → IP (CF) ---
let locationSource = 'NONE';

// Normalize incoming browser GPS
let numLat = (typeof lat === 'number') ? lat : parseFloat(lat);
let numLon = (typeof lon === 'number') ? lon : parseFloat(lon);

if (Number.isFinite(numLat) && Number.isFinite(numLon)) {
  locationSource = 'GPS';
} else if (Number.isFinite(exifLat) && Number.isFinite(exifLon)) {
  numLat = exifLat;
  numLon = exifLon;
  locationSource = 'IMG';
} else {
  // CF city-level coordinates (rough)
  const cfLat = parseFloat(request.cf?.latitude);
  const cfLon = parseFloat(request.cf?.longitude);
  if (Number.isFinite(cfLat) && Number.isFinite(cfLon)) {
    numLat = cfLat;
    numLon = cfLon;
    locationSource = 'IP';
  }
}

// Backfill accuracy: EXIF has none; IP is coarse
let numAcc = (typeof accuracy === 'number') ? accuracy : parseFloat(accuracy);
if (!Number.isFinite(numAcc)) {
  if (locationSource === 'IP') numAcc = 50000; // ~50 km heuristic
  else numAcc = null;
}

// Backfill date/time from EXIF if not provided earlier
if (!dateTime && exifDateIso) {
  dateTime = exifDateIso;
}

// Write normalized values back for downstream code
if (Number.isFinite(numLat) && Number.isFinite(numLon)) {
  lat = numLat;
  lon = numLon;
}
accuracy = Number.isFinite(numAcc) ? numAcc : null;
    
    // --- Authoritative validation (size + kind + allow-list) ------------
{
  if (!buffer || buffer.byteLength === 0) {
    return new Response(JSON.stringify({ ok:false, error:"Empty file" }), { status: 400 });
  }

  if (buffer.byteLength > MAX_BYTES) {
    return new Response(JSON.stringify({ ok:false, error:"File too large (max 25 MB)" }), { status: 413 });
  }

  const head = buffer.slice(0, 32);
  const kind = sniffKind(head);  // 'pdf' | 'jpg' | 'png' | 'webp' | 'heic' | 'unknown'

  const safeName = (fileName || "upload").toLowerCase();
  const extFromName = safeName.includes(".") ? safeName.split(".").pop() : "";
  const mimeOk = ALLOWED_MIME.has(contentType);
  const extOk  = ALLOWED_EXT.has(extFromName);

  // must be a known signature and either mime or ext is allow-listed
  if (kind === "unknown" || !(mimeOk || extOk)) {
    return new Response(JSON.stringify({ ok:false, error:"Unsupported or suspicious file" }), { status: 415 });
  }
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

// Location metadata (now respects locationSource = GPS | IMG | IP)
const cf = request.cf || {};
const ipPostal = (cf.postalCode || "").toString();
const ipCountryISO2 = (cf.country || "").toString().toUpperCase();

const buildLocationCode = (iso2, postal) => {
  if (!iso2) return "";
  const digits = (postal || "").replace(/\D+/g, "");
  const prefix = digits.slice(0, 2);
  return prefix ? `${iso2}${prefix}` : iso2;
};

let locationMeta = { locationQualifier: "", lat: "", lon: "", locationCode: "" };

if (Number.isFinite(lat) && Number.isFinite(lon)) {
  // lat/lon were set by the chooser block (GPS or IMG)
  locationMeta = {
    locationQualifier: locationSource,  // "GPS" or "IMG"
    lat: String(lat),
    lon: String(lon),
    ...(accuracy ? { accuracyM: String(accuracy) } : {}),
    ...(locTs ? { locationTimestamp: String(locTs) } : {}),
  };
} else if (Number.isFinite(parseFloat(cf.latitude)) && Number.isFinite(parseFloat(cf.longitude))) {
  locationMeta = {
    locationQualifier: "IP",
    lat: String(cf.latitude),
    lon: String(cf.longitude),
    ipCountry: ipCountryISO2 || "",
    ipPostal: ipPostal || "",
    locationCode: buildLocationCode(ipCountryISO2, ipPostal),
  };
}
    
// 2) NOW define the meta object used by emails (right after the block above)
const meta = {
  locationQualifier: locationMeta.locationQualifier || "",
  lat: locationMeta.lat || "",
  lon: locationMeta.lon || "",
  locationCode: locationMeta.locationCode || "",
};

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

// Build HTML email (preview only; sendMail will rebuild with CID logos)
const html = buildHtml({
  brand,
  brandName: t.brandName,
  theme: { brandColor: t.brandColor, logo: t.logo },
  fileName: `${finalBase}.${ext}`,
  podfyId,
  dateTime,                 // "POD upload"
  meta,                     // <-- use the const built from locationMeta
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

const common = {
  brand,
  brandName: t.brandName,
  theme: { brandColor: t.brandColor, logo: t.logo },
  fileName: `${finalBase}.${ext}`,
  podfyId,
  dateTime,
  meta,
  reference: cleanRef || "",
  imageUrlBase: env.PUBLIC_BASE_URL || "https://podfy.app",
  attachment,
};

// staff
let okStaff = false;
try {
  if (mailToList.length) {
    okStaff = await sendMail(env, {
      fromEmail: fromEnvelope,
      toList: mailToList,
      subject,
      html,
      ...common,
    });
    console.log("staff mail sent?", okStaff, { to: mailToList, from: fromEnvelope });
  } else {
    console.log("no staff recipients resolved");
  }
} catch (e) {
  console.error("email send (staff) failed (non-fatal):", e);
}

// user copy
let okUser = false;
try {
  if (emailCopy) {
    okUser = await sendMail(env, {
      fromEmail: fromEnvelope,
      toList: [emailCopy],
      subject: `We received your file: ${finalBase}.${ext}`,
      html,
      ...common,
    });
    console.log("user mail sent?", okUser, { to: emailCopy, from: fromEnvelope });
  }
} catch (e) {
  console.error("email send (user) failed (non-fatal):", e);
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
