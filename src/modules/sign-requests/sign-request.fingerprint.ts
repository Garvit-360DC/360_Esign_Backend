import { inflateSync } from "node:zlib";

/**
 * A coarse picture of an image: its brightness on a small grid.
 *
 * Every placeholder the add-in draws carries its signer's colour and a label such as
 * "Signer A · Sign Date", so two boxes of the same size still look different. Comparing the
 * picture in the .docx with the picture painted in the converted PDF tells which box is which,
 * where their order alone cannot: Word lists a table's cells column by column, while the PDF
 * reads row by row.
 */

const GRID_WIDTH = 48;
const GRID_HEIGHT = 8;

export type Fingerprint = Float32Array;

/** Pixels as RGB(A) bytes, `channels` per pixel. */
export type Pixels = { width: number; height: number; channels: 3 | 4; data: Uint8Array | Uint8ClampedArray };

/**
 * Average brightness per grid cell, 0..1, with transparent pixels treated as white. The outer
 * ring of cells is left out: a rounded or anti-aliased edge is where the two copies differ most.
 */
export function fingerprintOf(pixels: Pixels): Fingerprint | null {
  const { width, height, channels, data } = pixels;
  if (width < GRID_WIDTH || height < GRID_HEIGHT || data.length < width * height * channels) {
    return null;
  }

  const sums = new Float64Array(GRID_WIDTH * GRID_HEIGHT);
  const counts = new Uint32Array(GRID_WIDTH * GRID_HEIGHT);

  for (let y = 0; y < height; y += 1) {
    const row = Math.min(GRID_HEIGHT - 1, Math.floor((y * GRID_HEIGHT) / height));
    for (let x = 0; x < width; x += 1) {
      const column = Math.min(GRID_WIDTH - 1, Math.floor((x * GRID_WIDTH) / width));
      const offset = (y * width + x) * channels;
      const alpha = channels === 4 ? data[offset + 3] / 255 : 1;
      const luminance =
        (0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2]) / 255;
      const cell = row * GRID_WIDTH + column;
      sums[cell] += luminance * alpha + (1 - alpha);
      counts[cell] += 1;
    }
  }

  const inner = new Float32Array((GRID_WIDTH - 2) * (GRID_HEIGHT - 2));
  let index = 0;
  for (let row = 1; row < GRID_HEIGHT - 1; row += 1) {
    for (let column = 1; column < GRID_WIDTH - 1; column += 1) {
      const cell = row * GRID_WIDTH + column;
      inner[index] = counts[cell] ? sums[cell] / counts[cell] : 1;
      index += 1;
    }
  }
  return inner;
}

/** Mean absolute difference, 0 for identical pictures. */
export function fingerprintDistance(a: Fingerprint, b: Fingerprint): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decodes the PNGs the add-in writes: 8-bit RGB or RGBA, not interlaced, which is what a canvas
 * exports. Anything else returns null, and the caller falls back to placing boxes by order.
 */
export function decodePng(buffer: Buffer): Pixels | null {
  try {
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

    let width = 0;
    let height = 0;
    let colourType = -1;
    const idat: Buffer[] = [];

    for (let offset = 8; offset + 8 <= buffer.length; ) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString("latin1", offset + 4, offset + 8);
      const body = buffer.subarray(offset + 8, offset + 8 + length);

      if (type === "IHDR") {
        width = body.readUInt32BE(0);
        height = body.readUInt32BE(4);
        const bitDepth = body[8];
        colourType = body[9];
        const interlace = body[12];
        if (bitDepth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) return null;
      } else if (type === "IDAT") {
        idat.push(body);
      } else if (type === "IEND") {
        break;
      }
      offset += 12 + length;
    }

    if (!width || !height || idat.length === 0) return null;

    const channels = colourType === 6 ? 4 : 3;
    const stride = width * channels;
    const raw = inflateSync(Buffer.concat(idat));
    if (raw.length < (stride + 1) * height) return null;

    const out = new Uint8Array(stride * height);
    for (let y = 0; y < height; y += 1) {
      const filter = raw[y * (stride + 1)];
      const source = y * (stride + 1) + 1;
      const target = y * stride;
      for (let x = 0; x < stride; x += 1) {
        const value = raw[source + x];
        const left = x >= channels ? out[target + x - channels] : 0;
        const up = y > 0 ? out[target - stride + x] : 0;
        const upLeft = x >= channels && y > 0 ? out[target - stride + x - channels] : 0;
        let decoded: number;
        switch (filter) {
          case 0: decoded = value; break;
          case 1: decoded = value + left; break;
          case 2: decoded = value + up; break;
          case 3: decoded = value + Math.floor((left + up) / 2); break;
          case 4: decoded = value + paeth(left, up, upLeft); break;
          default: return null;
        }
        out[target + x] = decoded & 0xff;
      }
    }

    return { width, height, channels, data: out };
  } catch {
    return null;
  }
}
