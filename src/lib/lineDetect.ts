"use client";

import { bandsFromMask, toInkMask } from "./bands";
import type { LineBand, PageImage } from "./types";

/**
 * Browser shell around the line-segmentation core.
 *
 * Vision models are unreliable at emitting pixel coordinates, but they are good
 * at reading a number printed next to a line. So we find the ink lines
 * ourselves - deterministic, and it works on handwriting where OCR does not -
 * then stamp an index beside each one. The model only has to say "Q3 runs from
 * line 5 to line 12", and the highlight rectangle comes from our measurements.
 */

/** Working width for analysis; smaller is faster and smooths pen noise. */
const ANALYSIS_WIDTH = 900;
/** Margin drawn on the annotated image to hold the line numbers, in px. */
const GUTTER = 78;

export { bandsToRegion } from "./bands";

/** Rasterise to greyscale at analysis resolution. */
async function toGray(
  dataUrl: string,
): Promise<{ gray: Uint8Array; width: number; height: number }> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const scale = Math.min(1, ANALYSIS_WIDTH / img.width);
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const { data: rgba } = ctx.getImageData(0, 0, width, height);
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    // Luma; scans are near-greyscale so exact weights matter little.
    gray[p] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
  }

  return { gray, width, height };
}

/** Find the horizontal ink bands on one page, in reading order. */
export async function detectBands(dataUrl: string): Promise<LineBand[]> {
  const { gray, width, height } = await toGray(dataUrl);
  return bandsFromMask(toInkMask(gray), width, height);
}

/**
 * Redraw the page with each detected band numbered in a left gutter, so the
 * vision model can refer to lines by index instead of guessing coordinates.
 */
export async function annotateBands(
  page: PageImage,
  bands: LineBand[],
  maxEdge = 1100,
): Promise<string> {
  const img = new Image();
  img.src = page.dataUrl;
  await img.decode();

  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const pageWidth = Math.round(img.width * scale);
  const pageHeight = Math.round(img.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = pageWidth + GUTTER;
  canvas.height = pageHeight;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, GUTTER, 0, pageWidth, pageHeight);

  ctx.fillStyle = "#eef2f7";
  ctx.fillRect(0, 0, GUTTER, pageHeight);

  const fontSize = Math.max(15, Math.round(pageHeight * 0.016));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const band of bands) {
    const top = band.y0 * pageHeight;
    const bottom = band.y1 * pageHeight;

    // Ticks marking the band's vertical extent.
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER - 6, top);
    ctx.lineTo(GUTTER - 1, top);
    ctx.moveTo(GUTTER - 6, bottom);
    ctx.lineTo(GUTTER - 1, bottom);
    ctx.stroke();

    ctx.fillStyle = "#0f172a";
    ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial`;
    ctx.fillText(`L${band.index}`, GUTTER / 2, (top + bottom) / 2);
  }

  return canvas.toDataURL("image/jpeg", 0.85);
}
