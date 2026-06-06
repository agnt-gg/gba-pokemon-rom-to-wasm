/**
 * Regression: a CPU halted in VBlankIntrWait MUST be woken when the VBlank IRQ is delivered.
 *
 * The bug this guards against: the IRQ controller delivered an interrupt but never cleared
 * cpu.halted, so the BIOS IntrWait handshake deadlocked and the game spun forever on a VBlank
 * wait (Pokemon Ruby froze on a white screen). deliver() now clears halted, and runFrame only
 * dispatches to the user handler after poll() actually wakes the CPU.
 */
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const RUBY = 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
let passed = 0, failed = 0;
function test(n: string, f: () => void) { try { f(); passed++; console.log('ok   - ' + n); } catch (e: any) { failed++; console.log('FAIL - ' + n + '\n       ' + (e?.message || e)); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const m = new GbaMachine(new Uint8Array(readFileSync(RUBY)));
// Run to the point where the game enters its VBlank-wait main loop.
for (let f = 0; f < 200; f++) m.runFrame();

test('game reaches a steady main loop (CPU keeps executing, not deadlocked)', () => {
  const before = (m as any).instrCount;
  for (let f = 0; f < 100; f++) m.runFrame();
  const delta = (m as any).instrCount - before;
  // A deadlocked CPU executes ~0 instructions/frame (only the halted hardware steps). A live
  // main loop executes tens of thousands. Require a healthy floor.
  assert(delta > 50_000, `only ${delta} instructions over 100 frames — CPU appears deadlocked`);
  console.log('       executed ' + delta + ' instructions over 100 frames (~' + Math.round(delta / 100) + '/frame)');
});

test('the user IRQ handler actually runs each frame (handler PC region is exercised)', () => {
  let handlerInstrs = 0;
  const CYCLES_PER_FRAME = 280896; let cy = 0, guard = 0;
  while (cy < CYCLES_PER_FRAME && guard < 4_000_000) {
    if (m.cpu.halted) { m.ppu.step(8); m.timers.step(8); m.irq.poll(); if (!m.cpu.halted) (m as any).serviceIrqDispatch(); cy += 8; guard++; continue; }
    const pc = m.pc();
    // Count instructions executed while in IRQ mode (the VBlank handler).
    if (m.cpu.st.mode === 18 /* IRQ */) handlerInstrs++;
    cy += m.step(); guard++;
  }
  assert(handlerInstrs > 0, 'IRQ handler never executed — VBlank IRQ not delivered');
  console.log('       VBlank handler executed ' + handlerInstrs + ' instructions this frame');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
