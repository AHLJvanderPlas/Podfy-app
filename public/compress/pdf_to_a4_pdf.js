// public/compress/pdf_to_a4_pdf.js
// PDF (<=10 pages) -> rasterize each page -> A4 portrait @ 300 DPI -> JPEG -> new PDF (pdf-lib)
// Fully client-side, OCR-first, flattened (security-friendly).

const A4 = {
  widthPt: mmToPt(210),
  heightPt: mmToPt(297),
  pxPortrait: { w: 2480, h: 3508 }, // A4 @ 300 DPI
};

function mmToPt(mm) {
  return (mm / 25.4) * 72;
}

async function loadPdfLib() {
  return import("/vendor/pdf-lib.esm.js");
}

async function loadPdfJs() {
  // pdfjs-dist ESM build, locally hosted to satisfy CSP
  return import("/vendor/pdfjs/pdf.mjs");
}

function createA4Canvas() {
  const canvas = document.createElement("canvas");
  canvas.width = A4.pxPortrait.w;
  canvas.height = A4.pxPortrait.h;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

async function canvasToJpegBytes(canvas, quality) {
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality)
  );
  if (!blob) throw new Error("JPEG encoding failed (canvas.toBlob returned null).");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Render one PDF.js page to a raster image (canvas), scaled to fit within A4@300DPI,
 * then placed (contain) on a white A4 canvas.
 */
async function renderPageToA4Canvas(page) {
  // Get a baseline viewport
  const baseViewport = page.getViewport({ scale: 1 });

  // Scale so the rendered page fits within A4 pixel box
  const scale = Math.min(
    A4.pxPortrait.w / baseViewport.width,
    A4.pxPortrait.h / baseViewport.height
  );

  const viewport = page.getViewport({ scale });

  // Render to an intermediate canvas at the scaled viewport size
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = Math.max(1, Math.floor(viewport.width));
  srcCanvas.height = Math.max(1, Math.floor(viewport.height));

  const srcCtx = srcCanvas.getContext("2d", { alpha: false });
  srcCtx.fillStyle = "#ffffff";
  srcCtx.fillRect(0, 0, srcCanvas.width, srcCanvas.height);

  await page.render({
    canvasContext: srcCtx,
    viewport,
    // Flatten look: no transparency
    background: "white",
  }).promise;

  // Place onto A4 portrait canvas using contain (no cropping)
  const { canvas: a4Canvas, ctx: a4Ctx } = createA4Canvas();

  const drawW = srcCanvas.width;
  const drawH = srcCanvas.height;
  const x = Math.round((A4.pxPortrait.w - drawW) / 2);
  const y = Math.round((A4.pxPortrait.h - drawH) / 2);

  a4Ctx.imageSmoothingEnabled = true;
  a4Ctx.imageSmoothingQuality = "high";
  a4Ctx.drawImage(srcCanvas, 0, 0, drawW, drawH, x, y, drawW, drawH);

  // Help GC on mobile
  srcCanvas.width = 1; srcCanvas.height = 1;

  return a4Canvas;
}

/**
 * Main entry: PDF file -> { pdfBlob, meta }
 */
export async function pdfFileToRasterA4Pdf(file, options = {}) {
  const started = performance.now();

  const {
    maxPages = 10,
    jpegQuality = 0.82,
    maxBytesSoft = 25 * 1024 * 1024,
    qualityFallbacks = [0.75, 0.68],
  } = options;

  // Read PDF bytes
  const inputBytes = new Uint8Array(await file.arrayBuffer());

  // Load PDF.js
const pdfjs = await loadPdfJs();

// Configure worker from same origin (CSP-safe)
if (pdfjs.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
}

const loadingTask = pdfjs.getDocument({
  data: inputBytes,
});

  const pdf = await loadingTask.promise;

  if (pdf.numPages > maxPages) {
    throw new Error(`PDF has ${pdf.numPages} pages; max supported is ${maxPages}.`);
  }

  // Build output PDF
  const { PDFDocument } = await loadPdfLib();
  const outPdf = await PDFDocument.create();

  let lastJpegQ = jpegQuality;
  let totalJpgBytes = 0;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);

    // Rasterize page to A4 canvas
    const a4Canvas = await renderPageToA4Canvas(page);

    // Encode JPEG with soft size control (per-page fallback if needed)
    let q = jpegQuality;
    let jpgBytes = await canvasToJpegBytes(a4Canvas, q);

    if (jpgBytes.byteLength > maxBytesSoft) {
      for (const fq of qualityFallbacks) {
        q = fq;
        jpgBytes = await canvasToJpegBytes(a4Canvas, q);
        if (jpgBytes.byteLength <= maxBytesSoft) break;
      }
    }

    lastJpegQ = q;
    totalJpgBytes += jpgBytes.byteLength;

    // Add A4 portrait page and draw full-page image
    const outPage = outPdf.addPage([A4.widthPt, A4.heightPt]);
    const jpg = await outPdf.embedJpg(jpgBytes);
    outPage.drawImage(jpg, {
      x: 0,
      y: 0,
      width: A4.widthPt,
      height: A4.heightPt,
    });

    // Help GC on mobile
    a4Canvas.width = 1; a4Canvas.height = 1;
  }

  const outBytes = await outPdf.save();
  const pdfBlob = new Blob([outBytes], { type: "application/pdf" });

  const ended = performance.now();

  const meta = {
    original: {
      name: file.name,
      type: file.type,
      sizeBytes: file.size,
      lastModified: file.lastModified || null,
      pages: pdf.numPages,
    },
    processing: {
      a4: "portrait",
      targetPx: A4.pxPortrait,
      jpegQualityUsedLastPage: lastJpegQ,
      totalRasterJpgBytes: totalJpgBytes,
      pdfBytes: pdfBlob.size,
      durationMs: Math.round(ended - started),
      rasterized: true,
    },
  };

  return { pdfBlob, meta };
}
