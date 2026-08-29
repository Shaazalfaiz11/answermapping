"use client";

import type { PageImage } from "./types";

/**
 * Turns uploaded PDFs/images into page bitmaps in the browser. Rendering
 * client-side keeps the files out of any server and gives us the exact pixel
 * geometry the highlight overlay is measured against.
 */

/** Long-edge cap for rendered pages: enough detail for handwriting, small enough to upload. */
const MAX_EDGE = 1700;
/** Images sent to the vision model are downscaled further to stay inside token limits. */
const MODEL_MAX_EDGE = 1100;

type PdfModule = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfModule> | null = null;

async function loadPdfjs(): Promise<PdfModule> {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    return pdfjs;
  })();
  return pdfjsPromise;
}

export function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/** Count pages without rasterising, so the upload card can show "6 Pages" immediately. */
export async function countPages(file: File): Promise<number> {
  if (!isPdf(file)) return 1;
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

function fitScale(width: number, height: number, maxEdge: number): number {
  const longest = Math.max(width, height);
  return longest > maxEdge ? maxEdge / longest : 1;
}

async function renderPdf(
  file: File,
  onPage?: (done: number, total: number) => void,
): Promise<PageImage[]> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: PageImage[] = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: fitScale(base.width, base.height, MAX_EDGE),
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    // pdf.js v5 takes the canvas itself; passing a context alongside it is the
    // deprecated path. `background` flattens transparent-backed scans onto white.
    await page.render({ canvas, viewport, background: "#ffffff" }).promise;

    pages.push({
      index: pages.length,
      dataUrl: canvas.toDataURL("image/jpeg", 0.88),
      width: canvas.width,
      height: canvas.height,
    });
    page.cleanup();
    onPage?.(n, doc.numPages);
  }

  await doc.destroy();
  return pages;
}

async function renderImage(file: File, index: number): Promise<PageImage> {
  const bitmap = await createImageBitmap(file);
  const scale = fitScale(bitmap.width, bitmap.height, MAX_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return {
    index,
    dataUrl: canvas.toDataURL("image/jpeg", 0.88),
    width: canvas.width,
    height: canvas.height,
  };
}

/**
 * Render every uploaded file to page images, in the order the files were given.
 * Multiple image files are treated as consecutive pages of one document.
 */
export async function renderToPages(
  files: File[],
  onProgress?: (fraction: number) => void,
): Promise<PageImage[]> {
  const pages: PageImage[] = [];

  for (let f = 0; f < files.length; f++) {
    const file = files[f];
    if (isPdf(file)) {
      const rendered = await renderPdf(file, (done, total) =>
        onProgress?.((f + done / total) / files.length),
      );
      for (const p of rendered) pages.push({ ...p, index: pages.length });
    } else {
      pages.push(await renderImage(file, pages.length));
      onProgress?.((f + 1) / files.length);
    }
  }

  onProgress?.(1);
  return pages;
}

/** Downscale a page for upload; the model does not need full resolution. */
export async function toModelImage(dataUrl: string): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const scale = fitScale(img.width, img.height, MODEL_MAX_EDGE);
  if (scale === 1) return dataUrl;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}
