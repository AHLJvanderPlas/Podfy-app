// functions/api/upload.js

import themes from "../../public/themes.json" assert { type: "json" };
import { resolveEmailTheme, buildHtml, pickFromAddress, sendMail } from "../_mail.js";

// ---------- small helpers ----------
const nowParts = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  return { ymd: `${y}${m}${day}`, hhmm: `${hh}${mm}` };
};

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const randomId = (len = 8) =>
  Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map((b) => crockford[b % crockford.length])
    .join("");

const asNumber = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

// split `Name <email@domain>` into { name, email }
function parseFromNameAddr(str, fallbackDomain = "podfy.app") {
  if (!str) return { name: "Podfy App", email: `noreply@${fallbackDomain}` };
  const m = String(str).match(/^\s*(.+?)\s*<\s*([^>]+)\s*>\s*$/);
  if (m) return { name: m[1], email: m[2] };
  // if it’s just an email address
  if (str.includes("@")) return { name: "Podfy App", email: str.trim() };
  return { name: "Podfy App", email: `noreply@${fallbackDomain}` };
}

// Format date and time based on uploader location
function formatLocalDateTime(date = new Date(), timeZone = "UTC") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  return {
    ymd: `${parts.year}${parts.month}${parts.day}`,      // for filename
    hhmm: `${parts.hour}${parts.minute}`,                // for filename
    display: `${parts.year}-${parts.month}-${parts.day} at ${parts.hour}:${parts.minute}` // “POD upload”
  };
}

// optional: signing for image preview
const enc = new TextEncoder();
async function hmacSHA256(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

// ---------- parsing ----------
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

        // backend-provided
        podfyId: (form.get("podfyId") || "").toString(),
        dateTime: (form.get("dateTime") || "").toString(), // yyyy-mm-dd at hh:mm

        // if you expose preview route, you may also send this
        previewUrl: (form.get("previewUrl") || "").toString()
      }
    };
  }
  // JSON (less common for file uploads here)
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
      // optional base64 file transport (not recommended for large files)
      base64: (json.base64 || ""),
      fileName: (json.fileName || "upload.bin"),
      contentType: (json.contentType || "application/octet-stream")
    }
  };
}

// ---------- main handler ----------
export const onRequestPost = async ({ request, env }) => {
  const { PODFY_BUCKET } = env;

  try {
    const { mode, file, fields } = await parseRequest(request);
    let { brand, reference, emailCopy, lat, lon, accuracy, locTs, podfyId, dateTime, previewUrl } = fields;
    brand = (brand || "default").toLowerCase().replace(/[^a-z0-9-]/g, "");

    // Theme & routing
    const t = resolveEmailTheme(brand, themes);
    const mailToList = (t.mailTo ? [t.mailTo] : []).concat(env.MAIL_TO || []).flatMap(s => String(s).split(",")).map(s => s.trim()).filter(Boolean);


// Identifiers (timezone aware)
const tz = request.cf?.timezone || "UTC";
const { ymd, hhmm, display } = formatLocalDateTime(new Date(), tz);

if (!podfyId) podfyId = randomId(8);
if (!dateTime) dateTime = display;   // "yyyy-mm-dd at hh:mm" in uploader's local tz

    // File content
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
      buffer = Uint8Array.from(atob(fields.base64), c => c.charCodeAt(0)).buffer;
    }

    // Sanitize and build **flat** key: uploads/<slug>/<filename>
    const safeBase = (fileName.replace(/[^A-Za-z0-9_.-]/g, "_") || "upload");
    const dot = safeBase.lastIndexOf(".");
    const ext = dot > -1 ? safeBase.slice(dot + 1).toLowerCase() : "bin";
    const nameNoExt = dot > -1 ? safeBase.slice(0, dot) : safeBase;

    // filename format: <YYYYMMDD>_<HHmm>_<PodfyID8>_<Slug>[_<cleanRef>][<origNameNoExt>].ext
    const cleanRef = (reference || "").replace(/[^A-Za-z0-9._-]/g, "");
    const baseNameParts = [ymd, hhmm, podfyId, brand];
    if (cleanRef) baseNameParts.push(`_${cleanRef}`);
    // keep a short hint of original name (optional, safe)
    baseNameParts.push(`${nameNoExt.slice(0,40)}`);
    const finalBase = baseNameParts.join("_");
    const key = `${brand}/${finalBase}.${ext}`;

    // Location metadata — restore both precise and IP-derived signals
    const cf = request.cf || {};
    const ipLat = cf.latitude;
    const ipLon = cf.longitude;
    const ipPostal = (cf.postalCode || "").toString();
    const ipCountryISO2 = (cf.country || "").toString().toUpperCase();

    const buildLocationCode = (iso2, postal) => {
      if (!iso2) return "";
      const digits = (postal || "").replace(/\D+/g, "");
      const prefix = digits.slice(0, 2); // NL37 / NL10 pattern
      return prefix ? `${iso2}${prefix}` : iso2;
    };

    let locationMeta = {};
    if (lat && lon) {
      locationMeta = {
        locationQualifier: "GPS",
        lat: String(lat),
        lon: String(lon),
        ...(accuracy ? { accuracyM: String(accuracy) } : {}),
        ...(locTs ? { locationTimestamp: String(locTs) } : {})
      };
    } else if (ipLat && ipLon) {
      locationMeta = {
        locationQualifier: "IP",
        lat: String(ipLat),
        lon: String(ipLon),
        ipCountry: ipCountryISO2 || "",
        ipPostal: ipPostal || "",
        locationCode: buildLocationCode(ipCountryISO2, ipPostal)
      };
    } else {
      locationMeta = { locationQualifier: "", lat: "", lon: "", locationCode: "" };
    }

    // Store to R2
    await PODFY_BUCKET.put(key, buffer, {
      httpMetadata: {
        contentType,
        contentDisposition: `attachment; filename="${finalBase}.${ext}"`
      },
      customMetadata: {
        podfy_id: podfyId,
        reference: cleanRef,
        slug: brand,
        orig_name: fileName,
        orig_type: contentType,
        uploader_email: emailCopy || "",
        ...locationMeta
      }
    });

    // Generate optional signed preview URL for images
    let imagePreviewUrl = "";
    if (contentType.startsWith("image/") && env.SIGNED_MEDIA_SECRET) {
      const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7 days
      const sig = await hmacSHA256(env.SIGNED_MEDIA_SECRET, `${key}:${exp}`);
      const base = (env.PUBLIC_BASE_URL || "https://podfy.app").replace(/\/+$/,"");
      imagePreviewUrl = `${base}/media/${encodePath(key)}?e=${exp}&sig=${sig}`;
    } else if (contentType.startsWith("image/") && fields.previewUrl) {
      imagePreviewUrl = fields.previewUrl; // if you already provided a URL
    }

    // Build HTML email
    const html = buildHtml({
      brand,
      brandName: t.brandName,
      theme: { brandColor: t.brandColor, logo: t.logo },
      fileName: `${finalBase}.${ext}`,
      podfyId,
      dateTime, // "POD upload" row
      meta: {
        locationQualifier: locationMeta.locationQualifier || "",
        lat: locationMeta.lat || "",
        lon: locationMeta.lon || "",
        locationCode: locationMeta.locationCode || ""
      },
      reference: cleanRef || "",
      imageUrlBase: env.PUBLIC_BASE_URL || "https://podfy.app",
      imagePreviewUrl
    });

    const subject = `New POD upload [${brand}]${cleanRef ? ` — REF ${cleanRef}` : ""}: ${finalBase}.${ext}`;

    // Attachment guard
    let attachment = null;
    try {
      const maxMb = asNumber(env.MAX_ATTACH_MB, 8);
      if (buffer.byteLength <= maxMb * 1024 * 1024) {
        attachment = {
          filename: `${finalBase}.${ext}`,
          type: contentType,
          contentBase64: btoa(String.fromCharCode(...new Uint8Array(buffer)))
        };
      }
    } catch (e) {
      console.error("Attachment prepare error:", e);
    }

    // From / Reply-To
    const fromEnvelope = pickFromAddress(env, brand);
    const { name: fromName, email: fromEmail } = parseFromNameAddr(env.MAIL_FROM, env.MAIL_DOMAIN || "podfy.app");

    // *** send staff ***
    if (mailToList.length) {
      const ok = await sendMail(env, {
        fromEmail: fromEnvelope,               // envelope (MailChannels 'from.email')
        toList: mailToList,
        subject,
        html,
        attachment
      });
      if (ok === false) console.error("MailChannels staff send failed");
    }

    // *** send copy to uploader ***
    if (emailCopy) {
      const ok = await sendMail(env, {
        fromEmail: fromEnvelope,
        toList: [emailCopy],
        subject: `We received your file: ${finalBase}.${ext}`,
        html,
        attachment
      });
      if (ok === false) console.error("MailChannels uploader send failed");
    }

    return new Response(JSON.stringify({
      ok: true,
      key,
      filename: `${finalBase}.${ext}`,
      podfyId,
      dateTime
    }), { headers: { "content-type": "application/json" } });

  } catch (err) {
    console.error("Upload error:", err);
    return new Response(JSON.stringify({ ok: false, error: "Upload failed" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }
};
