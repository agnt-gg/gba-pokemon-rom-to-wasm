// Find the first frame.instr where the recompiler (real block lengths) and interpreter desync,
// using a per-STEP comparison. Because the recompiler runs multi-instruction blocks per step()
// while the interpreter runs one instr per step(), we compare at FRAME granularity but, once the
// diverging frame is known, we re-run that frame on the interpreter one instr at a time AND on the
// recompiler step-by-step, comparing architectural state after each recompiler step against the
// interpreter advanced by the same instruction count (block.count). Reports the block that desyncs.
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
const targetFrame = parseInt(process.argv[3] || '2', 10);
const rom = new Uint8Array(readFileSync(romPath));

// a = interpreter (truth), b = recompiler (real blocks)
const a: any = new GbaMachine(rom); a.useRecompiler = false;
const b: any = new GbaMachine(rom); b.useRecompiler = true;

for (let f = 1; f < targetFrame; f++) { a.runFrame(); b.runFrame(); }

// Step b (recompiler) and after each step advance a (interp) by the same #instructions, then compare.
const CYCLES = 280896;
let cyc = 0, guard = 0;
const instrCountBefore = () => b.instrCount;
while (cyc < CYCLES && guard < 2_000_000) {
  const pcB = b.cpu.st.r[15] >>> 0;
  const thumbB = b.cpu.st.thumb;
  const before = b.instrCount;
  cyc += b.step();
  const n = b.instrCount - before; // instructions the recompiler just executed
  // advance interpreter by the same count
  for (let i = 0; i < n; i++) a.step();
  guard++;
  // compare
  let diff: string | null = null;
  for (let i = 0; i < 16; i++) if ((a.cpu.st.r[i] >>> 0) !== (b.cpu.st.r[i] >>> 0)) { diff = `r${i}: interp=0x${(a.cpu.st.r[i]>>>0).toString(16)} wasm=0x${(b.cpu.st.r[i]>>>0).toString(16)}`; break; }
  const FF = 0xf0000000;
  if (!diff && (a.cpu.st.cpsr & FF) !== (b.cpu.st.cpsr & FF)) diff = `cpsr flags: interp=0x${(a.cpu.st.cpsr>>>0).toString(16)} wasm=0x${(b.cpu.st.cpsr>>>0).toString(16)}`;
  if (diff) {
    const word = thumbB ? (b.mem.read16(pcB) & 0xffff) : (b.mem.read32(pcB) >>> 0);
    console.log(JSON.stringify({ frame: targetFrame, blockStartPc: '0x'+pcB.toString(16), thumb: thumbB, blockInstrs: n, firstWord: '0x'+word.toString(16), diff }, null, 2));
    process.exit(0);
  }
}
console.log('no desync detected in frame ' + targetFrame);
