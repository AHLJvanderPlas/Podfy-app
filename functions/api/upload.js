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
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/* =============================================================================
   Recipient loading/parsing from slug_settings.email_recipients
   -----------------------------------------------------------------------------
   PURPOSE:
   This helper replaces the old theme-based mail addresses and instead retrieves
   recipient settings from the database table `slug_settings`, column
   `email_recipients`.

   WHY:
   Each slug (brand/customer) can define its own To, CC, and BCC recipients.
   These values are stored as JSON in the database. They may appear as arrays
   or as comma-separated strings. This code normalizes, validates, and deduplicates
   them before sending the email.

   EXAMPLE STORED JSON SHAPES SUPPORTED:
   {
     "to": ["a@company.com", "b@company.com"],
     "cc": "manager@company.com, team@company.com",
     "bcc": []
   }

   BEHAVIOUR:
   - Reads JSON safely (parses if stringified).
   - Accepts arrays or comma-separated strings.
   - Removes duplicates and invalid addresses.
   - Ensures proper precedence:
        TO > CC > BCC (an address in TO is removed from CC/BCC, and from CC removed from BCC)
   - Returns clean arrays ready for Resend or MailChannels.
============================================================================= */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // Basic email validation regex

/**
 * Split a string on commas and trim whitespace.
 * Example: "a@x.com, b@x.com" → ["a@x.com", "b@x.com"]
 */
function splitComma(v) {
  return String(v || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Normalizes possible JSON inputs (array or comma-separated string)
 * into a single flat array of strings.
 */
function normalizeList(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.flatMap(splitComma);
  return splitComma(x); // handle plain string
}

/**
 * Cleans and validates all emails.
 * - Lowercases
 * - Removes empties
 * - Removes duplicates
 * - Checks with simple EMAIL_RE
 */
function sanitizeEmails(list) {
  const set = new Set();
  for (const raw of list) {
    const e = String(raw || "").trim().toLowerCase();
    if (e && EMAIL_RE.test(e)) set.add(e);
  }
  return Array.from(set);
}

/**
 * Enforces recipient precedence:
 * - Anything in TO is removed from CC and BCC.
 * - Anything in CC is removed from BCC.
 */
function precedenceDedup({ to, cc, bcc }) {
  const TO  = new Set(to);
  const CC  = new Set(cc);
  const BCC = new Set(bcc);
  for (const e of TO) { CC.delete(e); BCC.delete(e); }
  for (const e of CC) { BCC.delete(e); }
  return { to: Array.from(TO), cc: Array.from(CC), bcc: Array.from(BCC) };
}

/**
 * Loads and resolves recipients for the given slug.
 * Reads from D1 database column `slug_settings.email_recipients`.
 *
 * Accepts both:
 *   - Proper JSON object (already parsed)
 *   - JSON text (stringified)
 * and safely normalizes it into arrays of valid email addresses.
 */
async function loadRecipientsFromDB(DB, slug) {
  // Query database
  const row = await DB.prepare(
    "SELECT email_recipients FROM slug_settings WHERE slug = ?"
  ).bind(slug).first();

  // Return empty lists if nothing found
  if (!row || !row.email_recipients) return { to: [], cc: [], bcc: [] };

  // Try to parse JSON if it’s stored as a string
  let cfg;
  try {
    cfg =
      typeof row.email_recipients === "string"
        ? JSON.parse(row.email_recipients)
        : row.email_recipients;
  } catch {
    cfg = {};
  }

  // Normalize and sanitize all three lists
  const to  = sanitizeEmails(normalizeList(cfg.to));
  const cc  = sanitizeEmails(normalizeList(cfg.cc));
  const bcc = sanitizeEmails(normalizeList(cfg.bcc));

  // Apply precedence and return
  return precedenceDedup({ to, cc, bcc });
}

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

async function loadPdfStampFlags(DB, brand) {
  // Sensible defaults (change if you want default OFF)
  const DEFAULT = { enableHeader: true, enableFooter: true };

  try {
    // Detect key column + stamp columns (supports a few likely names)
    const cols = await DB.prepare(`PRAGMA table_info(slug_details);`).all();
    const names = new Set((cols?.results || []).map(r => String(r.name || "").toLowerCase()));

    const keyCol = names.has("slug") ? "slug" : (names.has("brand") ? "brand" : null);
    if (!keyCol) return DEFAULT;

    const headerCol =
      names.has("pdf_header") ? "pdf_header" :
      names.has("enable_pdf_header") ? "enable_pdf_header" :
      names.has("pdf_stamp_header") ? "pdf_stamp_header" :
      null;

    const footerCol =
      names.has("pdf_footer") ? "pdf_footer" :
      names.has("enable_pdf_footer") ? "enable_pdf_footer" :
      names.has("pdf_stamp_footer") ? "pdf_stamp_footer" :
      null;

    // If neither column exists, keep defaults
    if (!headerCol && !footerCol) return DEFAULT;

    const selectCols = [headerCol, footerCol].filter(Boolean).join(", ");
    const row = await DB.prepare(
      `SELECT ${selectCols} FROM slug_details WHERE ${keyCol} = ? LIMIT 1`
    ).bind(brand).first();

    if (!row) return DEFAULT;

    const toBool = (v, fallback) => {
      if (v == null) return fallback;
      const s = String(v).trim().toLowerCase();
      return s === "1" || s === "true" || s === "on" || s === "yes";
    };

    return {
      enableHeader: headerCol ? toBool(row[headerCol], DEFAULT.enableHeader) : DEFAULT.enableHeader,
      enableFooter: footerCol ? toBool(row[footerCol], DEFAULT.enableFooter) : DEFAULT.enableFooter,
    };
  } catch (e) {
    console.error("pdf stamp flags lookup failed:", e);
    return DEFAULT;
  }
}

async function isMailNotificationEnabled(DB, brand) {
  // Default: ON (safer for legacy)
  const DEFAULT_ON = true;

  try {
    // Detect key column
    const cols = await DB.prepare(`PRAGMA table_info(slug_details);`).all();
    const names = new Set((cols?.results || []).map(r => String(r.name || "").toLowerCase()));

    const keyCol = names.has("slug") ? "slug" : (names.has("brand") ? "brand" : null);
    if (!keyCol) return DEFAULT_ON; // can't match row safely

    const row = await DB.prepare(
      `SELECT mail_notification FROM slug_details WHERE ${keyCol} = ? LIMIT 1`
    ).bind(brand).first();

    if (!row || row.mail_notification == null) return DEFAULT_ON;

    const v = String(row.mail_notification).trim().toLowerCase();
    return v === "1" || v === "true" || v === "on" || v === "yes";
  } catch (e) {
    console.error("mail_notification lookup failed:", e);
    return DEFAULT_ON;
  }
}

// Upserts a single transactions row; does not delete/recreate the row.
// Preserves created_at (and any other columns you don't update).
// Upserts a single transactions row; preserves original created_at if it exists.
// Upserts a single transactions row; preserves original created_at if it exists.
async function upsertTransaction(DB, row) {
  const sql = `
    INSERT OR REPLACE INTO transactions (
      podfy_id, slug, upload_date, upload_time,
      created_at,
      reference, presented_loc_url, presented_label,
      picture_url, original_filename, uploaded_file_type, file_size_bytes,
      storage_bucket, storage_key, driver_copy_sent, process_status,
      invoice_group_id, subscription_code, uploader_user_id, user_agent, app_version, meta_json,
      file_checksum, delivery_issue_code, delivery_issue_notes, location_raw_json
    ) VALUES (
      ?, ?, ?, ?,
      COALESCE(
        (SELECT created_at FROM transactions WHERE podfy_id = ?),
        strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ),
      ?, ?, ?,
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
    row.podfy_id, // for the created_at COALESCE subquery
    row.reference, row.presented_loc_url, row.presented_label,
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

async function applyPdfHeaderFooter({
  pdfBuffer,
  brand,
  reference,
  podfyId,
  dateTime,
  mediaBase,
  logoBase,
  enableHeader,
  enableFooter,
  brandColor,
}) {
  if (!enableHeader && !enableFooter) return pdfBuffer;

  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();

  // ---- helpers --------------------------------------------------------------
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const hexToRgb = (hex, fallback = "#000000") => {
    const h = String(hex || "").trim().replace(/^#/, "");
    const v = /^[0-9a-fA-F]{6}$/.test(h) ? h : String(fallback).trim().replace(/^#/, "");
    const r = parseInt(v.slice(0, 2), 16) / 255;
    const g = parseInt(v.slice(2, 4), 16) / 255;
    const b = parseInt(v.slice(4, 6), 16) / 255;
    return rgb(clamp01(r), clamp01(g), clamp01(b));
  };

  // Brand color header, fallback black
  const headerBg = hexToRgb(brandColor, "#000000");
  const footerBg = rgb(0.25, 0.25, 0.25);
  const white = rgb(1, 1, 1);
  const black = rgb(0, 0, 0);

  // ---- layout (70% thickness) ----------------------------------------------
  const padX = 36;                  // 0.5 inch
  const headerH = 30; // 31
  const footerH = 30; // 34
  const textSize = 10;

  // Logo sizing
  const headerLogoH = headerH * 0.6;
  const footerLogoH = footerH * 0.6;

  // ---- logo sources ---------------------------------------------------------
  const lb = (logoBase || mediaBase || "").replace(/\/+$/, "");
  const brandLogoUrl = `${lb}/logos/${encodeURIComponent(brand || "default")}.png`;
  const podfySvgUrl  = `${lb}/logos/podfy.svg`;
  const podfyPngUrl  = `${lb}/logos/podfy.png`;

  function ensureSvgSize(svgText) {
    // If SVG already has width+height, keep it.
    const hasW = /\bwidth\s*=\s*["'][^"']+["']/.test(svgText);
    const hasH = /\bheight\s*=\s*["'][^"']+["']/.test(svgText);
    if (hasW && hasH) return svgText;

    // Try to derive from viewBox
    const m = svgText.match(/\bviewBox\s*=\s*["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*["']/i);
    let w = 256, h = 256; // sensible fallback
    if (m) {
      const vbW = parseFloat(m[3]);
      const vbH = parseFloat(m[4]);
      if (Number.isFinite(vbW) && vbW > 0) w = vbW;
      if (Number.isFinite(vbH) && vbH > 0) h = vbH;
    }

    // Inject width/height into the <svg ...> tag
    return svgText.replace(
      /<svg\b([^>]*)>/i,
      (full, attrs) => {
        const attrs2 = attrs
          .replace(/\s+/g, " ")
          .trim();
        return `<svg ${attrs2} width="${w}" height="${h}">`;
      }
    );
  }

  async function loadWhiteSvg(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`svg fetch failed: ${r.status} ${url}`);
    let svgText = await r.text();

    // Force fills/strokes to white (best-effort)
    svgText = svgText
      .replace(/fill="[^"]*"/gi, 'fill="#ffffff"')
      .replace(/stroke="[^"]*"/gi, 'stroke="#ffffff"');

    // Also set root defaults (helps when paths use fill="currentColor" etc.)
    svgText = svgText.replace(/<svg\b/i, '<svg fill="#ffffff" stroke="#ffffff"');

    // Critical: ensure width/height exist (otherwise pdf-lib can render nothing)
    svgText = ensureSvgSize(svgText);

    return svgText;
  }

  // ---- fetch + embed logos once (best-effort) -------------------------------
  let brandLogoImg = null; // PNG
  let podfyLogoImg = null; // SVG preferred; PNG fallback

  // Brand logo
  try {
    const r = await fetch(brandLogoUrl);
    if (r.ok) brandLogoImg = await pdfDoc.embedPng(await r.arrayBuffer());
  } catch (e) {
    console.log("Brand logo fetch/embed failed (non-fatal):", String(e));
  }

  // Podfy logo (SVG -> PNG fallback)
  try {
    const svgText = await loadWhiteSvg(podfySvgUrl);
    if (typeof pdfDoc.embedSvg !== "function") {
      throw new Error("pdf-lib embedSvg() not available in this build");
    }
    podfyLogoImg = await pdfDoc.embedSvg(svgText);
  } catch (e) {
    console.log("Podfy SVG failed, trying PNG fallback:", String(e));
    try {
      const r = await fetch(podfyPngUrl);
      if (r.ok) podfyLogoImg = await pdfDoc.embedPng(await r.arrayBuffer());
    } catch (e2) {
      console.log("Podfy PNG fallback failed too:", String(e2));
    }
  }

  // ---- text content ---------------------------------------------------------
  const headerRight = reference ? `REF: ${reference}` : "";
  const footerLeft  = `PODFY ID: ${podfyId}`;
  const footerRight = dateTime ? `${dateTime}` : "";

  // ---- draw on each page ----------------------------------------------------
  pages.forEach((page) => {
    const { width, height } = page.getSize();

    // ---------------- HEADER ----------------
    if (enableHeader) {
      page.drawRectangle({
        x: 0,
        y: height - headerH,
        width,
        height: headerH,
        color: headerBg,
      });

      const centerY = height - headerH / 2;
      let leftX = padX;

      // Brand logo left (preferred), else brand text
      if (brandLogoImg) {
        const scale = headerLogoH / brandLogoImg.height;
        const logoW = brandLogoImg.width * scale;
        const logoH = brandLogoImg.height * scale;

        page.drawImage(brandLogoImg, {
          x: leftX,
          y: centerY - logoH / 2,
          width: logoW,
          height: logoH,
        });

        leftX += logoW + 10;
      } else {
        const brandText = (brand || "").toUpperCase();
        page.drawText(brandText, {
          x: leftX,
          y: centerY - textSize / 2,
          size: textSize + 2,
          font: fontBold,
          color: white,
        });
      }

      // Right header text (REF)
      if (headerRight) {
        const w = fontBold.widthOfTextAtSize(headerRight, textSize);
        page.drawText(headerRight, {
          x: Math.max(padX, width - padX - w),
          y: centerY - textSize / 2,
          size: textSize,
          font: fontBold,
          color: white,
        });
      }
    }

    // ---------------- FOOTER ----------------
    if (enableFooter) {
      page.drawRectangle({
        x: 0,
        y: 0,
        width,
        height: footerH,
        color: footerBg,
      });

      const centerY = footerH / 2;

      // Left footer text
      page.drawText(footerLeft, {
        x: padX,
        y: centerY - textSize / 2,
        size: textSize,
        font: fontBold,
        color: black,
      });

      // Right footer text (date/time)
      if (footerRight) {
        const w = fontBold.widthOfTextAtSize(footerRight, textSize);
        page.drawText(footerRight, {
          x: Math.max(padX, width - padX - w),
          y: centerY - textSize / 2,
          size: textSize,
          font: fontBold,
          color: black,
        });
      }

      // Podfy logo centered (60% of bar height)
      if (podfyLogoImg && podfyLogoImg.width > 0 && podfyLogoImg.height > 0) {
        const scale = footerLogoH / podfyLogoImg.height;
        const logoW = podfyLogoImg.width * scale;
        const logoH = podfyLogoImg.height * scale;

        page.drawImage(podfyLogoImg, {
          x: (width - logoW) / 2,
          y: centerY - logoH / 2,
          width: logoW,
          height: logoH,
        });
      }
    }
  });

  return await pdfDoc.save();
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

  // Multi-file support (preferred): <input name="files[]">
  const files = form.getAll("files[]").filter(Boolean);

  // Backwards compatibility (single-file): "file" or "upload"
  const single = form.get("file") || form.get("upload");
  if (files.length === 0 && single) files.push(single);

  if (files.length === 0) throw new Error("Missing file");

  // Optional per-file meta array from frontend (same index as files[])
  const clientMetaList = form.getAll("client_meta_json[]").map(v => (v || "").toString());

  return {
    mode: "form",
    files,                 // <-- NEW
    file: files[0],         // <-- keep old shape so the rest compiles until Step 2
    clientMetaList,         // <-- NEW
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
      honeypot: (form.get("company_website") || "").toString(),
      issuedAt: (form.get("form_issued_at") || "").toString(),
      tz: (form.get("tz") || "").toString(),
      issue: (form.get("issue") || "").toString(),
      issue_code: (form.get("issue_code") || "").toString(),
      issue_notes: (form.get("issue_notes") || "").toString(),
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
const { mode, files, clientMetaList, file, fields } = await parseRequest(request);
let { brand, reference, emailCopy, lat, lon, accuracy, locTs, podfyId, dateTime, previewUrl } = fields;

// For now: keep existing single-file behavior (we'll use these in Step 2)
const incomingFiles = (mode === "form" && Array.isArray(files) && files.length) ? files : [file].filter(Boolean);
const incomingClientMetaList = Array.isArray(clientMetaList) ? clientMetaList : [];
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

    const theme = resolveEmailTheme(brand, themes); // branding only
    const { enableHeader, enableFooter } = await loadPdfStampFlags(env.DB, brand);
     
    // Recipients now come from D1: slug_settings.email_recipients (plus optional env.MAIL_TO)
    const { to: dbTo, cc: dbCc, bcc: dbBcc } = await loadRecipientsFromDB(env.DB, brand);
    const mailNotificationEnabled = await isMailNotificationEnabled(env.DB, brand); 
    const envExtras = sanitizeEmails(
      Array.isArray(env.MAIL_TO) ? env.MAIL_TO.flatMap(splitComma) : splitComma(env.MAIL_TO)
    );
    const { to: mailToList, cc: mailCcList, bcc: mailBccList } = precedenceDedup({
      to:  [...dbTo,  ...envExtras],
      cc:  dbCc,
      bcc: dbBcc
    });

/* --- Time & IDs -------------------------------------------------------------- */
const tzForNames = request.cf?.timezone || "UTC";
const { ymd, hhmm, display } = formatLocalDateTime(new Date(), tzForNames);

// Treat any provided podfyId as the GROUP id for multi-file uploads.
const groupPodfyId = (podfyId || randomId(8));
if (!dateTime) dateTime = display;

// Per-file podfy_id must be unique (transactions is idempotent on podfy_id)
const makeFilePodfyId = (idx) =>
  (incomingFiles.length <= 1) ? groupPodfyId : `${groupPodfyId}-${idx + 1}`;

    /* --- Driver issue flags from form (UI may come later) ------------------------ */
    const driverIssue =
      String(fields.issue || "").toLowerCase() === "1" ||
      String(fields.issue || "").toLowerCase() === "true" ||
      String(fields.issue || "").toLowerCase() === "on";
    const driverIssueCode  = driverIssue ? (fields.issue_code  ? String(fields.issue_code).trim()  : "") : "";
    const driverIssueNotes = driverIssue ? (fields.issue_notes ? String(fields.issue_notes).trim() : "") : "";

    /* --- Load file --------------------------------------------------------------- */
   /* --- Process one file (extracted from existing single-file flow) -------------- */
async function processOneFile(fileObj, idx) {
   const podfyIdForFile = makeFilePodfyId(idx);

    console.log("D1 check", {
    hasDB: !!env.DB,
    podfyId: podfyIdForFile,
    slug: brand
  });
  // Optional client meta (align by index with files[])
  let clientMeta = null;
  try {
    const raw = incomingClientMetaList[idx];
    if (raw) clientMeta = JSON.parse(String(raw));
  } catch { clientMeta = null; }

  /* --- Load file ------------------------------------------------------------- */
  let fileName = "upload.bin";
  let contentType = "application/octet-stream";
  let buffer;
  let originalContentType = null;

  if (mode === "form") {
    fileName = fileObj?.name || fileName;
    contentType = fileObj?.type || contentType;
    originalContentType = contentType; 
    buffer = await fileObj.arrayBuffer();
  } else {
    // JSON mode stays single-file only (for now)
    if (idx > 0) throw new Error("JSON mode supports only one file");
    if (!fields.base64) throw new Error("No file provided. Use multipart/form-data.");
    fileName = fields.fileName;
    contentType = fields.contentType;
    originalContentType = contentType;
    buffer = Uint8Array.from(atob(fields.base64), (c) => c.charCodeAt(0)).buffer;
  }

  /* --- Optional EXIF extraction (GPS & timestamp) ---------------------------- */
let exifLat = null, exifLon = null;
try {
  const isImage =
    contentType.startsWith("image/") &&
    (contentType.includes("jpeg") || contentType.includes("png") || contentType.includes("webp") || contentType.includes("heic") || contentType.includes("heif"));

  let exif;
  if (isImage) {
    exif = await exifr.parse(new Uint8Array(buffer), { gps: true, tiff: true });
    if (exif && typeof exif.latitude === "number" && typeof exif.longitude === "number") {
      exifLat = exif.latitude;
      exifLon = exif.longitude;
    }
  }
} catch {
  /* ignore EXIF failures */
}

  /* --- Location selection (prefer EXIF → GPS → IP) ----------------------- */
  const userLat = Number.isFinite(parseFloat(fields.lat)) ? parseFloat(fields.lat) : Number.isFinite(parseFloat(lat)) ? parseFloat(lat) : null;
const userLon = Number.isFinite(parseFloat(fields.lon)) ? parseFloat(fields.lon) : Number.isFinite(parseFloat(lon)) ? parseFloat(lon) : null;
const userAcc = Number.isFinite(parseFloat(fields.accuracy)) ? parseFloat(fields.accuracy) : Number.isFinite(parseFloat(accuracy)) ? parseFloat(accuracy) : null;
const userLocTs = fields.locTs || locTs || null;
   
const ipLat = Number.isFinite(parseFloat(request.cf?.latitude)) ? parseFloat(request.cf.latitude) : null;
const ipLon = Number.isFinite(parseFloat(request.cf?.longitude)) ? parseFloat(request.cf.longitude) : null;

let finalLat = null, finalLon = null, finalAcc = null;
let presented_label = "UNKNOWN";

if (Number.isFinite(exifLat) && Number.isFinite(exifLon)) {
  finalLat = exifLat; finalLon = exifLon;
  finalAcc = null; // EXIF usually has no accuracy
  presented_label = "IMG";
} else if (Number.isFinite(userLat) && Number.isFinite(userLon)) {
  finalLat = userLat; finalLon = userLon;
  finalAcc = Number.isFinite(userAcc) ? userAcc : null;
  presented_label = "GPS";
} else if (Number.isFinite(ipLat) && Number.isFinite(ipLon)) {
  finalLat = ipLat; finalLon = ipLon;
  finalAcc = 50000;
  presented_label = "IP";
}

   const location_raw_json = {
  gps_exif: (Number.isFinite(exifLat) && Number.isFinite(exifLon))
    ? { lat: exifLat, lon: exifLon, accuracyM: null, ts: null }
    : { lat: null, lon: null, accuracyM: null, ts: null },

  gps_user: (Number.isFinite(userLat) && Number.isFinite(userLon))
    ? { lat: userLat, lon: userLon, accuracyM: Number.isFinite(userAcc) ? userAcc : null, ts: userLocTs }
    : { lat: null, lon: null, accuracyM: null, ts: null },

  gps_ip: (Number.isFinite(ipLat) && Number.isFinite(ipLon))
    ? { lat: ipLat, lon: ipLon, accuracyM: 50000, ts: null }
    : { lat: null, lon: null, accuracyM: null, ts: null },

  presented_label,
  final: { lat: finalLat, lon: finalLon, accuracyM: finalAcc }
};
   const mapUrl = (Number.isFinite(finalLat) && Number.isFinite(finalLon))
  ? buildMapUrl(finalLat, finalLon)
  : "";

const meta = {
  locationQualifier: presented_label, // keep for email template compatibility
  lat: Number.isFinite(finalLat) ? String(finalLat) : "",
  lon: Number.isFinite(finalLon) ? String(finalLon) : "",
};

  /* --- File validations ------------------------------------------------------ */
  if (!buffer || buffer.byteLength === 0) throw new Error("Empty file");
  if (buffer.byteLength > MAX_BYTES) throw new Error("File too large (max 25 MB)");
  const head = buffer.slice(0, 32);
  const kind = sniffKind(head);
 const safeName = (fileName || "upload").toLowerCase();
const extFromName = safeName.includes(".") ? safeName.split(".").pop() : "";

// sanitize reference BEFORE we might use it
const cleanRef = (reference || "").replace(/[^A-Za-z0-9._-]/g, "");

const mimeOk = ALLOWED_MIME.has(contentType);
const extOk  = ALLOWED_EXT.has(extFromName);
if (kind === "unknown" || !(mimeOk || extOk)) throw new Error("Unsupported or suspicious file");

// Optional PDF stamping (header/footer)
const mediaBase = (env.MEDIA_BASE_URL || env.PUBLIC_BASE_URL || "https://podfy.net").replace(/\/+$/, "");
const logoBase  = (env.LOGO_BASE_URL  || env.PUBLIC_BASE_URL || "https://podfy.net").replace(/\/+$/, "");
// From DB (loaded once per request)
const enableHeaderForPdf = enableHeader;
const enableFooterForPdf = enableFooter;

if (contentType === "application/pdf" || extFromName === "pdf" || kind === "pdf") {
  try {
buffer = await applyPdfHeaderFooter({
  pdfBuffer: buffer,
  brand,
  reference: cleanRef,
  podfyId: podfyIdForFile,
  dateTime,
  mediaBase,
  logoBase,
  enableHeader: enableHeaderForPdf,
  enableFooter: enableFooterForPdf,
  brandColor: theme.brandColor || "#000000",
});
    contentType = "application/pdf";
  } catch (e) {
    console.error("PDF header/footer failed (non-fatal):", e);
  }
}

/* --- Key & metadata -------------------------------------------------------- */
const safeBase = (fileName.replace(/[^A-Za-z0-9_.-]/g, "_") || "upload");
const dot = safeBase.lastIndexOf(".");
const ext = dot > -1 ? safeBase.slice(dot + 1).toLowerCase() : "bin";
  const { ymd: y, hhmm: hm } = formatLocalDateTime(new Date(), tzForNames);

  // include file index in the base when multi-file
  const idxTag = incomingFiles.length <= 1 ? "" : `_${idx + 1}of${incomingFiles.length}`;
  const finalBase = [y, hm, podfyIdForFile, brand, ...(cleanRef ? [cleanRef] : [])].join("_") + idxTag;

  const key = `${brand}/${finalBase}.${ext}`;

  /* --- Store in R2 ----------------------------------------------------------- */
  await PODFY_BUCKET.put(key, buffer, {
    httpMetadata: { contentType, contentDisposition: `attachment; filename="${finalBase}.${ext}"` },
    customMetadata: {
      podfy_id: podfyIdForFile,
      group_podfy_id: groupPodfyId,
      file_index: String(idx + 1),
      file_count: String(incomingFiles.length),
      reference: cleanRef,
      slug: brand,
      orig_name: fileName,
      orig_type: originalContentType || contentType,
      uploader_email: emailCopy || "",
      presented_label,
         finalLat: finalLat == null ? "" : String(finalLat),
         finalLon: finalLon == null ? "" : String(finalLon),
         finalAccuracyM: finalAcc == null ? "" : String(finalAcc),
    },
  });

  /* --- Preview URL ----------------------------------------------------------- */
  let imagePreviewUrl = "";
  if (contentType.startsWith("image/") && env.SIGNED_MEDIA_SECRET) {
    const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;
    const sig = await hmacSHA256(env.SIGNED_MEDIA_SECRET, `${key}:${exp}`);
    imagePreviewUrl = `${mediaBase}/media/${encodePath(key)}?e=${exp}&sig=${sig}`;
  } else if (contentType.startsWith("image/") && previewUrl) {
    imagePreviewUrl = previewUrl;
  }

  /* --- D1 upsert ------------------------------------------------------------- */
  try {
    let tzUpload = (fields.tz || request.cf?.timezone || "UTC");
    try { new Intl.DateTimeFormat("en-CA", { timeZone: tzUpload }).format(new Date()); } catch { tzUpload = "UTC"; }
    const { local_date, local_time } = localParts(new Date(), tzUpload);

    const fallbackUrl = `${mediaBase}/media/${encodePath(key)}`;
    const pictureUrl = imagePreviewUrl || fallbackUrl;
    const file_checksum = await sha256Hex(buffer);
    const subscription_code = normalizeSubscriptionCode(fields.subscription_code || fields.subscription || themes[brand]?.subscriptionCode || null);

    await upsertTransaction(env.DB, {
      podfy_id: podfyIdForFile,
      slug: brand,
      upload_date: local_date,
      upload_time: local_time,
      reference: cleanRef || null,
      presented_loc_url: mapUrl,
      presented_label: presented_label,
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
      meta_json: {
        via: "upload",
        tz: tzUpload,
        dateTime,
        group_podfy_id: groupPodfyId,
        file_index: idx + 1,
        file_count: incomingFiles.length,
        client_meta: clientMeta,
      },
      file_checksum,
      delivery_issue_code: driverIssue ? driverIssueCode : "",
      delivery_issue_notes: driverIssue ? driverIssueNotes : "",
      location_raw_json: location_raw_json,
    });
  } catch (e) {
    console.error("D1 upsert failed (non-fatal):", e);
    await setProcessStatus(env.DB, podfyIdForFile, "error_d1");
  }

  /* --- Email content --------------------------------------------------------- */
  const html = buildHtml({
    brand,
    brandName: theme.brandName,
    theme: { brandColor: theme.brandColor, logo: theme.logo },
    fileName: `${finalBase}.${ext}`,
    podfyId: podfyIdForFile,
    dateTime,
    meta,
    reference: cleanRef || "",
    imageUrlBase: mediaBase,
    imagePreviewUrl,
  });

  const brandForSubject = theme.brandName || brand;
  const yyyyMmDd = (dateTime || "").split(" at ")[0] || `${y.slice(0,4)}-${y.slice(4,6)}-${y.slice(6,8)}`;
  const subjectStaff = `POD | ${brandForSubject}${cleanRef ? ` | ${cleanRef}` : ""} | ${yyyyMmDd} by Podfy`;

  // Optional attachment per file
  let attachment = null;
  try {
    const maxMb = Number(env.MAX_ATTACH_MB || 8);
    if (buffer.byteLength <= maxMb * 1024 * 1024) {
      attachment = { filename: `${finalBase}.${ext}`, type: contentType, contentBase64: abToBase64(buffer) };
    }
  } catch {}

  const fromEnvelope = pickFromAddress(env, brand);

  const common = {
    brand,
    brandName: theme.brandName,
    theme: { brandColor: theme.brandColor, logo: theme.logo },
    fileName: `${finalBase}.${ext}`,
    podfyId: podfyIdForFile,
    dateTime,
    meta,
    reference: cleanRef || "",
    imageUrlBase: mediaBase,
    attachment,
  };

  // Staff mail (per file)
  let okStaff = false;
  try {
    if (mailNotificationEnabled && mailToList.length) {
      okStaff = await sendMail(env, {
        fromEmail: fromEnvelope,
        toList: mailToList,
        ccList: mailCcList,
        bccList: mailBccList,
        subject: subjectStaff,
        html,
        ...common
      });
      if (!okStaff) await setProcessStatus(env.DB, podfyIdForFile, "error_staff_mail");
    }
  } catch (e) {
    console.error("email send (staff) failed:", e);
    await setProcessStatus(env.DB, podfyIdForFile, "error_staff_mail");
  }

   // Treat staff mail as "satisfied" when disabled OR there are no recipients.
const staffSatisfied = (!mailNotificationEnabled || !mailToList.length) ? true : okStaff;
   
  // Driver mail (per file)
  let okUser = false;
  try {
    if (emailCopy) {
      okUser = await sendMail(env, {
        fromEmail: fromEnvelope,
        toList: [emailCopy],
        subject: `We received your file: ${finalBase}.${ext}`,
        html,
        ...common
      });
      if (!okUser) await setProcessStatus(env.DB, podfyIdForFile, "error_user_mail");
    }
  } catch (e) {
    console.error("email send (user) failed:", e);
    await setProcessStatus(env.DB, podfyIdForFile, "error_user_mail");
  }

  // Persist driver-copy identity per transaction row
  try {
    if (emailCopy) {
      const normalizedEmail = emailCopy.trim().toLowerCase();
      const domain = emailDomain(normalizedEmail);
      const hash = await sha256HexText(normalizedEmail);

      await env.DB.prepare(`
        UPDATE transactions
           SET copy_email        = COALESCE(copy_email, ?),
               copy_email_domain = ?,
               copy_email_hash   = ?,
               driver_copy_at    = COALESCE(driver_copy_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         WHERE podfy_id = ?
      `).bind(normalizedEmail, domain, hash, podfyIdForFile).run();

      if (okUser) {
        await env.DB.prepare(
          `UPDATE transactions SET driver_copy_sent = 1 WHERE podfy_id = ?`
        ).bind(podfyIdForFile).run();
      }
    }
  } catch (e) {
    console.error("D1 driver_copy persistence failed:", e);
    await setProcessStatus(env.DB, podfyIdForFile, "error_user_mail");
  }

  // Finalize status per file
  try {
const shouldBeDelivered = !driverIssue && staffSatisfied && (emailCopy ? okUser : true);
await env.DB.prepare(`
  UPDATE transactions
     SET process_status = CASE WHEN ?1 THEN 'delivered' ELSE process_status END
   WHERE podfy_id = ?2
`).bind(shouldBeDelivered ? 1 : 0, podfyIdForFile).run();
  } catch (e) {
    console.error("final status update failed:", e);
    await setProcessStatus(env.DB, podfyIdForFile, "error");
  }

  return {
    ok: true,
    key,
    filename: `${finalBase}.${ext}`,
    podfyId: podfyIdForFile,
    groupPodfyId,
    dateTime,
    mail: { staff: okStaff, staffAttempted: (mailNotificationEnabled && mailToList.length > 0), user: okUser }
  };
}

/* --- Run per-file ------------------------------------------------------------ */
const results = [];
for (let i = 0; i < incomingFiles.length; i++) {
  results.push(await processOneFile(incomingFiles[i], i));
}

/* --- Response ---------------------------------------------------------------- */
return new Response(
  JSON.stringify({
    ok: true,
    groupPodfyId,
    files: results
  }),
  { headers: { "content-type": "application/json" } }
);

} catch (err) {
  console.error("Upload error:", err);
  return new Response(JSON.stringify({ ok: false, error: "Upload failed" }), {
    status: 500, headers: { "content-type": "application/json" },
  });
}
};
