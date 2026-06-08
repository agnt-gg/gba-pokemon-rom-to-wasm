// Instruction-level lockstep: run interpreter (a) and recompiler (b) machines, advancing BOTH by
// exactly one guest instruction at a time, and report the first instruction where architectural
// state (r0..r15, cpsr flags) diverges. To force one-instruction granularity on the recompiler we
// set THUMB_MAXLEN=1 so each native block is a single instruction.
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

(globalThis as any).__THUMB_MAXLEN = 1;
(globalThis as any).__ARM_MAXLEN = 1;

const romPath = process.argv[2];
const stopFrame = parseInt(process.argv[3] || '170', 10);
const rom = new Uint8Array(readFileSync(romPath));

const a: any = new GbaMachine(rom); a.useRecompiler = false;
const b: any = new GbaMachine(rom); b.useRecompiler = true;

function regsEqual(): string | null {
  for (let i = 0; i < 16; i++) {
    if ((a.cpu.st.r[i] >>> 0) !== (b.cpu.st.r[i] >>> 0)) {
      return `r${i}: interp=0x${(a.cpu.st.r[i] >>> 0).toString(16)} wasm=0x${(b.cpu.st.r[i] >>> 0).toString(16)}`;
    }
  }
  const FLAGS = 0xf0000000;
  if ((a.cpu.st.cpsr & FLAGS) !== (b.cpu.st.cpsr & FLAGS)) {
    return `cpsr flags: interp=0x${(a.cpu.st.cpsr >>> 0).toString(16)} wasm=0x${(b.cpu.st.cpsr >>> 0).toString(16)}`;
  }
  return null;
}

// Run frame-by-frame until the known diverging frame, comparing per-instruction within frames.
// We approximate by running both via runFrame up to stopFrame-1, then single-stepping the target frame.
for (let f = 1; f < stopFrame; f++) { a.runFrame(); b.runFrame(); }

// Now step the target frame one instruction at a time on both.
const CYCLES_PER_FRAME = 280896;
let cyclesA = 0, cyclesB = 0, instr = 0;
let lastPcA = 0, lastPcB = 0, lastInstrWord = 0;
while (cyclesA < CYCLES_PER_FRAME && instr < 5_000_000) {
  lastPcA = a.cpu.st.r[15] >>> 0;
  lastPcB = b.cpu.st.r[15] >>> 0;
  lastInstrWord = a.mem.read16(lastPcA) & 0xffff;
  cyclesA += a.step();
  cyclesB += b.step();
  instr++;
  let diff = regsEqual();
  // Also compare VRAM + palette + OAM every 4096 instrs (cheap-ish) to catch store divergence.
  if (!diff && (instr & 0xfff) === 0) {
    const cmp = (name: string, x: any, y: any) => {
      if (!x || !y) return null;
      const xa = x instanceof Uint8Array ? x : new Uint8Array(x.buffer || x);
      const ya = y instanceof Uint8Array ? y : new Uint8Array(y.buffer || y);
      const n = Math.min(xa.length, ya.length);
      for (let i = 0; i < n; i++) if (xa[i] !== ya[i]) return `${name}[${i}]: interp=${xa[i]} wasm=${ya[i]}`;
      return null;
    };
    diff = cmp('vram', a.mem.vram, b.mem.vram) || cmp('pram', a.mem.palette ?? a.mem.pram, b.mem.palette ?? b.mem.pram) || cmp('oam', a.mem.oam, b.mem.oam) || cmp('iwram', a.mem.iwram, b.mem.iwram);
  }
  if (diff || lastPcA !== lastPcB) {
    if (!diff && lastPcA !== lastPcB) {
      console.log(JSON.stringify({ note: 'PC desync (control-flow divergence already happened upstream)', frame: stopFrame, instrIntoFrame: instr, pcInterp: '0x'+lastPcA.toString(16), pcWasm: '0x'+lastPcB.toString(16) }, null, 2));
      process.exit(0);
    }
    console.log(JSON.stringify({
      frame: stopFrame, instrIntoFrame: instr,
      pcBeforeInterp: '0x' + lastPcA.toString(16),
      pcBeforeWasm: '0x' + lastPcB.toString(16),
      thumb: a.cpu.st.thumb,
      instrWord: '0x' + lastInstrWord.toString(16),
      top3: (lastInstrWord >>> 13).toString(2),
      diff,
    }, null, 2));
    process.exit(0);
  }
}
console.log('no per-instruction divergence detected in frame ' + stopFrame + ' (' + instr + ' instrs)');
