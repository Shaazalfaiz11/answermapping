/**
 * Builds a PDF from JPEG pages, so the fixtures cover the pdf.js path as well
 * as the plain-image path. JPEGs embed into a PDF verbatim via /DCTDecode, so
 * this needs no image library.
 *
 *   node scripts/make-pdf.mjs out.pdf page1.jpg page2.jpg ...
 */
import { readFileSync, writeFileSync } from "node:fs";

const [out, ...images] = process.argv.slice(2);
if (!out || images.length === 0) {
  console.error("usage: make-pdf.mjs <out.pdf> <page.jpg> [...]");
  process.exit(1);
}

/** Read width/height from a JPEG's SOF marker. */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    const length = buf.readUInt16BE(i + 2);

    // SOF0..SOF15, excluding DHT(c4), JPG(c8) and DAC(cc).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  throw new Error("Could not read JPEG dimensions");
}

const chunks = [];
const offsets = [0];
let length = 0;

const push = (data) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
  chunks.push(buf);
  length += buf.length;
};

const startObject = () => offsets.push(length);

push("%PDF-1.4\n");

const pageCount = images.length;
// Object layout: 1 = catalog, 2 = pages, then per page: page, contents, image.
const pageObjectId = (i) => 3 + i * 3;

startObject();
push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

startObject();
const kids = images.map((_, i) => `${pageObjectId(i)} 0 R`).join(" ");
push(`2 0 obj\n<< /Type /Pages /Count ${pageCount} /Kids [${kids}] >>\nendobj\n`);

images.forEach((file, i) => {
  const jpeg = readFileSync(file);
  const { width, height } = jpegSize(jpeg);

  // Lay the page out at 72 dpi-ish scale so the sheet is a sensible size.
  const pw = Math.round((width / 150) * 72);
  const ph = Math.round((height / 150) * 72);

  const pageId = pageObjectId(i);
  const contentId = pageId + 1;
  const imageId = pageId + 2;

  startObject();
  push(
    `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ` +
      `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
  );

  const stream = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  startObject();
  push(`${contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);

  startObject();
  push(
    `${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  push(jpeg);
  push("\nendstream\nendobj\n");
});

const xrefStart = length;
const objectCount = offsets.length;
push(`xref\n0 ${objectCount}\n`);
push("0000000000 65535 f \n");
for (let i = 1; i < objectCount; i++) {
  push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
}
push(
  `trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
);

writeFileSync(out, Buffer.concat(chunks));
console.log(`${out}  ${pageCount} page(s), ${(length / 1024).toFixed(0)}KB`);
