/**
 * THUMB -> WASM lifter.
 *
 * THUMB is the 16-bit instruction set that dominates Pokemon Gen 3 code. Porting the hot THUMB
 * formats to native WebAssembly is the single biggest lever for native coverage (the ARM lifter
 * only covers the minority of ARM-mode code).
 *
 * Same contract as the ARM lifter:
 *   - ok:        instruction lifted to native WASM.
 *   - endsBlock: control-flow boundary (branch); block ends after it.
 *   - bail:      not lifted yet; block stops BEFORE it and the interpreter resumes.
 *
 * Correctness rules we honor exactly (matching thumb_core.ts):
 *   - PC reads as instr+4 in THUMB mode (we materialize the constant where needed).
 *   - Most THUMB data-processing ALWAYS sets N/Z (and many set C/V). There is no S-bit.
 *   - setNZ in the interpreter sets ONLY N and Z; C/V are left to the specific op. We mirror that.
 *   - Flags are kept as exploded i32 words (OFF_NF/ZF/CF/VF). The runtime syncs them to/from CPSR.
 *
 * What we lift natively (the common, hot, register-only or simple-memory formats):
 *   Fmt 1  : LSL/LSR/ASR by immediate
 *   Fmt 2  : ADD/SUB register or imm3 (sets NZCV)
 *   Fmt 3  : MOV/CMP/ADD/SUB imm8 (sets flags)
 *   Fmt 4  : ALU reg subset (AND/EOR/ORR/BIC/MVN/TST/CMP/CMN/MUL/NEG/ADC/SBC and the shift ALUs)
 *   Fmt 5  : hi-reg ADD/CMP/MOV (NOT when Rd==PC and NOT BX)
 *   Fmt 9  : load/store word/byte, immediate offset (LDR word bails for unaligned-rotation safety)
 *   Fmt 10 : load/store halfword, immediate offset
 *   Fmt 11 : SP-relative load/store word (LDR bails for rotation safety)
 *   Fmt 12 : load address (ADD Rd, PC/SP, #imm)
 *   Fmt 13 : add offset to SP
 *   Fmt 16 : conditional branch  (ends block)
 *   Fmt 18 : unconditional branch (ends block)
 *   Fmt 19 : long branch with link, both halves (ends block on the low half)
 *
 * Bail (interpreter handles): Fmt 6 PC-rel load, Fmt 7 reg-offset load/store (word rotation),
 *   Fmt 8 sign-extended loads, Fmt 14 PUSH/POP, Fmt 15 LDM/STM, SWI, BX, any PC-as-operand write.
 */

import { CodeBuilder, OP, I32 } from './wasm_encoder.ts';
import { regOff, OFF_NF, OFF_ZF, OFF_CF, OFF_VF, HOST } from './abi.ts';
import type { LiftResult } from './arm_lifter.ts';

// Reserved locals inside every block function (declared by the block builder):
//   local 0: tmpA, 1: tmpB, 2: tmpRes  (shared with the ARM lifter's RESERVED_LOCALS)
const L_A = 0, L_B = 1, L_RES = 2;

function loadReg(cb: CodeBuilder, n: number): CodeBuilder {
  cb.i32_const(regOff(n)).i32_load(0);
  return cb;
}
function storeRegFromStack(cb: CodeBuilder, n: number) {
  // stack: [value] -> store to reg n
  cb.local_set(L_RES);
  cb.i32_const(regOff(n));
  cb.local_get(L_RES);
  cb.i32_store(0);
}
function storeRegFromLocal(cb: CodeBuilder, n: number, local: number) {
  cb.i32_const(regOff(n));
  cb.local_get(local);
  cb.i32_store(0);
}

/** Set N and Z from the value currently in `local`. Mirrors interpreter setNZ (C/V untouched). */
function setNZfromLocal(cb: CodeBuilder, local: number) {
  cb.i32_const(OFF_ZF);
  cb.local_get(local).op(OP.i32_eqz);
  cb.i32_store(0);
  cb.i32_const(OFF_NF);
  cb.local_get(local).i32_const(0).op(OP.i32_lt_s);
  cb.i32_store(0);
}
function setFlagWord(cb: CodeBuilder, off: number, push: (b: CodeBuilder) => void) {
  cb.i32_const(off);
  push(cb);
  cb.i32_store(0);
}

/**
 * Lift one THUMB instruction at `pc` (address of the instruction itself).
 * pc+4 is what r15 reads during execution.
 */
// Diagnostic: a set of THUMB top-level groups to force-bail (for bisecting divergences).
// Set via globalThis.__THUMB_DISABLE = new Set([0b011, 0b100, ...]) in a tool.
function disabled(top: number): boolean {
  const d = (globalThis as any).__THUMB_DISABLE;
  return d && d.has(top);
}

export function liftThumb(cb: CodeBuilder, instr: number, pc: number): LiftResult {
  const pcPlus4 = (pc + 4) >>> 0;
  const top = instr >>> 13;
  if (disabled(top)) return { status: 'bail' };

  // ---- Fmt 1/2: shifted register OR add/subtract ----
  if (top === 0b000) {
    const op = (instr >>> 11) & 3;
    if (op === 3) {
      // ADD/SUB (Fmt 2)
      const sub = (instr & 0x0200) !== 0;
      const immFlag = (instr & 0x0400) !== 0;
      const rn = (instr >>> 6) & 7;
      const rs = (instr >>> 3) & 7;
      const rd = instr & 7;
      // a = Rs, b = imm3 or Rn
      loadReg(cb, rs).local_set(L_A);
      if (immFlag) cb.i32_const(rn).local_set(L_B);
      else loadReg(cb, rn).local_set(L_B);
      if (sub) {
        cb.local_get(L_A).local_get(L_B).op(OP.i32_sub).local_set(L_RES);
        storeRegFromLocal(cb, rd, L_RES);
        setNZfromLocal(cb, L_RES);
        // C = a >= b
        setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).local_get(L_B).op(OP.i32_ge_u));
        // V = ((a^b)&(a^res))>>31
        setFlagWord(cb, OFF_VF, (b) => {
          b.local_get(L_A).local_get(L_B).op(OP.i32_xor);
          b.local_get(L_A).local_get(L_RES).op(OP.i32_xor);
          b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
        });
      } else {
        cb.local_get(L_A).local_get(L_B).op(OP.i32_add).local_set(L_RES);
        storeRegFromLocal(cb, rd, L_RES);
        setNZfromLocal(cb, L_RES);
        // C = unsigned overflow: res < a
        setFlagWord(cb, OFF_CF, (b) => b.local_get(L_RES).local_get(L_A).op(OP.i32_lt_u));
        // V = (~(a^b)&(a^res))>>31
        setFlagWord(cb, OFF_VF, (b) => {
          b.local_get(L_A).local_get(L_B).op(OP.i32_xor).i32_const(-1).op(OP.i32_xor);
          b.local_get(L_A).local_get(L_RES).op(OP.i32_xor);
          b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
        });
      }
      return { status: 'ok' };
    }
    // Fmt 1: LSL/LSR/ASR by immediate. Sets N/Z and C (from shifter). V untouched.
    const amount = (instr >>> 6) & 0x1f;
    const rs = (instr >>> 3) & 7;
    const rd = instr & 7;
    loadReg(cb, rs).local_set(L_A);
    if (op === 0) {
      // LSL #amount. amount==0 => value unchanged, carry unchanged.
      if (amount === 0) {
        cb.local_get(L_A).local_set(L_RES);
        storeRegFromLocal(cb, rd, L_RES);
        setNZfromLocal(cb, L_RES);
        return { status: 'ok' };
      }
      cb.local_get(L_A).i32_const(amount).op(OP.i32_shl).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES);
      setNZfromLocal(cb, L_RES);
      // C = bit (32-amount) of original = (a >>> (32-amount)) & 1
      setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).i32_const(32 - amount).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and));
      return { status: 'ok' };
    }
    if (op === 1) {
      // LSR. amount==0 means #32: value=0, C = bit31 of a.
      const amt = amount === 0 ? 32 : amount;
      if (amt === 32) {
        cb.i32_const(0).local_set(L_RES);
        storeRegFromLocal(cb, rd, L_RES);
        setNZfromLocal(cb, L_RES);
        setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).i32_const(31).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and));
        return { status: 'ok' };
      }
      cb.local_get(L_A).i32_const(amt).op(OP.i32_shr_u).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES);
      setNZfromLocal(cb, L_RES);
      setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).i32_const(amt - 1).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and));
      return { status: 'ok' };
    }
    // op === 2: ASR. amount==0 means #32: value = sign-extension, C = bit31.
    const amt = amount === 0 ? 32 : amount;
    if (amt === 32) {
      cb.local_get(L_A).i32_const(31).op(OP.i32_shr_s).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES);
      setNZfromLocal(cb, L_RES);
      setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).i32_const(31).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and));
      return { status: 'ok' };
    }
    cb.local_get(L_A).i32_const(amt).op(OP.i32_shr_s).local_set(L_RES);
    storeRegFromLocal(cb, rd, L_RES);
    setNZfromLocal(cb, L_RES);
    setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).i32_const(amt - 1).op(OP.i32_shr_s).i32_const(1).op(OP.i32_and));
    return { status: 'ok' };
  }

  // ---- Fmt 3: MOV/CMP/ADD/SUB imm8 ----
  if (top === 0b001) {
    const op = (instr >>> 11) & 3;
    const rd = (instr >>> 8) & 7;
    const imm = instr & 0xff;
    loadReg(cb, rd).local_set(L_A);
    cb.i32_const(imm).local_set(L_B);
    if (op === 0) {
      // MOV: Rd = imm; setNZ(imm). (C/V untouched)
      cb.i32_const(imm).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES);
      setNZfromLocal(cb, L_RES);
      return { status: 'ok' };
    }
    if (op === 2) {
      // ADD: Rd = a + imm; NZCV
      cb.local_get(L_A).local_get(L_B).op(OP.i32_add).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES);
      setNZfromLocal(cb, L_RES);
      setFlagWord(cb, OFF_CF, (b) => b.local_get(L_RES).local_get(L_A).op(OP.i32_lt_u));
      setFlagWord(cb, OFF_VF, (b) => {
        b.local_get(L_A).local_get(L_B).op(OP.i32_xor).i32_const(-1).op(OP.i32_xor);
        b.local_get(L_A).local_get(L_RES).op(OP.i32_xor);
        b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
      });
      return { status: 'ok' };
    }
    // op 1 (CMP) and op 3 (SUB): r = a - imm; NZCV. CMP doesn't write Rd.
    cb.local_get(L_A).local_get(L_B).op(OP.i32_sub).local_set(L_RES);
    if (op === 3) storeRegFromLocal(cb, rd, L_RES);
    setNZfromLocal(cb, L_RES);
    setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).local_get(L_B).op(OP.i32_ge_u));
    setFlagWord(cb, OFF_VF, (b) => {
      b.local_get(L_A).local_get(L_B).op(OP.i32_xor);
      b.local_get(L_A).local_get(L_RES).op(OP.i32_xor);
      b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
    });
    return { status: 'ok' };
  }

  // ---- Fmt 4/5/6/7/8 (top == 0b010) ----
  if (top === 0b010) {
    // Fmt 4: ALU reg (0100 00xx xxxx xxxx)
    if ((instr & 0xfc00) === 0x4000) {
      return liftAluReg(cb, instr);
    }
    // Fmt 5: hi-reg ops / BX (0100 01xx xxxx xxxx)
    if ((instr & 0xfc00) === 0x4400) {
      return liftHiReg(cb, instr, pcPlus4);
    }
    // Fmt 6 (PC-rel load), Fmt 7 (reg offset), Fmt 8 (sign-ext): bail to interpreter.
    return { status: 'bail' };
  }

  // ---- Fmt 9: load/store word/byte immediate offset (top == 0b011) ----
  if (top === 0b011) {
    const byte = (instr & 0x1000) !== 0;
    const load = (instr & 0x0800) !== 0;
    const off = (instr >>> 6) & 0x1f;
    const rb = (instr >>> 3) & 7;
    const rd = instr & 7;
    // Decide bail BEFORE emitting any code: a lifter that emits WASM and then returns 'bail' leaves
    // dead, half-finished code in the shared block CodeBuilder. Word LDR needs unaligned-rotation
    // semantics we don't model natively, so it must bail with ZERO prior emission.
    if (load && !byte) return { status: 'bail' }; // word LDR: unaligned rotation safety
    // addr = Rb + (byte ? off : off<<2)
    loadReg(cb, rb);
    cb.i32_const(byte ? off : (off << 2));
    cb.op(OP.i32_add).local_set(L_A);
    if (load) {
      // LDRB: Rd = read8(addr)
      cb.local_get(L_A).call(HOST.read8);
      storeRegFromStack(cb, rd);
    } else {
      if (byte) {
        cb.local_get(L_A); loadReg(cb, rd); cb.call(HOST.write8);
      } else {
        // STR word: store aligned word (addr & ~3). Interpreter masks: write32(addr & ~3, ...)
        cb.local_get(L_A).i32_const(~3).op(OP.i32_and);
        loadReg(cb, rd);
        cb.call(HOST.write32);
      }
    }
    return { status: 'ok' };
  }

  // ---- Fmt 10/11 (top == 0b100) ----
  if (top === 0b100) {
    if ((instr & 0xf000) === 0x8000) {
      // Fmt 10: load/store halfword, immediate offset.
      const load = (instr & 0x0800) !== 0;
      const off = ((instr >>> 6) & 0x1f) << 1;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      loadReg(cb, rb).i32_const(off).op(OP.i32_add).i32_const(~1).op(OP.i32_and).local_set(L_A);
      if (load) {
        cb.local_get(L_A).call(HOST.read16);
        storeRegFromStack(cb, rd);
      } else {
        cb.local_get(L_A); loadReg(cb, rd); cb.call(HOST.write16);
      }
      return { status: 'ok' };
    }
    // Fmt 11: SP-relative load/store word.
    const load = (instr & 0x0800) !== 0;
    const rd = (instr >>> 8) & 7;
    const off = (instr & 0xff) << 2;
    // Bail BEFORE emitting: SP-relative word LDR needs rotation semantics we don't model natively.
    if (load) return { status: 'bail' }; // word LDR rotation safety
    loadReg(cb, 13).i32_const(off).op(OP.i32_add).local_set(L_A);
    cb.local_get(L_A).i32_const(~3).op(OP.i32_and);
    loadReg(cb, rd);
    cb.call(HOST.write32);
    return { status: 'ok' };
  }

  // ---- Fmt 12/13 (top == 0b101) ----
  if (top === 0b101) {
    if ((instr & 0xf000) === 0xa000) {
      // Fmt 12: load address. Rd = (sp ? SP : (PC&~3)) + (imm8<<2)
      const sp = (instr & 0x0800) !== 0;
      const rd = (instr >>> 8) & 7;
      const off = (instr & 0xff) << 2;
      if (sp) {
        loadReg(cb, 13).i32_const(off).op(OP.i32_add).local_set(L_RES);
      } else {
        // (PC+4 already) & ~3 then + off. Interpreter uses (r15+2)&~3 because its r15 holds pc+2.
        // Here pc+4 is the architectural PC read; (pc+4)&~3 matches ((r15(=pc+2)+2)&~3).
        cb.i32_const(((pcPlus4) & ~3) >>> 0).i32_const(off).op(OP.i32_add).local_set(L_RES);
      }
      storeRegFromLocal(cb, rd, L_RES);
      return { status: 'ok' };
    }
    // Fmt 13: add offset to SP (0xB000), or PUSH/POP (0xB400) -> bail.
    if ((instr & 0xff00) === 0xb000) {
      const off = (instr & 0x7f) << 2;
      const sub = (instr & 0x80) !== 0;
      loadReg(cb, 13).i32_const(off).op(sub ? OP.i32_sub : OP.i32_add).local_set(L_RES);
      storeRegFromLocal(cb, 13, L_RES);
      return { status: 'ok' };
    }
    // PUSH/POP and other misc -> bail.
    return { status: 'bail' };
  }

  // ---- Fmt 14/15/16/17 (top == 0b110) ----
  if (top === 0b110) {
    if ((instr & 0xf000) === 0xc000) {
      // Fmt 15 LDM/STM -> bail (memory list).
      return { status: 'bail' };
    }
    // Fmt 16/17: conditional branch or SWI.
    const cond = (instr >>> 8) & 0xf;
    if (cond === 0xf) return { status: 'bail' }; // SWI
    if (cond === 0xe) return { status: 'bail' }; // undefined
    // Conditional branch: if (condPass) PC = (pc+4) + (signext(imm8)<<1); else PC = pc+2.
    let off = instr & 0xff;
    if (off & 0x80) off |= 0xffffff00;
    const taken = (pcPlus4 + (off << 1)) >>> 0;
    const notTaken = (pc + 2) >>> 0;
    // Emit: push condition (i32 0/1); if -> set PC=taken else PC=notTaken.
    emitCond(cb, cond);
    cb.if_();
    cb.i32_const(regOff(15)).i32_const(taken).i32_store(0);
    cb.else_();
    cb.i32_const(regOff(15)).i32_const(notTaken).i32_store(0);
    cb.end();
    return { status: 'endsBlock' };
  }

  // ---- Fmt 18/19 (top == 0b111): unconditional / long branch with link ----
  if (top === 0b111) {
    const sub = (instr >>> 11) & 0x1f;
    if (sub === 0b11100) {
      // Fmt 18: unconditional branch. PC = (pc+4) + (signext(imm11)<<1).
      let off = instr & 0x7ff;
      if (off & 0x400) off |= 0xfffff800;
      const target = (pcPlus4 + (off << 1)) >>> 0;
      cb.i32_const(regOff(15)).i32_const(target).i32_store(0);
      return { status: 'endsBlock', staticTarget: target };
    }
    if (sub === 0b11110) {
      // Fmt 19 high half: LR = (pc+4) + (signext(imm11)<<12). Does NOT end the block; the low
      // half follows immediately. We lift it and continue.
      let hi = (instr & 0x7ff) << 12;
      if (hi & 0x00400000) hi |= 0xff800000;
      const lr = (pcPlus4 + hi) >>> 0;
      cb.i32_const(regOff(14)).i32_const(lr).i32_store(0);
      return { status: 'ok' };
    }
    if (sub === 0b11111) {
      // Fmt 19 low half: temp = (pc+2)|1; PC = LR + (imm11<<1); LR = temp.
      const off = (instr & 0x7ff) << 1;
      const next = ((pc + 2) | 1) >>> 0;
      // PC = LR + off
      cb.i32_const(regOff(15));
      loadReg(cb, 14).i32_const(off).op(OP.i32_add);
      cb.i32_store(0);
      // LR = next
      cb.i32_const(regOff(14)).i32_const(next).i32_store(0);
      return { status: 'endsBlock', isCall: true };
    }
    return { status: 'bail' };
  }

  return { status: 'bail' };
}

/** Fmt 4 ALU reg. Returns ok/bail. Bails on ops needing shifter-carry edge cases we don't model. */
function liftAluReg(cb: CodeBuilder, instr: number): LiftResult {
  const op = (instr >>> 6) & 0xf;
  const rs = (instr >>> 3) & 7;
  const rd = instr & 7;
  // a = Rd, b = Rs
  const loadAB = () => { loadReg(cb, rd).local_set(L_A); loadReg(cb, rs).local_set(L_B); };

  switch (op) {
    case 0x0: // AND
      loadAB(); cb.local_get(L_A).local_get(L_B).op(OP.i32_and).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES); setNZfromLocal(cb, L_RES); return { status: 'ok' };
    case 0x1: // EOR
      loadAB(); cb.local_get(L_A).local_get(L_B).op(OP.i32_xor).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES); setNZfromLocal(cb, L_RES); return { status: 'ok' };
    case 0xc: // ORR
      loadAB(); cb.local_get(L_A).local_get(L_B).op(OP.i32_or).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES); setNZfromLocal(cb, L_RES); return { status: 'ok' };
    case 0xe: // BIC = a & ~b
      loadAB(); cb.local_get(L_A).local_get(L_B).i32_const(-1).op(OP.i32_xor).op(OP.i32_and).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES); setNZfromLocal(cb, L_RES); return { status: 'ok' };
    case 0xf: // MVN = ~b
      loadReg(cb, rs).i32_const(-1).op(OP.i32_xor).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES); setNZfromLocal(cb, L_RES); return { status: 'ok' };
    case 0x8: // TST = a & b, sets NZ only
      loadAB(); cb.local_get(L_A).local_get(L_B).op(OP.i32_and).local_set(L_RES);
      setNZfromLocal(cb, L_RES); return { status: 'ok' };
    case 0xa: // CMP = a - b ; NZCV, no writeback
      loadAB(); cb.local_get(L_A).local_get(L_B).op(OP.i32_sub).local_set(L_RES);
      setNZfromLocal(cb, L_RES);
      setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).local_get(L_B).op(OP.i32_ge_u));
      setFlagWord(cb, OFF_VF, (b) => {
        b.local_get(L_A).local_get(L_B).op(OP.i32_xor);
        b.local_get(L_A).local_get(L_RES).op(OP.i32_xor);
        b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
      });
      return { status: 'ok' };
    case 0xb: // CMN = a + b ; NZCV, no writeback
      loadAB(); cb.local_get(L_A).local_get(L_B).op(OP.i32_add).local_set(L_RES);
      setNZfromLocal(cb, L_RES);
      setFlagWord(cb, OFF_CF, (b) => b.local_get(L_RES).local_get(L_A).op(OP.i32_lt_u));
      setFlagWord(cb, OFF_VF, (b) => {
        b.local_get(L_A).local_get(L_B).op(OP.i32_xor).i32_const(-1).op(OP.i32_xor);
        b.local_get(L_A).local_get(L_RES).op(OP.i32_xor);
        b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
      });
      return { status: 'ok' };
    case 0xd: // MUL = a * b ; sets NZ only (matches interpreter setNZ)
      loadAB(); cb.local_get(L_A).local_get(L_B).op(OP.i32_mul).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES); setNZfromLocal(cb, L_RES); return { status: 'ok' };
    case 0x9: // NEG = 0 - b. Interpreter: C = (b==0), V = (b & res)>>31. (quirky; mirror exactly)
      loadReg(cb, rs).local_set(L_B);
      cb.i32_const(0).local_get(L_B).op(OP.i32_sub).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES); setNZfromLocal(cb, L_RES);
      setFlagWord(cb, OFF_CF, (b) => b.local_get(L_B).op(OP.i32_eqz));
      setFlagWord(cb, OFF_VF, (b) => {
        b.local_get(L_B).local_get(L_RES).op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
      });
      return { status: 'ok' };
    // 0x2 LSL, 0x3 LSR, 0x4 ASR, 0x7 ROR (register-amount shifts), 0x5 ADC, 0x6 SBC:
    // these need full register-amount shifter-carry / carry-in modeling. Bail to interpreter.
    default:
      return { status: 'bail' };
  }
}

/** Fmt 5 hi-register ADD/CMP/MOV. Bails on BX and any PC (r15) operand/dest. */
function liftHiReg(cb: CodeBuilder, instr: number, pcPlus4: number): LiftResult {
  const op = (instr >>> 8) & 3;
  const h1 = (instr & 0x80) !== 0;
  const h2 = (instr & 0x40) !== 0;
  let rs = (instr >>> 3) & 7;
  let rd = instr & 7;
  if (h1) rd += 8;
  if (h2) rs += 8;
  if (op === 3) return { status: 'bail' }; // BX -> interpreter (mode switch)
  // If PC is involved, the interpreter does special masking / pipeline effects. Bail for safety.
  if (rd === 15 || rs === 15) return { status: 'bail' };
  switch (op) {
    case 0: // ADD (no flags)
      loadReg(cb, rd).local_set(L_A);
      loadReg(cb, rs).local_set(L_B);
      cb.local_get(L_A).local_get(L_B).op(OP.i32_add).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES);
      return { status: 'ok' };
    case 1: { // CMP (NZCV, no writeback)
      loadReg(cb, rd).local_set(L_A);
      loadReg(cb, rs).local_set(L_B);
      cb.local_get(L_A).local_get(L_B).op(OP.i32_sub).local_set(L_RES);
      setNZfromLocal(cb, L_RES);
      setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).local_get(L_B).op(OP.i32_ge_u));
      setFlagWord(cb, OFF_VF, (b) => {
        b.local_get(L_A).local_get(L_B).op(OP.i32_xor);
        b.local_get(L_A).local_get(L_RES).op(OP.i32_xor);
        b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
      });
      return { status: 'ok' };
    }
    case 2: // MOV (no flags)
      loadReg(cb, rs).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES);
      return { status: 'ok' };
  }
  return { status: 'bail' };
}

/**
 * Emit a condition test: pushes i32 1 if the condition passes else 0, based on the exploded flag
 * words (NF/ZF/CF/VF in linear memory). Mirrors thumb_core condPass exactly.
 */
function emitCond(cb: CodeBuilder, cond: number) {
  const N = () => cb.i32_const(OFF_NF).i32_load(0);
  const Z = () => cb.i32_const(OFF_ZF).i32_load(0);
  const C = () => cb.i32_const(OFF_CF).i32_load(0);
  const V = () => cb.i32_const(OFF_VF).i32_load(0);
  switch (cond) {
    case 0x0: Z(); break;                              // EQ: Z
    case 0x1: Z(); cb.op(OP.i32_eqz); break;           // NE: !Z
    case 0x2: C(); break;                              // CS: C
    case 0x3: C(); cb.op(OP.i32_eqz); break;           // CC: !C
    case 0x4: N(); break;                              // MI: N
    case 0x5: N(); cb.op(OP.i32_eqz); break;           // PL: !N
    case 0x6: V(); break;                              // VS: V
    case 0x7: V(); cb.op(OP.i32_eqz); break;           // VC: !V
    case 0x8: C(); Z().op(OP.i32_eqz); cb.op(OP.i32_and); break; // HI: C && !Z
    case 0x9: C().op(OP.i32_eqz); Z(); cb.op(OP.i32_or); break;  // LS: !C || Z
    case 0xa: N(); V(); cb.op(OP.i32_eq); break;        // GE: N == V
    case 0xb: N(); V(); cb.op(OP.i32_ne); break;        // LT: N != V
    case 0xc: // GT: !Z && (N==V)
      Z().op(OP.i32_eqz);
      N(); V(); cb.op(OP.i32_eq);
      cb.op(OP.i32_and);
      break;
    case 0xd: // LE: Z || (N!=V)
      Z();
      N(); V(); cb.op(OP.i32_ne);
      cb.op(OP.i32_or);
      break;
    default: cb.i32_const(1); break;                   // AL
  }
}
