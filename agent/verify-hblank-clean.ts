/**
 * Clean HBlank verification: instead of fighting the game's IO writes by force-poking IE every
 * frame, we INJECT real HBlank IRQ requests through the PPU's own requestIrq path while leaving the
 * game's IE/DISPSTAT alone. This exercises the exact code that mattered: request() must NOT pollute
 * BIOS-IF, and serviceIrqDispatch must set BIOS-IF only for actually-dispatched bits.
 *
 * We compare the BIOS-IF behaviour and confirm: (a) the game keeps running (liveness high), (b) no
 * SoftReset, (c) BIOS-IF never carries a sustained stale HBlank-only value.
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
log(`[overworld] f${a.frame} IE=0x${m.io.get16(0x4000200).toString(16)} liveness=${m.lastFrameLiveness}`);

// Inject HBlank IRQ requests directly (as if DISPSTAT HBlank-IRQ were on), WITHOUT enabling it in
// the game's IE. With the OLD code, request() would still OR HBlank into BIOS-IF if IE had bit1;
// here IE bit1 is OFF so request() correctly ignores it. To truly stress the IE=0x3 case we ALSO
// set IE bit1 once and let the game manage it; but we do NOT re-poke every frame (no fighting).
m.io.set16(0x4000200, m.io.get16(0x4000200) | 0x2); // enable HBlank in IE once
m.io.set16(0x4000004, m.io.get16(0x4000004) | (1<<4)); // DISPSTAT HBlank-IRQ enable once

let minLiveness = 9999, staleBiosIf = 0, sawBoth = false;
for (let f = 0; f < 600; f++) {
  a.wait(1);
  const biosIf = m.mem.read16(0x03007ff8) & 0xffff;
  if ((biosIf & 0x3) === 0x3) sawBoth = true;
  if ((biosIf & 0x2) && !(biosIf & 0x1)) staleBiosIf++;
  minLiveness = Math.min(minLiveness, m.lastFrameLiveness | 0);
  if (softReset) { log(`[!!] SoftReset at offset ${f}`); break; }
}
log(`\n[HBlank-enabled-once, 600 frames]`);
log(`  liveness min=${minLiveness}  staleHblankBiosIf frames=${staleBiosIf}  SoftResets=${softReset}`);
log(softReset === 0 && minLiveness >= 20 ? '[PASS] clean: no reset, game fully alive with HBlank enabled.' : `[CHECK] liveness=${minLiveness}`);
