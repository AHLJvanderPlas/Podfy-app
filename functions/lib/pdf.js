// functions/lib/pdf.js
// Step 1: Simple “one A4 PDF per upload” builder, no branding yet.

import { PDFDocument, PageSizes } from 'pdf-lib';

/**
 * Build a single A4 PDF from an uploaded file.
 *
 * For Step 1:
 * - If the file is already a PDF, we return it unchanged.
 * - If the file is JPEG/PNG, we create a simple A4 page with the image centered.
 * - We never resample the image; we only scale it down to fit the page,
 *   and never upscale (so we do not degrade the effective DPI vs the source).
 */
export async function buildSinglePdfFromUpload({ buffer, contentType, fileName }) {
  const uint8 =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  // 1) If it is already a PDF, keep as-is (no layout yet in Step 1)
  if (contentType === 'application/pdf') {
    return {
      pdfBuffer: uint8,
      pageCount: null
    };
  }

  // 2) Only convert JPEG/PNG in Step 1
  const isJpeg = contentType === 'image/jpeg';
  const isPng = contentType === 'image/png';

  if (!isJpeg && !isPng) {
    // For HEIC/WEBP or anything else, we let the caller decide (fallback to original storage).
    throw new Error(`Unsupported contentType for PDF conversion: ${contentType}`);
  }

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage(PageSizes.A4); // A4 portrait
  const { width: pageWidth, height: pageHeight } = page.getSize();

  // Embed image
  const image = isJpeg
    ? await pdfDoc.embedJpg(uint8)
    : await pdfDoc.embedPng(uint8);

  const imgWidth = image.width;
  const imgHeight = image.height;

  // Fit image within page with a small margin, never upscale
  const margin = 36; // 0.5 inch
  const maxWidth = pageWidth - margin * 2;
  const maxHeight = pageHeight - margin * 2;

  const scale = Math.min(
    maxWidth / imgWidth,
    maxHeight / imgHeight,
    1 // do not upscale
  );

  const drawWidth = imgWidth * scale;
  const drawHeight = imgHeight * scale;

  const x = (pageWidth - drawWidth) / 2;
  const y = (pageHeight - drawHeight) / 2;

  page.drawImage(image, {
    x,
    y,
    width: drawWidth,
    height: drawHeight
  });

  const pdfBytes = await pdfDoc.save();

  return {
    pdfBuffer: pdfBytes,
    pageCount: 1
  };
}
