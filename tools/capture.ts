/**
 * Boot a ROM and dump a frame to PNG so we can eyeball PPU output.
 * Usage: node --experimental-strip-types tools/capture.ts <rom> <frames> <out.png>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { GbaMachine } from '../src/runtime/machine.ts';

const rom = process.argv[2] ?? 'build/ruby.gba';
const frames = parseInt(process.argv[3] ?? '200', 10);
const out = process.argv[4] ?? 'build/frame.png';

const m = new GbaMachine(new Uint8Array(readFileSync(rom)));
let fb = new Uint8Array(240 * 160 * 4);
for (let f = 0; f < frames; f++) fb = m.runFrame();

// Encode RGBA -> PNG (truecolor+alpha, single IDAT).
function png(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.subarray(y * width * 4, (y + 1) * width * 4).forEach((b, i) => { raw[y * (width * 4 + 1) + 1 + i] = b; });
  }
  const idat = deflateSync(raw);
  const chunks: Buffer[] = [];
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const tb = Buffer.from(type, 'ascii');
    const body = Buffer.concat([tb, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', idat));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer): number { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

writeFileSync(out, png(240, 160, fb));

// Quick stats so we know if the screen is blank/garbage/structured.
let nonBlack = 0, distinct = new Set<number>();
for (let i = 0; i < fb.length; i += 4) {
  const k = (fb[i] << 16) | (fb[i + 1] << 8) | fb[i + 2];
  if (k !== 0) nonBlack++;
  distinct.add(k);
}
console.log(`Wrote ${out} after ${frames} frames. nonBlackPixels=${nonBlack}/${240 * 160} distinctColors=${distinct.size}`);
console.log('DISPCNT=0x' + (m.io.get16(0x000)).toString(16) + ' mode=' + (m.io.get16(0x000) & 7));
