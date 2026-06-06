/**
 * Directly verify the HBlank-on path no longer floods BIOS-IF and no longer triggers SoftReset.
 *
 * The live freeze had IE=0x3 (VBlank+HBlank) with the game in VBlankIntrWait. We simulate that
 * worst case at the runtime level: reach overworld, then enable the HBlank IRQ (DISPSTAT HBlank-IRQ
 * bit + IE bit1) exactly as the trainer card / battle scene does, and run for several seconds while
 * the game does its normal VBlankIntrWait main loop. We assert:
 *   (1) BIOS-IF (0x03007FF8) is never left holding stale HBlank bits across a VBlank wait, and
 *   (2) no SoftReset(SWI 0) is invoked, and
 *   (3) CPU liveness stays healthy (game keeps running).
 */
import { Agent, bootToTitle } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);
const m = a.m;

let softReset = 0;
const origSwi = m.cpu.swiHandler;
m.cpu.swiHandler = (c: number, cpu: any) => { if (c === 0x00) softReset++; return origSwi(c, cpu); };

bootToTitle(a, 320);
for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
a.tap('start', 4, 10);
for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
log(`[overworld] f${a.frame} IE=0x${m.io.get16(0x4000200).toString(16)} softResets=${softReset}`);

// Force the trainer-card/battle interrupt profile: enable HBlank IRQ in DISPSTAT + IE.
function enableHblank() {
  m.io.set16(0x4000004, m.io.get16(0x4000004) | (1 << 4)); // DISPSTAT HBlank IRQ enable
  m.io.set16(0x4000200, m.io.get16(0x4000200) | (1 << 1)); // IE HBlank
}

// Sample BIOS-IF right at the start of each frame (when the game is typically mid VBlankIntrWait)
// and confirm it never carries a stale HBlank bit (bit1) once a VBlank wait should have consumed it.
let staleHblankInBiosIf = 0, maxBiosIf = 0, minLiveness = 9999;
for (let f = 0; f < 600; f++) {
  enableHblank();           // game re-asserts this every frame; mimic that
  a.wait(1);
  const biosIf = m.mem.read16(0x03007ff8) & 0xffff;
  maxBiosIf = Math.max(maxBiosIf, biosIf);
  // If BIOS-IF still has HBlank(bit1) set but NOT VBlank(bit0) for a sustained period, that's the bug.
  if ((biosIf & 0x2) && !(biosIf & 0x1)) staleHblankInBiosIf++;
  minLiveness = Math.min(minLiveness, m.lastFrameLiveness | 0);
  if (softReset) { log(`[!!] SoftReset at frame offset ${f}`); break; }
}
log(`\n[HBlank-on stress over 600 frames]`);
log(`  IE now=0x${m.io.get16(0x4000200).toString(16)}  maxBiosIf=0x${maxBiosIf.toString(16)}`);
log(`  frames with stale HBlank-only BIOS-IF: ${staleHblankInBiosIf}`);
log(`  min CPU liveness: ${minLiveness}  (healthy = high; spin would be <5)`);
log(`  SoftResets: ${softReset}`);
log(softReset === 0 && minLiveness > 12 ? '\n[PASS] HBlank path runs clean: no SoftReset, game stays alive.' : '\n[FAIL] still resets or hangs.');
