/**
 * Regression: IRQ entry from THUMB state must set LR_irq to next+4, not next+2.
 *
 * The runtime returns from the HLE BIOS IRQ frame by restoring SPSR and doing the BIOS-equivalent
 * return to (LR_irq - 4). Therefore, if the interrupted code was THUMB and r15 already points at the
 * next instruction when poll() delivers the IRQ, LR_irq must be next+4 so return lands at next.
 *
 * Old bug: deliver() used next+2 for THUMB. Returning with -4 landed at next-2, re-executing the
 * interrupted halfword. Under HBlank-heavy screens (trainer card / battle) that can re-run BL halves
 * or stack/return instructions and corrupt control flow until the CPU executes EWRAM data and hits
 * SoftReset. This test directly asserts the return PC for an IRQ delivered from THUMB code.
 */
import { ArmCore } from '../src/cpu/arm_core.ts';
import { GbaIo, REG } from '../src/runtime/io.ts';
import { GbaInterrupts } from '../src/runtime/interrupts.ts';
import { FLAG_T, Mode } from '../src/cpu/arm_state.ts';
import type { Bus } from '../src/cpu/bus.ts';

let passed = 0, failed = 0;
function test(n: string, f: () => void) { try { f(); passed++; console.log('ok   - ' + n); } catch (e: any) { failed++; console.log('FAIL - ' + n + '\n       ' + (e?.message || e)); } }
function assertEq(a: any, b: any, m: string) { if (a !== b) throw new Error(`${m}: got ${a}, expected ${b}`); }

class TinyBus implements Bus {
  mem = new Uint8Array(0x1000);
  read8(a: number) { return this.mem[a & 0xfff] ?? 0; }
  read16(a: number) { return this.read8(a) | (this.read8(a + 1) << 8); }
  read32(a: number) { return (this.read16(a) | (this.read16(a + 2) << 16)) >>> 0; }
  write8(a: number, v: number) { this.mem[a & 0xfff] = v & 0xff; }
  write16(a: number, v: number) { this.write8(a, v); this.write8(a + 1, v >>> 8); }
  write32(a: number, v: number) { this.write16(a, v); this.write16(a + 2, v >>> 16); }
}

test('IRQ delivered while executing THUMB returns to the next THUMB instruction', () => {
  const bus = new TinyBus();
  const io = new GbaIo();
  const cpu = new ArmCore(bus);
  const irq = new GbaInterrupts(io, cpu);

  // Simulate the interpreter after it has executed a THUMB instruction at 0x08000100:
  // r15 now points at the next instruction, 0x08000102.
  cpu.st.cpsr = Mode.SYS | FLAG_T;
  cpu.st.r[15] = 0x08000102;
  io.set16(REG.IE, 1);
  io.set16(REG.IME, 1);

  irq.request(1);
  irq.poll();

  assertEq(cpu.st.mode, Mode.IRQ, 'CPU entered IRQ mode');
  assertEq(cpu.st.r[15] >>> 0, 0x18, 'IRQ vector PC');
  assertEq(cpu.st.r[14] >>> 0, 0x08000106, 'LR_irq must be next+4 for THUMB');

  // BIOS-style return subtracts 4 from LR_irq and restores T from SPSR, so it lands at next.
  // Capture LR_irq BEFORE restoring CPSR: r14 is banked, so after switching back to SYS it would
  // refer to SYS LR, not IRQ LR.
  const lrIrq = cpu.st.r[14] >>> 0;
  cpu.st.writeCpsr(cpu.st.getSpsr());
  cpu.st.r[15] = (lrIrq - 4) >>> 0;
  assertEq((cpu.st.cpsr & FLAG_T) !== 0, true, 'returned to THUMB state');
  assertEq(cpu.st.r[15] >>> 0, 0x08000102, 'return PC is the next THUMB instruction, not next-2');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
