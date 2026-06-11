/**
 * Scripted-input probe: drive a ROM with timed key presses, dump screenshots + OAM/VRAM
 * diagnostics at checkpoints. Used to reach in-game screens headlessly (main menu, Oak intro).
 *
 *   node --experimental-strip-types tools/_input_probe.ts <rom> <tag> <frames> "<script>"
 *
 * Script syntax: semicolon-separated events  "<frame>:<key>"  — press key for 6 frames.
 *   keys: A B SELECT START RIGHT LEFT UP DOWN R L
 *   Repeat ranges: "<from>-<to>/<step>:<key>" presses key every <step> frames in [from,to].
 * Screenshots: every 300 frames + final, written to build/inprobe_<tag>_<frame>.ppm (+png via ffmpeg later).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const KEY: Record<string, number> = { A: 0, B: 1, SELECT: 2, START: 3, RIGHT: 4, LEFT: 5, UP: 6, DOWN: 7, R: 8, L: 9 };
const HOLD = 6;

const [romPath, tag, framesStr, script] = process.argv.slice(2);
const FRAMES = Number(framesStr || 3000);

// Expand the key script into per-frame pressed-key sets.
const pressAt = new Map<number, number>(); // frame -> bitmask of keys newly pressed (held HOLD frames)
for (const ev of (script || '').split(';').map((s) => s.trim()).filter(Boolean)) {
  const [when, key] = ev.split(':');
  const bit = KEY[key.toUpperCase()];
  if (bit === undefined) { console.error('bad key: ' + key); process.exit(1); }
  if (when.includes('-')) {
    const [range, stepStr] = when.split('/');
    const [from, to] = range.split('-').map(Number);
    const step = Number(stepStr || 60);
    for (let f = from; f <= to; f += step) pressAt.set(f, (pressAt.get(f) || 0) | (1 << bit));
  } else {
    const f = Number(when);
    pressAt.set(f, (pressAt.get(f) || 0) | (1 << bit));
  }
}

const m = new GbaMachine(new Uint8Array(readFileSync(romPath)));
console.log(`${tag}: title="${m.header.title}" code=${m.header.gameCode} frames=${FRAMES}`);

const releaseAt = new Map<number, number>();

function shoot(frame: number) {
  const W = 240, H = 160; const fb = m.ppu.framebuffer;
  const header = `P6\n${W} ${H}\n255\n`;
  const body = new Uint8Array(W * H * 3);
  for (let i = 0, j = 0; i < W * H * 4; i += 4) { body[j++] = fb[i]; body[j++] = fb[i + 1]; body[j++] = fb[i + 2]; }
  const out = new Uint8Array(header.length + body.length);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  out.set(body, header.length);
  writeFileSync(`build/inprobe_${tag}_${String(frame).padStart(5, '0')}.ppm`, out);

  // OAM/VRAM diagnostics
  const dispcnt = m.io.get16(0x000);
  let active = 0; const samples: string[] = [];
  for (let i = 0; i < 128; i++) {
    const a0 = m.mem.oam16(i * 8), a1 = m.mem.oam16(i * 8 + 2), a2 = m.mem.oam16(i * 8 + 4);
    const affine = (a0 & 0x100) !== 0;
    const disabled = !affine && (a0 & 0x200) !== 0;
    if (disabled) continue;
    const y = a0 & 0xff;
    if (y >= 160 && y < 256 - 64) continue; // offscreen
    active++;
    if (samples.length < 6) samples.push(`#${i} y=${y} x=${a1 & 0x1ff} a0=${a0.toString(16)} a1=${a1.toString(16)} a2=${a2.toString(16)}`);
  }
  let objVramNz = 0;
  for (let i = 0x10000; i < 0x18000; i++) if (m.mem.vram[i]) objVramNz++;
  console.log(`f${frame}: DISPCNT=0x${dispcnt.toString(16)} OBJon=${(dispcnt & 0x1000) ? 1 : 0} activeOAM=${active} objVRAMnz=${objVramNz}`);
  for (const s of samples) console.log('    ' + s);
}

let keys = 0x3ff;
for (let f = 1; f <= FRAMES; f++) {
  const press = pressAt.get(f);
  if (press) {
    keys &= ~press; m.setKeys(keys);
    releaseAt.set(f + HOLD, press);
  }
  const rel = releaseAt.get(f);
  if (rel) { keys |= rel; m.setKeys(keys); releaseAt.delete(f); }
  m.runFrame();
  if (f % 300 === 0 || f === FRAMES) shoot(f);
}
console.log('done');
