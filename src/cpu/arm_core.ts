/**
 * ARM7TDMI interpreter core (ARM + THUMB).
 *
 * This is the heart of gba-recomp. It fetches, decodes, and executes ARM and THUMB
 * instructions against a Bus. Design goals, in priority order:
 *   1. Correctness (oracle-diffable against a reference emulator).
 *   2. Clarity (every instruction class is a named, commented method).
 *   3. Speed later (hot blocks can be lifted to WASM once the interpreter is correct).
 *
 * Pipeline model: ARM7TDMI is a 3-stage pipeline, so a running instruction sees PC pointing
 * two instructions ahead: PC+8 in ARM mode, PC+4 in THUMB mode. We model this by keeping
 * r15 = address_of_current_instruction + (8 or 4) during execution, which is what real code
 * observes when it reads r15.
 */

import { ArmState, Mode, FLAG_C, FLAG_V, FLAG_N, FLAG_Z, FLAG_T, FLAG_I } from './arm_state.ts';
import type { Bus } from './bus.ts';
import { ShiftType, shiftImm, shiftReg } from './barrel.ts';

export interface SwiHandler {
  /** Return true if the SWI was handled via HLE (skip the BIOS vector). */
  (comment: number, cpu: ArmCore): boolean;
}

export class ArmCore {
  st = new ArmState();
  bus: Bus;
  cycles = 0;
  swiHandler: SwiHandler | null = null;
  halted = false;
  // True while inside an active BIOS IntrWait/VBlankIntrWait that has halted and is waiting to be
  // re-polled after an IRQ wake. Used by the BIOS HLE to skip the discardOld clear on re-entry.
  intrWaitActive = false;

  constructor(bus: Bus) { this.bus = bus; }

  /**
   * Reset to GBA cartridge entry behavior.
   *
   * Real hardware runs the Nintendo BIOS before jumping to the cartridge; that BIOS initializes
   * the THREE banked stack pointers and leaves the CPU in System mode. Cartridges (including the
   * jsmolka test ROMs and Pokemon) rely on these being set, since the header just branches to the
   * entry with no stack setup of its own. We replicate the documented BIOS post-boot state:
   *   SP_svc = 0x03007FE0, SP_irq = 0x03007FA0, SP_sys/usr = 0x03007F00, CPU in System mode.
   */
  resetToCartridge(): void {
    // Set SP_svc.
    this.st.switchMode(Mode.SVC);
    this.st.r[13] = 0x03007fe0;
    // Set SP_irq.
    this.st.switchMode(Mode.IRQ);
    this.st.r[13] = 0x03007fa0;
    // Finish in System mode with SP_usr/sys, IRQs masked at boot.
    this.st.switchMode(Mode.SYS);
    this.st.r[13] = 0x03007f00;
    this.st.cpsr = Mode.SYS | FLAG_I | (1 << 6);
    this.st.r[15] = 0x08000000;
    this.refillPipeline();
  }

  // ---- condition codes ----
  private condPass(cond: number): boolean {
    const f = this.st.cpsr;
    const N = (f & FLAG_N) !== 0, Z = (f & FLAG_Z) !== 0, C = (f & FLAG_C) !== 0, V = (f & FLAG_V) !== 0;
    switch (cond) {
      case 0x0: return Z;            // EQ
      case 0x1: return !Z;           // NE
      case 0x2: return C;            // CS/HS
      case 0x3: return !C;           // CC/LO
      case 0x4: return N;            // MI
      case 0x5: return !N;           // PL
      case 0x6: return V;            // VS
      case 0x7: return !V;           // VC
      case 0x8: return C && !Z;      // HI
      case 0x9: return !C || Z;      // LS
      case 0xa: return N === V;      // GE
      case 0xb: return N !== V;      // LT
      case 0xc: return !Z && (N === V); // GT
      case 0xd: return Z || (N !== V);  // LE
      case 0xe: return true;         // AL
      default: return true;          // 0xf (NV) treated as always for ARMv4T BX-extension safety
    }
  }

  /** After any direct PC write, re-sync the visible PC (no real prefetch buffer modeled). */
  private refillPipeline(): void { /* PC offset applied at read time below */ }

  // r15 as seen by an executing instruction. NOTE: stepArm/stepThumb already advanced r15 to
  // (instruction_address + instr_size). ARM code observes PC = instruction + 8, so a normal read
  // adds +4 here (since r15 already holds +4); a register-specified shift observes PC = instr + 12,
  // so it adds +8. THUMB reads add +2 (PC observed as instr + 4). Callers pass the right delta.
  private readReg(i: number, pcAhead: number): number {
    if (i === 15) return (this.st.r[15] + pcAhead) >>> 0;
    return this.st.r[i] >>> 0;
  }

  /** Execute a single instruction (ARM or THUMB depending on T flag). Returns cycles consumed (approx). */
  step(): number {
    const before = this.cycles;
    if (this.st.cpsr & FLAG_T) this.stepThumb();
    else this.stepArm();
    return this.cycles - before;
  }

  // =========================================================================
  // ARM mode
  // =========================================================================
  private stepArm(): void {
    const pc = this.st.r[15] >>> 0;
    const instr = this.bus.read32(pc) >>> 0;
    this.st.r[15] = (pc + 4) | 0; // advance; PC reads as +8 (pc+4 here, +4 ahead applied per-read)
    this.cycles += 1;

    const cond = instr >>> 28;
    if (!this.condPass(cond)) return;

    // Decode by major classes.
    if ((instr & 0x0ffffff0) === 0x012fff10) { this.armBX(instr); return; }            // BX
    if ((instr & 0x0c000000) === 0x00000000) {
      // data processing / PSR transfer / multiply / halfword transfer
      if ((instr & 0x0fc000f0) === 0x00000090) { this.armMUL(instr); return; }         // MUL/MLA
      if ((instr & 0x0f8000f0) === 0x00800090) { this.armMULL(instr); return; }        // (U|S)MULL/MLAL
      if ((instr & 0x0fb00ff0) === 0x01000090) { this.armSWP(instr); return; }         // SWP
      if ((instr & 0x0e000090) === 0x00000090 && (instr & 0x60) !== 0) { this.armHalfXfer(instr); return; }
      this.armDataProc(instr); return;
    }
    if ((instr & 0x0c000000) === 0x04000000) { this.armSingleXfer(instr); return; }    // LDR/STR
    if ((instr & 0x0e000000) === 0x08000000) { this.armBlockXfer(instr); return; }     // LDM/STM
    if ((instr & 0x0e000000) === 0x0a000000) { this.armBranch(instr); return; }        // B/BL
    if ((instr & 0x0f000000) === 0x0f000000) { this.armSWI(instr); return; }           // SWI
    // Unhandled — treat as NOP for now (coprocessor ops don't exist on GBA games).
  }

  private armBX(instr: number): void {
    const rn = instr & 0xf;
    const addr = this.st.r[rn] >>> 0;
    if (addr & 1) { this.st.cpsr |= FLAG_T; this.st.r[15] = addr & ~1; }
    else { this.st.cpsr &= ~FLAG_T; this.st.r[15] = addr & ~3; }
  }

  private armBranch(instr: number): void {
    const link = (instr & 0x01000000) !== 0;
    let off = (instr & 0x00ffffff);
    if (off & 0x00800000) off |= 0xff000000; // sign-extend 24-bit
    off <<= 2;
    const pc = (this.st.r[15] + 4) >>> 0; // PC+8 relative to instruction
    if (link) this.st.r[14] = (this.st.r[15]) | 0; // return addr = instr+4
    this.st.r[15] = (pc + off) | 0;
  }

  private armSWI(instr: number): void {
    const comment = (instr >>> 16) & 0xff;
    if (this.swiHandler && this.swiHandler(comment, this)) return;
    // Vector to BIOS SWI handler.
    this.enterException(Mode.SVC, 0x08, true);
  }

  /** Common exception entry: bank LR/SPSR, set mode, jump to vector. */
  enterException(mode: Mode, vector: number, fromSwi: boolean): void {
    const retAddr = fromSwi ? (this.st.r[15] | 0) : (this.st.r[15] | 0);
    const savedCpsr = this.st.cpsr;
    this.st.switchMode(mode);
    this.st.setSpsr(savedCpsr);
    this.st.r[14] = retAddr;
    this.st.cpsr |= FLAG_I;
    this.st.cpsr &= ~FLAG_T;
    this.st.r[15] = vector;
  }

  // ---- data processing ----
  private armDataProc(instr: number): void {
    const imm = (instr & 0x02000000) !== 0;
    const opcode = (instr >>> 21) & 0xf;
    const setFlags = (instr & 0x00100000) !== 0;
    const rn = (instr >>> 16) & 0xf;
    const rd = (instr >>> 12) & 0xf;

    // PSR transfer (MRS/MSR) hides in TST/TEQ/CMP/CMN opcodes with S=0.
    if (!setFlags && opcode >= 0x8 && opcode <= 0xb) { this.armPsrTransfer(instr); return; }

    let op2: number; let shifterCarry = (this.st.cpsr & FLAG_C) !== 0;
    // r15 reads as +8 normally; but if a register-specified shift is used, the value is +12.
    if (imm) {
      const rot = ((instr >>> 8) & 0xf) * 2;
      const val = instr & 0xff;
      if (rot === 0) op2 = val;
      else { op2 = ((val >>> rot) | (val << (32 - rot))) >>> 0; shifterCarry = (op2 & 0x80000000) !== 0; }
    } else {
      const rm = instr & 0xf;
      const type = ((instr >>> 5) & 3) as ShiftType;
      if (instr & 0x10) {
        // Register-specified shift: rm and rn observe PC = instr + 12 (we add +8 to r15+4).
        const rs = (instr >>> 8) & 0xf;
        const amount = this.readReg(rs, 8) & 0xff;
        const rmAdj = this.readReg(rm, 8);
        const r = shiftReg(type, rmAdj, amount, shifterCarry);
        op2 = r.value >>> 0; shifterCarry = r.carry;
      } else {
        const amount = (instr >>> 7) & 0x1f;
        const rmVal = this.readReg(rm, 4);
        const r = shiftImm(type, rmVal, amount, shifterCarry);
        op2 = r.value >>> 0; shifterCarry = r.carry;
      }
    }

    // rn observes PC = instr + 8 normally, or + 12 when a register-specified shift is present.
    const rnAhead = (!imm && (instr & 0x10)) ? 8 : 4;
    const a = this.readReg(rn, rnAhead) >>> 0;
    const b = op2 >>> 0;
    let result = 0; let writeback = true; let carry = (this.st.cpsr & FLAG_C) !== 0; let overflow = (this.st.cpsr & FLAG_V) !== 0;
    let logical = false;

    switch (opcode) {
      case 0x0: result = (a & b) >>> 0; logical = true; break;                 // AND
      case 0x1: result = (a ^ b) >>> 0; logical = true; break;                 // EOR
      case 0x2: { const r = (a - b) >>> 0; carry = a >= b; overflow = (((a ^ b) & (a ^ r)) & 0x80000000) !== 0; result = r; break; } // SUB
      case 0x3: { const r = (b - a) >>> 0; carry = b >= a; overflow = (((b ^ a) & (b ^ r)) & 0x80000000) !== 0; result = r; break; } // RSB
      case 0x4: { const r = a + b; carry = r > 0xffffffff; result = r >>> 0; overflow = ((~(a ^ b) & (a ^ result)) & 0x80000000) !== 0; break; } // ADD
      case 0x5: { const cin = (this.st.cpsr & FLAG_C) ? 1 : 0; const r = a + b + cin; carry = r > 0xffffffff; result = r >>> 0; overflow = ((~(a ^ b) & (a ^ result)) & 0x80000000) !== 0; break; } // ADC
      case 0x6: { const cin = (this.st.cpsr & FLAG_C) ? 1 : 0; const r = (a - b - (1 - cin)) >>> 0; carry = a >= (b + (1 - cin)); overflow = (((a ^ b) & (a ^ r)) & 0x80000000) !== 0; result = r; break; } // SBC
      case 0x7: { const cin = (this.st.cpsr & FLAG_C) ? 1 : 0; const r = (b - a - (1 - cin)) >>> 0; carry = b >= (a + (1 - cin)); overflow = (((b ^ a) & (b ^ r)) & 0x80000000) !== 0; result = r; break; } // RSC
      case 0x8: result = (a & b) >>> 0; logical = true; writeback = false; break; // TST
      case 0x9: result = (a ^ b) >>> 0; logical = true; writeback = false; break; // TEQ
      case 0xa: { const r = (a - b) >>> 0; carry = a >= b; overflow = (((a ^ b) & (a ^ r)) & 0x80000000) !== 0; result = r; writeback = false; break; } // CMP
      case 0xb: { const r = a + b; carry = r > 0xffffffff; result = r >>> 0; overflow = ((~(a ^ b) & (a ^ result)) & 0x80000000) !== 0; writeback = false; break; } // CMN
      case 0xc: result = (a | b) >>> 0; logical = true; break;                 // ORR
      case 0xd: result = b >>> 0; logical = true; break;                       // MOV
      case 0xe: result = (a & ~b) >>> 0; logical = true; break;                // BIC
      case 0xf: result = (~b) >>> 0; logical = true; break;                    // MVN
    }

    if (setFlags) {
      if (rd === 15) {
        // Restore CPSR from SPSR (exception return form).
        if (this.st.hasSpsr()) this.st.writeCpsr(this.st.getSpsr());
      } else {
        this.st.setFlag(FLAG_N, (result & 0x80000000) !== 0);
        this.st.setFlag(FLAG_Z, (result >>> 0) === 0);
        if (logical) { this.st.setFlag(FLAG_C, shifterCarry); }
        else { this.st.setFlag(FLAG_C, carry); this.st.setFlag(FLAG_V, overflow); }
      }
    }
    if (writeback) {
      this.st.r[rd] = result | 0;
      if (rd === 15) { this.st.r[15] = this.st.r[15] & ~3; }
    }
  }

  private armPsrTransfer(instr: number): void {
    const toSpsr = (instr & 0x00400000) !== 0;
    const isMsr = (instr & 0x00200000) !== 0;
    if (!isMsr) {
      // MRS
      const rd = (instr >>> 12) & 0xf;
      this.st.r[rd] = (toSpsr ? this.st.getSpsr() : this.st.cpsr) | 0;
      return;
    }
    // MSR
    let value: number;
    if (instr & 0x02000000) {
      const rot = ((instr >>> 8) & 0xf) * 2;
      const v = instr & 0xff;
      value = rot === 0 ? v : ((v >>> rot) | (v << (32 - rot))) >>> 0;
    } else {
      value = this.st.r[instr & 0xf] >>> 0;
    }
    let mask = 0;
    if (instr & 0x00080000) mask |= 0xff000000; // flags
    if (instr & 0x00040000) mask |= 0x00ff0000;
    if (instr & 0x00020000) mask |= 0x0000ff00;
    if (instr & 0x00010000) mask |= 0x000000ff; // control
    // In user mode, only the flag bits can change.
    if (this.st.mode === Mode.USR) mask &= 0xff000000;
    if (toSpsr) {
      this.st.setSpsr((this.st.getSpsr() & ~mask) | (value & mask));
    } else {
      const newCpsr = (this.st.cpsr & ~mask) | (value & mask);
      this.st.writeCpsr(newCpsr);
    }
  }

  private armMUL(instr: number): void {
    const rd = (instr >>> 16) & 0xf;
    const rn = (instr >>> 12) & 0xf;
    const rs = (instr >>> 8) & 0xf;
    const rm = instr & 0xf;
    const accumulate = (instr & 0x00200000) !== 0;
    const setFlags = (instr & 0x00100000) !== 0;
    let result = Math.imul(this.st.r[rm] | 0, this.st.r[rs] | 0) | 0;
    if (accumulate) result = (result + (this.st.r[rn] | 0)) | 0;
    this.st.r[rd] = result;
    if (setFlags) { this.st.setFlag(FLAG_N, (result & 0x80000000) !== 0); this.st.setFlag(FLAG_Z, (result >>> 0) === 0); }
  }

  private armMULL(instr: number): void {
    const rdHi = (instr >>> 16) & 0xf;
    const rdLo = (instr >>> 12) & 0xf;
    const rs = (instr >>> 8) & 0xf;
    const rm = instr & 0xf;
    const signed = (instr & 0x00400000) !== 0;
    const accumulate = (instr & 0x00200000) !== 0;
    const setFlags = (instr & 0x00100000) !== 0;
    const m = signed ? BigInt(this.st.r[rm] | 0) : BigInt(this.st.r[rm] >>> 0);
    const s = signed ? BigInt(this.st.r[rs] | 0) : BigInt(this.st.r[rs] >>> 0);
    let product = m * s;
    if (accumulate) {
      const acc = (BigInt(this.st.r[rdHi] >>> 0) << 32n) | BigInt(this.st.r[rdLo] >>> 0);
      product = product + acc;
    }
    const lo = Number(product & 0xffffffffn) | 0;
    const hi = Number((product >> 32n) & 0xffffffffn) | 0;
    this.st.r[rdLo] = lo; this.st.r[rdHi] = hi;
    if (setFlags) { this.st.setFlag(FLAG_N, (hi & 0x80000000) !== 0); this.st.setFlag(FLAG_Z, lo === 0 && hi === 0); }
  }

  private armSWP(instr: number): void {
    const rn = (instr >>> 16) & 0xf;
    const rd = (instr >>> 12) & 0xf;
    const rm = instr & 0xf;
    const byte = (instr & 0x00400000) !== 0;
    const addr = this.st.r[rn] >>> 0;
    if (byte) { const tmp = this.bus.read8(addr); this.bus.write8(addr, this.st.r[rm] & 0xff); this.st.r[rd] = tmp; }
    else { const tmp = this.ldrWord(addr); this.bus.write32(addr & ~3, this.st.r[rm] >>> 0); this.st.r[rd] = tmp | 0; }
  }

  // Rotated unaligned word read (ARM LDR semantics).
  private ldrWord(addr: number): number {
    const aligned = this.bus.read32(addr & ~3) >>> 0;
    const rot = (addr & 3) * 8;
    return rot === 0 ? aligned : ((aligned >>> rot) | (aligned << (32 - rot))) >>> 0;
  }

  private armSingleXfer(instr: number): void {
    const imm = (instr & 0x02000000) === 0; // bit25=0 means immediate offset (note inverted vs dataproc)
    const pre = (instr & 0x01000000) !== 0;
    const up = (instr & 0x00800000) !== 0;
    const byte = (instr & 0x00400000) !== 0;
    const writeback = (instr & 0x00200000) !== 0;
    const load = (instr & 0x00100000) !== 0;
    const rn = (instr >>> 16) & 0xf;
    const rd = (instr >>> 12) & 0xf;

    let offset: number;
    if (imm) offset = instr & 0xfff;
    else {
      const rm = instr & 0xf;
      const type = ((instr >>> 5) & 3) as ShiftType;
      const amount = (instr >>> 7) & 0x1f;
      offset = shiftImm(type, this.st.r[rm] | 0, amount, (this.st.cpsr & FLAG_C) !== 0).value >>> 0;
    }

    let base = this.readReg(rn, 4) >>> 0;
    let addr = base;
    if (pre) addr = up ? (base + offset) >>> 0 : (base - offset) >>> 0;

    // The address to write back to Rn: for post-index it's base±offset (applied after the access);
    // for pre-index with writeback (the `!` form) it's the indexed `addr` itself. Previously the
    // pre-index writeback wrote back the *unmodified* base, which broke `ldr r3,[r2,-r1,lsl#2]!`
    // (jsmolka ARM test 353): the load was correct but Rn never advanced.
    const wbAddr = pre ? addr : (up ? (base + offset) >>> 0 : (base - offset) >>> 0);

    if (load) {
      const val = byte ? this.bus.read8(addr) : this.ldrWord(addr);
      // Writeback happens when post-indexed (always) or pre-indexed with the W bit. Rn==Rd: the
      // loaded value wins (no writeback) per ARM7 behavior.
      if ((writeback || !pre) && rn !== rd) this.st.r[rn] = wbAddr | 0;
      this.st.r[rd] = val | 0;
      if (rd === 15) this.st.r[15] = this.st.r[15] & ~3;
    } else {
      // STR of PC stores instr + 12 on ARM7 (r15 already holds +4, so add +8).
      const val = rd === 15 ? (this.st.r[15] + 8) >>> 0 : this.st.r[rd] >>> 0;
      if (byte) this.bus.write8(addr, val & 0xff); else this.bus.write32(addr & ~3, val >>> 0);
      if (writeback || !pre) this.st.r[rn] = wbAddr | 0;
    }
  }

  private armHalfXfer(instr: number): void {
    const pre = (instr & 0x01000000) !== 0;
    const up = (instr & 0x00800000) !== 0;
    const immForm = (instr & 0x00400000) !== 0;
    const writeback = (instr & 0x00200000) !== 0;
    const load = (instr & 0x00100000) !== 0;
    const rn = (instr >>> 16) & 0xf;
    const rd = (instr >>> 12) & 0xf;
    const sh = (instr >>> 5) & 3;
    let offset = immForm ? (((instr >>> 4) & 0xf0) | (instr & 0xf)) : (this.st.r[instr & 0xf] >>> 0);

    let base = this.readReg(rn, 4) >>> 0;
    let addr = base;
    if (pre) addr = up ? (base + offset) >>> 0 : (base - offset) >>> 0;
    // Writeback target: indexed addr for pre-index, base±offset for post-index (same fix as word xfer).
    const wbAddr = pre ? addr : (up ? (base + offset) >>> 0 : (base - offset) >>> 0);

    if (load) {
      let val = 0;
      switch (sh) {
        case 1: val = this.bus.read16(addr & ~1); if (addr & 1) val = ((val >>> 8) | (val << 24)) >>> 0; break; // LDRH (rotated)
        case 2: { const b = this.bus.read8(addr); val = (b & 0x80) ? (b | 0xffffff00) : b; break; }             // LDRSB
        case 3: { // LDRSH
          if (addr & 1) { const b = this.bus.read8(addr); val = (b & 0x80) ? (b | 0xffffff00) : b; }
          else { const h = this.bus.read16(addr); val = (h & 0x8000) ? (h | 0xffff0000) : h; }
          break;
        }
      }
      if ((writeback || !pre) && rn !== rd) this.st.r[rn] = wbAddr | 0;
      this.st.r[rd] = val | 0;
    } else {
      const val = this.st.r[rd] & 0xffff; // STRH
      this.bus.write16(addr & ~1, val);
      if (writeback || !pre) this.st.r[rn] = wbAddr | 0;
    }
  }

  private armBlockXfer(instr: number): void {
    const pre = (instr & 0x01000000) !== 0;
    const up = (instr & 0x00800000) !== 0;
    const psrForce = (instr & 0x00400000) !== 0;
    const writeback = (instr & 0x00200000) !== 0;
    const load = (instr & 0x00100000) !== 0;
    const rn = (instr >>> 16) & 0xf;
    const list = instr & 0xffff;

    let count = 0; for (let i = 0; i < 16; i++) if (list & (1 << i)) count++;
    const base = this.st.r[rn] >>> 0;

    // ---- ARM7TDMI empty-register-list quirk (jsmolka ARM tests 513/515) ----
    // An LDM/STM with an empty rlist transfers nothing *except* it behaves as if r15 were the
    // sole register for addressing purposes, and writeback adjusts the base by ±0x40 (16 words).
    // LDM loads PC from the effective base; STM stores PC+? at the base. We implement the
    // hardware-observable result: writeback of base ± 0x40, and for LDM, PC <- [effectiveAddr].
    if (list === 0) {
      const delta = 0x40;
      // Effective transfer address mirrors the normal low->high model with a single 16-word block.
      let ea: number; let wb: number;
      if (up) { ea = base; wb = (base + delta) >>> 0; }
      else { ea = (base - delta) >>> 0; wb = ea; }
      // Pre/post indexing shifts the actual access by one word, same as a populated list.
      const accAddr = (up ? (pre ? ea + 4 : ea) : (pre ? ea : ea + 4)) >>> 0;
      if (load) {
        const v = this.bus.read32(accAddr & ~3) >>> 0;
        this.st.r[15] = v & (this.st.cpsr & FLAG_T ? ~1 : ~3);
        this.refillPipeline?.();
      } else {
        this.bus.write32(accAddr & ~3, (this.st.r[15] + 8) >>> 0);
      }
      if (writeback) this.st.r[rn] = wb | 0;
      return;
    }

    let addr: number; let finalBase: number;
    if (up) { addr = base; finalBase = (base + count * 4) >>> 0; }
    else { addr = (base - count * 4) >>> 0; finalBase = addr; }
    // For pre-indexing, adjust start; addresses always processed low->high.
    let ptr = addr;
    const preInc = up ? pre : !pre;

    // ARM7TDMI STM-base-in-rlist quirk (jsmolka ARM tests 522/523): when the base register is in
    // the store list AND it is NOT the lowest-numbered register in the list, the value written for
    // the base is the POST-writeback (final) base. If it IS the lowest, the ORIGINAL base is stored.
    const baseInList = (list & (1 << rn)) !== 0;
    let lowest = -1; for (let i = 0; i < 16; i++) if (list & (1 << i)) { lowest = i; break; }
    const storeFinalForBase = !load && baseInList && writeback && rn !== lowest;

    const userBank = psrForce && !(load && (list & 0x8000));
    const savedMode = this.st.mode;
    if (userBank && savedMode !== Mode.USR && savedMode !== Mode.SYS) this.st.switchMode(Mode.USR);

    for (let i = 0; i < 16; i++) {
      if (!(list & (1 << i))) continue;
      if (preInc) ptr = (ptr + 4) >>> 0;
      if (load) {
        const v = this.bus.read32(ptr & ~3) >>> 0;
        this.st.r[i] = v | 0;
        if (i === 15) {
          if (psrForce && this.st.hasSpsr()) this.st.writeCpsr(this.st.getSpsr());
          this.st.r[15] = this.st.r[15] & (this.st.cpsr & FLAG_T ? ~1 : ~3);
        }
      } else {
        let v: number;
        if (i === 15) v = (this.st.r[15] + 8) >>> 0;
        else if (i === rn && storeFinalForBase) v = finalBase >>> 0; // base-in-rlist, not lowest -> store final base
        else v = this.st.r[i] >>> 0;
        this.bus.write32(ptr & ~3, v);
      }
      if (!preInc) ptr = (ptr + 4) >>> 0;
    }

    if (userBank && savedMode !== Mode.USR && savedMode !== Mode.SYS) this.st.switchMode(savedMode);
    if (writeback && !(load && (list & (1 << rn)))) this.st.r[rn] = finalBase | 0;
  }

  // =========================================================================
  // THUMB mode (delegated to thumb_core for clarity)
  // =========================================================================
  stepThumb(): void {
    // Implemented in thumb_core via mixin to keep files focused.
    thumbStep(this);
  }
}

// Late import to avoid circular type issues; thumb_core augments ArmCore behavior.
import { thumbStep } from './thumb_core.ts';
