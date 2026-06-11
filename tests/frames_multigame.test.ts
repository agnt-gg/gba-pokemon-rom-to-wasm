/**
 * Multi-game verification: Emerald + FireRed must BOOT (display programmed, graphics written,
 * animating framebuffer) and the recompiler must stay byte-identical to the interpreter.
 *
 * These two games gate the fixes Ruby/Sapphire never needed:
 *  - boot-time DISPCNT forced blank (gpu_regs.c defers DISPSTAT writes otherwise -> WaitForVBlank
 *    deadlock at 0x80008ac)
 *  - SIO disconnected semantics (RFU/STWI wireless-adapter probe must terminate)
 * LeafGreen shares FireRed's engine; Sapphire shares Ruby's. 300 frames each keeps suite time sane.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const BASE = 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator';
const ROMS: Array<[string, string]> = [
  ['Emerald', `${BASE}/Pokemon Emerald/Pokemon Emerald.GBA`],
  ['FireRed', `${BASE}/Pokemon - Fire Red/Pokemon - Fire Red.GBA`],
  ['LeafGreen', `${BASE}/Pokemon - Leaf Green/Pokemon - Leaf Green.GBA`],
];
const FRAMES = 300;
const CHECKPOINTS = [60, 180, 300];

let passed = 0, failed = 0;
function test(n: string, f: () => void) {
  try { f(); passed++; console.log('ok   - ' + n); }
  catch (e: any) { failed++; console.log('FAIL - ' + n + '\n       ' + (e?.message || e)); }
}

function fbHash(fb: Uint8Array | Uint8ClampedArray): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < fb.length; i++) { h ^= fb[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

for (const [name, path] of ROMS) {
  if (!existsSync(path)) { console.log(`skip - ${name}: ROM not present`); continue; }
  const rom = new Uint8Array(readFileSync(path));

  const mr = new GbaMachine(rom);
  const reHashes = new Map<number, number>();
  const mi = new GbaMachine(new Uint8Array(rom));
  mi.useRecompiler = false;
  const inHashes = new Map<number, number>();

  test(`${name}: recompiler runs ${FRAMES} frames without throwing`, () => {
    for (let f = 1; f <= FRAMES; f++) {
      mr.runFrame();
      if (CHECKPOINTS.includes(f)) reHashes.set(f, fbHash(mr.ppu.framebuffer));
    }
  });

  test(`${name}: interpreter runs ${FRAMES} frames without throwing`, () => {
    for (let f = 1; f <= FRAMES; f++) {
      mi.runFrame();
      if (CHECKPOINTS.includes(f)) inHashes.set(f, fbHash(mi.ppu.framebuffer));
    }
  });

  test(`${name}: display programmed + graphics memory written (game escaped boot spins)`, () => {
    const dispcnt = mr.io.get16(0x000);
    let vram = 0; for (const b of mr.mem.vram) if (b) { vram++; if (vram > 1000) break; }
    console.log(`       DISPCNT=0x${dispcnt.toString(16)} VRAMnz>${vram}`);
    assert.notEqual(dispcnt & 0xff7f, 0, 'DISPCNT should be programmed (ignoring forced-blank bit)');
    assert.ok(vram > 1000, 'VRAM should contain tile data');
  });

  test(`${name}: framebuffer animates (intro actually playing)`, () => {
    const hashes = CHECKPOINTS.map((f) => reHashes.get(f));
    assert.ok(new Set(hashes).size >= 2, `expected animation, got ${hashes.map((h) => h?.toString(16)).join(',')}`);
  });

  test(`${name}: recompiler framebuffers byte-identical to interpreter at all checkpoints`, () => {
    for (const f of CHECKPOINTS) {
      assert.equal(reHashes.get(f), inHashes.get(f), `frame ${f}: recomp=${reHashes.get(f)?.toString(16)} interp=${inHashes.get(f)?.toString(16)}`);
    }
  });

  test(`${name}: native coverage > 99%`, () => {
    const r: any = mr.recompiler;
    const cov = r.nativeInstrs / (r.nativeInstrs + (mr.instrCount - r.nativeInstrs));
    console.log(`       native=${r.nativeInstrs} total=${mr.instrCount} coverage=${(100 * r.nativeInstrs / mr.instrCount).toFixed(2)}%`);
    assert.ok(r.nativeInstrs / mr.instrCount > 0.99, 'coverage regression');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
