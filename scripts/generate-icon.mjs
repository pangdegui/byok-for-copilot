/**
 * Generate VS Code extension icons — clean interlocking rings.
 *
 * resources/icon.png         128×128  (marketplace)
 * resources/activitybar.png   24×24   (activity bar)
 *
 * Pure Node.js (zlib built-in), no dependencies.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOURCES = resolve(__dirname, '..', 'resources');
mkdirSync(RESOURCES, { recursive: true });

// ---- PNG builder ----

function buildPNG(pixels, w, h) {
  const scanlines = [];
  for (let y = 0; y < h; y++) {
    const line = Buffer.alloc(1 + w * 4);
    line[0] = 0;
    pixels.copy(line, 1, y * w * 4, (y + 1) * w * 4);
    scanlines.push(line);
  }
  const raw = Buffer.concat(scanlines);

  const crc32 = (b) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0); }
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };

  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w,0); ih.writeUInt32BE(h,4); ih[8]=8; ih[9]=6;
  return Buffer.concat([sig, chk('IHDR', ih), chk('IDAT', deflateSync(raw, { level: 9 })), chk('IEND', Buffer.alloc(0))]);
}

// ---- Pixel ops ----

function setPx(buf, w, x, y, r, g, b, a) {
  if (x < 0 || x >= w || y < 0) return;
  const i = (y * w + x) * 4;
  const sa = a / 255;
  buf[i]     = Math.round(buf[i]     * (1 - sa) + r * sa);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - sa) + g * sa);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - sa) + b * sa);
  buf[i + 3] = Math.round(Math.min(255, buf[i + 3] + a));
}

function aaCircle(buf, w, cx, cy, r, R, G, B, A = 255) {
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const alpha = d <= r - 0.5 ? A : d <= r + 0.5 ? Math.round(A * (r + 0.5 - d)) : 0;
      if (alpha > 0) setPx(buf, w, x, y, R, G, B, alpha);
    }
  }
}

// ---- Icon: two interlocking rings (infinity-like) ----

function makeIcon(size, r, g, b) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const cx = size / 2;
  const cy = size * 0.50;
  const radius = size * 0.28;
  const ringW = size * 0.10;
  const offset = size * 0.09;

  // Left ring
  aaCircle(buf, size, cx - offset, cy, radius, r, g, b);
  aaCircle(buf, size, cx - offset, cy, radius - ringW, 0, 0, 0, 0);

  // Right ring
  aaCircle(buf, size, cx + offset, cy, radius, r, g, b);
  aaCircle(buf, size, cx + offset, cy, radius - ringW, 0, 0, 0, 0);

  return buf;
}

// ---- Generate ----

// Activity bar 24×24 — light grey
const aBuf = makeIcon(24, 0xdd, 0xdd, 0xdd);
writeFileSync(resolve(RESOURCES, 'activitybar.png'), buildPNG(aBuf, 24, 24));

// Marketplace 128×128 — blue accent
const iBuf = makeIcon(128, 0x4d, 0xa8, 0xff);
writeFileSync(resolve(RESOURCES, 'icon.png'), buildPNG(iBuf, 128, 128));

console.log('✓ Generated activitybar.png (24×24)');
console.log('✓ Generated icon.png (128×128)');
