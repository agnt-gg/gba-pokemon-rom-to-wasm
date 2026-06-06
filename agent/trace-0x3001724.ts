/**
 * verify-nested-irq (enable HBlank in IE once, no per-frame forcing) reproducibly hits ONE garbage
 * SWI 0xe0 at pc=0x3001724 = inside the game's IWRAM IRQ dispatcher. We instrument: just before the
 * CPU's PC enters 0x3001700..0x3001740, snapshot regs + the IWRAM bytes there, and catch the exact
 * instant PC reaches 0x3001724 to see what instruction (real or garbage) is decoded as SWI 0xe0, and
 * what _irqDepth / mode / IF are at that moment. This tells us whether the IWRAM code itself is being
 * overwritten (data corruption) or the CPU is mis-jumping into the middle of it (control corruption).
 */
import { Agent, bootToTitle } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);
const m = a.m;

let captured = false;
const origSwi = m.cpu.swiHandler;
m.cpu.swiHandler = (c: number, cpu: any) => {
  if (c > 0x2b && !captured) {
    captured = true;
    const pc = cpu.st.r[15] >>> 0;
    log(`\n*** garbage SWI 0x${c.toString(16)} at pc=0x${pc.toString(16)} mode=${cpu.st.mode} depth=${(m as any)._irqDepth} ***`);
    log('regs: ' + Array.from({length:16},(_,i)=>'r'+i+'=0x'+(cpu.st.r[i]>>>0).toString(16)).join(' '));
    log('IWRAM 0x3001700..0x3001740:');
    for (let p=0x3001700;p<0x3001740;p+=2) log(`  0x${p.toString(16)}: 0x${(m.mem.read16(p)&0xffff).toString(16).padStart(4,'0')}`);
    log(`IF=0x${m.io.get16(0x4000202).toString(16)} IE=0x${m.io.get16(0x4000200).toString(16)} IME=0x${m.io.get16(0x4000208).toString(16)}`);
    log(`BIOS-IF(0x3007ff8)=0x${m.mem.read16(0x3007ff8).toString(16)} userHandler(0x3007ffc)=0x${m.mem.read32(0x3007ffc).toString(16)}`);
  }
  return origSwi(c, cpu);
};

bootToTitle(a, 320);
for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
a.tap('start', 4, 10);
for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
log(`[overworld] f${a.frame}`);
// Enable HBlank IRQ once (the verify-nested-irq condition).
m.io.set16(0x4000004, m.io.get16(0x4000004) | (1 << 4));
m.io.set16(0x4000200, m.io.get16(0x4000200) | (1 << 1));
for (let f = 0; f < 400 && !captured; f++) a.wait(1);
if (!captured) log('[no garbage SWI captured this run]');
