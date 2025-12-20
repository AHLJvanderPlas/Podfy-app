// public/compress/compress_file_to_pdf.js
// Router: decide by file type. Step 1 supports images only.
// Step 2 will add PDF rasterization here.

import { imageFileToA4Pdf } from "./image_to_a4_pdf.js";

function isPdf(file) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isImage(file) {
  // Includes empty type edge cases by checking extension.
  const t = (file.type || "").toLowerCase();
  if (t.startsWith("image/")) return true;
  const n = file.name.toLowerCase();
  return n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png") || n.endsWith(".webp") || n.endsWith(".heic") || n.endsWith(".heif");
}

export async function compressFileToPdf(file) {
  if (isImage(file)) {
    return imageFileToA4Pdf(file);
  }

  if (isPdf(file)) {
    // Step 2 will implement: rasterize PDF -> A4@300DPI -> JPEG pages -> PDF
    throw new Error("PDF compression not implemented yet (Step 2).");
  }

  throw new Error(`Unsupported file type: ${file.type || "unknown"} (${file.name})`);
}
