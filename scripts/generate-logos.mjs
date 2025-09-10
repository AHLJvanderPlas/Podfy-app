// scripts/generate-logos.mjs
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC_DIR = "public/logos";
const OUT_DIR = "public/logos";

// We render logos to 2x height for crispness in email.
// HTML will show them at 28px high, so we rasterize at 56px.
const TARGET_HEIGHT = 56;       // px (2x)
const MAX_WIDTH     = 600;      // safety cap, keep aspect-ratio

async function ensureDir(p) {
  try { await fs.mkdir(p, { recursive: true }); } catch {}
}

async function listSvgs(dir) {
  const files = await fs.readdir(dir).catch(() => []);
  return files.filter(f => f.toLowerCase().endsWith(".svg"));
}

async function convert(svgPath, outPngPath, outMetaPath) {
  const svgBuf = await fs.readFile(svgPath);

  // Use a high density so thin strokes rasterize crisply.
  let img = sharp(svgBuf, { density: 288 });

  // Many brand SVGs include extra transparent padding.
  // Trim it to reduce odd stretching/centering in Outlook.
  img = img.trim();

  // Resize by height, maintain aspect ratio, never enlarge beyond safety.
  img = img.resize({
    height: TARGET_HEIGHT,
    width: MAX_WIDTH,
    fit: "inside",
    withoutEnlargement: true
  });

  // Export PNG (transparent).
  const png = await img.png({ compressionLevel: 9 }).toBuffer();
  await fs.writeFile(outPngPath, png);

  // Write a tiny metadata file (optional but useful).
  const meta = await sharp(png).metadata();
  await fs.writeFile(outMetaPath, JSON.stringify({
    width: meta.width,
    height: meta.height
  }, null, 2));

  console.log(`✓ ${path.basename(svgPath)} → ${path.basename(outPngPath)} (${meta.width}×${meta.height})`);
}

async function run() {
  await ensureDir(SRC_DIR);
  await ensureDir(OUT_DIR);

  const svgs = await listSvgs(SRC_DIR);
  if (!svgs.length) {
    console.log("No SVG logos found in", SRC_DIR);
    return;
  }

  for (const file of svgs) {
    const base = file.replace(/\.svg$/i, "");
    const svgPath = path.join(SRC_DIR, file);
    const pngPath = path.join(OUT_DIR, `${base}.png`);
    const metaPath = path.join(OUT_DIR, `${base}.json`);

    try {
      // Always (re)build so logos are consistent after design tweaks.
      await convert(svgPath, pngPath, metaPath);
    } catch (err) {
      console.error(`✗ Failed to convert ${file}:`, err?.message || err);
    }
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
