// Instrument the recompiler's host read16 to log the address+value it returns when executing the
// block at pc 0x8000580 in frame 2, to see exactly what the native LDRH reads.
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
const rom = new Uint8Array(readFileSync(romPath));
const b: any = new GbaMachine(rom); b.useRecompiler = true;

// Wrap bus.read16 to log reads of 0x4000208 (IME).
const mem = b.mem;
const origR16 = mem.read16.bind(mem);
let logging = false;
mem.read16 = (a: number) => {
  const v = origR16(a);
  if (logging && ((a >>> 0) === 0x4000208)) console.log(`  [host read16] 0x${(a>>>0).toString(16)} -> 0x${(v>>>0).toString(16)}`);
  return v;
};

for (let f = 1; f < 2; f++) b.runFrame();

const CYCLES = 280896;
let cyc = 0, guard = 0;
while (cyc < CYCLES && guard < 2_000_000) {
  const pc = b.cpu.st.r[15] >>> 0;
  if (pc === 0x8000580 && b.cpu.st.thumb) {
    console.log(`reached 0x8000580; r5=0x${(b.cpu.st.r[5]>>>0).toString(16)} r4=0x${(b.cpu.st.r[4]>>>0).toString(16)}`);
    console.log(`  direct bus.read16(0x4000208) = 0x${(origR16(0x4000208)>>>0).toString(16)}`);
    logging = true;
    b.step();
    logging = false;
    console.log(`  r4 after = 0x${(b.cpu.st.r[4]>>>0).toString(16)}`);
    process.exit(0);
  }
  cyc += b.step(); guard++;
}
console.log('did not reach');
