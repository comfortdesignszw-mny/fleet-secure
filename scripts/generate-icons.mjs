// Generates crisp, valid PNG icons (192x192, 512x512, maskable 512x512, apple-touch-icon 180x180)
// using only Node built-in zlib and fs so no external native packages are required.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function renderIcon(size, maskable = false) {
  const buf = Buffer.alloc(size * size * 4);
  // Safe zone scaling: maskable keeps logo inside central 68%
  const scale = maskable ? 0.68 : 0.86;
  const half = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      // Normalized coords in [-1, 1]
      const nx = (x + 0.5 - half) / (half * scale);
      const ny = (y + 0.5 - half) / (half * scale);

      // Base slate-900 (#0F172A)
      let r = 15, g = 23, b = 42, a = 255;

      // Shield outer contour
      const inShieldTop = ny >= -0.62 && ny <= 0.1 && Math.abs(nx) <= 0.62;
      const shieldBottomY = 0.68 - Math.abs(nx) * 0.92;
      const inShieldBottom = ny > 0.1 && ny <= shieldBottomY && Math.abs(nx) <= 0.62;
      const inShield = inShieldTop || inShieldBottom;

      // Shield inner contour
      const inInnerTop = ny >= -0.52 && ny <= 0.08 && Math.abs(nx) <= 0.52;
      const innerBottomY = 0.56 - Math.abs(nx) * 0.92;
      const inInnerBottom = ny > 0.08 && ny <= innerBottomY && Math.abs(nx) <= 0.52;
      const inInner = inInnerTop || inInnerBottom;

      if (inShield && !inInner) {
        // Sky-400 shield border (#38BDF8)
        r = 56; g = 189; b = 248;
      } else if (inInner) {
        // Slate-800 shield interior (#1E293B)
        r = 30; g = 41; b = 59;
      }

      // Emerald-500 checkmark (#10B981)
      const d1 = distToSegment(nx, ny, -0.28, 0.02, -0.06, 0.24);
      const d2 = distToSegment(nx, ny, -0.06, 0.24, 0.34, -0.20);
      if (Math.min(d1, d2) <= 0.085) {
        r = 16; g = 185; b = 129;
      }

      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = a;
    }
  }
  return encodePNG(size, size, buf);
}

const outDir = path.resolve(process.cwd(), 'public');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'pwa-192x192.png'), renderIcon(192, false));
fs.writeFileSync(path.join(outDir, 'pwa-512x512.png'), renderIcon(512, false));
fs.writeFileSync(path.join(outDir, 'pwa-maskable-512x512.png'), renderIcon(512, true));
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), renderIcon(180, false));
console.log('Generated PWA PNG icons in public/');
