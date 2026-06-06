/**
 * The live build SoftReset had flag@0x3007FFA=0 (=> ROM restart). On real hardware pokeruby's
 * INTENTIONAL soft-reset writes a NON-zero flag to resume in EWRAM; flag=0 means "cold boot to ROM".
 *
 * Hypothesis: the game DOES write 0x03007FFA before calling SoftReset, but our runtime either
 *   (a) never persists that write (wrong region routing for 0x03007FFA), or
 *   (b) the SoftReset is being called from the game's exception/fault path (real crash upstream).
 *
 * This script: trap EVERY write to 0x03007FF8..0x03007FFF (BIOS-IF + reset flags) and every SWI,
 * across boot + overworld + trainer-card + encounter roam, so we see exactly what the game writes
 * to the reset flag and when SoftReset is invoked.
 */
import { Agent, bootToTitle } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);
const m = a.m;

// Trap writes to the reset-flag region.
const flagWrites: string[] = [];
const oW8 = m.mem.write8.bind(m.mem), oW16 = m.mem.write16.bind(m.mem), oW32 = m.mem.write32.bind(m.mem);
const note = (addr: number, v: number, sz: string) => {
  const al = addr >>> 0;
  if (al >= 0x03007ff8 && al <= 0x03007fff) flagWrites.push(`f${a.frame} pc=0x${(m.cpu.st.r[15]>>>0).toString(16)} ${sz}[0x${al.toString(16)}]=0x${v.toString(16)}`);
};
m.mem.write8 = (x: number, v: number) => { note(x, v, 'b'); return oW8(x, v); };
m.mem.write16 = (x: number, v: number) => { note(x, v, 'h'); return oW16(x, v); };
m.mem.write32 = (x: number, v: number) => { note(x, v, 'w'); return oW32(x, v); };

// Trap SWI 0.
let softReset = 0;
const origSwi = m.cpu.swiHandler;
m.cpu.swiHandler = (c: number, cpu: any) => {
  if (c === 0x00) { softReset++; log(`f${a.frame} *** SoftReset #${softReset} pc=0x${(cpu.st.r[15]>>>0).toString(16)} lr=0x${(cpu.st.r[14]>>>0).toString(16)} flag=0x${m.mem.read8(0x03007ffa).toString(16)}`); }
  return origSwi(c, cpu);
};

bootToTitle(a, 320);
log(`[boot done] f${a.frame} reset-flag writes so far: ${flagWrites.length}`);
for (const w of flagWrites.slice(-8)) log('   '+w);

for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
a.tap('start', 4, 10);
for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
log(`\n[overworld] f${a.frame} DISPCNT=0x${a.snap().DISPCNT.toString(16)} flag@FFA=0x${m.mem.read8(0x03007ffa).toString(16)} totalFlagWrites=${flagWrites.length} softResets=${softReset}`);

// Trainer card.
a.tap('b',3,6); a.tap('start',4,14);
for (let d=0; d<3; d++) a.tap('down',3,6);
a.tap('a',4,12); a.wait(120);
log(`[trainer card] flag@FFA=0x${m.mem.read8(0x03007ffa).toString(16)} softResets=${softReset}`);
log(`\n[all reset-flag writes ${flagWrites.length}]:`);
for (const w of flagWrites) log('   '+w);
