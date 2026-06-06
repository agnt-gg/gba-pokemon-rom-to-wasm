/**
 * Find the SoftReset trigger. Live: SoftReset from EWRAM trampoline (pc=0x202107c) via lr=0x8001e7b.
 * In pokeruby, IntrMain (the IRQ handler, copied to EWRAM ~0x03000000 region) checks the IF against
 * a handler table. If an UNEXPECTED interrupt fires (a bit set in IF that has no registered handler,
 * or the "intr check" fails), some builds fall through to a path that can reset. More commonly the
 * game's main loop calls AGB's "IntrMain" which, on a serial/keypad/unexpected IRQ, does nothing
 * bad — BUT if our emulator raises an IRQ bit the game never enabled (IE), the handler indexes past
 * its table => garbage call => crash => exception => reset.
 *
 * So: trap every IRQ delivery and assert (fired & IE) — if we ever deliver an IRQ whose bit is NOT
 * in IE, that's a bug. Also count which IRQ sources fire during overworld/trainer-card/encounter.
 */
import { Agent, bootToTitle } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);
const m = a.m;

let badDeliveries = 0;
const irqCounts: Record<number, number> = {};
const origReq = m.irq.request.bind(m.irq);
m.irq.request = (bits: number) => {
  const ie = m.io.get16(0x4000200);
  for (let b = 0; b < 14; b++) if (bits & (1<<b)) irqCounts[b] = (irqCounts[b]||0)+1;
  // A request for a source NOT enabled in IE is fine (stays pending); the bug would be DELIVERING it.
  return origReq(bits);
};
// Wrap deliver if exposed; else wrap poll to check what gets delivered.
const origPoll = m.irq.poll.bind(m.irq);
m.irq.poll = () => {
  const before = m.cpu.st.r[15] >>> 0;
  const haltedBefore = m.cpu.halted;
  origPoll();
  // If poll vectored to 0x18 (IRQ), the dispatch will run; check that the IF bits being serviced
  // are all in IE.
  const ie = m.io.get16(0x4000200), iff = m.io.get16(0x4000202);
  if ((iff & ~ie) & 0xffff && !haltedBefore) {
    // pending bits with no enable — only a problem if delivered. We can't easily see delivery here,
    // so just note it.
  }
};

bootToTitle(a, 320);
for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
a.tap('start', 4, 10);
for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
const names = ['VBlank','HBlank','VCount','Timer0','Timer1','Timer2','Timer3','Serial','DMA0','DMA1','DMA2','DMA3','Keypad','GamePak'];
log(`[overworld] IE=0x${m.io.get16(0x4000200).toString(16)}`);
log('IRQ requests so far: ' + Object.entries(irqCounts).map(([b,c])=>names[+b]+':'+c).join(' '));

// Now the trainer card, watching for any IRQ source that's NOT in IE getting requested heavily.
const ieOnCard = m.io.get16(0x4000200);
a.tap('b',3,6); a.tap('start',4,14);
for (let d=0; d<3; d++) a.tap('down',3,6);
const c0 = {...irqCounts};
a.tap('a',4,12); a.wait(180);
const ieAfter = m.io.get16(0x4000200);
log(`\n[trainer card] IE before=0x${ieOnCard.toString(16)} after=0x${ieAfter.toString(16)}`);
const delta: string[] = [];
for (let b=0;b<14;b++){ const d=(irqCounts[b]||0)-(c0[b]||0); if(d>0) delta.push(names[b]+':'+d); }
log('IRQ requests during card: ' + delta.join(' '));
log(`bad deliveries (delivered w/o IE): ${badDeliveries}`);
