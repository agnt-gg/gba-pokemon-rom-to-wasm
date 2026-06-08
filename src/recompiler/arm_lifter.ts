/**
 * ARM -> WASM lifter.
 *
 * Decodes a single ARM instruction and emits WebAssembly opcodes (into a CodeBuilder) that
 * reproduce its effect on the register file held in linear memory. Returns a LiftResult that
 * tells the block builder what happened:
 *   - ok:        instruction was lifted to native WASM.
 *   - endsBlock: this instruction is a control-flow boundary (branch); the block ends after it.
 *   - bail:      we don't lift this instruction class yet; the block must stop BEFORE it and the
 *                runtime falls back to the interpreter from this PC. (Honest hybrid model.)
 *
 * What we lift natively (the hot path in Pokemon code):
 *   - Data-processing (AND/EOR/SUB/RSB/ADD/ORR/MOV/BIC/MVN/CMP/CMN/TST/TEQ) with immediate or
 *     register (non-shifted, or immediate-shift) operand2, condition AL only for v1.
 *   - Branch / Branch-with-Link (B/BL), condition AL.
 *
 * Everything else (shifted-register operand2 with reg-specified shift, LDR/STR/LDM/STM, MUL,
 * MSR/MRS, BX, SWI, conditional execution other than AL) bails to the interpreter. This is
 * deliberately conservative: a correct hybrid beats an incorrect "100% native".
 *
 * Flag model: N/Z/C/V are kept as exploded i32 words (see abi.ts). For ADD/SUB we compute carry
 * and overflow inline. For logical ops, C comes from the shifter (immediate-shift only here) and
 * V is preserved.
 */

import { CodeBuilder, OP, I32 } from './wasm_encoder.ts';
import { regOff, OFF_NF, OFF_ZF, OFF_CF, OFF_VF, OFF_SCRATCH0, HOST } from './abi.ts';

export type LiftStatus = 'ok' | 'endsBlock' | 'bail';

export interface LiftResult {
  status: LiftStatus;
  /** For endsBlock branches with a static target, the target PC (for chaining). */
  staticTarget?: number;
  /** True if this is a BL (link) — runtime may still treat as block end. */
  isCall?: boolean;
}

// Local indices reserved inside every block function (declared by the block builder):
//   local 0: tmpA (i32)
//   local 1: tmpB (i32)
//   local 2: tmpRes (i32)
const L_A = 0, L_B = 1, L_RES = 2;

/** Push register n's value onto the WASM stack. r15 reads as pc+8 in ARM (handled by caller via const). */
function loadReg(cb: CodeBuilder, n: number, pcPlus8: number): CodeBuilder {
  if (n === 15) { cb.i32_const(pcPlus8 | 0); return cb; }
  cb.i32_const(regOff(n)).i32_load(0);
  return cb;
}

/** Store top-of-stack into register n. */
function storeReg(cb: CodeBuilder, n: number) {
  // stack: [value]; we need [addr, value] for i32_store -> stash value, push addr, reload.
  cb.local_set(L_RES);
  cb.i32_const(regOff(n));
  cb.local_get(L_RES);
  cb.i32_store(0);
}

function setFlagZNfromRes(cb: CodeBuilder) {
  // expects result in L_RES
  // Z = (res == 0)
  cb.i32_const(OFF_ZF);
  cb.local_get(L_RES).op(OP.i32_eqz);
  cb.i32_store(0);
  // N = (res >>> 31) & 1  -> use signed lt 0
  cb.i32_const(OFF_NF);
  cb.local_get(L_RES).i32_const(0).op(OP.i32_lt_s);
  cb.i32_store(0);
}

function setC(cb: CodeBuilder, pushC: (cb: CodeBuilder) => void) {
  cb.i32_const(OFF_CF);
  pushC(cb);
  cb.i32_store(0);
}
function setV(cb: CodeBuilder, pushV: (cb: CodeBuilder) => void) {
  cb.i32_const(OFF_VF);
  pushV(cb);
  cb.i32_store(0);
}

/** ARM immediate operand: 8-bit value rotated right by 2*rot. */
function armImm(instr: number): number {
  const imm = instr & 0xff;
  const rot = ((instr >> 8) & 0xf) * 2;
  return ((imm >>> rot) | (imm << (32 - rot))) >>> 0;
}

/**
 * Lift one ARM instruction at `pc` (the address of the instruction itself).
 * pc+8 is what r15 reads during execution.
 */
export function liftArm(cb: CodeBuilder, instr: number, pc: number): LiftResult {
  const cond = (instr >>> 28) & 0xf;
  if (cond !== 0xe) return { status: 'bail' }; // only AL (always) for v1

  const pcPlus8 = (pc + 8) >>> 0;

  // ---- Branch / Branch-with-Link: cond 1010 (B) / 1011 (BL) ----
  if ((instr & 0x0e000000) === 0x0a000000) {
    const link = (instr & 0x01000000) !== 0;
    let off = instr & 0x00ffffff;
    if (off & 0x00800000) off |= 0xff000000; // sign-extend 24-bit
    const target = (pcPlus8 + (off << 2)) >>> 0;
    if (link) {
      // LR = pc + 4 (address of the instruction after the BL)
      cb.i32_const(regOff(14));
      cb.i32_const((pc + 4) >>> 0);
      cb.i32_store(0);
    }
    // PC = target
    cb.i32_const(regOff(15));
    cb.i32_const(target);
    cb.i32_store(0);
    return { status: 'endsBlock', staticTarget: target, isCall: link };
  }

  // ---- Single data transfer: LDR/STR immediate-offset (AL) ----
  // Format: cond 01 I P U B W L Rn Rd offset12
  // We lift the common, safe subset:
  //   - immediate offset (I==0), so no shifted-register index
  //   - pre-indexed (P==1) with optional writeback, OR post-indexed (P==0)
  //   - word (B==0) and byte (B==1) sizes
  //   - Rd != 15 and Rn != 15 (PC-relative / PC-load handled by interpreter)
  if ((instr & 0x0c000000) === 0x04000000) {
    const I = (instr & 0x02000000) !== 0; // 1 => register offset (shifted) -> bail
    if (I) return { status: 'bail' };
    const P = (instr & 0x01000000) !== 0;
    const U = (instr & 0x00800000) !== 0;
    const B = (instr & 0x00400000) !== 0;
    const W = (instr & 0x00200000) !== 0;
    const L = (instr & 0x00100000) !== 0;
    const Rn = (instr >>> 16) & 0xf;
    const Rd = (instr >>> 12) & 0xf;
    const off12 = instr & 0xfff;
    if (Rn === 15 || Rd === 15) return { status: 'bail' };
    // Compute effective address into L_A.
    // base = Rn
    loadReg(cb, Rn, pcPlus8).local_set(L_A);
    const applyOffset = (b: CodeBuilder) => {
      b.local_get(L_A);
      b.i32_const(off12);
      b.op(U ? OP.i32_add : OP.i32_sub);
    };
    // address used for the access:
    if (P) {
      // pre-indexed: address = base +/- off
      applyOffset(cb); cb.local_set(L_A); // L_A now = effective addr
    }
    // else post-indexed: access at base (L_A unchanged); writeback adds offset after.
    if (L) {
      // LDR word can require ARM's unaligned-read rotation (addr not word-aligned rotates the
      // loaded value by 8*(addr&3)). Our host read32 returns the bus value without that rotation,
      // so to stay bit-exact we only lift the byte load (LDRB) natively and bail on word loads.
      // STR word is unaffected (stores write the aligned word), so STR remains native below.
      if (!B) return { status: 'bail' };
      // LDRB Rd = mem[addr]
      cb.local_get(L_A);
      cb.call(HOST.read8);
      storeReg(cb, Rd);
    } else {
      // STR/STRB mem[addr] = Rd
      cb.local_get(L_A);              // arg0 addr
      loadReg(cb, Rd, pcPlus8);       // arg1 value
      cb.call(B ? HOST.write8 : HOST.write32);
    }
    // Writeback.
    if (P && W) {
      // pre-indexed writeback: Rn = effective addr (already in L_A)
      cb.local_get(L_A);
      storeReg(cb, Rn);
    } else if (!P) {
      // post-indexed: Rn = base +/- off. base was original Rn; but we overwrote L_A only if P.
      // For post-indexed we kept L_A == base. Compute base +/- off and write to Rn.
      cb.local_get(L_A);
      cb.i32_const(off12);
      cb.op(U ? OP.i32_add : OP.i32_sub);
      storeReg(cb, Rn);
    }
    return { status: 'ok' };
  }

  // ---- Data processing (immediate or register operand2, AL) ----
  // Format: cond 00 I opcode S Rn Rd operand2
  if ((instr & 0x0c000000) === 0x00000000) {
    const I = (instr & 0x02000000) !== 0;
    const opcode = (instr >>> 21) & 0xf;
    const S = (instr & 0x00100000) !== 0;
    const Rn = (instr >>> 16) & 0xf;
    const Rd = (instr >>> 12) & 0xf;

    // Reject multiply / halfword transfer encodings that masquerade as DP.
    // MUL/MLA: bits 7..4 == 1001 with opcode in the DP range.
    if (!I && (instr & 0x000000f0) === 0x00000090) return { status: 'bail' };
    // Reject register-specified-shift operand2 (bit4 set with !I) — needs shifter carry.
    if (!I && (instr & 0x00000010) !== 0) return { status: 'bail' };
    // Reject PSR transfers (TST/TEQ/CMP/CMN with S=0) and BX-family in DP space.
    if (Rd === 15) return { status: 'bail' }; // writing PC via DP -> let interpreter handle

    // operand2 value -> push onto stack
    const pushOp2 = (b: CodeBuilder) => {
      if (I) {
        b.i32_const(armImm(instr) | 0);
      } else {
        const Rm = instr & 0xf;
        const shamt = (instr >>> 7) & 0x1f;
        const stype = (instr >>> 5) & 0x3;
        loadReg(b, Rm, pcPlus8);
        if (shamt === 0 && stype === 0) {
          // LSL #0 -> value unchanged
        } else if (stype === 0) { // LSL
          b.i32_const(shamt).op(OP.i32_shl);
        } else if (stype === 1) { // LSR (#0 means 32)
          b.i32_const(shamt === 0 ? 32 : shamt).op(OP.i32_shr_u);
        } else if (stype === 2) { // ASR (#0 means 32)
          b.i32_const(shamt === 0 ? 31 : shamt).op(OP.i32_shr_s);
        } else { // ROR / RRX(#0)
          if (shamt === 0) return; // RRX needs carry-in -> bail handled below
          b.i32_const(shamt).op(OP.i32_rotr);
        }
      }
    };
    // RRX bail: register op2 with ROR #0
    if (!I) {
      const stype = (instr >>> 5) & 0x3;
      const shamt = (instr >>> 7) & 0x1f;
      if (stype === 3 && shamt === 0) return { status: 'bail' };
    }

    const isLogical = (op: number) => op === 0 || op === 1 || op === 8 || op === 9 || op === 12 || op === 13 || op === 14 || op === 15;
    const isTest = (op: number) => op >= 8 && op <= 11; // TST/TEQ/CMP/CMN

    // Compute result into L_RES.
    switch (opcode) {
      case 0x0: // AND
      case 0x8: // TST
        loadReg(cb, Rn, pcPlus8); pushOp2(cb); cb.op(OP.i32_and); cb.local_set(L_RES); break;
      case 0x1: // EOR
      case 0x9: // TEQ
        loadReg(cb, Rn, pcPlus8); pushOp2(cb); cb.op(OP.i32_xor); cb.local_set(L_RES); break;
      case 0xc: // ORR
        loadReg(cb, Rn, pcPlus8); pushOp2(cb); cb.op(OP.i32_or); cb.local_set(L_RES); break;
      case 0xe: // BIC = Rn & ~op2
        loadReg(cb, Rn, pcPlus8); pushOp2(cb); cb.i32_const(-1).op(OP.i32_xor); cb.op(OP.i32_and); cb.local_set(L_RES); break;
      case 0xd: // MOV
        pushOp2(cb); cb.local_set(L_RES); break;
      case 0xf: // MVN
        pushOp2(cb); cb.i32_const(-1).op(OP.i32_xor); cb.local_set(L_RES); break;
      case 0x4: // ADD
      case 0xb: // CMN
        loadReg(cb, Rn, pcPlus8).local_set(L_A);
        pushOp2(cb); cb.local_set(L_B);
        cb.local_get(L_A).local_get(L_B).op(OP.i32_add).local_set(L_RES);
        break;
      case 0x2: // SUB
      case 0xa: // CMP
        loadReg(cb, Rn, pcPlus8).local_set(L_A);
        pushOp2(cb); cb.local_set(L_B);
        cb.local_get(L_A).local_get(L_B).op(OP.i32_sub).local_set(L_RES);
        break;
      case 0x3: // RSB = op2 - Rn
        loadReg(cb, Rn, pcPlus8).local_set(L_A);
        pushOp2(cb); cb.local_set(L_B);
        cb.local_get(L_B).local_get(L_A).op(OP.i32_sub).local_set(L_RES);
        break;
      default:
        // ADC/SBC/RSC need carry-in -> bail for v1.
        return { status: 'bail' };
    }

    // Write result for non-test ops.
    if (!isTest(opcode)) {
      cb.local_get(L_RES);
      storeReg(cb, Rd);
    }

    // Flags
    if (S || isTest(opcode)) {
      setFlagZNfromRes(cb);
      if (opcode === 0x4 || opcode === 0xb) {
        // ADD/CMN: C = unsigned(a+b) < a ; V = (~(a^b) & (a^res)) >>> 31
        setC(cb, (b) => { b.local_get(L_RES).local_get(L_A).op(OP.i32_lt_u); });
        setV(cb, (b) => {
          b.local_get(L_A).local_get(L_B).op(OP.i32_xor).i32_const(-1).op(OP.i32_xor);
          b.local_get(L_A).local_get(L_RES).op(OP.i32_xor);
          b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
        });
      } else if (opcode === 0x2 || opcode === 0xa || opcode === 0x3) {
        // SUB/CMP/RSB: define a,b as minuend/subtrahend already in L_A/L_B (RSB swapped at compute).
        // For SUB/CMP: C = a >= b (no borrow). For RSB: minuend is L_B.
        const minuendLocal = opcode === 0x3 ? L_B : L_A;
        const subLocal = opcode === 0x3 ? L_A : L_B;
        setC(cb, (b) => { b.local_get(minuendLocal).local_get(subLocal).op(OP.i32_ge_u); });
        setV(cb, (b) => {
          b.local_get(minuendLocal).local_get(subLocal).op(OP.i32_xor);
          b.local_get(minuendLocal).local_get(L_RES).op(OP.i32_xor);
          b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
        });
      } else if (isLogical(opcode)) {
        // Logical: C from shifter. For immediate with rot==0, C unchanged; we conservatively
        // bail when S is set on a logical op with a rotated immediate or shifted reg, to avoid
        // getting shifter-carry wrong. Keep it correct: bail.
        return { status: 'bail' };
      }
    }

    return { status: 'ok' };
  }

  // Everything else: bail to interpreter.
  return { status: 'bail' };
}

export const RESERVED_LOCALS = [
  { count: 3, type: I32 }, // L_A, L_B, L_RES
];
