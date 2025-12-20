// public/compress/image_to_a4_pdf.js
// Image -> A4 @ 300 DPI raster -> JPEG -> single-page PDF (pdf-lib)
// Fully client-side, designed for OCR quality and low user interaction.

const A4 = {
  // A4 in points (PDF points): 595.28 x 841.89 (approx)
  // We'll use exact mm->pt conversion for robustness.
  widthPt: mmToPt(210),
  heightPt: mmToPt(297),
  // 300 DPI pixel box for A4
  pxPortrait: { w: 2480, h: 3508 },
  pxLandscape: { w: 3508, h: 2480 },
};

function mmToPt(mm) {
  // 1 inch = 25.4 mm, 1 pt = 1/72 inch
  return (mm / 25.4) * 72;
}

// Lazy-load dependencies only when used (low bandwidth friendly).
async function loadPdfLib() {
  // ESM build from jsdelivr
  return import("/vendor/pdf-lib.esm.js");
}

async function loadExifr() {
  // Exifr ESM for EXIF parsing
  return import("/vendor/exifr.esm.js");
}

function isPortrait(width, height) {
  return height >= width;
}

function chooseA4PixelBox(imgW, imgH) {
  return isPortrait(imgW, imgH) ? A4.pxPortrait : A4.pxLandscape;
}

/**
 * Apply EXIF orientation by drawing the source image into a correctly oriented canvas.
 * orientation: 1..8 (EXIF standard), default = 1
 */
function drawWithOrientation(ctx, img, orientation, destW, destH) {
  // Clear destination
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, destW, destH);

  // Orientation reference:
  // 1 = 0°, 2 = flip X, 3 = 180°, 4 = flip Y,
  // 5 = transpose, 6 = 90° CW, 7 = transverse, 8 = 90° CCW
  switch (orientation) {
    case 2: // flip X
      ctx.translate(destW, 0);
      ctx.scale(-1, 1);
      break;
    case 3: // 180
      ctx.translate(destW, destH);
      ctx.rotate(Math.PI);
      break;
    case 4: // flip Y
      ctx.translate(0, destH);
      ctx.scale(1, -1);
      break;
    case 5: // transpose
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(1, -1);
      break;
    case 6: // 90 CW
      ctx.translate(destW, 0);
      ctx.rotate(0.5 * Math.PI);
      break;
    case 7: // transverse
      ctx.translate(destW, destH);
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(-1, 1);
      break;
    case 8: // 90 CCW
      ctx.translate(0, destH);
      ctx.rotate(-0.5 * Math.PI);
      break;
    case 1:
    default:
      // no transform
      break;
  }

  ctx.drawImage(img, 0, 0);
}

/**
 * Create a white A4 canvas and place the image using "contain" (no cropping).
 * Returns { canvas, placed: {x,y,w,h}, targetPx: {w,h} }
 */
function renderImageToA4Canvas(img, orientation, targetPx) {
  const canvas = document.createElement("canvas");
  canvas.width = targetPx.w;
  canvas.height = targetPx.h;

  const ctx = canvas.getContext("2d", { alpha: false });
  // White background (flatten)
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Step 1: draw into a temp canvas with correct orientation (so width/height reflect real orientation)
  // For orientations 5-8, width/height swap.
  const swapWH = orientation >= 5 && orientation <= 8;
  const orientedW = swapWH ? img.height : img.width;
  const orientedH = swapWH ? img.width : img.height;

  // Compute contain scale into A4 pixel box
  const scale = Math.min(targetPx.w / orientedW, targetPx.h / orientedH);
  const drawW = Math.round(orientedW * scale);
  const drawH = Math.round(orientedH * scale);
  const x = Math.round((targetPx.w - drawW) / 2);
  const y = Math.round((targetPx.h - drawH) / 2);

  // Temp canvas to apply orientation at full resolution then scale into final (better quality)
  const tmp = document.createElement("canvas");
  tmp.width = orientedW;
  tmp.height = orientedH;
  const tctx = tmp.getContext("2d", { alpha: true });

  // Draw image into tmp applying orientation
  // We draw the original image into tmp with transforms on tctx
  // For 5-8, the transforms assume destW/destH = tmp.width/tmp.height (already swapped).
  drawWithOrientation(tctx, img, orientation || 1, tmp.width, tmp.height);

  // High quality downscale
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, drawW, drawH);

  return { canvas, placed: { x, y, w: drawW, h: drawH }, targetPx };
}

async function canvasToJpegBytes(canvas, quality) {
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality)
  );
  if (!blob) throw new Error("JPEG encoding failed (canvas.toBlob returned null).");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Main entry: image file -> { pdfBlob, meta }
 * meta contains extracted EXIF and processing stats (for D1 storage).
 */
export async function imageFileToA4Pdf(file, options = {}) {
  const started = performance.now();

  const {
    jpegQuality = 0.82,
    maxBytesSoft = 25 * 1024 * 1024, // soft target (25MB)
    qualityFallbacks = [0.75, 0.68],
  } = options;

  // Parse EXIF (best-effort; failures are non-fatal)
  let exif = null;
  let orientation = 1;
  try {
    const exifr = await loadExifr();
    // "parse" returns EXIF tags; "orientation" is included when present
    exif = await exifr.parse(file, { gps: true, xmp: false, tiff: true, ifd0: true });
    if (exif && typeof exif.Orientation === "number") orientation = exif.Orientation;
  } catch {
    // ignore
  }

  // Decode image
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (e) {
    throw new Error(`Image decode failed: ${e?.message || e}`);
  }

  const targetPx = chooseA4PixelBox(bitmap.width, bitmap.height);
  const { canvas } = renderImageToA4Canvas(bitmap, orientation, targetPx);

  // Encode JPEG (with 0-2 fallback attempts if file too big)
  let jpegQ = jpegQuality;
  let jpgBytes = await canvasToJpegBytes(canvas, jpegQ);

  if (jpgBytes.byteLength > maxBytesSoft) {
    for (const q of qualityFallbacks) {
      jpegQ = q;
      jpgBytes = await canvasToJpegBytes(canvas, jpegQ);
      if (jpgBytes.byteLength <= maxBytesSoft) break;
    }
  }

  // Build PDF
  const { PDFDocument } = await loadPdfLib();
  const pdfDoc = await PDFDocument.create();

  // A4 page (portrait or landscape based on targetPx)
  const isA4Portrait = targetPx.w === A4.pxPortrait.w;
  const pageWidthPt = isA4Portrait ? A4.widthPt : A4.heightPt;
  const pageHeightPt = isA4Portrait ? A4.heightPt : A4.widthPt;

  const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);

  const jpg = await pdfDoc.embedJpg(jpgBytes);

  // Place image to fill page (contain on A4 already baked into the raster),
  // so we simply draw full-page.
  page.drawImage(jpg, {
    x: 0,
    y: 0,
    width: pageWidthPt,
    height: pageHeightPt,
  });

  const pdfBytes = await pdfDoc.save();
  const pdfBlob = new Blob([pdfBytes], { type: "application/pdf" });

  const ended = performance.now();

  const meta = {
    original: {
      name: file.name,
      type: file.type,
      sizeBytes: file.size,
      lastModified: file.lastModified || null,
      width: bitmap.width,
      height: bitmap.height,
    },
    exif: exif || null,
    processing: {
      a4: isA4Portrait ? "portrait" : "landscape",
      targetPx,
      jpegQualityUsed: jpegQ,
      jpgBytes: jpgBytes.byteLength,
      pdfBytes: pdfBlob.size,
      durationMs: Math.round(ended - started),
      orientationApplied: orientation || 1,
    },
  };

  return { pdfBlob, meta };
}
