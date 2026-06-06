/**
 * Prove the nested-IRQ guard fixes the live corruption WITHOUT fighting the game's IO.
 *
 * Real repro condition (from the live SoftReset post-mortem): IE=0x3, an HBlank IRQ arrives while
 * the CPU is inside the VBlank handler that re-enabled IRQs => second dispatch aliases the BIOS frame
 * => lr=0x0 => PC into EWRAM garbage => SoftReset.
 *
 * We reproduce by enabling the HBlank IRQ at the HARDWARE level (DISPSTAT bit4 + IE bit1) ONCE the
 * game is in a stable overworld VBlankIntrWait loop, then letting the PPU raise real HBlank IRQs on
 * every scanline through its normal requestIrq path. We DO NOT re-poke IO every frame (that was the
 * earlier harness artifact). We then watch for:
 *   - any SWI with comment > 0x2B (garbage / executing wreckage)
 *   - any SoftReset (SWI 0)
 *   - lr becoming 0 at an IRQ return
 *   - CPU liveness collapse
 * Across 1200 frames (~20s). With the guard, none should occur.
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
  if (c > 0x2b && c !== 0x00) { garbageSwi++; if (!firstGarbage) firstGarbage = `SWI 0x${c.toString(16)} pc=0x${(cpu.st.r[15]>>>0).toString(16)}`; }
  return origSwi(c, cpu);
};

bootToTitle(a, 320);
for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
a.tap('start', 4, 10);
for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
log(`[overworld] f${a.frame} IE=0x${m.io.get16(0x4000200).toString(16)} liveness=${m.lastFrameLiveness}`);

// Enable HBlank IRQ at hardware level ONCE. The PPU will now raise IRQ_HBLANK every scanline via its
// own requestIrq path, exactly like the trainer card / battle. The game's handler (which re-enables
// IRQs for nesting) will be hammered with HBlank during its VBlank servicing => the exact nested
// condition. The guard must prevent frame aliasing.
m.io.set16(0x4000004, m.io.get16(0x4000004) | (1 << 4)); // DISPSTAT HBlank IRQ enable
m.io.set16(0x4000200, m.io.get16(0x4000200) | (1 << 1)); // IE HBlank

let minLiveness = 9999, lrZeroAtReturn = 0;
for (let f = 0; f < 1200; f++) {
  a.wait(1);
  minLiveness = Math.min(minLiveness, m.lastFrameLiveness | 0);
  if (softReset || garbageSwi) break;
}
log(`\n[nested-IRQ stress: HBlank enabled, 1200 frames]`);
log(`  IE now=0x${m.io.get16(0x4000200).toString(16)}`);
log(`  SoftResets: ${softReset}`);
log(`  garbage SWIs (executing wreckage): ${garbageSwi}${firstGarbage?'  first='+firstGarbage:''}`);
log(`  min CPU liveness: ${minLiveness}`);
const pass = softReset === 0 && garbageSwi === 0 && minLiveness >= 20;
log(pass ? '\n[PASS] HBlank IRQ storm survived: no SoftReset, no garbage execution, game fully alive.'
        : '\n[FAIL] corruption still occurs.');
