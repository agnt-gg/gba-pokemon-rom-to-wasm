/**
 * ARM7TDMI CPU state.
 *
 * The GBA CPU is an ARM7TDMI: a 32-bit ARMv4T core that runs two instruction sets,
 * ARM (32-bit fixed-width) and THUMB (16-bit compressed). This module models the
 * register file, banked registers, and the program status registers (CPSR/SPSR).
 *
 * Register model (ARMv4T):
 *   - 16 visible general registers r0-r15 at any time.
 *   - r13 = SP, r14 = LR, r15 = PC.
 *   - Several registers are "banked" per processor mode (FIQ banks r8-r14; IRQ/SVC/ABT/UND
 *     bank r13-r14). Switching mode swaps which physical register backs r8..r14.
 *   - CPSR holds condition flags (N,Z,C,V), the IRQ/FIQ disable bits, the THUMB state bit,
 *     and the 5-bit mode field. Each privileged mode has a saved CPSR (SPSR) used by exceptions.
 *
 * We keep this faithful because correctness here is the foundation for everything above it.
 * The interpreter (arm_core) and the eventual recompiler both build on this state.
 */

export const Mode = {
  USR: 0x10,
  FIQ: 0x11,
  IRQ: 0x12,
  SVC: 0x13,
  ABT: 0x17,
  UND: 0x1b,
  SYS: 0x1f,
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

// CPSR bit positions
export const FLAG_N = 1 << 31;
export const FLAG_Z = 1 << 30;
export const FLAG_C = 1 << 29;
export const FLAG_V = 1 << 28;
export const FLAG_I = 1 << 7; // IRQ disable
export const FLAG_F = 1 << 6; // FIQ disable
export const FLAG_T = 1 << 5; // THUMB state

export class ArmState {
  // Current visible register file r0..r15. r15 is PC.
  r = new Int32Array(16);

  // Current Program Status Register.
  cpsr = Mode.SVC | FLAG_I | FLAG_F;

  // Banked registers. We store the *other* modes' versions and swap on mode change.
  // User/System share one bank for r8-r14.
  private bankUsr = new Int32Array(7); // r8..r14
  private bankFiq = new Int32Array(7); // r8..r14
  private bankIrq = new Int32Array(2); // r13..r14
  private bankSvc = new Int32Array(2);
  private bankAbt = new Int32Array(2);
  private bankUnd = new Int32Array(2);

  // Saved PSRs per privileged mode.
  spsrFiq = 0; spsrIrq = 0; spsrSvc = 0; spsrAbt = 0; spsrUnd = 0;

  private curMode: Mode = Mode.SVC;

  // ---- flag helpers ----
  get n(): boolean { return (this.cpsr & FLAG_N) !== 0; }
  get z(): boolean { return (this.cpsr & FLAG_Z) !== 0; }
  get c(): boolean { return (this.cpsr & FLAG_C) !== 0; }
  get v(): boolean { return (this.cpsr & FLAG_V) !== 0; }
  get thumb(): boolean { return (this.cpsr & FLAG_T) !== 0; }
  get irqDisabled(): boolean { return (this.cpsr & FLAG_I) !== 0; }

  setFlag(mask: number, on: boolean): void {
    if (on) this.cpsr |= mask; else this.cpsr &= ~mask;
  }
  setNZ(value: number): void {
    this.setFlag(FLAG_N, (value & 0x80000000) !== 0);
    this.setFlag(FLAG_Z, (value | 0) === 0);
  }

  get mode(): Mode { return this.curMode; }

  /** PC convenience (r15). */
  get pc(): number { return this.r[15] >>> 0; }
  set pc(v: number) { this.r[15] = v | 0; }

  /** Read a register as unsigned 32-bit. */
  get(i: number): number { return this.r[i] >>> 0; }
  set(i: number, v: number): void { this.r[i] = v | 0; }

  /** SPSR of the current mode (USR/SYS have no SPSR; return CPSR per ARM convention). */
  getSpsr(): number {
    switch (this.curMode) {
      case Mode.FIQ: return this.spsrFiq;
      case Mode.IRQ: return this.spsrIrq;
      case Mode.SVC: return this.spsrSvc;
      case Mode.ABT: return this.spsrAbt;
      case Mode.UND: return this.spsrUnd;
      default: return this.cpsr;
    }
  }
  setSpsr(v: number): void {
    switch (this.curMode) {
      case Mode.FIQ: this.spsrFiq = v | 0; break;
      case Mode.IRQ: this.spsrIrq = v | 0; break;
      case Mode.SVC: this.spsrSvc = v | 0; break;
      case Mode.ABT: this.spsrAbt = v | 0; break;
      case Mode.UND: this.spsrUnd = v | 0; break;
      default: break;
    }
  }
  hasSpsr(): boolean {
    return this.curMode !== Mode.USR && this.curMode !== Mode.SYS;
  }

  /**
   * Switch processor mode, banking r8..r14 in/out. r0-r7 and r15 are never banked.
   * Call this whenever the CPSR mode field changes (MSR, exception entry, mode restore).
   */
  switchMode(next: Mode): void {
    if (next === this.curMode) {
      this.cpsr = (this.cpsr & ~0x1f) | next;
      return;
    }
    this.saveBank(this.curMode);
    this.loadBank(next);
    this.curMode = next;
    this.cpsr = (this.cpsr & ~0x1f) | next;
  }

  /** Apply a new CPSR value, performing a mode switch if the mode field changed. */
  writeCpsr(value: number, allowModeChange = true): void {
    const newMode = (value & 0x1f) as Mode;
    if (allowModeChange && newMode !== this.curMode && this.isValidMode(newMode)) {
      this.switchMode(newMode);
    }
    // Preserve the mode bits we just (maybe) switched to.
    this.cpsr = (value & ~0x1f) | (this.cpsr & 0x1f);
  }

  private isValidMode(m: number): boolean {
    return m === Mode.USR || m === Mode.FIQ || m === Mode.IRQ || m === Mode.SVC ||
           m === Mode.ABT || m === Mode.UND || m === Mode.SYS;
  }

  private saveBank(mode: Mode): void {
    switch (mode) {
      case Mode.FIQ:
        for (let i = 0; i < 7; i++) this.bankFiq[i] = this.r[8 + i];
        break;
      case Mode.IRQ: this.bankIrq[0] = this.r[13]; this.bankIrq[1] = this.r[14]; this.saveUsrHigh(); break;
      case Mode.SVC: this.bankSvc[0] = this.r[13]; this.bankSvc[1] = this.r[14]; this.saveUsrHigh(); break;
      case Mode.ABT: this.bankAbt[0] = this.r[13]; this.bankAbt[1] = this.r[14]; this.saveUsrHigh(); break;
      case Mode.UND: this.bankUnd[0] = this.r[13]; this.bankUnd[1] = this.r[14]; this.saveUsrHigh(); break;
      default: // USR / SYS
        for (let i = 0; i < 7; i++) this.bankUsr[i] = this.r[8 + i];
        break;
    }
  }

  // For non-FIQ privileged modes, r8-r12 come from the user bank.
  private saveUsrHigh(): void {
    for (let i = 0; i < 5; i++) this.bankUsr[i] = this.r[8 + i];
  }
  private loadUsrHigh(): void {
    for (let i = 0; i < 5; i++) this.r[8 + i] = this.bankUsr[i];
  }

  private loadBank(mode: Mode): void {
    switch (mode) {
      case Mode.FIQ:
        for (let i = 0; i < 7; i++) this.r[8 + i] = this.bankFiq[i];
        break;
      case Mode.IRQ: this.loadUsrHigh(); this.r[13] = this.bankIrq[0]; this.r[14] = this.bankIrq[1]; break;
      case Mode.SVC: this.loadUsrHigh(); this.r[13] = this.bankSvc[0]; this.r[14] = this.bankSvc[1]; break;
      case Mode.ABT: this.loadUsrHigh(); this.r[13] = this.bankAbt[0]; this.r[14] = this.bankAbt[1]; break;
      case Mode.UND: this.loadUsrHigh(); this.r[13] = this.bankUnd[0]; this.r[14] = this.bankUnd[1]; break;
      default: // USR / SYS
        for (let i = 0; i < 7; i++) this.r[8 + i] = this.bankUsr[i];
        break;
    }
  }
}
