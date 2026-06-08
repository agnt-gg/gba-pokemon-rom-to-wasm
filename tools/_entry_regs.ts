// At the diverging memcpy block 0x3007d6a (frame 168), compare ALL regs at block ENTRY between
// interp and recompiler, stepping the recompiler in real blocks and interp by matching instr count.
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const rom = new Uint8Array(readFileSync(process.argv[2]));
const frame = parseInt(process.argv[3] || '168', 10);
const a: any = new GbaMachine(rom); a.useRecompiler = false;
const b: any = new GbaMachine(rom); b.useRecompiler = true;
for (let f = 1; f < frame; f++) { a.runFrame(); b.runFrame(); }
let iters = 0;
const CYCLES = 280896;
let cyc = 0, guard = 0;
while (cyc < CYCLES && guard < 3_000_000) {
  const pcB = b.cpu.st.r[15] >>> 0;
  if (pcB === 0x3007d6a && b.cpu.st.thumb) {
    // compare entry regs
    const diffs: string[] = [];
    for (let i = 0; i < 16; i++) if ((a.cpu.st.r[i]>>>0)!==(b.cpu.st.r[i]>>>0)) diffs.push(`r${i}: int=0x${(a.cpu.st.r[i]>>>0).toString(16)} wasm=0x${(b.cpu.st.r[i]>>>0).toString(16)}`);
    if (diffs.length) { console.log('ENTRY DIVERGENCE at 0x3007d6a:\n  '+diffs.join('\n  ')); process.exit(0); }
    // entry matches; capture entry regs then step both one block/matching-instrs and see if exit diverges
    const entry = Array.from({length:16}, (_,i)=> b.cpu.st.r[i]>>>0);
    const before = b.instrCount; cyc += b.step(); const n = b.instrCount - before;
    for (let i=0;i<n;i++) a.step();
    const ed: string[] = [];
    for (let i = 0; i < 16; i++) if ((a.cpu.st.r[i]>>>0)!==(b.cpu.st.r[i]>>>0)) ed.push(`r${i}: int=0x${(a.cpu.st.r[i]>>>0).toString(16)} wasm=0x${(b.cpu.st.r[i]>>>0).toString(16)}`);
    if (ed.length) { console.log(`EXIT DIVERGENCE after ${iters} identical iterations, on iteration ${iters+1}, ${n}-instr block from 0x3007d6a:\n  `+ed.join('\n  ')); console.log('  ENTRY regs (identical in both) this iter: '+entry.map((v,i)=>`r${i}=0x${v.toString(16)}`).join(' ')); process.exit(0); }
    iters++;
    continue;
  }
  const before = b.instrCount; cyc += b.step(); const n = b.instrCount - before;
  for (let i=0;i<n;i++) a.step();
  guard++;
}
console.log('done');
