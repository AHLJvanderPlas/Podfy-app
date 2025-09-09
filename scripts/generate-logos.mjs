// scripts/generate-logos.mjs
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC = "public/logos";
const OUT = "public/logos";
const WIDTH = 294; // 2x for crisp email; render at 147px in HTML

async function ensureDir(p) {
  try { await fs.mkdir(p, { recursive: true }); } catch {}
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function run() {
  await ensureDir(SRC);
  await ensureDir(OUT);

  const files = await fs.readdir(SRC).catch(() => []);
  const svgs = files.filter(f => f.toLowerCase().endsWith(".svg"));

  if (!svgs.length) {
    console.log("No SVG logos found in", SRC);
    return;
  }

  for (const file of svgs) {
    const base = file.replace(/\.svg$/i, "");
    const svgPath = path.join(SRC, file);
    const pngPath = path.join(OUT, `${base}.png`);

    if (await exists(pngPath)) {
      console.log(`↷ Skipping (exists): ${base}.png`);
      continue;
    }

    try {
      const svg = await fs.readFile(svgPath);
      const png = await sharp(svg, { density: 288 }) // high density for crisp raster
        .resize({ width: WIDTH })
        .png({ compressionLevel: 9 })
        .toBuffer();

      await fs.writeFile(pngPath, png);
      console.log(`✓ ${file} → ${base}.png`);
    } catch (err) {
      console.error(`✗ Failed to convert ${file}:`, err?.message || err);
    }
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
