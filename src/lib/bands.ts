import type { LineBand } from "./types";

/**
 * Line segmentation maths, with no DOM dependency.
 *
 * Kept separate from lineDetect.ts so the algorithm can be exercised directly
 * against fixture images in Node - the browser shell only supplies pixels.
 */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Otsu's method: pick the threshold that best separates ink from paper. */
export function otsu(histogram: ArrayLike<number>, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }

  // Nudge darker so faint paper texture is not read as ink.
  return Math.max(60, Math.min(200, best));
}

/** Binarise a greyscale buffer into an ink mask (1 = ink). */
export function toInkMask(gray: Uint8Array): Uint8Array {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) histogram[gray[i]]++;

  const threshold = otsu(histogram, gray.length);
  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) mask[i] = gray[i] < threshold ? 1 : 0;
  return mask;
}

/**
 * Columns inked down most of the page: printed margins and vertical rules.
 * Left in, they make every row look occupied and destroy the row profile.
 */
function ruleColumns(mask: Uint8Array, width: number, height: number): Uint8Array {
  const isRule = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < height; y++) if (mask[y * width + x]) count++;
    if (count > height * 0.55) isRule[x] = 1;
  }
  return isRule;
}

/** A printed rule is one long uninterrupted stroke; handwriting is broken up. */
function isHorizontalRule(
  mask: Uint8Array,
  width: number,
  y: number,
  usableWidth: number,
): boolean {
  let run = 0;
  let longest = 0;
  for (let x = 0; x < width; x++) {
    if (mask[y * width + x]) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest > usableWidth * 0.75;
}

/** Find the horizontal ink bands on one page, in reading order. */
export function bandsFromMask(
  mask: Uint8Array,
  width: number,
  height: number,
): LineBand[] {
  const isRule = ruleColumns(mask, width, height);
  const border = Math.round(width * 0.02);

  let usableWidth = 0;
  for (let x = border; x < width - border; x++) if (!isRule[x]) usableWidth++;
  if (usableWidth === 0) return [];

  const rowInk = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    if (isHorizontalRule(mask, width, y, usableWidth)) continue;
    let count = 0;
    for (let x = border; x < width - border; x++) {
      if (!isRule[x] && mask[y * width + x]) count++;
    }
    rowInk[y] = count;
  }

  const rowThreshold = Math.max(2, Math.round(usableWidth * 0.006));

  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let y = 0; y < height; y++) {
    const inked = rowInk[y] >= rowThreshold;
    if (inked && start === -1) start = y;
    else if (!inked && start !== -1) {
      runs.push({ start, end: y - 1 });
      start = -1;
    }
  }
  if (start !== -1) runs.push({ start, end: height - 1 });
  if (runs.length === 0) return [];

  // Merge runs separated by less than half a typical line height: ascenders and
  // descenders of the same handwritten line otherwise split into two bands.
  const heights = runs.map((r) => r.end - r.start + 1).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 8;
  const mergeGap = Math.max(4, Math.round(medianHeight * 0.6));

  const merged: Array<{ start: number; end: number }> = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && run.start - prev.end <= mergeGap) prev.end = run.end;
    else merged.push({ ...run });
  }

  // Drop specks: anything far thinner than a real line of writing.
  const minHeight = Math.max(3, Math.round(medianHeight * 0.45));
  const kept = merged.filter((r) => r.end - r.start + 1 >= minHeight);

  const padX = width * 0.008;
  const padY = height * 0.004;

  return kept.map((run, i) => {
    let minX = width;
    let maxX = 0;
    for (let y = run.start; y <= run.end; y++) {
      for (let x = border; x < width - border; x++) {
        if (!isRule[x] && mask[y * width + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    if (minX > maxX) {
      minX = border;
      maxX = width - border;
    }

    return {
      index: i + 1,
      x0: clamp01((minX - padX) / width),
      y0: clamp01((run.start - padY) / height),
      x1: clamp01((maxX + padX) / width),
      y1: clamp01((run.end + padY) / height),
    };
  });
}

/** Union of the bands in [startLine, endLine], as one normalised rectangle. */
export function bandsToRegion(
  bands: LineBand[],
  startLine: number,
  endLine: number,
): { x: number; y: number; width: number; height: number } | null {
  const selected = bands.filter((b) => b.index >= startLine && b.index <= endLine);
  if (selected.length === 0) return null;

  const x0 = Math.min(...selected.map((b) => b.x0));
  const y0 = Math.min(...selected.map((b) => b.y0));
  const x1 = Math.max(...selected.map((b) => b.x1));
  const y1 = Math.max(...selected.map((b) => b.y1));

  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
