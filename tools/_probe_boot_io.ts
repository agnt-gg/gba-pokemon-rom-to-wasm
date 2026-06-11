/**
 * Cold-boot IO trace for the FRLG/Emerald spin diagnosis: logs every write to
 * DISPSTAT / IE / IME / RCNT / SIOCNT / JOYCNT / JOY regs / TM3 + every irq.request,
 * for the first N frames.
 *   node --experimental-strip-types tools/_probe_boot_io.ts "<rom>" [frames]
 */
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const m = new GbaMachine(new Uint8Array(readFileSync(process.argv[2])));
const frames = Number(process.argv[3] || 5);
m.useRecompiler = false;

const WATCH = new Set([0x004, 0x200, 0x208, 0x128, 0x12a, 0x134, 0x140, 0x150, 0x152, 0x154, 0x156, 0x158, 0x10c, 0x10e]);
const NAME: Record<number, string> = {
  0x004: 'DISPSTAT', 0x200: 'IE', 0x208: 'IME', 0x128: 'SIOCNT', 0x12a: 'SIODATA8',
  0x134: 'RCNT', 0x140: 'JOYCNT', 0x150: 'JOY_RECV_L', 0x152: 'JOY_RECV_H',
  0x154: 'JOY_TRANS_L', 0x156: 'JOY_TRANS_H', 0x158: 'JOYSTAT', 0x10c: 'TM3CNT_L', 0x10e: 'TM3CNT_H',
};
let lines = 0;
const oldHook = m.io.writeHook;
m.io.writeHook = (off, val, prev) => {
  if (WATCH.has(off) && val !== prev && lines < 400) {
    console.log(`[w] f${m.frameCount} pc=0x${m.pc().toString(16)} ${NAME[off] || off.toString(16)} 0x${prev.toString(16)} -> 0x${val.toString(16)}`);
    lines++;
  }
  oldHook?.(off, val, prev);
};
const oldReq = m.irq.request.bind(m.irq);
let reqCount = 0;
(m.irq as any).request = (bits: number) => {
  if (reqCount < 200) { console.log(`[irq] f${m.frameCount} pc=0x${m.pc().toString(16)} request bits=0x${bits.toString(16)}`); reqCount++; }
  oldReq(bits);
};
for (let f = 0; f < frames; f++) m.runFrame();
console.log(`\nend: pc=0x${m.pc().toString(16)} IE=0x${m.io.get16(0x200).toString(16)} DISPSTAT=0x${m.io.get16(4).toString(16)} RCNT=0x${m.io.get16(0x134).toString(16)} JOYCNT=0x${m.io.get16(0x140).toString(16)} flag@0x300310c=0x${m.mem.read16(0x300310c).toString(16)}`);
