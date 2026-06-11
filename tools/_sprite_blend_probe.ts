/**
 * Sprite-visibility diagnosis at a target frame: run the same scripted input three times and
 * compare framebuffers:
 *   A) normal renderer
 *   B) renderSprites disabled            -> shows what the BG-only frame looks like
 *   C) semi-transparent OBJ forced opaque -> shows whether the blend path is hiding sprites
 * Also dumps BLDCNT/BLDALPHA/BLDY so we can see the blend registers the game programmed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
import { GbaPpu } from '../src/runtime/ppu.ts';

const [romPath, framesStr, script] = process.argv.slice(2);
const FRAMES = Number(framesStr);

const KEY: Record<string, number> = { A: 0, B: 1, SELECT: 2, START: 3, RIGHT: 4, LEFT: 5, UP: 6, DOWN: 7, R: 8, L: 9 };
function runScripted(mutate: ((m: GbaMachine) => void) | null): GbaMachine {
  const m = new GbaMachine(new Uint8Array(readFileSync(romPath)));
  if (mutate) mutate(m);
  const pressAt = new Map<number, number>();
  for (const ev of (script || '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const [when, key] = ev.split(':');
    const bit = KEY[key.toUpperCase()];
    if (when.includes('-')) {
      const [range, stepStr] = when.split('/');
      const [from, to] = range.split('-').map(Number);
      for (let f = from; f <= to; f += Number(stepStr || 60)) pressAt.set(f, (pressAt.get(f) || 0) | (1 << bit));
    } else pressAt.set(Number(when), (pressAt.get(Number(when)) || 0) | (1 << bit));
  }
  let keys = 0x3ff; const releaseAt = new Map<number, number>();
  for (let f = 1; f <= FRAMES; f++) {
    const p = pressAt.get(f); if (p) { keys &= ~p; m.setKeys(keys); releaseAt.set(f + 6, p); }
    const r = releaseAt.get(f); if (r) { keys |= r; m.setKeys(keys); releaseAt.delete(f); }
    m.runFrame();
  }
  return m;
}

function fbDiff(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): number {
  let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  return n; // differing pixels
}
function shoot(m: GbaMachine, name: string) {
  const W = 240, H = 160; const fb = m.ppu.framebuffer;
  const header = `P6\n${W} ${H}\n255\n`;
  const body = new Uint8Array(W * H * 3);
  for (let i = 0, j = 0; i < W * H * 4; i += 4) { body[j++] = fb[i]; body[j++] = fb[i + 1]; body[j++] = fb[i + 2]; }
  const out = new Uint8Array(header.length + body.length);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  out.set(body, header.length);
  writeFileSync(`build/blendprobe_${name}.ppm`, out);
}

console.log('run A: normal...');
const A = runScripted(null);
shoot(A, 'normal');
console.log(`BLDCNT=0x${A.io.get16(0x050).toString(16)} BLDALPHA=0x${A.io.get16(0x052).toString(16)} BLDY=0x${A.io.get16(0x054).toString(16)} DISPCNT=0x${A.io.get16(0x000).toString(16)}`);

console.log('run B: sprites disabled...');
const B = runScripted((m) => { (m.ppu as any).renderSprites = () => {}; });
shoot(B, 'nosprites');

console.log('run C: semi-transparent OBJ forced opaque...');
const C = runScripted((m) => {
  const ppu: any = m.ppu;
  const orig = Object.getPrototypeOf(ppu).renderSprites;
  ppu.renderSprites = function (line: number, dispcnt: number, colorLine: any, priLine: any, drawn: any) {
    // Monkey-wrap: temporarily rewrite OAM attr0 objMode 1 -> 0 for this call.
    const saved: Array<[number, number]> = [];
    for (let i = 0; i < 128; i++) {
      const a0 = this.mem.oam16(i * 8);
      if (((a0 >> 10) & 3) === 1) { saved.push([i, a0]); this.mem.oam[i * 8] = (a0 & ~0x0400) & 0xff; this.mem.oam[i * 8 + 1] = ((a0 & ~0x0400) >> 8) & 0xff; }
    }
    orig.call(this, line, dispcnt, colorLine, priLine, drawn);
    for (const [i, a0] of saved) { this.mem.oam[i * 8] = a0 & 0xff; this.mem.oam[i * 8 + 1] = (a0 >> 8) & 0xff; }
  };
});
shoot(C, 'opaque');

const dAB = fbDiff(A.ppu.framebuffer, B.ppu.framebuffer);
const dAC = fbDiff(A.ppu.framebuffer, C.ppu.framebuffer);
const dBC = fbDiff(B.ppu.framebuffer, C.ppu.framebuffer);
console.log(`\npixels changed by sprites (A vs B): ${dAB}`);
console.log(`pixels changed by forcing opaque (A vs C): ${dAC}`);
console.log(`sprite contribution when opaque (B vs C): ${dBC}`);
console.log(dAB === 0 && dBC > 0
  ? '>>> VERDICT: sprites render INVISIBLY in normal mode but EXIST when opaque - the semi-transparent blend path is eating them.'
  : dAB === 0 && dBC === 0
    ? '>>> VERDICT: sprites contribute nothing even when opaque - tile data or OAM placement issue, not blending.'
    : '>>> VERDICT: sprites ARE visible in normal mode; issue is elsewhere (check screenshots).');
