// Trace where r2 last changed before the diverging PUSH at 0x3007d68 in frame 168.
// Run interpreter-only, single-step, log every instruction that writes r2 to a value of 0x1000
// or 0xfffff000 near the divergence, plus the surrounding context (pc, instr word, r2 before/after).
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
const targetFrame = parseInt(process.argv[3] || '168', 10);
const rom = new Uint8Array(readFileSync(romPath));

// Run WASM-enabled machine (the one that goes wrong) so we capture the bad path.
const M: any = new GbaMachine(rom);
M.useRecompiler = true;
(globalThis as any).__THUMB_MAXLEN = 1; // force per-instruction so we can observe r2 each step
(globalThis as any).__ARM_MAXLEN = 1;

for (let f = 1; f < targetFrame; f++) M.runFrame();

// Now single-step the target frame, watching r2.
const CYCLES_PER_FRAME = 280896;
let cyc = 0, instr = 0;
let prevR2 = M.cpu.st.r[2] >>> 0;
const ring: string[] = [];
while (cyc < CYCLES_PER_FRAME && instr < 5_000_000) {
  const pc = M.cpu.st.r[15] >>> 0;
  const thumb = M.cpu.st.thumb;
  const word = thumb ? (M.mem.read16(pc) & 0xffff) : (M.mem.read32(pc) >>> 0);
  cyc += M.step();
  instr++;
  const r2 = M.cpu.st.r[2] >>> 0;
  if (r2 !== prevR2) {
    const line = `instr#${instr} pc=0x${pc.toString(16)} ${thumb ? 'T' : 'A'} word=0x${word.toString(16)} r2: 0x${prevR2.toString(16)} -> 0x${r2.toString(16)}`;
    ring.push(line);
    if (ring.length > 12) ring.shift();
    prevR2 = r2;
  }
  // Stop once we reach the diverging PUSH.
  if (pc === 0x3007d68) {
    console.log('--- last r2 writes before diverging PUSH at 0x3007d68 (frame ' + targetFrame + ') ---');
    console.log(ring.join('\n'));
    console.log('r2 at PUSH = 0x' + (M.cpu.st.r[2] >>> 0).toString(16));
    process.exit(0);
  }
}
console.log('did not reach 0x3007d68 in frame ' + targetFrame);
