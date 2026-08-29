/**
 * Runs the real line-segmentation core against the fixture pages and reports
 * what it found. Node strips the TypeScript types, so this exercises the same
 * source the browser runs - not a copy of it.
 *
 *   node --experimental-strip-types scripts/detect-bands.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bandsFromMask, toInkMask } from "../src/lib/bands.ts";
import { decodePng, resizeGray, toGray } from "./png.mjs";

const ANALYSIS_WIDTH = 900;
const fixtures = process.argv.slice(2);
if (fixtures.length === 0) {
  console.error("usage: detect-bands.mjs <page.png> [...]");
  process.exit(1);
}

const report = [];

for (const file of fixtures) {
  const decoded = decodePng(readFileSync(file));
  const full = toGray(decoded);
  const { gray, width, height } = resizeGray(
    full,
    decoded.width,
    decoded.height,
    ANALYSIS_WIDTH,
  );

  const bands = bandsFromMask(toInkMask(gray), width, height);

  console.log(`\n${file}`);
  console.log(`  ${decoded.width}x${decoded.height} -> analysed at ${width}x${height}`);
  console.log(`  ${bands.length} line bands`);
  for (const b of bands) {
    const top = Math.round(b.y0 * decoded.height);
    const bottom = Math.round(b.y1 * decoded.height);
    const left = Math.round(b.x0 * decoded.width);
    const right = Math.round(b.x1 * decoded.width);
    console.log(
      `    L${String(b.index).padStart(2)}  y ${String(top).padStart(4)}-${String(bottom).padStart(4)}  x ${String(left).padStart(4)}-${String(right).padStart(4)}`,
    );
  }

  report.push({
    file,
    width: decoded.width,
    height: decoded.height,
    bands,
  });
}

const out = join(process.cwd(), "fixtures", "bands.json");
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nWrote ${out}`);
