/**
 * Lockstep divergence finder: run two full machines (recompiler ON vs OFF) frame by frame and, at
 * the end of each frame, compare a hash of CPU regs + IWRAM + EWRAM + VRAM + palette + OAM. Report
 * the first frame where they diverge and which region differs first. This pinpoints whether a
 * lifted block is corrupting guest state (and where), beyond what the per-block gate can see.
 */
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
const maxFrames = Number(process.argv[3] || 200);
if (!romPath) { console.error('usage: _lockstep_diff.ts <rom.gba> [frames]'); process.exit(1); }
const rom = new Uint8Array(readFileSync(romPath));

if (process.env.NO_NATIVE_WHEN_TIMERS) { (globalThis as any).__NO_NATIVE_WHEN_TIMERS = true; console.log('native disabled while timers live'); }
if (process.env.THUMB_MAXLEN) { (globalThis as any).__THUMB_MAXLEN = Number(process.env.THUMB_MAXLEN); console.log('THUMB block maxlen =', process.env.THUMB_MAXLEN); }
if (process.env.ARM_MAXLEN) { (globalThis as any).__ARM_MAXLEN = Number(process.env.ARM_MAXLEN); console.log('ARM block maxlen =', process.env.ARM_MAXLEN); }
if (process.env.THUMB_DISABLE) {
  (globalThis as any).__THUMB_DISABLE = new Set(process.env.THUMB_DISABLE.split(',').map(s => parseInt(s, 2)));
  console.log('disabling THUMB groups (binary):', process.env.THUMB_DISABLE);
}

const a = new GbaMachine(rom); a.useRecompiler = false;
const b = new GbaMachine(rom); b.useRecompiler = true;

function regions(m: GbaMachine): { name: string; bytes: Uint8Array }[] {
  const mem: any = m.mem;
  const out: { name: string; bytes: Uint8Array }[] = [];
  const tryRegion = (name: string, arr: any) => { if (arr && arr.length) out.push({ name, bytes: arr instanceof Uint8Array ? arr : new Uint8Array(arr.buffer || arr) }); };
  tryRegion('iwram', mem.iwram);
  tryRegion('ewram', mem.ewram);
  tryRegion('vram', mem.vram);
  tryRegion('palette', mem.palette ?? mem.pram);
  tryRegion('oam', mem.oam);
  return out;
}

function fnv(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function firstByteDiff(x: Uint8Array, y: Uint8Array): number {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return i;
  return x.length === y.length ? -1 : n;
}

for (let f = 1; f <= maxFrames; f++) {
  a.runFrame();
  b.runFrame();

  // compare CPU registers first
  let regDiff = -1;
  for (let i = 0; i < 16; i++) if ((a.cpu.st.r[i] >>> 0) !== (b.cpu.st.r[i] >>> 0)) { regDiff = i; break; }
  const cpsrDiff = (a.cpu.st.cpsr >>> 0) !== (b.cpu.st.cpsr >>> 0);

  const ra = regions(a), rb = regions(b);
  let memDiffName = '', memDiffIdx = -1;
  for (let i = 0; i < ra.length; i++) {
    if (fnv(ra[i].bytes) !== fnv(rb[i].bytes)) { memDiffName = ra[i].name; memDiffIdx = firstByteDiff(ra[i].bytes, rb[i].bytes); break; }
  }

  if (regDiff !== -1 || cpsrDiff || memDiffName) {
    console.log(`\n❌ First divergence at end of frame ${f}:`);
    if (regDiff !== -1) console.log(`   reg r${regDiff}: interp=0x${(a.cpu.st.r[regDiff]>>>0).toString(16)} wasm=0x${(b.cpu.st.r[regDiff]>>>0).toString(16)}`);
    if (cpsrDiff) console.log(`   cpsr: interp=0x${(a.cpu.st.cpsr>>>0).toString(16)} wasm=0x${(b.cpu.st.cpsr>>>0).toString(16)}`);
    if (memDiffName) {
      const ai = ra.find(r => r.name === memDiffName)!.bytes;
      const bi = rb.find(r => r.name === memDiffName)!.bytes;
      console.log(`   mem ${memDiffName}[0x${memDiffIdx.toString(16)}]: interp=${ai[memDiffIdx]} wasm=${bi[memDiffIdx]}`);
    }
    console.log(`   recompiler rejected blocks so far: ${b.recompiler!.blocksRejected}`);
    const dumpIrq = (m: GbaMachine, tag: string) => {
      const bus: any = m.mem;
      const rd = (r: number) => { try { return (bus.read16(r) >>> 0); } catch { return -1; } };
      console.log(`   [${tag}] IE=0x${rd(0x4000200).toString(16)} IF=0x${rd(0x4000202).toString(16)} IME=0x${rd(0x4000208).toString(16)} DISPSTAT=0x${rd(0x4000004).toString(16)} VCOUNT=${rd(0x4000006)} halted=${m.cpu.halted} thumb=${m.cpu.st.thumb} pc=0x${(m.cpu.st.r[15]>>>0).toString(16)} cpsrI=${(m.cpu.st.cpsr&0x80)?1:0}`);
    };
    dumpIrq(a, 'interp'); dumpIrq(b, 'wasm');
    process.exit(1);
  }
}
console.log(`\n✅ No divergence across ${maxFrames} frames (CPU regs + IWRAM/EWRAM/VRAM/palette/OAM all identical).`);
