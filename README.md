# PODFY Upload — Cloudflare Pages + Functions

Minimal, production-ready upload tool for CMR/POD files with slug-based branding, EU translations, optional GPS, per-slug mail routing, and image→PDF conversion at the edge.

- Frontend: static site (HTML/CSS/JS) served by **Cloudflare Pages**
- API: **Pages Function** at `/api/upload`
- Storage: **Cloudflare R2**
- Mail: **MailChannels** (built into Workers)
- Themable per customer via `themes.json` (logo, colors, mailbox)

---

## Contents

```
podfy-app/
 ├─ public/
 │   ├─ index.html          # UI
 │   ├─ styles.css          # All-white base; themed by CSS variables
 │   ├─ main.js             # Slug theming, i18n, GPS, upload
 │   ├─ themes.json         # Per-slug branding + routing
 │   ├─ i18n.json           # UI strings (EN + EU languages)
 │   └─ logos/              # Brand assets (SVG/PNG)
 ├─ functions/
 │   ├─ package.json        # pdf-lib dependency for image→PDF
 │   └─ api/
 │       └─ upload.js       # Pages Function (R2 + MailChannels)
 └─ wrangler.toml           # Optional for local dev
```

---

## Quick start (Cloudflare Pages)

1. **Create R2 bucket**
   - Cloudflare Dashboard → **R2** → **Create bucket**
   - Name: `podfy-uploads`

2. **Create Pages project**
   - Dashboard → **Pages** → **Create project**
   - Connect this repo (recommended) or upload the folder
   - **Build settings**
     - Framework preset: **None**
     - Build command: *(empty)*
     - Build output directory: `public`

3. **Enable Functions + bind R2**
   - Pages → Your project → **Settings → Functions → R2 bindings**
   - Add binding: **Name** `PODFY_BUCKET` → **Bucket** `podfy-uploads`

4. **Environment variables** (Production & Preview)
   - Pages → **Settings → Environment variables**
     - `MAIL_DOMAIN = podfy.app`
     - *(Optional)* `MAIL_FROM = PODFY <noreply@podfy.app>`

5. **Custom domain**
   - Pages → **Custom domains** → Add `podfy.app` and follow DNS wizard (CNAME)
   - SSL is automatic

6. **Test**
   - Visit:
     - `/` → default PODFY theme
     - `/dsv`, `/fender`, `/netgear` → sample themes
   - Upload a small JPG/PNG/PDF; tick “Email me a copy”; optionally “Share my location”

---

## How it works

- **Slug theming**: The first path segment (e.g., `/dsv`) is used as a key in `public/themes.json`.  
  Unknown slugs load the **default** theme and show a banner linking to the product page, advising the uploader to email themselves a copy. The original slug is included in the ops email subject as `[UNKNOWN:{slug}]`.

- **Uploads**:
  - Client sends `multipart/form-data` to `/api/upload` with:
    - `file`, `brand` (slug), `slug_original`, `slug_known`, optional `email`
    - optional GPS: `lat`, `lon`, `acc`, `loc_ts`
  - The Function stores to **R2** at `/{YYYY}/{MM}/{slug_YYYYMMDD_HHmmss_uuid}.{ext}` with metadata, and emails ops via MailChannels. If `email` provided, it also emails a copy.

- **Image → PDF**:
  - PNG/JPEG are wrapped as a single-page PDF using `pdf-lib`.
  - PDFs pass through unchanged.
  - Other types (e.g., DOCX, HEIC) are stored as-is (extend as needed).

- **Translations**:
  - `public/i18n.json` contains EN and a sample set (NL, DE, FR, ES, IT).  
    Add more EU languages by copying keys; the menu populates automatically.

---

## Configure brands (themes)

1. Add a logo to `public/logos/{slug}.svg` (or PNG).  
2. Add an entry to `public/themes.json`:

```json
"acme": {
  "brandName": "ACME Logistics",
  "logo": "/logos/acme.svg",
  "mailTo": "pod+acme@podfy.app",
  "colors": {
    "primary": "#FF6600",
    "accent": "#CC5200",
    "text": "#0B1220",
    "muted": "#6B7280",
    "border": "#E5E7EB",
    "buttonText": "#FFFFFF"
  },
  "header": { "bg": "#FFFFFF" },
  "favicon": "/logos/acme.svg"
}
```

3. Deploy. Visiting `https://podfy.app/acme` uses that theme and routes mail to `pod+acme@podfy.app`.

> Tip: keep `default.mailTo` as your central ops mailbox for safety.

---

## Security & privacy

- **Max file size**: 25 MB enforced client-side. You may add server-side checks in the Function (inspect `file.size`).
- **R2 metadata** includes slug, original filename, optional GPS, and uploader email. Update your privacy notice accordingly.
- Use an **R2 lifecycle rule** if you want automatic deletions (e.g., after 180 days).
- Consider adding **rate limiting** (IP-based) in the Function to reduce abuse.

---

## Local development (optional)

1. `npm i -g wrangler` and `wrangler login`  
2. From repo root:
```bash
wrangler pages dev
```
- Serves `public/` and Functions together.
- For real R2, deploy to a preview; local R2 emulation is not required for basic UI work.

---

## Extending

- **Office → PDF**: integrate an external API (CloudConvert/Adobe) from the Function for DOCX/XLSX/PPTX.
- **Multi-page PDF**: accept multiple images and build a multi-page PDF via `pdf-lib`.
- **Signed downloads**: add an endpoint to generate short-lived signed URLs to R2 objects.
- **Admin console**: add a protected page to list/search recent uploads (by slug/date/email).

---

## Troubleshooting

- **Function not running / 404 on `/api/upload`**  
  Ensure the folder is `functions/api/upload.js` and not nested incorrectly. Functions must live under `functions/`.

- **Emails not received**  
  Check Pages **Function logs**. Verify `MAIL_DOMAIN` is your domain. If you set a custom `MAIL_FROM`, ensure SPF/DMARC for `podfy.app` are valid. Some providers may rate-limit; test with different recipients.

- **R2 errors**  
  Confirm the **R2 binding** exists in Pages → Settings → Functions → R2 bindings and the bucket name matches.

- **Theme not applied**  
  Make sure the path segment matches the slug key in `themes.json` and that the logo path exists.

---

## API reference

### `POST /api/upload`
**Form fields**:
- `file` (required): file blob  
- `brand` / `slug_original` (required): path slug  
- `slug_known` (“1” or “0”)  
- `email` (optional): to receive a copy  
- `lat`, `lon`, `acc`, `loc_ts` (optional): GPS

**Response**:
```json
{ "ok": true, "key": "2025/08/slug_20250830_154112_ab12cd34.pdf", "name": "slug_20250830_154112_ab12cd34.pdf" }
```

---

## License

Internal use for podfy.app. If you plan to open-source, add a license here.

---

## Maintainers

- App owner: podfy.app  
- For questions about deployment or configuration, open an issue or contact the maintainer.
