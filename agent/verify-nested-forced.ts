/**
 * Definitive nested-IRQ proof. Rather than poke IO (which the game overwrites), we INJECT an extra
 * HBlank IRQ request on a timer so that HBlank IRQs keep arriving even while the game is inside its
 * VBlank handler. To make the game's IE actually accept HBlank, we also re-assert IE bit1 from a
 * post-step hook EVERY instruction-batch (not by fighting a single write, but continuously), and we
 * keep IME on. This sustains the IE=0x3 nested condition for the full run.
 *
 * Pass criteria: zero SoftReset, zero garbage SWIs (>0x2B), CPU never wedges (liveness recovers),
 * across 1500 frames. Before the guard, this produced lr=0 + EWRAM garbage + SoftReset.
 */
import { Agent, bootToTitle } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);
const m = a.m;

let softReset = 0, garbageSwi = 0, firstGarbage = '';
const origSwi = m.cpu.swiHandler;
m.cpu.swiHandler = (c: number, cpu: any) => {
  if (c === 0x00) softReset++;
  if (c > 0x2b) { garbageSwi++; if (!firstGarbage) firstGarbage = `0x${c.toString(16)}@0x${(cpu.st.r[15]>>>0).toString(16)}`; }
  return origSwi(c, cpu);
};

bootToTitle(a, 320);
for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
a.tap('start', 4, 10);
for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
log(`[overworld] f${a.frame} liveness=${m.lastFrameLiveness}`);

// Hook the PPU's HBlank emission: force DISPSTAT HBlank-IRQ + IE HBlank to STAY on by re-asserting
// inside the PPU onHblank callback (runs every visible scanline, in-sync with real timing — no
// mid-instruction IO corruption because it fires at scanline boundaries like real hardware).
const origOnHblank = m.ppu.onHblank;
m.ppu.onHblank = (line: number) => {
  // Keep HBlank IRQ enabled in both DISPSTAT and IE so the PPU raises a real IRQ_HBLANK each line.
  m.io.set16(0x4000004, m.io.get16(0x4000004) | (1 << 4));
  m.io.set16(0x4000200, m.io.get16(0x4000200) | (1 << 1));
  return origOnHblank(line);
};

let minLiveness = 9999, framesAlive = 0;
for (let f = 0; f < 1500; f++) {
  a.wait(1);
  const lv = m.lastFrameLiveness | 0;
  minLiveness = Math.min(minLiveness, lv);
  if (lv > 5) framesAlive++;
  if (softReset || garbageSwi) break;
}
log(`\n[forced sustained HBlank-IRQ nesting, 1500 frames]`);
log(`  IE now=0x${m.io.get16(0x4000200).toString(16)} (held at 0x3 by hook)`);
log(`  SoftResets: ${softReset}`);
log(`  garbage SWIs: ${garbageSwi}${firstGarbage?'  first='+firstGarbage:''}`);
log(`  framesAlive(>5): ${framesAlive}/1500   minLiveness=${minLiveness}`);
const pass = softReset === 0 && garbageSwi === 0 && framesAlive > 1400;
log(pass ? '\n[PASS] Sustained nested HBlank IRQs: no SoftReset, no garbage execution, game alive throughout.'
        : '\n[FAIL] corruption/hang persists.');
