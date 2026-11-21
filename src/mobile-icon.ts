// The phone's home-screen icon (src/mobile.ts): Pako's orb on a dark square, drawn here as a PNG at the sizes a phone asks for, rather
// than kept as image files in git. iOS takes no SVG for "Add to Home Screen", so these are plain PNGs (RGBA, no compression tricks).

import { crc32, deflateSync } from "node:zlib";

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};

/** A PNG from RGBA pixels, row by row. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; // bits per channel
  head[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const BG = [20, 17, 15];
const LIGHT = [236, 140, 96];
const DARK = [176, 78, 42];

/**
 * The icon, `size` pixels square: a warm orb, lit from the top left, on Pako's dark ground. Its radius is 0.36 of the side, inside the
 * "maskable" safe circle (0.4), so a phone that crops it to a circle or a squircle never cuts the orb.
 */
export function iconPng(size: number): Buffer {
  const px = new Uint8Array(size * size * 4);
  const c = size / 2;
  const r = size * 0.36;
  // Four samples a pixel, for a smooth edge.
  const offsets = [0.25, 0.75];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (const oy of offsets) for (const ox of offsets) if (Math.hypot(x + ox - c, y + oy - c) <= r) cover += 0.25;
      // The light: nearer the top left, the lighter.
      const lx = (x - (c - r * 0.45)) / (r * 2);
      const ly = (y - (c - r * 0.45)) / (r * 2);
      const k = Math.min(1, Math.max(0, Math.hypot(lx, ly) * 1.3));
      const i = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const orb = LIGHT[ch]! * (1 - k) + DARK[ch]! * k;
        px[i + ch] = Math.round(BG[ch]! * (1 - cover) + orb * cover);
      }
      px[i + 3] = 255;
    }
  }
  return encodePng(size, size, px);
}
