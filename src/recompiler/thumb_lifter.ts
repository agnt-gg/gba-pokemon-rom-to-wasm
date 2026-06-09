/**
 * THUMB -> WASM lifter.
 *
 * THUMB is the 16-bit instruction set that dominates Pokemon Gen 3 code. Porting the hot THUMB
 * formats to native WebAssembly is the single biggest lever for native coverage.
 *
 * Same contract as the ARM lifter:
 *   - ok:        instruction lifted to native WASM.
 *   - endsBlock: control-flow boundary (branch); block ends after it.
 *   - bail:      not lifted yet; block stops BEFORE it and the interpreter resumes.
 *                (The block builder snapshots/truncates the CodeBuilder around every lift, so a
 *                 lifter MAY bail after partial emission - the bytes are rolled back.)
 *
 * Correctness rules we honor exactly (matching thumb_core.ts):
 *   - PC reads as instr+4 in THUMB mode (we materialize the constant where needed).
 *   - Most THUMB data-processing ALWAYS sets N/Z (and many set C/V). There is no S-bit.
 *   - setNZ in the interpreter sets ONLY N and Z; C/V are left to the specific op. We mirror that.
 *   - Word LDR uses ARM's unaligned-rotation semantics: rotr(read32(addr&~3), 8*(addr&3)).
 *   - Flags are kept as exploded i32 words (OFF_NF/ZF/CF/VF). The runtime syncs them to/from CPSR.
 *   - BX / POP{pc} update the CPSR T bit IN LINEAR MEMORY (OFF_CPSR); syncOut carries it to the
 *     interpreter state so the dispatcher picks the right mode for the next block.
 *
 * Natively lifted (everything the interpreter supports except SWI/undefined):
 *   Fmt 1  : LSL/LSR/ASR by immediate
 *   Fmt 2  : ADD/SUB register or imm3 (sets NZCV)
 *   Fmt 3  : MOV/CMP/ADD/SUB imm8 (sets flags)
 *   Fmt 4  : FULL ALU reg set incl. ADC/SBC and LSL/LSR/ASR/ROR by register
 *   Fmt 5  : hi-reg ADD/CMP/MOV incl. PC operands/dest, and BX (mode switch via CPSR T bit)
 *   Fmt 6  : PC-relative load, with ROM literal-pool CONSTANT FOLDING (zero host calls)
 *   Fmt 7  : load/store word/byte, register offset (word load uses native rotation)
 *   Fmt 8  : STRH/LDRH/LDRSB/LDRSH register offset
 *   Fmt 9  : load/store word/byte, immediate offset (word load uses native rotation)
 *   Fmt 10 : load/store halfword, immediate offset
 *   Fmt 11 : SP-relative load/store word (word load uses native rotation)
 *   Fmt 12 : load address (ADD Rd, PC/SP, #imm)
 *   Fmt 13 : add offset to SP
 *   Fmt 14 : PUSH/POP incl. POP {..., pc} (ends block, updates T bit like the interpreter)
 *   Fmt 15 : LDMIA/STMIA incl. the empty-rlist quirk
 *   Fmt 16 : conditional branch  (ends block)
 *   Fmt 18 : unconditional branch (ends block)
 *   Fmt 19 : long branch with link, both halves (ends block on the low half)
 *
 * Still bails: SWI (Fmt 17), undefined encodings.
 */

import { CodeBuilder, OP, I32 } from './wasm_encoder.ts';
import { regOff, OFF_NF, OFF_ZF, OFF_CF, OFF_VF, OFF_CPSR, HOST } from './abi.ts';
import type { LiftResult, LiftCtx } from './arm_lifter.ts';

// Reserved locals inside every block function (declared by the block builder):
//   local 0: tmpA, 1: tmpB, 2: tmpRes, 3: tmpT (shared with the ARM lifter's RESERVED_LOCALS)
const L_A = 0, L_B = 1, L_RES = 2, L_T = 3;

const FLAG_T_BIT = 0x20;

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

/** Push the ARM7 rotated unaligned word read for the address in `addrLocal`:
 *  rotr(read32(addr & ~3), 8 * (addr & 3)). rotr by 0 is the identity, so this is branchless. */
function emitLdrWord(cb: CodeBuilder, addrLocal: number) {
  cb.local_get(addrLocal).i32_const(-4).op(OP.i32_and).call(HOST.read32);
  cb.local_get(addrLocal).i32_const(3).op(OP.i32_and).i32_const(3).op(OP.i32_shl);
  cb.op(OP.i32_rotr);
}

/** [OFF_CPSR] = ([OFF_CPSR] & ~T) | ((v&1) << 5) where v is in `local`. Mirrors interpreter BX/POP-pc. */
function emitSetThumbBitFromLocal(cb: CodeBuilder, local: number) {
  cb.i32_const(OFF_CPSR);
  cb.i32_const(OFF_CPSR).i32_load(0).i32_const(~FLAG_T_BIT).op(OP.i32_and);
  cb.local_get(local).i32_const(1).op(OP.i32_and).i32_const(5).op(OP.i32_shl);
  cb.op(OP.i32_or);
  cb.i32_store(0);
}

/** Sign-extend the i32 on the stack from `bits` to 32. */
function emitSignExt(cb: CodeBuilder, bits: number) {
  cb.i32_const(32 - bits).op(OP.i32_shl).i32_const(32 - bits).op(OP.i32_shr_s);
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

export function liftThumb(cb: CodeBuilder, instr: number, pc: number, ctx?: LiftCtx): LiftResult {
  const pcPlus4 = (pc + 4) >>> 0;
  const top = instr >>> 13;
  if (disabled(top)) return { status: 'bail', reason: 'disabled' };

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
      return liftHiReg(cb, instr, pc, pcPlus4);
    }
    // Fmt 6: PC-relative load. addr = ((pc+4) & ~3) + imm8*4 -- a compile-time constant.
    if ((instr & 0xf800) === 0x4800) {
      const rd = (instr >>> 8) & 7;
      const off = (instr & 0xff) << 2;
      const addr = (((pcPlus4) & ~3) + off) >>> 0;
      // ROM is immutable: fold the literal-pool value into an i32.const (zero host calls).
      const folded = ctx?.romRead32 ? ctx.romRead32(addr & ~3) : null;
      if (folded !== null && folded !== undefined) {
        cb.i32_const(folded | 0);
        storeRegFromStack(cb, rd);
        return { status: 'ok' };
      }
      // Interpreter does a plain read32(addr & ~3) (no rotation; addr is word-aligned).
      cb.i32_const((addr & ~3) | 0).call(HOST.read32);
      storeRegFromStack(cb, rd);
      return { status: 'ok', mayLoad: true };
    }
    // Fmt 7 (bit9==0): load/store word/byte with register offset.
    if ((instr & 0x0200) === 0) {
      const load = (instr & 0x0800) !== 0;
      const byte = (instr & 0x0400) !== 0;
      const ro = (instr >>> 6) & 7;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      loadReg(cb, rb); loadReg(cb, ro); cb.op(OP.i32_add).local_set(L_A);
      if (load) {
        if (byte) { cb.local_get(L_A).call(HOST.read8); }
        else { emitLdrWord(cb, L_A); }
        storeRegFromStack(cb, rd);
        return { status: 'ok', mayLoad: true };
      }
      if (byte) { cb.local_get(L_A); loadReg(cb, rd); cb.call(HOST.write8); }
      else { cb.local_get(L_A).i32_const(-4).op(OP.i32_and); loadReg(cb, rd); cb.call(HOST.write32); }
      return { status: 'ok', mayStore: true };
    }
    // Fmt 8: STRH/LDRH/LDRSB/LDRSH with register offset.
    {
      const h = (instr & 0x0800) !== 0;
      const s = (instr & 0x0400) !== 0;
      const ro = (instr >>> 6) & 7;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      loadReg(cb, rb); loadReg(cb, ro); cb.op(OP.i32_add).local_set(L_A);
      if (!s && !h) { // STRH
        cb.local_get(L_A).i32_const(-2).op(OP.i32_and); loadReg(cb, rd); cb.call(HOST.write16);
        return { status: 'ok', mayStore: true };
      }
      if (!s && h) { // LDRH
        cb.local_get(L_A).i32_const(-2).op(OP.i32_and).call(HOST.read16);
        storeRegFromStack(cb, rd);
        return { status: 'ok', mayLoad: true };
      }
      if (s && !h) { // LDRSB
        cb.local_get(L_A).call(HOST.read8);
        emitSignExt(cb, 8);
        storeRegFromStack(cb, rd);
        return { status: 'ok', mayLoad: true };
      }
      // LDRSH (interpreter: read16(addr & ~1), sign-extend 16)
      cb.local_get(L_A).i32_const(-2).op(OP.i32_and).call(HOST.read16);
      emitSignExt(cb, 16);
      storeRegFromStack(cb, rd);
      return { status: 'ok', mayLoad: true };
    }
  }

  // ---- Fmt 9: load/store word/byte immediate offset (top == 0b011) ----
  if (top === 0b011) {
    const byte = (instr & 0x1000) !== 0;
    const load = (instr & 0x0800) !== 0;
    const off = (instr >>> 6) & 0x1f;
    const rb = (instr >>> 3) & 7;
    const rd = instr & 7;
    // addr = Rb + (byte ? off : off<<2)
    loadReg(cb, rb);
    cb.i32_const(byte ? off : (off << 2));
    cb.op(OP.i32_add).local_set(L_A);
    if (load) {
      if (byte) { cb.local_get(L_A).call(HOST.read8); }
      else { emitLdrWord(cb, L_A); } // ARM7 unaligned rotation, natively
      storeRegFromStack(cb, rd);
      return { status: 'ok', mayLoad: true };
    }
    if (byte) {
      cb.local_get(L_A); loadReg(cb, rd); cb.call(HOST.write8);
    } else {
      // STR word: store aligned word (addr & ~3). Interpreter masks: write32(addr & ~3, ...)
      cb.local_get(L_A).i32_const(-4).op(OP.i32_and);
      loadReg(cb, rd);
      cb.call(HOST.write32);
    }
    return { status: 'ok', mayStore: true };
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
        return { status: 'ok', mayLoad: true };
      }
      cb.local_get(L_A); loadReg(cb, rd); cb.call(HOST.write16);
      return { status: 'ok', mayStore: true };
    }
    // Fmt 11: SP-relative load/store word.
    const load = (instr & 0x0800) !== 0;
    const rd = (instr >>> 8) & 7;
    const off = (instr & 0xff) << 2;
    loadReg(cb, 13).i32_const(off).op(OP.i32_add).local_set(L_A);
    if (load) {
      emitLdrWord(cb, L_A); // ARM7 unaligned rotation, natively
      storeRegFromStack(cb, rd);
      return { status: 'ok', mayLoad: true };
    }
    cb.local_get(L_A).i32_const(-4).op(OP.i32_and);
    loadReg(cb, rd);
    cb.call(HOST.write32);
    return { status: 'ok', mayStore: true };
  }

  // ---- Fmt 12/13/14 (top == 0b101) ----
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
        cb.i32_const(((pcPlus4) & ~3) >>> 0).i32_const(off).op(OP.i32_add).local_set(L_RES);
      }
      storeRegFromLocal(cb, rd, L_RES);
      return { status: 'ok' };
    }
    // Fmt 13: add offset to SP (0xB000)
    if ((instr & 0xff00) === 0xb000) {
      const off = (instr & 0x7f) << 2;
      const sub = (instr & 0x80) !== 0;
      loadReg(cb, 13).i32_const(off).op(sub ? OP.i32_sub : OP.i32_add).local_set(L_RES);
      storeRegFromLocal(cb, 13, L_RES);
      return { status: 'ok' };
    }
    // Fmt 14: PUSH/POP (1011 x10x xxxx xxxx)
    if ((instr & 0xf600) === 0xb400) {
      const load = (instr & 0x0800) !== 0;
      const pcLr = (instr & 0x0100) !== 0;
      const list = instr & 0xff;
      if (load) {
        // POP: loads ascending from SP; optional PC slot last; SP advances past all slots.
        loadReg(cb, 13).local_set(L_A);
        let k = 0;
        for (let i = 0; i < 8; i++) {
          if (!(list & (1 << i))) continue;
          cb.i32_const(regOff(i));
          cb.local_get(L_A).i32_const(k * 4).op(OP.i32_add).i32_const(-4).op(OP.i32_and).call(HOST.read32);
          cb.i32_store(0);
          k++;
        }
        if (pcLr) {
          // v = read32(sp_k); T = v&1 (interpreter updates CPSR T); PC = v & ~1.
          cb.local_get(L_A).i32_const(k * 4).op(OP.i32_add).i32_const(-4).op(OP.i32_and).call(HOST.read32).local_set(L_B);
          k++;
          emitSetThumbBitFromLocal(cb, L_B);
          cb.i32_const(regOff(15));
          cb.local_get(L_B).i32_const(-2).op(OP.i32_and);
          cb.i32_store(0);
        }
        // SP = sp + 4k
        cb.i32_const(regOff(13));
        cb.local_get(L_A).i32_const(k * 4).op(OP.i32_add);
        cb.i32_store(0);
        if (pcLr) return { status: 'endsBlock', mayLoad: true };
        return { status: 'ok', mayLoad: true };
      }
      // PUSH: sp_new = sp - 4*count; stores ascending from sp_new; optional LR last; SP = sp_new.
      let count = 0;
      for (let i = 0; i < 8; i++) if (list & (1 << i)) count++;
      if (pcLr) count++;
      if (count === 0) return { status: 'bail', reason: 'push-empty' };
      loadReg(cb, 13).i32_const(count * 4).op(OP.i32_sub).local_set(L_A);
      let k = 0;
      for (let i = 0; i < 8; i++) {
        if (!(list & (1 << i))) continue;
        cb.local_get(L_A).i32_const(k * 4).op(OP.i32_add).i32_const(-4).op(OP.i32_and);
        loadReg(cb, i);
        cb.call(HOST.write32);
        k++;
      }
      if (pcLr) {
        cb.local_get(L_A).i32_const(k * 4).op(OP.i32_add).i32_const(-4).op(OP.i32_and);
        loadReg(cb, 14);
        cb.call(HOST.write32);
      }
      storeRegFromLocal(cb, 13, L_A);
      return { status: 'ok', mayStore: true };
    }
    return { status: 'bail', reason: 'misc-b' };
  }

  // ---- Fmt 15/16/17 (top == 0b110) ----
  if (top === 0b110) {
    if ((instr & 0xf000) === 0xc000) {
      // Fmt 15: LDMIA/STMIA Rb!, {rlist}
      const load = (instr & 0x0800) !== 0;
      const rb = (instr >>> 8) & 7;
      const list = instr & 0xff;
      loadReg(cb, rb).local_set(L_A);
      if (list === 0) {
        // Empty rlist quirk (mirrors interpreter): transfers PC, base += 0x40.
        if (load) {
          cb.i32_const(regOff(15));
          cb.local_get(L_A).i32_const(-4).op(OP.i32_and).call(HOST.read32).i32_const(-2).op(OP.i32_and);
          cb.i32_store(0);
          cb.i32_const(regOff(rb));
          cb.local_get(L_A).i32_const(0x40).op(OP.i32_add);
          cb.i32_store(0);
          return { status: 'endsBlock', mayLoad: true };
        }
        cb.local_get(L_A).i32_const(-4).op(OP.i32_and);
        cb.i32_const(pcPlus4 | 0);
        cb.call(HOST.write32);
        cb.i32_const(regOff(rb));
        cb.local_get(L_A).i32_const(0x40).op(OP.i32_add);
        cb.i32_store(0);
        return { status: 'ok', mayStore: true };
      }
      let k = 0;
      for (let i = 0; i < 8; i++) {
        if (!(list & (1 << i))) continue;
        if (load) {
          cb.i32_const(regOff(i));
          cb.local_get(L_A).i32_const(k * 4).op(OP.i32_add).i32_const(-4).op(OP.i32_and).call(HOST.read32);
          cb.i32_store(0);
        } else {
          cb.local_get(L_A).i32_const(k * 4).op(OP.i32_add).i32_const(-4).op(OP.i32_and);
          loadReg(cb, i);
          cb.call(HOST.write32);
        }
        k++;
      }
      // Writeback unless loading rb itself (mirrors interpreter).
      if (!(load && (list & (1 << rb)))) {
        cb.i32_const(regOff(rb));
        cb.local_get(L_A).i32_const(k * 4).op(OP.i32_add);
        cb.i32_store(0);
      }
      return load ? { status: 'ok', mayLoad: true } : { status: 'ok', mayStore: true };
    }
    // Fmt 16/17: conditional branch or SWI.
    const cond = (instr >>> 8) & 0xf;
    if (cond === 0xf) return { status: 'bail', reason: 'swi' }; // SWI
    if (cond === 0xe) return { status: 'bail', reason: 'undef' }; // undefined
    // Conditional branch: if (condPass) PC = (pc+4) + (signext(imm8)<<1); else PC = pc+2.
    let off = instr & 0xff;
    if (off & 0x80) off |= 0xffffff00;
    const taken = (pcPlus4 + (off << 1)) >>> 0;
    const notTaken = (pc + 2) >>> 0;
    emitCond(cb, cond);
    cb.if_();
    cb.i32_const(regOff(15)).i32_const(taken | 0).i32_store(0);
    cb.else_();
    cb.i32_const(regOff(15)).i32_const(notTaken | 0).i32_store(0);
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
      cb.i32_const(regOff(15)).i32_const(target | 0).i32_store(0);
      return { status: 'endsBlock', staticTarget: target };
    }
    if (sub === 0b11110) {
      // Fmt 19 high half: LR = (pc+4) + (signext(imm11)<<12). Does NOT end the block.
      let hi = (instr & 0x7ff) << 12;
      if (hi & 0x00400000) hi |= 0xff800000;
      const lr = (pcPlus4 + hi) >>> 0;
      cb.i32_const(regOff(14)).i32_const(lr | 0).i32_store(0);
      return { status: 'ok' };
    }
    if (sub === 0b11111) {
      // Fmt 19 low half: temp = (pc+2)|1; PC = LR + (imm11<<1); LR = temp.
      const off = (instr & 0x7ff) << 1;
      const next = ((pc + 2) | 1) >>> 0;
      cb.i32_const(regOff(15));
      loadReg(cb, 14).i32_const(off).op(OP.i32_add);
      cb.i32_store(0);
      cb.i32_const(regOff(14)).i32_const(next | 0).i32_store(0);
      return { status: 'endsBlock', isCall: true };
    }
    return { status: 'bail', reason: 'fmt19-blx' };
  }

  return { status: 'bail', reason: 'undecoded' };
}

/** Fmt 4 ALU reg. Now lifts the FULL set incl. ADC/SBC and register-amount shifts. */
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
    case 0x5: { // ADC: res = a + b + cin; C = carry out of 33-bit sum; V = signed overflow.
      loadAB();
      // t = a + b ; res = t + cin
      cb.local_get(L_A).local_get(L_B).op(OP.i32_add).local_set(L_T);
      cb.local_get(L_T).i32_const(OFF_CF).i32_load(0).op(OP.i32_add).local_set(L_RES);
      // C = (t <u a) | (res <u t)   (two-step carry detection, exact for a+b+cin)
      setFlagWord(cb, OFF_CF, (b) => {
        b.local_get(L_T).local_get(L_A).op(OP.i32_lt_u);
        b.local_get(L_RES).local_get(L_T).op(OP.i32_lt_u);
        b.op(OP.i32_or);
      });
      // V = (~(a^b) & (a^res)) >> 31
      setFlagWord(cb, OFF_VF, (b) => {
        b.local_get(L_A).local_get(L_B).op(OP.i32_xor).i32_const(-1).op(OP.i32_xor);
        b.local_get(L_A).local_get(L_RES).op(OP.i32_xor);
        b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
      });
      storeRegFromLocal(cb, rd, L_RES);
      setNZfromLocal(cb, L_RES);
      return { status: 'ok' };
    }
    case 0x6: { // SBC: res = a - b - (1-cin); C = a >= b+(1-cin) === (a>b) | ((a==b)&cin); V = sub overflow.
      loadAB();
      // res = a - b - 1 + cin
      cb.local_get(L_A).local_get(L_B).op(OP.i32_sub).i32_const(1).op(OP.i32_sub)
        .i32_const(OFF_CF).i32_load(0).op(OP.i32_add).local_set(L_RES);
      setFlagWord(cb, OFF_CF, (b) => {
        b.local_get(L_A).local_get(L_B).op(OP.i32_gt_u);
        b.local_get(L_A).local_get(L_B).op(OP.i32_eq);
        b.i32_const(OFF_CF).i32_load(0);
        b.op(OP.i32_and);
        b.op(OP.i32_or);
      });
      setFlagWord(cb, OFF_VF, (b) => {
        b.local_get(L_A).local_get(L_B).op(OP.i32_xor);
        b.local_get(L_A).local_get(L_RES).op(OP.i32_xor);
        b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
      });
      storeRegFromLocal(cb, rd, L_RES);
      setNZfromLocal(cb, L_RES);
      return { status: 'ok' };
    }
    case 0x2: // LSL by register
    case 0x3: // LSR by register
    case 0x4: // ASR by register
    case 0x7: { // ROR by register
      const kind = op === 0x2 ? 0 : op === 0x3 ? 1 : op === 0x4 ? 2 : 3;
      loadReg(cb, rd).local_set(L_A);
      loadReg(cb, rs).i32_const(0xff).op(OP.i32_and).local_set(L_B);
      emitShiftByReg(cb, kind);
      storeRegFromLocal(cb, rd, L_RES);
      setNZfromLocal(cb, L_RES);
      return { status: 'ok' };
    }
    default:
      return { status: 'bail', reason: 'alu-unknown' };
  }
}

/**
 * Register-amount shift (barrel.ts shiftReg semantics). a in L_A, amount (0..255) in L_B.
 * Result -> L_RES. OFF_CF updated exactly like the interpreter (unchanged when amount==0).
 * kind: 0=LSL 1=LSR 2=ASR 3=ROR
 */
function emitShiftByReg(cb: CodeBuilder, kind: number) {
  // if (amount == 0) { res = a; C unchanged }
  cb.local_get(L_B).op(OP.i32_eqz);
  cb.if_();
  cb.local_get(L_A).local_set(L_RES);
  cb.else_();
  if (kind === 0 || kind === 1) {
    const shiftOp = kind === 0 ? OP.i32_shl : OP.i32_shr_u;
    // amount < 32 ?
    cb.local_get(L_B).i32_const(32).op(OP.i32_lt_u);
    cb.if_();
    cb.local_get(L_A).local_get(L_B).op(shiftOp).local_set(L_RES);
    // C = bit out: LSL -> (a >>> (32-amt)) & 1 ; LSR -> (a >>> (amt-1)) & 1
    setFlagWord(cb, OFF_CF, (b) => {
      if (kind === 0) b.local_get(L_A).i32_const(32).local_get(L_B).op(OP.i32_sub).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and);
      else b.local_get(L_A).local_get(L_B).i32_const(1).op(OP.i32_sub).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and);
    });
    cb.else_();
    // amount == 32 ?
    cb.local_get(L_B).i32_const(32).op(OP.i32_eq);
    cb.if_();
    cb.i32_const(0).local_set(L_RES);
    setFlagWord(cb, OFF_CF, (b) => {
      if (kind === 0) b.local_get(L_A).i32_const(1).op(OP.i32_and);            // LSL#32: C = bit0
      else b.local_get(L_A).i32_const(31).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and); // LSR#32: C = bit31
    });
    cb.else_();
    // amount > 32: res = 0, C = 0
    cb.i32_const(0).local_set(L_RES);
    setFlagWord(cb, OFF_CF, (b) => b.i32_const(0));
    cb.end();
    cb.end();
  } else if (kind === 2) {
    // ASR: amount < 32 -> shr_s; >= 32 -> sign fill, C = bit31.
    cb.local_get(L_B).i32_const(32).op(OP.i32_lt_u);
    cb.if_();
    cb.local_get(L_A).local_get(L_B).op(OP.i32_shr_s).local_set(L_RES);
    setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).local_get(L_B).i32_const(1).op(OP.i32_sub).op(OP.i32_shr_s).i32_const(1).op(OP.i32_and));
    cb.else_();
    cb.local_get(L_A).i32_const(31).op(OP.i32_shr_s).local_set(L_RES);
    setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).i32_const(31).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and));
    cb.end();
  } else {
    // ROR: t = amount & 31; t==0 -> res=a, C=bit31; else res=rotr(a,t), C=(a>>>(t-1))&1.
    cb.local_get(L_B).i32_const(31).op(OP.i32_and).local_set(L_T);
    cb.local_get(L_T).op(OP.i32_eqz);
    cb.if_();
    cb.local_get(L_A).local_set(L_RES);
    setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).i32_const(31).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and));
    cb.else_();
    cb.local_get(L_A).local_get(L_T).op(OP.i32_rotr).local_set(L_RES);
    setFlagWord(cb, OFF_CF, (b) => b.local_get(L_A).local_get(L_T).i32_const(1).op(OP.i32_sub).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and));
    cb.end();
  }
  cb.end();
}

/** Fmt 5 hi-register ADD/CMP/MOV/BX, including PC operands/destinations and the BX mode switch. */
function liftHiReg(cb: CodeBuilder, instr: number, pc: number, pcPlus4: number): LiftResult {
  const op = (instr >>> 8) & 3;
  const h1 = (instr & 0x80) !== 0;
  const h2 = (instr & 0x40) !== 0;
  let rs = (instr >>> 3) & 7;
  let rd = instr & 7;
  if (h1) rd += 8;
  if (h2) rs += 8;

  // readSrc(i): i==15 reads pc+4 (interpreter: r15(=pc+2)+2).
  const pushSrc = (b: CodeBuilder, i: number) => {
    if (i === 15) b.i32_const(pcPlus4 | 0);
    else loadReg(b, i);
  };

  if (op === 3) {
    // BX: addr = readSrc(rs). T = addr&1; PC = addr & (T ? ~1 : ~3). Mirrors interpreter exactly.
    pushSrc(cb, rs); cb.local_set(L_A);
    emitSetThumbBitFromLocal(cb, L_A);
    cb.local_get(L_A).i32_const(1).op(OP.i32_and);
    cb.if_();
    cb.i32_const(regOff(15));
    cb.local_get(L_A).i32_const(-2).op(OP.i32_and);
    cb.i32_store(0);
    cb.else_();
    cb.i32_const(regOff(15));
    cb.local_get(L_A).i32_const(-4).op(OP.i32_and);
    cb.i32_store(0);
    cb.end();
    return { status: 'endsBlock' };
  }

  switch (op) {
    case 0: { // ADD (no flags). rd==15: PC = ((pc+2) + src) & ~1 (interpreter reads raw r15 = pc+2).
      if (rd === 15) {
        cb.i32_const(regOff(15));
        cb.i32_const(((pc + 2) | 0));
        pushSrc(cb, rs);
        cb.op(OP.i32_add).i32_const(-2).op(OP.i32_and);
        cb.i32_store(0);
        return { status: 'endsBlock' };
      }
      loadReg(cb, rd).local_set(L_A);
      pushSrc(cb, rs); cb.local_set(L_B);
      cb.local_get(L_A).local_get(L_B).op(OP.i32_add).local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES);
      return { status: 'ok' };
    }
    case 1: { // CMP (NZCV, no writeback). a: rd==15 reads pc+4.
      if (rd === 15) cb.i32_const(pcPlus4 | 0).local_set(L_A);
      else loadReg(cb, rd).local_set(L_A);
      pushSrc(cb, rs); cb.local_set(L_B);
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
    case 2: { // MOV (no flags). rd==15: PC = src & ~1, ends block.
      if (rd === 15) {
        cb.i32_const(regOff(15));
        pushSrc(cb, rs);
        cb.i32_const(-2).op(OP.i32_and);
        cb.i32_store(0);
        return { status: 'endsBlock' };
      }
      pushSrc(cb, rs); cb.local_set(L_RES);
      storeRegFromLocal(cb, rd, L_RES);
      return { status: 'ok' };
    }
  }
  return { status: 'bail', reason: 'hireg-unknown' };
}

/**
 * Emit a condition test: pushes i32 1 if the condition passes else 0, based on the exploded flag
 * words (NF/ZF/CF/VF in linear memory). Mirrors thumb_core condPass exactly.
 */
export function emitCond(cb: CodeBuilder, cond: number) {
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
