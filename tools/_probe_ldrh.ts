// At the diverging LDRH r4,[r5,#0] at pc 0x8000580 in frame 2, print r5 (the load address) and
// what read16 returns, in the recompiler machine, right before the step that diverges.
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
const rom = new Uint8Array(readFileSync(romPath));
const b: any = new GbaMachine(rom); b.useRecompiler = true;
for (let f = 1; f < 2; f++) b.runFrame();

const CYCLES = 280896;
let cyc = 0, guard = 0;
while (cyc < CYCLES && guard < 2_000_000) {
  const pc = b.cpu.st.r[15] >>> 0;
  if (pc === 0x8000580 && b.cpu.st.thumb) {
    const r5 = b.cpu.st.r[5] >>> 0;
    const region = (r5 >>> 24) & 0xff;
    const v = b.mem.read16(r5) & 0xffff;
    console.log(JSON.stringify({
      pc: '0x'+pc.toString(16), r5: '0x'+r5.toString(16),
      region: '0x'+region.toString(16),
      read16: '0x'+v.toString(16),
      isIO: region === 0x04, isVRAM: region === 0x06, isPAL: region === 0x05, isOAM: region === 0x07,
      r4before: '0x'+(b.cpu.st.r[4]>>>0).toString(16),
    }, null, 2));
    // step once and show r4 after
    b.step();
    console.log('r4 after native step = 0x' + (b.cpu.st.r[4]>>>0).toString(16));
    process.exit(0);
  }
  cyc += b.step(); guard++;
}
console.log('did not reach 0x8000580 in frame 2');
