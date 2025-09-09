import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC = "public/logos";
const OUT = "public/logos";
const WIDTH = 294; // 2x, email will render at 147px

async function run() {
  const files = await fs.readdir(SRC);
  const svgs = files.filter(f => f.toLowerCase().endsWith(".svg"));

  for (const file of svgs) {
    const base = file.replace(/\.svg$/i, "");
    const svgPath = path.join(SRC, file);
    const pngPath = path.join(OUT, `${base}.png`);
    const buf = await fs.readFile(svgPath);

    const pngBuf = await sharp(buf, { density: 288 })
      .resize({ width: WIDTH })
      .png({ compressionLevel: 9 })
      .toBuffer();

    await fs.writeFile(pngPath, pngBuf);
    console.log("✓", file, "→", path.basename(pngPath));
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
