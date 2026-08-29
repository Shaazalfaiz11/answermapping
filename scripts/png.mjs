import { inflateSync } from "node:zlib";

/**
 * Minimal PNG reader for the test harness: 8-bit, non-interlaced, which is what
 * the fixture generator produces. Avoids pulling an image library into the
 * project just to verify the segmentation maths.
 */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG");

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("Interlaced PNG not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  if (bitDepth !== 8) throw new Error(`Unsupported bit depth ${bitDepth}`);

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec section 9).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prior ? prior[i] : 0;
      const c = prior && i >= channels ? prior[i - channels] : 0;
      const x = line[i];

      switch (filter) {
        case 0:
          out[i] = x;
          break;
        case 1:
          out[i] = (x + a) & 0xff;
          break;
        case 2:
          out[i] = (x + b) & 0xff;
          break;
        case 3:
          out[i] = (x + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          out[i] = (x + pred) & 0xff;
          break;
        }
        default:
          throw new Error(`Unknown filter ${filter}`);
      }
    }
  }

  return { width, height, channels, pixels };
}

/** Convert a decoded PNG to a greyscale buffer, flattening alpha onto white. */
export function toGray({ width, height, channels, pixels }) {
  const gray = new Uint8Array(width * height);

  for (let p = 0; p < width * height; p++) {
    const i = p * channels;
    let r;
    let g;
    let b;
    let alpha = 255;

    if (channels === 1) {
      r = g = b = pixels[i];
    } else if (channels === 2) {
      r = g = b = pixels[i];
      alpha = pixels[i + 1];
    } else {
      r = pixels[i];
      g = pixels[i + 1];
      b = pixels[i + 2];
      if (channels === 4) alpha = pixels[i + 3];
    }

    let v = (r * 299 + g * 587 + b * 114) / 1000;
    if (alpha < 255) v = v * (alpha / 255) + 255 * (1 - alpha / 255);
    gray[p] = v;
  }

  return gray;
}

/** Nearest-neighbour downscale, matching what the browser path does closely enough. */
export function resizeGray(gray, width, height, targetWidth) {
  if (targetWidth >= width) return { gray, width, height };

  const scale = targetWidth / width;
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(outWidth * outHeight);

  // Box-average so thin strokes are not lost the way nearest-neighbour loses them.
  const boxW = width / outWidth;
  const boxH = height / outHeight;

  for (let y = 0; y < outHeight; y++) {
    const y0 = Math.floor(y * boxH);
    const y1 = Math.min(height, Math.ceil((y + 1) * boxH));
    for (let x = 0; x < outWidth; x++) {
      const x0 = Math.floor(x * boxW);
      const x1 = Math.min(width, Math.ceil((x + 1) * boxW));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          sum += gray[yy * width + xx];
          n++;
        }
      }
      out[y * outWidth + x] = n > 0 ? sum / n : 255;
    }
  }

  return { gray: out, width: outWidth, height: outHeight };
}
