// Watch guest address 0x3007f88 in BOTH machines during a frame; report the first instruction
// where the two machines write (or fail to write) it differently.
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
const targetFrame = parseInt(process.argv[3] || '168', 10);
const WADDR = parseInt(process.argv[4] || '0x3007f88', 16);
const rom = new Uint8Array(readFileSync(romPath));

(globalThis as any).__THUMB_MAXLEN = 1;
(globalThis as any).__ARM_MAXLEN = 1;

const a: any = new GbaMachine(rom); a.useRecompiler = false;
const b: any = new GbaMachine(rom); b.useRecompiler = true;

for (let f = 1; f < targetFrame; f++) { a.runFrame(); b.runFrame(); }

const idx = WADDR & 0x7fff;
const CYCLES_PER_FRAME = 280896;
let cycA = 0, cycB = 0, instr = 0;
let prevA = a.mem.iwram[idx], prevB = b.mem.iwram[idx];
console.log(`watching guest 0x${WADDR.toString(16)} (iwram[0x${idx.toString(16)}]) start: interp=${prevA} wasm=${prevB}`);
while (cycA < CYCLES_PER_FRAME && instr < 5_000_000) {
  const pcA = a.cpu.st.r[15] >>> 0, pcB = b.cpu.st.r[15] >>> 0;
  const wA = a.cpu.st.thumb ? a.mem.read16(pcA) : a.mem.read32(pcA);
  cycA += a.step(); cycB += b.step(); instr++;
  const curA = a.mem.iwram[idx], curB = b.mem.iwram[idx];
  if (curA !== prevA || curB !== prevB) {
    console.log(`instr#${instr} pc(interp)=0x${pcA.toString(16)} pc(wasm)=0x${pcB.toString(16)} word=0x${wA.toString(16)}  byte: interp ${prevA}->${curA}  wasm ${prevB}->${curB}${curA!==curB?'   <<< DIVERGE':''}`);
    prevA = curA; prevB = curB;
    if (curA !== curB) process.exit(0);
  }
  if (pcA !== pcB) { console.log(`PC desync at instr#${instr}: interp=0x${pcA.toString(16)} wasm=0x${pcB.toString(16)}`); process.exit(0); }
}
console.log('done, no byte divergence; final interp=' + a.mem.iwram[idx] + ' wasm=' + b.mem.iwram[idx]);
