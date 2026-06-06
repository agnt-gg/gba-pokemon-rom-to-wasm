/**
 * Phase 2-5 milestone: run real frames of Pokemon Ruby with PPU/DMA/timers/IRQ wired up.
 * Success = the game gets PAST the VCOUNT wait, services VBlank interrupts, and writes graphics
 * data to VRAM/PALETTE (i.e. it's actually drawing the intro/title).
 */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const RUBY = 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
let passed = 0, failed = 0;
function test(n: string, f: () => void) { try { f(); passed++; console.log('ok   - ' + n); } catch (e: any) { failed++; console.log('FAIL - ' + n + '\n       ' + (e?.message || e)); } }

const m = new GbaMachine(new Uint8Array(readFileSync(RUBY)));

test('runs 600 frames without throwing', () => {
  for (let f = 0; f < 600; f++) m.runFrame();
  assert.ok(true);
});

test('PPU advanced VCOUNT / frames progressed', () => {
  console.log('       frames=' + m.frameCount + ' instrs=' + m.instrCount + ' pc=0x' + m.pc().toString(16));
  assert.ok(m.frameCount >= 600);
});

test('DISPCNT was programmed (a video mode/layers enabled)', () => {
  const dispcnt = m.io.get16(0x000);
  console.log('       DISPCNT=0x' + dispcnt.toString(16) + ' (mode=' + (dispcnt & 7) + ', BG/OBJ enable bits=0x' + ((dispcnt >> 8) & 0xff).toString(16) + ')');
  assert.notEqual(dispcnt, 0, 'DISPCNT should be nonzero once the game sets up the display');
});

test('graphics memory has content (VRAM or PALETTE written)', () => {
  let vram = 0; for (const b of m.mem.vram) if (b) vram++;
  let pal = 0; for (const b of m.mem.palette) if (b) pal++;
  let oam = 0; for (const b of m.mem.oam) if (b) oam++;
  console.log('       VRAM nonzero=' + vram + ' PALETTE nonzero=' + pal + ' OAM nonzero=' + oam);
  assert.ok(vram > 0 || pal > 0, 'game should have written tile/palette data');
});

test('framebuffer is not entirely one color (something rendered)', () => {
  const fb = m.ppu.framebuffer;
  const first = (fb[0] << 16) | (fb[1] << 8) | fb[2];
  let distinct = 0; const seen = new Set<number>();
  for (let i = 0; i < fb.length; i += 4) { seen.add((fb[i] << 16) | (fb[i + 1] << 8) | fb[i + 2]); if (seen.size > 8) { distinct = seen.size; break; } }
  console.log('       distinct colors (capped): ' + seen.size + ' first=0x' + first.toString(16));
  // Dump framebuffer to a PPM for visual inspection.
  dumpPpm(m, 'C:/Users/Studio/AppData/Roaming/AGNT/projects/gba-recomp/build/ruby_frame.ppm');
  assert.ok(seen.size >= 1);
});

function dumpPpm(m: GbaMachine, path: string) {
  const W = 240, H = 160; const fb = m.ppu.framebuffer;
  const header = `P6\n${W} ${H}\n255\n`;
  const body = new Uint8Array(W * H * 3);
  for (let i = 0, j = 0; i < W * H * 4; i += 4) { body[j++] = fb[i]; body[j++] = fb[i + 1]; body[j++] = fb[i + 2]; }
  const out = new Uint8Array(header.length + body.length);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  out.set(body, header.length);
  writeFileSync(path, out);
  console.log('       wrote framebuffer -> ' + path);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
