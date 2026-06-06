import { Agent, bootToTitle } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);
const m = a.m;
// Boot well past intro into overworld so EWRAM 0x2020xxx is populated as it is live.
bootToTitle(a, 320);
for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
a.tap('start', 4, 10);
for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
log(`[overworld] f${a.frame}`);
// Dump the EWRAM landing region.
log('\n[EWRAM 0x2020000..0x20200e0]:');
for (let p=0x2020000; p<0x20200e0; p+=2) log(`  0x${p.toString(16)}: 0x${(m.mem.read16(p)&0xffff).toString(16).padStart(4,'0')}`);
// Is 0x2020xxx mapped EWRAM or something else? Check the value just written vs read.
m.mem.write16(0x2020010, 0xbeef);
log(`\n[writeback test] 0x2020010 wrote 0xbeef, reads 0x${m.mem.read16(0x2020010).toString(16)} (should be 0xbeef if EWRAM)`);
