/**
 * The live SoftReset post-mortem showed 8x SWI 0xB (CpuSet) at pc=0x81e07ee immediately before the
 * code ran off into EWRAM garbage. So a CpuSet is overrunning/corrupting memory. Trap every CpuSet
 * (0x0B) and CpuFastSet (0x0C) and log r0(src)/r1(dst)/r2(ctrl) + decoded count/mode, flagging any
 * that write OUTSIDE the destination region or have an absurd count. This pinpoints the bad call.
 */
import { Agent, bootToTitle } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);
const m = a.m;

function regionEnd(addr: number): number {
  switch ((addr >>> 24) & 0xff) {
    case 0x02: return 0x02040000;
    case 0x03: return 0x03008000;
    case 0x05: return 0x05000400;
    case 0x06: return 0x06018000;
    case 0x07: return 0x07000400;
    default: return (addr & 0xff000000) + 0x01000000;
  }
}

const bad: string[] = [];
let total = 0;
const origSwi = m.cpu.swiHandler;
m.cpu.swiHandler = (c: number, cpu: any) => {
  if (c === 0x0b || c === 0x0c) {
    total++;
    const src = cpu.st.r[0] >>> 0, dst = cpu.st.r[1] >>> 0, ctrl = cpu.st.r[2] >>> 0;
    let count = ctrl & 0x1fffff;
    const fixed = (ctrl & (1<<24)) !== 0;
    const word = c === 0x0c ? true : (ctrl & (1<<26)) !== 0;
    if (c === 0x0c) count = (count + 7) & ~7;
    const unit = word ? 4 : 2;
    const bytes = count * unit;
    const dstEnd = (dst + bytes) >>> 0;
    const overrun = dstEnd > regionEnd(dst) || count > 0x10000;
    if (overrun && bad.length < 20) {
      bad.push(`SWI 0x${c.toString(16)} pc=0x${(cpu.st.r[15]>>>0).toString(16)} src=0x${src.toString(16)} dst=0x${dst.toString(16)} ctrl=0x${ctrl.toString(16)} count=${count} unit=${unit} bytes=${bytes} dstEnd=0x${dstEnd.toString(16)} regionEnd=0x${regionEnd(dst).toString(16)} ${word?'32':'16'}bit ${fixed?'FILL':'COPY'}`);
    }
  }
  return origSwi(c, cpu);
};

bootToTitle(a, 320);
for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
a.tap('start', 4, 10);
for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
log(`[overworld] f${a.frame} totalCpuSet=${total} suspicious=${bad.length}`);

// Trainer card + roam to trigger the transition CpuSet.
a.tap('b',3,6); a.tap('start',4,14);
for (let d=0; d<3; d++) a.tap('down',3,6);
for (let i=0;i<40;i++) a.tap('a',2,3);
a.wait(120);
const dirs:('up'|'down'|'left'|'right')[]=['down','right','up','left'];
for (let pass=0; pass<20; pass++){ for (const d of dirs){ a.hold(d); a.wait(28); a.release(d); a.wait(4); } }
log(`[after card+roam] f${a.frame} totalCpuSet=${total} suspicious=${bad.length}`);
log('\n[suspicious CpuSet calls]:');
for (const b of bad) log('  '+b);
if (!bad.length) log('  (none flagged headlessly — the bad call needs the live transition path)');
