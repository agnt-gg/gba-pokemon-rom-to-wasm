/**
 * Multi-ROM verification probe: boots each Gen-3 Pokemon ROM for N frames on BOTH the
 * recompiler path and the interpreter-only path, then reports REAL telemetry:
 *   - frames completed, instructions executed, native coverage %
 *   - DISPCNT, VRAM/palette content, distinct framebuffer colors
 *   - framebuffer hash equivalence (recompiler vs interpreter) at checkpoints
 *   - SMC invalidations, verification rejections
 * This is a probe, not a test: it never throws, it reports.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const BASE = 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator';
const ROMS: Array<[string, string]> = [
  ['Ruby', `${BASE}/Pokemon Ruby/Pokemon Ruby.GBA`],
  ['Sapphire', `${BASE}/Pokemon Sapphire/Pokemon Sapphire.GBA`],
  ['Emerald', `${BASE}/Pokemon Emerald/Pokemon Emerald.GBA`],
  ['FireRed', `${BASE}/Pokemon - Fire Red/Pokemon - Fire Red.GBA`],
  ['LeafGreen', `${BASE}/Pokemon - Leaf Green/Pokemon - Leaf Green.GBA`],
];

const FRAMES = Number(process.env.FRAMES || 600);
const CHECKPOINTS = [60, 180, 300, 450, 600, 900, 1200, 1500, 1800, 2400, 3000].filter((f) => f <= FRAMES);

function fbHash(fb: Uint8Array | Uint8ClampedArray): string {
  // FNV-1a over the framebuffer
  let h = 0x811c9dc5;
  for (let i = 0; i < fb.length; i++) { h ^= fb[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function colorCount(fb: Uint8Array | Uint8ClampedArray): number {
  const seen = new Set<number>();
  for (let i = 0; i < fb.length; i += 4) { seen.add((fb[i] << 16) | (fb[i + 1] << 8) | fb[i + 2]); if (seen.size > 64) break; }
  return seen.size;
}

for (const [name, path] of ROMS) {
  console.log(`\n================ ${name} ================`);
  let rom: Uint8Array;
  try { rom = new Uint8Array(readFileSync(path)); } catch (e: any) { console.log(`  SKIP: ${e.message}`); continue; }

  // --- recompiler run ---
  const reHashes = new Map<number, string>();
  let reErr: string | null = null;
  const mr = new GbaMachine(rom);
  console.log(`  header: title="${mr.header.title}" code=${mr.header.gameCode}`);
  try {
    for (let f = 1; f <= FRAMES; f++) {
      mr.runFrame();
      if (CHECKPOINTS.includes(f)) reHashes.set(f, fbHash(mr.ppu.framebuffer));
    }
  } catch (e: any) { reErr = `frame ${mr.frameCount}: ${e.message}`; }

  // --- interpreter-only run ---
  const inHashes = new Map<number, string>();
  let inErr: string | null = null;
  const mi = new GbaMachine(new Uint8Array(readFileSync(path)));
  mi.useRecompiler = false;
  try {
    for (let f = 1; f <= FRAMES; f++) {
      mi.runFrame();
      if (CHECKPOINTS.includes(f)) inHashes.set(f, fbHash(mi.ppu.framebuffer));
    }
  } catch (e: any) { inErr = `frame ${mi.frameCount}: ${e.message}`; }

  const r: any = mr.recompiler;
  const stats = r ? {
    native: r.nativeInstrs ?? r.stats?.nativeInstrs, interp: r.interpInstrs ?? r.stats?.interpInstrs,
    smc: r.smcInvalidations ?? r.stats?.smcInvalidations, rejected: r.verifyRejections ?? r.stats?.verifyRejections,
  } : {};
  console.log(`  recompiler: frames=${mr.frameCount} instrs=${mr.instrCount}${reErr ? ' ERROR=' + reErr : ''}`);
  console.log(`  interp:     frames=${mi.frameCount} instrs=${mi.instrCount}${inErr ? ' ERROR=' + inErr : ''}`);
  console.log(`  recomp stats: ${JSON.stringify(stats)}`);
  const dispcnt = mr.io.get16(0x000);
  let vram = 0; for (const b of mr.mem.vram) if (b) vram++;
  let pal = 0; for (const b of mr.mem.palette) if (b) pal++;
  console.log(`  DISPCNT=0x${dispcnt.toString(16)} VRAMnz=${vram} PALnz=${pal} colors=${colorCount(mr.ppu.framebuffer)}`);
  for (const f of CHECKPOINTS) {
    const a = reHashes.get(f), b = inHashes.get(f);
    console.log(`  frame ${String(f).padStart(3)}: recomp=${a} interp=${b} ${a === b ? 'MATCH' : '*** DIVERGE ***'}`);
  }
  // dump final frame for visual check
  try {
    const W = 240, H = 160; const fb = mr.ppu.framebuffer;
    const header = `P6\n${W} ${H}\n255\n`;
    const body = new Uint8Array(W * H * 3);
    for (let i = 0, j = 0; i < W * H * 4; i += 4) { body[j++] = fb[i]; body[j++] = fb[i + 1]; body[j++] = fb[i + 2]; }
    const out = new Uint8Array(header.length + body.length);
    for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
    out.set(body, header.length);
    writeFileSync(`C:/Users/Studio/AppData/Roaming/AGNT/projects/gba-recomp/build/probe_${name.toLowerCase()}.ppm`, out);
  } catch { /* ignore */ }
}
console.log('\nprobe complete');
