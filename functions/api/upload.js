// functions/api/upload.js
// -----------------------------------------------------------------------------
// PODFY Upload API (clean & ordered)
// - Accepts file uploads (multipart or JSON test)
// - Extracts minimal EXIF/location
// - Stores the object in R2
// - Upserts a D1 "transactions" row (idempotent on podfy_id)
// - Sends staff + user (driver) emails
// - Persists driver-copy identity & finalizes process_status
// - Uses uploader local time for upload_date/time (tz → fields.tz | CF | UTC)
// -----------------------------------------------------------------------------

import themes from "../../public/themes.json" assert { type: "json" };
import { resolveEmailTheme, buildHtml, pickFromAddress, sendMail } from "../_mail.js";
import * as exifr from "exifr";

/* =============================================================================
   Helpers (each helper has a short, plain-English explanation)
============================================================================= */

// Returns local date/time strings (YYYY-MM-DD / HH:MM:SS) in a given IANA tz.
// Use this to populate upload_date/upload_time in the user's local time.
function localParts(d = new Date(), timeZone = "UTC") {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  return { local_date: `${parts.year}-${parts.month}-${parts.day}`, local_time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

// Formats date/time for filenames/subjects and returns friendly pieces.
// Purely cosmetic—does not affect database timekeeping.
function formatLocalDateTime(date = new Date(), timeZone = "UTC") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  return { ymd: `${parts.year}${parts.month}${parts.day}`, hhmm: `${parts.hour}${parts.minute}`, display: `${parts.year}-${parts.month}-${parts.day} at ${parts.hour}:${parts.minute}` };
}

// Returns UTC upload_date/upload_time; kept for completeness/testing.
function utcParts(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return { upload_date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, upload_time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` };
}

// Computes a SHA-256 hex of ArrayBuffer data (used for file checksum).
const enc = new TextEncoder();
async function sha256Hex(buffer) {
  try {
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}

// Computes a SHA-256 hex of a text string (used for hashing email addresses).
async function sha256HexText(str) { return sha256Hex(enc.encode(str)); }

// Creates an HMAC-SHA256 hex signature (used to sign preview URLs, if enabled).
async function hmacSHA256(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Returns the domain part of an email address (example.com from a@b).
function emailDomain(addr) {
  const m = String(addr || "").toLowerCase().match(/^[^@]+@([^@]+)$/); return m ? m[1] : null;
}

// Parses "Name <email@domain>" into {name,email}; falls back to noreply@domain.
function parseFromNameAddr(str, fallbackDomain = "podfy.app") {
  if (!str) return { name: "Podfy App", email: `noreply@${fallbackDomain}` };
  const m = String(str).match(/^\s*(.+?)\s*<\s*([^>]+)\s*>\s*$/);
  if (m) return { name: m[1], email: m[2] };
  if (str.includes("@")) return { name: "Podfy App", email: str.trim() };
  return { name: "Podfy App", email: `noreply@${fallbackDomain}` };
}

// Maps a short qualifier to a canonical source string (for DB consistency).
function mapPresentedSource(qualifier) {
  switch (String(qualifier || "").toUpperCase()) {
    case "GPS": return "gps";
    case "IMG": return "exif";
    case "IP":  return "ip";
    case "MANUAL": return "manual";
    default: return "unknown";
  }
}

// Builds a user-friendly map link for given coordinates (Google Maps universal).
function buildMapUrl(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  return `https://www.google.com/maps?q=${lat},${lon}`;
}

// Normalizes subscription plan to a 2-letter code; returns null if unknown.
function normalizeSubscriptionCode(s) {
  if (!s) return null;
  const x = String(s).trim().toUpperCase();
  if (["TR","BA","AD","PR","PM","EN","UN"].includes(x)) return x;
  const map = { TRIAL:"TR", BASIC:"BA", ADVANCED:"AD", PRO:"PR", PREMIUM:"PM", ENTERPRISE:"EN", UNKNOWN:"UN" };
  return map[x] || null;
}

// Upserts a single transactions row; preserves original created_at if it exists.
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
  const meta_json_text = row.meta_json != null ? JSON.stringify(row.meta_json) : null;
  const location_raw_json_text = row.location_raw_json != null ? JSON.stringify(row.location_raw_json) : null;
  await DB.prepare(sql).bind(
    row.podfy_id, row.slug, row.upload_date, row.upload_time,
    row.podfy_id,
    row.reference, row.presented_loc_url, row.presented_label, row.presented_source,
    row.picture_url, row.original_filename, row.uploaded_file_type, row.file_size_bytes,
    row.storage_bucket, row.storage_key, row.driver_copy_sent, row.process_status,
    row.invoice_group_id, row.subscription_code, row.uploader_user_id, row.user_agent, row.app_version, meta_json_text,
    row.file_checksum, row.delivery_issue_code, row.delivery_issue_notes, location_raw_json_text
  ).run();
  return true;
}

// Returns a quick file-kind guess from header bytes; blocks unknown/suspicious.
function sniffKind(bytes) {
  const b = new Uint8Array(bytes);
  const h = (i, n) => [...b.slice(i, i+n)].map(x=>x.toString(16).padStart(2,"0")).join("");
  if (h(0,4) === "25504446") return "pdf";                       // %PDF
  if (h(0,3) === "ffd8ff") return "jpg";                         // JPEG
  if (h(0,4) === "89504e47") return "png";                       // PNG
  if (h(0,4) === "52494646" && new TextDecoder().decode(b.slice(8,12)) === "WEBP") return "webp";
  if (h(4,4) === "66747970") {                                   // ftyp (HEIF family)
    const brand = new TextDecoder().decode(b.slice(8,12)).toLowerCase();
    if (["heic","heif","mif1","hevc","hevx","heis","hevm"].includes(brand)) return "heic";
  }
  return "unknown";
}

// URL-encodes every path segment safely (prevents broken URLs).
const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

// Converts an ArrayBuffer to base64 (used to inline small attachments in email).
function abToBase64(arrayBuffer) {
  const CHUNK = 0x8000;
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

// Generates a short, URL-safe business id if none provided.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const randomId = (len = 8) => Array.from(crypto.getRandomValues(new Uint8Array(len))).map((b) => crockford[b % crockford.length]).join("");

// Updates process_status to a terminal or intermediate state (best-effort).
async function setProcessStatus(DB, podfyId, status) {
  try {
    await DB.prepare(`UPDATE transactions SET process_status = ? WHERE podfy_id = ?`).bind(status, podfyId).run();
  } catch (e) {
    // Last-resort: log only; never throw from status update
    console.error("process_status update failed:", status, podfyId, e);
  }
}

/* =============================================================================
   Request parsing (accepts multipart form-data or JSON test payloads)
============================================================================= */

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set(["application/pdf","image/jpeg","image/png","image/heic","image/heif","image/webp"]);
const ALLOWED_EXT  = new Set(["pdf","jpg","jpeg","png","heic","heif","webp"]);

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
        lat: (form.get("lat") || "").toString(),
        lon: (form.get("lon") || "").toString(),
        accuracy: (form.get("accuracy") || form.get("acc") || "").toString(),
        locTs: (form.get("loc_ts") || "").toString(),
        podfyId: (form.get("podfyId") || "").toString(),
        dateTime: (form.get("dateTime") || "").toString(),
        previewUrl: (form.get("previewUrl") || "").toString(),
        honeypot: (form.get("company_website") || "").toString(),          // bot trap
        issuedAt: (form.get("form_issued_at") || "").toString(),           // anti-rapid submit
        tz: (form.get("tz") || "").toString(),                             // optional uploader tz
        issue: (form.get("issue") || "").toString(),                       // driver issue checkbox
        issue_code: (form.get("issue_code") || "").toString(),             // optional code
        issue_notes: (form.get("issue_notes") || "").toString(),           // optional notes
        subscription_code: (form.get("subscription_code") || form.get("subscription") || "").toString(),
      },
    };
  }
  // JSON test mode (no file stream; base64 content is accepted)
  const json = await request.json();
  return {
    mode: "json",
    file: null,
    fields: {
      brand: (json.brand || json.slug || "default"),
      reference: (json.reference || ""),
      emailCopy: (json.email || json.uploaderEmail || ""),
      lat: (json.lat || ""), lon: (json.lon || ""),
      accuracy: (json.accuracy || json.acc || ""),
      locTs: (json.loc_ts || ""),
      podfyId: (json.podfyId || ""),
      dateTime: (json.dateTime || ""),
      previewUrl: (json.previewUrl || ""),
      honeypot: (json.company_website || ""),
      issuedAt: (json.form_issued_at || ""),
      base64: (json.base64 || ""),
      fileName: (json.fileName || "upload.bin"),
      contentType: (json.contentType || "application/octet-stream"),
      tz: (json.tz || ""),
      issue: (json.issue || ""),
      issue_code: (json.issue_code || ""),
      issue_notes: (json.issue_notes || ""),
      subscription_code: (json.subscription_code || json.subscription || ""),
    },
  };
}

/* =============================================================================
   Handler
============================================================================= */

export const onRequestPost = async ({ request, env }) => {
  const { PODFY_BUCKET } = env;

  try {
    // Parse request
    const { mode, file, fields } = await parseRequest(request);
    let { brand, reference, emailCopy, lat, lon, accuracy, locTs, podfyId, dateTime, previewUrl } = fields;

    /* --- Bot & origin protection ------------------------------------------------ */
    {
      // 1) Honeypot: if bots filled this hidden field, reject early.
      const hp = (fields.honeypot || "").toString().trim();
      if (hp) return new Response(JSON.stringify({ ok:false, error:"Rejected" }), { status: 400 });

      // 2) Form must be at least 2s old (reduces scripted bursts).
      const t0 = parseInt((fields.issuedAt || "0").toString(), 10);
      if (!t0 || Date.now() - t0 < 2000) return new Response(JSON.stringify({ ok:false, error:"Too fast" }), { status: 400 });

      // 3) Origin allowlist: allow current host and configured prod URL.
      const origin = request.headers.get("origin") || "";
      const selfOrigin = new URL(request.url).origin;
      const cfgOrigin = (env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
      const allowed = new Set([selfOrigin]); if (cfgOrigin) allowed.add(cfgOrigin);
      if (!origin || !allowed.has(origin)) return new Response(JSON.stringify({ ok:false, error:"Bad origin" }), { status: 403 });
    }

    /* --- Brand resolution -------------------------------------------------------- */
    const firstPathSegment = (u) => {
      try {
        const parts = new URL(u).pathname.split("/").filter(Boolean);
        if (!parts.length) return "";
        const skip = new Set(["api","logo","media","_assets","_static","_worker"]);
        return skip.has(parts[0].toLowerCase()) ? "" : parts[0].toLowerCase();
      } catch { return ""; }
    };
    const normalizeBrand = (slug, themesObj) => {
      const s = (slug || "").toLowerCase().replace(/[^a-z0-9-_.]/g, "-");
      return s && Object.prototype.hasOwnProperty.call(themesObj, s) ? s : "default";
    };
    let resolvedBrand = (brand || fields.slug || "").toLowerCase();
    if (!resolvedBrand) {
      const ref = request.headers.get("referer") || "";
      resolvedBrand = firstPathSegment(ref) || firstPathSegment(request.url) || "";
    }
    brand = normalizeBrand(resolvedBrand, themes);
    console.log("resolved brand:", brand, { posted: fields.brand || fields.slug || "", referer: request.headers.get("referer") || "", url: request.url });

    const theme = resolveEmailTheme(brand, themes);
    const mailToList = (theme.mailTo ? [theme.mailTo] : [])
      .concat(env.MAIL_TO || [])
      .flatMap((s) => String(s).split(","))
      .map((s) => s.trim())
      .filter(Boolean);

    /* --- Time & IDs -------------------------------------------------------------- */
    const tzForNames = request.cf?.timezone || "UTC";
    const { ymd, hhmm, display } = formatLocalDateTime(new Date(), tzForNames);
    if (!podfyId) podfyId = randomId(8);
    if (!dateTime) dateTime = display;

    /* --- Driver issue flags from form (UI may come later) ------------------------ */
    const driverIssue =
      String(fields.issue || "").toLowerCase() === "1" ||
      String(fields.issue || "").toLowerCase() === "true" ||
      String(fields.issue || "").toLowerCase() === "on";
    const driverIssueCode  = driverIssue ? (fields.issue_code  ? String(fields.issue_code).trim()  : "") : "";
    const driverIssueNotes = driverIssue ? (fields.issue_notes ? String(fields.issue_notes).trim() : "") : "";

    /* --- Load file --------------------------------------------------------------- */
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

    /* --- Optional EXIF extraction (GPS & timestamp) ------------------------------ */
    let exifLat = null, exifLon = null, exifDateIso = null;
    try {
      const isImage =
        contentType.startsWith("image/") &&
        (contentType.includes("jpeg") || contentType.includes("png") || contentType.includes("webp") || contentType.includes("heic") || contentType.includes("heif"));
      let exif;
      if (isImage && (!lat || !lon)) {
        exif = await exifr.parse(new Uint8Array(buffer), { gps: true, tiff: true });
        if (exif && typeof exif.latitude === "number" && typeof exif.longitude === "number") { exifLat = exif.latitude; exifLon = exif.longitude; }
      }
      if (!dateTime && exif?.DateTimeOriginal instanceof Date) exifDateIso = exif.DateTimeOriginal.toISOString();
    } catch { /* ignore EXIF failures */ }

    /* --- Location selection (prefer GPS → EXIF IMG → IP) ------------------------- */
    let locationSource = "NONE";
    let numLat = (typeof lat === "number") ? lat : parseFloat(lat);
    let numLon = (typeof lon === "number") ? lon : parseFloat(lon);
    if (Number.isFinite(numLat) && Number.isFinite(numLon)) {
      locationSource = "GPS";
    } else if (Number.isFinite(exifLat) && Number.isFinite(exifLon)) {
      numLat = exifLat; numLon = exifLon; locationSource = "IMG";
    } else {
      const cfLat = parseFloat(request.cf?.latitude);
      const cfLon = parseFloat(request.cf?.longitude);
      if (Number.isFinite(cfLat) && Number.isFinite(cfLon)) { numLat = cfLat; numLon = cfLon; locationSource = "IP"; }
    }
    let numAcc = (typeof accuracy === "number") ? accuracy : parseFloat(accuracy);
    if (!Number.isFinite(numAcc)) numAcc = (locationSource === "IP") ? 50000 : null;
    if (!dateTime && exifDateIso) dateTime = exifDateIso;
    if (Number.isFinite(numLat) && Number.isFinite(numLon)) { lat = numLat; lon = numLon; }
    accuracy = Number.isFinite(numAcc) ? numAcc : null;

    // Map-friendly label/source/url for the chosen coordinates (user facing + DB)
    const methodTag =
      locationSource === "IMG" ? "IMG" :
      locationSource === "GPS" ? "GPS" :
      locationSource === "IP"  ? "IP"  : "UNKNOWN";
    const presented_source = mapPresentedSource(locationSource);
    const mapUrl = (Number.isFinite(lat) && Number.isFinite(lon)) ? buildMapUrl(lat, lon) : "";

    /* --- Build base locationMeta (raw facts) ------------------------------------ */
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
      locationMeta = {
        locationQualifier: locationSource,
        lat: String(lat), lon: String(lon),
        ...(accuracy ? { accuracyM: String(accuracy) } : {}),
        ...(locTs ? { locationTimestamp: String(locTs) } : {}),
      };
    } else if (Number.isFinite(parseFloat(cf.latitude)) && Number.isFinite(parseFloat(cf.longitude))) {
      locationMeta = {
        locationQualifier: "IP",
        lat: String(cf.latitude), lon: String(cf.longitude),
        ipCountry: ipCountryISO2 || "", ipPostal: ipPostal || "",
        locationCode: buildLocationCode(ipCountryISO2, ipPostal),
      };
    }

    // Enrich raw JSON with final decisions (used by admin views/debugging)
    locationMeta = {
      ...locationMeta,
      finalLat: Number.isFinite(lat) ? String(lat) : "",
      finalLon: Number.isFinite(lon) ? String(lon) : "",
      finalAccuracyM: Number.isFinite(accuracy) ? String(accuracy) : "",
      methodTag,
      presentedSource: presented_source,
      ipCountry: locationMeta.ipCountry || (request.cf?.country || ""),
      ipPostal: locationMeta.ipPostal || (request.cf?.postalCode || ""),
    };

    // Meta subset used in the email template (kept small and human-friendly)
    const meta = {
      locationQualifier: locationMeta.locationQualifier || "",
      lat: locationMeta.lat || "",
      lon: locationMeta.lon || "",
      locationCode: locationMeta.locationCode || "",
    };

    /* --- File validations -------------------------------------------------------- */
    if (!buffer || buffer.byteLength === 0) return new Response(JSON.stringify({ ok:false, error:"Empty file" }), { status: 400 });
    if (buffer.byteLength > MAX_BYTES) return new Response(JSON.stringify({ ok:false, error:"File too large (max 25 MB)" }), { status: 413 });
    const head = buffer.slice(0, 32);
    const kind = sniffKind(head);
    const safeName = (fileName || "upload").toLowerCase();
    const extFromName = safeName.includes(".") ? safeName.split(".").pop() : "";
    const mimeOk = ALLOWED_MIME.has(contentType);
    const extOk  = ALLOWED_EXT.has(extFromName);
    if (kind === "unknown" || !(mimeOk || extOk)) return new Response(JSON.stringify({ ok:false, error:"Unsupported or suspicious file" }), { status: 415 });

    /* --- Key & metadata ---------------------------------------------------------- */
    const safeBase = (fileName.replace(/[^A-Za-z0-9_.-]/g, "_") || "upload");
    const dot = safeBase.lastIndexOf(".");
    const ext = dot > -1 ? safeBase.slice(dot + 1).toLowerCase() : "bin";
    const nameNoExt = dot > -1 ? safeBase.slice(0, dot) : safeBase;

    const cleanRef = (reference || "").replace(/[^A-Za-z0-9._-]/g, "");
    const { ymd: y, hhmm: hm } = formatLocalDateTime(new Date(), tzForNames);
    const finalBase = [y, hm, podfyId, brand, ...(cleanRef ? [cleanRef] : [])].join("_");
    const key = `${brand}/${finalBase}.${ext}`;

    /* --- Store in R2 ------------------------------------------------------------- */
    await PODFY_BUCKET.put(key, buffer, {
      httpMetadata: { contentType, contentDisposition: `attachment; filename="${finalBase}.${ext}"` },
      customMetadata: {
        podfy_id: podfyId, reference: cleanRef, slug: brand,
        orig_name: fileName, orig_type: contentType,
        uploader_email: emailCopy || "",
        ...locationMeta,
      },
    });

    /* --- Preview URL (signed if configured) -------------------------------------- */
    const mediaBase = (env.MEDIA_BASE_URL || env.PUBLIC_BASE_URL || "https://podfy.net").replace(/\/+$/, "");
    let imagePreviewUrl = "";
    if (contentType.startsWith("image/") && env.SIGNED_MEDIA_SECRET) {
      const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;
      const sig = await hmacSHA256(env.SIGNED_MEDIA_SECRET, `${key}:${exp}`);
      imagePreviewUrl = `${mediaBase}/media/${encodePath(key)}?e=${exp}&sig=${sig}`;
    } else if (contentType.startsWith("image/") && previewUrl) {
      imagePreviewUrl = previewUrl;
    }

    /* --- Insert/Upsert transaction in D1 ----------------------------------------- */
    try {
      let tzUpload = (fields.tz || request.cf?.timezone || "UTC");
      try { new Intl.DateTimeFormat("en-CA", { timeZone: tzUpload }).format(new Date()); } catch { tzUpload = "UTC"; }
      const { local_date, local_time } = localParts(new Date(), tzUpload);

      const fallbackUrl = `${mediaBase}/media/${encodePath(key)}`;
      const pictureUrl = imagePreviewUrl || fallbackUrl;
      const file_checksum = await sha256Hex(buffer);
      const subscription_code = normalizeSubscriptionCode(fields.subscription_code || fields.subscription || themes[brand]?.subscriptionCode || null);

      await upsertTransaction(env.DB, {
        podfy_id: podfyId,
        slug: brand,
        upload_date: local_date,
        upload_time: local_time,
        reference: cleanRef || null,
        presented_loc_url: mapUrl,        // map link of final coordinates
        presented_label: methodTag,       // IMG | GPS | IP | UNKNOWN
        presented_source,                 // exif | gps | ip | unknown
        picture_url: pictureUrl,
        original_filename: fileName || null,
        uploaded_file_type: contentType || null,
        file_size_bytes: buffer.byteLength,
        storage_bucket: env.PODFY_BUCKET_NAME || "podfy",
        storage_key: key,
        driver_copy_sent: 0,
        process_status: driverIssue ? "issue_reported" : "received",
        invoice_group_id: local_date.slice(0, 7),
        subscription_code,
        uploader_user_id: null,
        user_agent: request.headers.get("user-agent") || null,
        app_version: env.APP_VERSION || null,
        meta_json: { via: "upload", tz: tzUpload, dateTime },
        file_checksum,
        delivery_issue_code: driverIssue ? driverIssueCode : "",
        delivery_issue_notes: driverIssue ? driverIssueNotes : "",
        location_raw_json: locationMeta,
      });
      console.log("D1 upsert OK:", podfyId);
    } catch (e) {
      console.error("D1 upsert failed (non-fatal):", e);
      await setProcessStatus(env.DB, podfyId, "error_d1");
    }

    /* --- Build email content ----------------------------------------------------- */
    const html = buildHtml({
      brand,
      brandName: theme.brandName,
      theme: { brandColor: theme.brandColor, logo: theme.logo },
      fileName: `${finalBase}.${ext}`,
      podfyId,
      dateTime,
      meta,
      reference: cleanRef || "",
      imageUrlBase: mediaBase,
      imagePreviewUrl,
    });

    const brandForSubject = theme.brandName || brand;
    const yyyyMmDd = (dateTime || "").split(" at ")[0] || `${y.slice(0,4)}-${y.slice(4,6)}-${y.slice(6,8)}`;
    const subjectStaff = `POD | ${brandForSubject}${cleanRef ? ` | ${cleanRef}` : ""} | ${yyyyMmDd} by Podfy`;

    // Prepare a small attachment if the file size is below limit.
    let attachment = null;
    try {
      const maxMb = Number(env.MAX_ATTACH_MB || 8);
      if (buffer.byteLength <= maxMb * 1024 * 1024) {
        attachment = { filename: `${finalBase}.${ext}`, type: contentType, contentBase64: abToBase64(buffer) };
      } else {
        console.log("Attachment skipped (over MAX_ATTACH_MB)", { sizeBytes: buffer.byteLength, maxBytes: maxMb * 1024 * 1024 });
      }
    } catch (e) {
      console.error("Attachment prepare error:", e);
      // Not fatal; do not change status for attachment decision.
    }

    const fromEnvelope = pickFromAddress(env, brand);
    const { name: fromName, email: fromEmail } = parseFromNameAddr(env.MAIL_FROM, env.MAIL_DOMAIN || "podfy.app");
    console.log("email from envelope:", fromEnvelope, "| display name:", fromName, "| display email:", fromEmail);

    const common = {
      brand,
      brandName: theme.brandName,
      theme: { brandColor: theme.brandColor, logo: theme.logo },
      fileName: `${finalBase}.${ext}`,
      podfyId,
      dateTime,
      meta,
      reference: cleanRef || "",
      imageUrlBase: mediaBase,
      attachment,
    };

    /* --- Send staff email -------------------------------------------------------- */
    let okStaff = false;
    try {
      if (mailToList.length) {
        okStaff = await sendMail(env, { fromEmail: fromEnvelope, toList: mailToList, subject: subjectStaff, html, ...common });
        console.log("staff mail sent?", okStaff, { to: mailToList, from: fromEnvelope });
        if (!okStaff) await setProcessStatus(env.DB, podfyId, "error_staff_mail");
      } else {
        console.log("no staff recipients resolved");
      }
    } catch (e) {
      console.error("email send (staff) failed:", e);
      await setProcessStatus(env.DB, podfyId, "error_staff_mail");
    }

    /* --- Send user (driver) email ------------------------------------------------ */
    let okUser = false;
    try {
      if (emailCopy) {
        okUser = await sendMail(env, { fromEmail: fromEnvelope, toList: [emailCopy], subject: `We received your file: ${finalBase}.${ext}`, html, ...common });
        console.log("user mail sent?", okUser, { to: emailCopy, from: fromEnvelope });
        if (!okUser) await setProcessStatus(env.DB, podfyId, "error_user_mail");
      }
    } catch (e) {
      console.error("email send (user) failed:", e);
      await setProcessStatus(env.DB, podfyId, "error_user_mail");
    }

    /* --- Persist driver-copy identity & attempt result (no auto-issue) ----------- */
    try {
      if (emailCopy) {
        const domain = emailDomain(emailCopy);
        const hash = await sha256HexText(emailCopy.trim().toLowerCase());
        await env.DB.prepare(`
          UPDATE transactions
             SET copy_email_domain = ?,
                 copy_email_hash   = ?,
                 driver_copy_at    = COALESCE(driver_copy_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           WHERE podfy_id = ?
        `).bind(domain, hash, podfyId).run();

        if (okUser) {
          await env.DB.prepare(`UPDATE transactions SET driver_copy_sent = 1 WHERE podfy_id = ?`).bind(podfyId).run();
        }
        console.log("D1 driver_copy identity persisted:", { podfyId, sent: okUser, domain });
      }
    } catch (e) {
      console.error("D1 driver_copy persistence failed:", e);
      await setProcessStatus(env.DB, podfyId, "error_user_mail"); // best-fit category
    }

    /* --- Finalize process_status ------------------------------------------------- */
    try {
      const shouldBeDelivered = !driverIssue && okStaff && (emailCopy ? okUser : true);
      await env.DB.prepare(`
        UPDATE transactions
           SET process_status = CASE WHEN ?1 THEN 'delivered' ELSE process_status END
         WHERE podfy_id = ?2
      `).bind(shouldBeDelivered ? 1 : 0, podfyId).run();
      if (shouldBeDelivered) console.log("process_status → delivered:", podfyId);
      else console.log("process_status unchanged:", { podfyId, driverIssue, okStaff, okUser, hasDriver: !!emailCopy });
    } catch (e) {
      console.error("final status update failed:", e);
      await setProcessStatus(env.DB, podfyId, "error");
    }

    /* --- Response ---------------------------------------------------------------- */
    return new Response(
      JSON.stringify({ ok: true, key, filename: `${finalBase}.${ext}`, podfyId, dateTime, mail: { staff: okStaff, user: okUser } }),
      { headers: { "content-type": "application/json" } }
    );

  } catch (err) {
    console.error("Upload error:", err);
    // If we crash before D1 insert, we cannot mark status; return 500.
    return new Response(JSON.stringify({ ok: false, error: "Upload failed" }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
};
