/**
 * GBA interrupt controller.
 *
 * Registers: IE (enable mask), IF (request flags, write-1-to-clear), IME (master enable).
 * When an enabled interrupt is requested and IME is on and CPSR.I is clear, the CPU takes an
 * IRQ exception (vectors to 0x18, switches to IRQ mode). The game's handler reads IF, services
 * the source, and acknowledges by writing IF. Many games use the BIOS IntrWait, which we HLE by
 * halting the CPU until requestIrq wakes it.
 */

import { GbaIo, REG } from './io.ts';
import { ArmCore } from '../cpu/arm_core.ts';
import { Mode, FLAG_I, FLAG_T } from '../cpu/arm_state.ts';

export class GbaInterrupts {
  io: GbaIo;
  cpu: ArmCore;
  ifFlags = 0; // internal IF (the IO IF mirrors this on read)
  // Read accessor for the BIOS interrupt-check halfword (0x03007FF8 / mirror 0x03FFFFF8) that
  // IntrWait/VBlankIntrWait poll. Set by machine after wiring memory; used so request() can mirror
  // the real BIOS handler's behaviour of OR-ing fired+enabled bits into BIOS-IF the instant an IRQ
  // is raised. Without this, a CPU halted in IntrWait races its own SWI re-execution against the
  // IRQ dispatch and can re-halt before BIOS-IF is set — deadlocking the wait (observed as the
  // player-profile / wild-encounter freeze: pc=IntrWait spin, IF=1, biosIF=0 forever).
  biosIfOr: (bits: number) => void = () => {};

  // Gate set by the runtime: returns false while a BIOS IRQ-handler frame is still outstanding
  // (dispatched but not yet returned). The interrupt controller must NOT deliver a new IRQ (i.e. must
  // not vector the CPU to 0x18) during that window, otherwise — because the HLE BIOS dispatch is what
  // actually redirects 0x18 to the user handler — the CPU would be stranded at the 0x18 vector with no
  // dispatch, executing whatever lies there and crashing into EWRAM. The pending IRQ instead stays
  // latched in IF and is delivered the instant the current handler returns. This is the correct place
  // for the nested-IRQ guard (NOT inside serviceIrqDispatch, which would early-return and strand the
  // CPU at 0x18).
  canDeliver: () => boolean = () => true;

  constructor(io: GbaIo, cpu: ArmCore) {
    this.io = io; this.cpu = cpu;
    io.ifReadHook = () => this.ifFlags & 0xffff;
    io.ifAckHook = (bits) => { this.ifFlags &= ~bits; };
  }

  request(bits: number): void {
    this.ifFlags |= bits & 0xffff;
    this.io.set16(REG.IF, this.ifFlags & 0xffff);
    // Wake a halted CPU if this interrupt is enabled (BIOS IntrWait semantics).
    const ie = this.io.get16(REG.IE);
    const enabledFired = ie & this.ifFlags & 0xffff;
    if (enabledFired) {
      // Wake a CPU halted in Halt/IntrWait/VBlankIntrWait so the pending IRQ can be dispatched.
      this.cpu.halted = false;
      // NOTE: we deliberately DO NOT touch BIOS-IF (0x03007FF8) here. The real BIOS only updates the
      // interrupt-check halfword from inside its IRQ HANDLER, for the bits it actually dispatches.
      // Speculatively OR-ing every fired+enabled bit at request() time is wrong when more than one
      // source is enabled (e.g. the trainer card / battle scene enables HBlank => IE=0x3 and HBlank
      // fires ~160x/frame): it floods BIOS-IF with HBlank bits while the game spins in
      // VBlankIntrWait polling for the VBlank bit, desyncing the BIOS handshake. Ruby's IRQ
      // dispatcher detects the inconsistency and falls through to its SoftReset safety path — the
      // exact "trainer card / encounter resets the game" symptom. BIOS-IF is set authoritatively in
      // serviceIrqDispatch() at the moment of actual dispatch instead.
    }
  }

  /** Check and possibly deliver an IRQ to the CPU. Call between instructions. */
  poll(): void {
    const ime = this.io.get16(REG.IME) & 1;
    if (!ime) return;
    if (this.cpu.st.cpsr & FLAG_I) return; // IRQs disabled in CPSR
    const ie = this.io.get16(REG.IE);
    const pending = ie & this.ifFlags;
    if (!pending) return;
    // Nested-IRQ correctness: we allow the game's handler to re-enable IRQs and take a nested IRQ,
    // BUT we must not deliver a new IRQ while the CPU is still sitting at the BIOS vector (0x18) not
    // yet redirected to the user handler, nor recurse without bound. canDeliver() encodes that rule
    // (it is false at the unredirected vector and above a small depth cap). The pending IRQ stays
    // latched in IF and is taken as soon as delivery is permitted again.
    if (!this.canDeliver()) return;
    this.deliver();
  }

  private deliver(): void {
    const st = this.cpu.st;
    // Return address: IRQ exception LR is next-instruction address + 4. This is true for both ARM
    // and THUMB on ARM7TDMI when returning with SUBS PC, LR, #4 / BIOS equivalent. Our interpreter's
    // r15 already points at the next instruction when poll() runs after a completed instruction, so
    // always add +4. The old THUMB special-case (+2) returned to next-2 after the BIOS-frame restore,
    // re-executing the interrupted halfword. That is catastrophic on HBlank-heavy screens (trainer
    // card/battle) because IRQs can land between THUMB BL halves or stack/return sequences, corrupting
    // LR/control flow until the CPU executes EWRAM data and hits SoftReset.
    const retAddr = (st.r[15] + 4) >>> 0; // r15 currently points at next fetch
    const savedCpsr = st.cpsr;
    st.switchMode(Mode.IRQ);
    st.setSpsr(savedCpsr);
    st.r[14] = retAddr;
    st.cpsr |= FLAG_I;
    st.cpsr &= ~FLAG_T;
    st.r[15] = 0x18; // IRQ vector (BIOS). Games install a handler the BIOS dispatches to.
    // Delivering an IRQ wakes a CPU that was halted in Halt/IntrWait/VBlankIntrWait. Without this
    // the BIOS IntrWait handshake never advances and the game spins forever on a VBlank wait.
    this.cpu.halted = false;
  }
}
