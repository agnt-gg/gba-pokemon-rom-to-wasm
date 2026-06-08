/**
 * Render-equivalence proof: boot the ROM with the WASM recompiler ON and OFF for the same number
 * of frames, then compare the final framebuffer byte-for-byte. If the recompiler is correct, the
 * displayed pixels MUST be identical. This is the end-to-end correctness check that complements the
 * per-instruction differential tests.
 */
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
const frames = Number(process.argv[3] || 300);
if (!romPath) { console.error('usage: _recomp_render_equiv.ts <rom.gba> [frames]'); process.exit(1); }
const rom = new Uint8Array(readFileSync(romPath));

function bootAndHash(useRecompiler: boolean): { hash: number; fb: Uint8Array; native: number; total: number } {
  const m = new GbaMachine(rom);
  m.useRecompiler = useRecompiler;
  for (let i = 0; i < frames; i++) m.runFrame();
  const fb = m.ppu.framebuffer instanceof Uint8Array ? m.ppu.framebuffer : new Uint8Array((m.ppu as any).framebuffer.buffer);
  // FNV-1a hash over the framebuffer.
  let h = 0x811c9dc5;
  for (let i = 0; i < fb.length; i++) { h ^= fb[i]; h = Math.imul(h, 0x01000193); }
  return { hash: h >>> 0, fb: Uint8Array.from(fb), native: m.recompiler ? m.recompiler.nativeInstrs : 0, total: m.instrCount };
}

console.log(`Booting "${romPath.split(/[\\/]/).pop()}" for ${frames} frames, recompiler OFF...`);
const off = bootAndHash(false);
console.log(`Booting for ${frames} frames, recompiler ON...`);
const on = bootAndHash(true);

console.log(`\nframebuffer hash (interp) : 0x${off.hash.toString(16)}`);
console.log(`framebuffer hash (wasm)   : 0x${on.hash.toString(16)}`);
console.log(`native coverage (wasm run): ${((on.native / on.total) * 100).toFixed(1)}%`);

let firstDiff = -1;
const n = Math.min(off.fb.length, on.fb.length);
for (let i = 0; i < n; i++) if (off.fb[i] !== on.fb[i]) { firstDiff = i; break; }

if (off.hash === on.hash && off.fb.length === on.fb.length && firstDiff === -1) {
  console.log(`\n✅ IDENTICAL framebuffers (${off.fb.length} bytes). WASM recompiler output == interpreter output.`);
  process.exit(0);
} else {
  console.log(`\n❌ DIVERGENCE: first differing byte at index ${firstDiff} (interp=${off.fb[firstDiff]} wasm=${on.fb[firstDiff]}), lengths ${off.fb.length} vs ${on.fb.length}`);
  process.exit(1);
}
