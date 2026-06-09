/**
 * ARM -> WASM lifter.
 *
 * Decodes a single ARM instruction and emits WebAssembly opcodes (into a CodeBuilder) that
 * reproduce its effect on the register file held in linear memory. Returns a LiftResult:
 *   - ok:        instruction was lifted to native WASM.
 *   - endsBlock: control-flow boundary; the block ends after it.
 *   - bail:      not lifted; the block must stop BEFORE it and the runtime falls back to the
 *                interpreter from this PC. The block builder snapshots/rolls back the
 *                CodeBuilder around every lift, so bailing after partial emission is SAFE.
 *
 * Coverage (mirrors arm_core.ts interpreter semantics exactly — the verify gate depends on it):
 *   - FULL conditional execution: any liftable instruction under any condition is wrapped in an
 *     if(cond) block (control-flow ops get an else writing PC = pc+4).
 *   - Data-processing: all 16 opcodes incl. ADC/SBC/RSC (carry-in from the exploded C flag),
 *     immediate operands (with static shifter-carry), immediate-shifted registers (with exact
 *     shifter-carry exprs incl. RRX), and register-specified shifts (value path; bails only on
 *     S-flag logical ops with register shifts).
 *   - B / BL, BX (mode switch via the CPSR T bit in linear memory).
 *   - LDR/STR word/byte: immediate & register-shifted offsets, pre/post index, writeback, the
 *     ARM7 unaligned-LDR rotation (native i32.rotr), LDR pc (jump tables), STR pc (stores pc+12),
 *     and PC-relative LITERAL FOLDING: `ldr rd, [pc, #imm]` from immutable ROM becomes i32.const.
 *   - Halfword/signed transfers: LDRH (unaligned rotation), LDRSB, LDRSH (unaligned->LDRSB quirk),
 *     STRH; immediate & register offsets, pre/post, writeback.
 *   - LDM/STM: full register lists (unrolled — the list is static!), pre/post/up/down, writeback,
 *     the empty-rlist quirk, the STM base-in-rlist-not-lowest quirk, LDM with PC (ends block).
 *   - MUL/MLA (i32.mul) and UMULL/SMULL/UMLAL/SMLAL (i64 math), with flags.
 *   - SWP/SWPB.
 *
 * Still bails: MRS/MSR (mode plumbing), SWI (BIOS HLE), LDM/STM with S bit (user bank/SPSR),
 * DP writing PC (exception returns), coprocessor space.
 */

import { CodeBuilder, OP, I32, I64 } from './wasm_encoder.ts';
import { regOff, OFF_NF, OFF_ZF, OFF_CF, OFF_VF, OFF_CPSR, HOST } from './abi.ts';

export type LiftStatus = 'ok' | 'endsBlock' | 'bail';

export interface LiftResult {
  status: LiftStatus;
  /** For endsBlock branches with a static target, the target PC (for chaining). */
  staticTarget?: number;
  /** True if this is a BL (link) — runtime may still treat as block end. */
  isCall?: boolean;
  /** Why we bailed (telemetry). */
  reason?: string;
  /** Instruction performs guest memory loads / stores (drives verify-gate snapshotting). */
  mayLoad?: boolean;
  mayStore?: boolean;
}

/** Compile-time context the block builder can hand to lifters (e.g. ROM literal folding). */
export interface LiftCtx {
  /** Return the 32-bit word at `addr` if it lies in IMMUTABLE memory (ROM/BIOS), else null. */
  romRead32?: (addr: number) => number | null;
}

// Reserved locals inside every block function (declared by the block builder):
//   local 0: tmpA (i32), 1: tmpB (i32), 2: tmpRes (i32), 3: tmpT (i32), 4: tmp64 (i64)
const L_A = 0, L_B = 1, L_RES = 2, L_T = 3, L_64 = 4;

export const RESERVED_LOCALS = [
  { count: 4, type: I32 }, // L_A, L_B, L_RES, L_T
  { count: 1, type: I64 }, // L_64
];

const FLAG_T_BIT = 0x20;

/** Push register n's value onto the WASM stack. r15 reads as `pcRead` (pc+8 or pc+12). */
function loadReg(cb: CodeBuilder, n: number, pcRead: number): CodeBuilder {
  if (n === 15) { cb.i32_const(pcRead | 0); return cb; }
  cb.i32_const(regOff(n)).i32_load(0);
  return cb;
}

/** Store top-of-stack into register n. */
function storeReg(cb: CodeBuilder, n: number) {
  cb.local_set(L_RES);
  cb.i32_const(regOff(n));
  cb.local_get(L_RES);
  cb.i32_store(0);
}

function setFlagZNfromRes(cb: CodeBuilder) {
  cb.i32_const(OFF_ZF);
  cb.local_get(L_RES).op(OP.i32_eqz);
  cb.i32_store(0);
  cb.i32_const(OFF_NF);
  cb.local_get(L_RES).i32_const(0).op(OP.i32_lt_s);
  cb.i32_store(0);
}

function setFlag(cb: CodeBuilder, off: number, push: (cb: CodeBuilder) => void) {
  cb.i32_const(off);
  push(cb);
  cb.i32_store(0);
}

/** ARM immediate operand: 8-bit value rotated right by 2*rot. */
function armImm(instr: number): number {
  const imm = instr & 0xff;
  const rot = ((instr >> 8) & 0xf) * 2;
  return rot === 0 ? imm : (((imm >>> rot) | (imm << (32 - rot))) >>> 0);
}

/** Push the ARM7 rotated unaligned word read for the address in `addrLocal`. */
function emitLdrWord(cb: CodeBuilder, addrLocal: number) {
  cb.local_get(addrLocal).i32_const(-4).op(OP.i32_and).call(HOST.read32);
  cb.local_get(addrLocal).i32_const(3).op(OP.i32_and).i32_const(3).op(OP.i32_shl);
  cb.op(OP.i32_rotr);
}

/** [OFF_CPSR] = ([OFF_CPSR] & ~T) | ((v&1) << 5) where v is in `local`. */
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

/** Push 1/0 for ARM condition `cond` from the exploded flag words. Mirrors condPass exactly. */
function emitCondArm(cb: CodeBuilder, cond: number) {
  const N = () => cb.i32_const(OFF_NF).i32_load(0);
  const Z = () => cb.i32_const(OFF_ZF).i32_load(0);
  const C = () => cb.i32_const(OFF_CF).i32_load(0);
  const V = () => cb.i32_const(OFF_VF).i32_load(0);
  switch (cond) {
    case 0x0: Z(); break;
    case 0x1: Z(); cb.op(OP.i32_eqz); break;
    case 0x2: C(); break;
    case 0x3: C(); cb.op(OP.i32_eqz); break;
    case 0x4: N(); break;
    case 0x5: N(); cb.op(OP.i32_eqz); break;
    case 0x6: V(); break;
    case 0x7: V(); cb.op(OP.i32_eqz); break;
    case 0x8: C(); Z().op(OP.i32_eqz); cb.op(OP.i32_and); break;
    case 0x9: C().op(OP.i32_eqz); Z(); cb.op(OP.i32_or); break;
    case 0xa: N(); V(); cb.op(OP.i32_eq); break;
    case 0xb: N(); V(); cb.op(OP.i32_ne); break;
    case 0xc: Z().op(OP.i32_eqz); N(); V(); cb.op(OP.i32_eq); cb.op(OP.i32_and); break;
    case 0xd: Z(); N(); V(); cb.op(OP.i32_ne); cb.op(OP.i32_or); break;
    default: cb.i32_const(1); break;
  }
}

/**
 * Lift one ARM instruction at `pc`. Conditional instructions are lifted by emitting the body
 * into a scratch builder, then wrapping it in if(cond){...} — with else{PC=pc+4} for
 * control-flow bodies so the block's PC is always architecturally correct.
 */
export function liftArm(cb: CodeBuilder, instr: number, pc: number, ctx?: LiftCtx): LiftResult {
  const cond = (instr >>> 28) & 0xf;
  if (cond === 0xf) return { status: 'bail', reason: 'cond-nv' };
  if (cond === 0xe) return liftArmBody(cb, instr, pc, ctx);

  const inner = new CodeBuilder();
  const r = liftArmBody(inner, instr, pc, ctx);
  if (r.status === 'bail') return r;
  emitCondArm(cb, cond);
  cb.if_();
  cb.bytes.push(...inner.bytes);
  if (r.status === 'endsBlock') {
    cb.else_();
    cb.i32_const(regOff(15)).i32_const(((pc + 4) >>> 0) | 0).i32_store(0);
  }
  cb.end();
  if (r.status === 'endsBlock') {
    // Conditional control flow: target is dynamic at runtime; drop staticTarget.
    return { status: 'endsBlock', isCall: r.isCall, mayLoad: r.mayLoad, mayStore: r.mayStore };
  }
  return r;
}

/** Lift the (unconditional) body of one ARM instruction. Decode order mirrors stepArm. */
function liftArmBody(cb: CodeBuilder, instr: number, pc: number, ctx?: LiftCtx): LiftResult {
  const pcPlus8 = (pc + 8) >>> 0;
  const pcPlus12 = (pc + 12) >>> 0;

  // ---- BX ----
  if ((instr & 0x0ffffff0) === 0x012fff10) {
    const rn = instr & 0xf;
    if (rn === 15) return { status: 'bail', reason: 'bx-pc' };
    loadReg(cb, rn, pcPlus8).local_set(L_A);
    emitSetThumbBitFromLocal(cb, L_A);
    cb.local_get(L_A).i32_const(1).op(OP.i32_and);
    cb.if_();
    cb.i32_const(regOff(15)).local_get(L_A).i32_const(-2).op(OP.i32_and).i32_store(0);
    cb.else_();
    cb.i32_const(regOff(15)).local_get(L_A).i32_const(-4).op(OP.i32_and).i32_store(0);
    cb.end();
    return { status: 'endsBlock' };
  }

  if ((instr & 0x0c000000) === 0x00000000) {
    // ---- MUL/MLA ----
    if ((instr & 0x0fc000f0) === 0x00000090) {
      const rd = (instr >>> 16) & 0xf;
      const rn = (instr >>> 12) & 0xf;
      const rs = (instr >>> 8) & 0xf;
      const rm = instr & 0xf;
      const accumulate = (instr & 0x00200000) !== 0;
      const setFlags = (instr & 0x00100000) !== 0;
      if (rd === 15 || rn === 15 || rs === 15 || rm === 15) return { status: 'bail', reason: 'mul-pc' };
      loadReg(cb, rm, pcPlus8);
      loadReg(cb, rs, pcPlus8);
      cb.op(OP.i32_mul);
      if (accumulate) { loadReg(cb, rn, pcPlus8); cb.op(OP.i32_add); }
      cb.local_set(L_RES);
      cb.i32_const(regOff(rd)).local_get(L_RES).i32_store(0);
      if (setFlags) setFlagZNfromRes(cb);
      return { status: 'ok' };
    }
    // ---- UMULL/SMULL/UMLAL/SMLAL ----
    if ((instr & 0x0f8000f0) === 0x00800090) {
      const rdHi = (instr >>> 16) & 0xf;
      const rdLo = (instr >>> 12) & 0xf;
      const rs = (instr >>> 8) & 0xf;
      const rm = instr & 0xf;
      const signed = (instr & 0x00400000) !== 0;
      const accumulate = (instr & 0x00200000) !== 0;
      const setFlags = (instr & 0x00100000) !== 0;
      if (rdHi === 15 || rdLo === 15 || rs === 15 || rm === 15) return { status: 'bail', reason: 'mull-pc' };
      const ext = signed ? OP.i64_extend_i32_s : OP.i64_extend_i32_u;
      loadReg(cb, rm, pcPlus8); cb.op(ext);
      loadReg(cb, rs, pcPlus8); cb.op(ext);
      cb.op(OP.i64_mul);
      if (accumulate) {
        loadReg(cb, rdHi, pcPlus8); cb.op(OP.i64_extend_i32_u); cb.i64_const(32n).op(OP.i64_shl);
        loadReg(cb, rdLo, pcPlus8); cb.op(OP.i64_extend_i32_u); cb.op(OP.i64_or);
        cb.op(OP.i64_add);
      }
      cb.local_set(L_64);
      // rdLo = wrap(p); rdHi = wrap(p >> 32)
      cb.i32_const(regOff(rdLo)).local_get(L_64).op(OP.i32_wrap_i64).i32_store(0);
      cb.i32_const(regOff(rdHi)).local_get(L_64).i64_const(32n).op(OP.i64_shr_u).op(OP.i32_wrap_i64).i32_store(0);
      if (setFlags) {
        setFlag(cb, OFF_NF, (b) => b.local_get(L_64).i64_const(32n).op(OP.i64_shr_u).op(OP.i32_wrap_i64).i32_const(0).op(OP.i32_lt_s));
        setFlag(cb, OFF_ZF, (b) => b.local_get(L_64).op(OP.i64_eqz));
      }
      return { status: 'ok' };
    }
    // ---- SWP/SWPB ----
    if ((instr & 0x0fb00ff0) === 0x01000090) {
      const rn = (instr >>> 16) & 0xf;
      const rd = (instr >>> 12) & 0xf;
      const rm = instr & 0xf;
      const byte = (instr & 0x00400000) !== 0;
      if (rn === 15 || rd === 15 || rm === 15) return { status: 'bail', reason: 'swp-pc' };
      loadReg(cb, rn, pcPlus8).local_set(L_A);
      if (byte) {
        cb.local_get(L_A).call(HOST.read8).local_set(L_B);
        cb.local_get(L_A); loadReg(cb, rm, pcPlus8); cb.call(HOST.write8);
      } else {
        emitLdrWord(cb, L_A); cb.local_set(L_B);
        cb.local_get(L_A).i32_const(-4).op(OP.i32_and); loadReg(cb, rm, pcPlus8); cb.call(HOST.write32);
      }
      cb.i32_const(regOff(rd)).local_get(L_B).i32_store(0);
      return { status: 'ok', mayLoad: true, mayStore: true };
    }
    // ---- halfword / signed transfers ----
    if ((instr & 0x0e000090) === 0x00000090 && (instr & 0x60) !== 0) {
      return liftHalfXfer(cb, instr, pcPlus8);
    }
    // ---- data processing / PSR ----
    return liftDataProc(cb, instr, pc, pcPlus8);
  }

  // ---- single data transfer (LDR/STR) ----
  if ((instr & 0x0c000000) === 0x04000000) {
    return liftSingleXfer(cb, instr, pc, pcPlus8, pcPlus12, ctx);
  }

  // ---- block transfer (LDM/STM) ----
  if ((instr & 0x0e000000) === 0x08000000) {
    return liftBlockXfer(cb, instr, pcPlus12);
  }

  // ---- B / BL ----
  if ((instr & 0x0e000000) === 0x0a000000) {
    const link = (instr & 0x01000000) !== 0;
    let off = instr & 0x00ffffff;
    if (off & 0x00800000) off |= 0xff000000;
    const target = (pcPlus8 + (off << 2)) >>> 0;
    if (link) {
      cb.i32_const(regOff(14));
      cb.i32_const(((pc + 4) >>> 0) | 0);
      cb.i32_store(0);
    }
    cb.i32_const(regOff(15));
    cb.i32_const(target | 0);
    cb.i32_store(0);
    return { status: 'endsBlock', staticTarget: target, isCall: link };
  }

  // ---- SWI / coprocessor / undefined ----
  if ((instr & 0x0f000000) === 0x0f000000) return { status: 'bail', reason: 'swi' };
  return { status: 'bail', reason: 'arm-undecoded' };
}

// ---------------------------------------------------------------------------
// Data processing
// ---------------------------------------------------------------------------

function liftDataProc(cb: CodeBuilder, instr: number, pc: number, pcPlus8: number): LiftResult {
  const I = (instr & 0x02000000) !== 0;
  const opcode = (instr >>> 21) & 0xf;
  const S = (instr & 0x00100000) !== 0;
  const Rn = (instr >>> 16) & 0xf;
  const Rd = (instr >>> 12) & 0xf;

  // PSR transfer (MRS/MSR) hides in TST/TEQ/CMP/CMN opcodes with S=0.
  if (!S && opcode >= 0x8 && opcode <= 0xb) return { status: 'bail', reason: 'psr' };
  // Writing PC via DP (exception returns, computed jumps) -> interpreter.
  if (Rd === 15) return { status: 'bail', reason: 'dp-rd15' };

  const isLogical = (op: number) => op === 0 || op === 1 || op === 8 || op === 9 || op === 12 || op === 13 || op === 14 || op === 15;
  const isTest = (op: number) => op >= 8 && op <= 11;
  const needShifterCarry = (S || isTest(opcode)) && isLogical(opcode);

  const regShift = !I && (instr & 0x10) !== 0;
  // Register-specified shifts read PC as +12.
  const pcRead = regShift ? ((pc + 12) >>> 0) : pcPlus8;

  // ---- operand2 -> stack, shifter carry plan ----
  // carryMode: 0 = C unchanged; 1 = constant; 2 = expr over original Rm value stashed in L_T.
  let carryMode = 0;
  let carryConst = 0;
  let carryExpr: ((b: CodeBuilder) => void) | null = null;

  if (I) {
    const rot = ((instr >> 8) & 0xf) * 2;
    const val = armImm(instr);
    cb.i32_const(val | 0);
    if (rot !== 0) { carryMode = 1; carryConst = (val >>> 31) & 1; }
  } else {
    const rm = instr & 0xf;
    const stype = (instr >>> 5) & 3;
    if (regShift) {
      // Register-specified shift. rs holds the amount (low byte). Value-only path; the
      // S-flag logical + register-shift combination (needs dynamic carry) bails.
      const rs = (instr >>> 8) & 0xf;
      if (rs === 15) return { status: 'bail', reason: 'regshift-rs15' };
      if (needShifterCarry) return { status: 'bail', reason: 'regshift-carry' };
      loadReg(cb, rm, pcRead).local_set(L_T);
      loadReg(cb, rs, pcRead).i32_const(0xff).op(OP.i32_and).local_set(L_B);
      emitShiftRegValue(cb, stype);  // L_T = shiftReg(stype, L_T, L_B).value
      cb.local_get(L_T);
    } else {
      const amount = (instr >>> 7) & 0x1f;
      // Stash original Rm in L_T (needed by carry exprs and RRX).
      loadReg(cb, rm, pcRead).local_set(L_T);
      if (stype === 0) { // LSL
        if (amount === 0) { cb.local_get(L_T); /* C unchanged */ }
        else {
          cb.local_get(L_T).i32_const(amount).op(OP.i32_shl);
          carryMode = 2; carryExpr = (b) => b.local_get(L_T).i32_const(32 - amount).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and);
        }
      } else if (stype === 1) { // LSR (#0 means #32)
        if (amount === 0) {
          cb.i32_const(0);
          carryMode = 2; carryExpr = (b) => b.local_get(L_T).i32_const(31).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and);
        } else {
          cb.local_get(L_T).i32_const(amount).op(OP.i32_shr_u);
          carryMode = 2; carryExpr = (b) => b.local_get(L_T).i32_const(amount - 1).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and);
        }
      } else if (stype === 2) { // ASR (#0 means #32)
        if (amount === 0) {
          cb.local_get(L_T).i32_const(31).op(OP.i32_shr_s);
          carryMode = 2; carryExpr = (b) => b.local_get(L_T).i32_const(31).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and);
        } else {
          cb.local_get(L_T).i32_const(amount).op(OP.i32_shr_s);
          carryMode = 2; carryExpr = (b) => b.local_get(L_T).i32_const(amount - 1).op(OP.i32_shr_s).i32_const(1).op(OP.i32_and);
        }
      } else { // ROR / RRX (#0)
        if (amount === 0) {
          // RRX: value = (C << 31) | (Rm >>> 1); carry-out = Rm & 1.
          cb.i32_const(OFF_CF).i32_load(0).i32_const(31).op(OP.i32_shl);
          cb.local_get(L_T).i32_const(1).op(OP.i32_shr_u);
          cb.op(OP.i32_or);
          carryMode = 2; carryExpr = (b) => b.local_get(L_T).i32_const(1).op(OP.i32_and);
        } else {
          cb.local_get(L_T).i32_const(amount).op(OP.i32_rotr);
          carryMode = 2; carryExpr = (b) => b.local_get(L_T).i32_const(amount - 1).op(OP.i32_shr_u).i32_const(1).op(OP.i32_and);
        }
      }
    }
  }
  // operand2 value is now on the stack.
  cb.local_set(L_B);
  loadReg(cb, Rn, regShift ? pcRead : pcPlus8).local_set(L_A);

  // ---- compute result into L_RES ----
  const a = () => cb.local_get(L_A);
  const b_ = () => cb.local_get(L_B);
  switch (opcode) {
    case 0x0: case 0x8: a(); b_(); cb.op(OP.i32_and).local_set(L_RES); break;   // AND / TST
    case 0x1: case 0x9: a(); b_(); cb.op(OP.i32_xor).local_set(L_RES); break;   // EOR / TEQ
    case 0xc: a(); b_(); cb.op(OP.i32_or).local_set(L_RES); break;              // ORR
    case 0xe: a(); b_(); cb.i32_const(-1).op(OP.i32_xor); cb.op(OP.i32_and).local_set(L_RES); break; // BIC
    case 0xd: b_(); cb.local_set(L_RES); break;                                 // MOV
    case 0xf: b_(); cb.i32_const(-1).op(OP.i32_xor).local_set(L_RES); break;    // MVN
    case 0x4: case 0xb: a(); b_(); cb.op(OP.i32_add).local_set(L_RES); break;   // ADD / CMN
    case 0x2: case 0xa: a(); b_(); cb.op(OP.i32_sub).local_set(L_RES); break;   // SUB / CMP
    case 0x3: b_(); a(); cb.op(OP.i32_sub).local_set(L_RES); break;             // RSB
    case 0x5: // ADC: res = a + b + cin
      a(); b_(); cb.op(OP.i32_add).local_set(L_T); // NOTE: L_T reuse is safe (arith ops never need carryExpr)
      cb.local_get(L_T).i32_const(OFF_CF).i32_load(0).op(OP.i32_add).local_set(L_RES);
      break;
    case 0x6: // SBC: res = a - b - 1 + cin
      a(); b_(); cb.op(OP.i32_sub).i32_const(1).op(OP.i32_sub).i32_const(OFF_CF).i32_load(0).op(OP.i32_add).local_set(L_RES);
      break;
    case 0x7: // RSC: res = b - a - 1 + cin
      b_(); a(); cb.op(OP.i32_sub).i32_const(1).op(OP.i32_sub).i32_const(OFF_CF).i32_load(0).op(OP.i32_add).local_set(L_RES);
      break;
  }

  // ---- write result ----
  if (!isTest(opcode)) {
    cb.i32_const(regOff(Rd)).local_get(L_RES).i32_store(0);
  }

  // ---- flags ----
  if (S || isTest(opcode)) {
    setFlagZNfromRes(cb);
    if (opcode === 0x4 || opcode === 0xb) {
      // ADD/CMN: C = res < a ; V = (~(a^b) & (a^res)) >>> 31
      setFlag(cb, OFF_CF, (b) => b.local_get(L_RES).local_get(L_A).op(OP.i32_lt_u));
      setFlag(cb, OFF_VF, (b) => {
        b.local_get(L_A).local_get(L_B).op(OP.i32_xor).i32_const(-1).op(OP.i32_xor);
        b.local_get(L_A).local_get(L_RES).op(OP.i32_xor);
        b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
      });
    } else if (opcode === 0x2 || opcode === 0xa || opcode === 0x3) {
      const minuend = opcode === 0x3 ? L_B : L_A;
      const sub = opcode === 0x3 ? L_A : L_B;
      setFlag(cb, OFF_CF, (b) => b.local_get(minuend).local_get(sub).op(OP.i32_ge_u));
      setFlag(cb, OFF_VF, (b) => {
        b.local_get(minuend).local_get(sub).op(OP.i32_xor);
        b.local_get(minuend).local_get(L_RES).op(OP.i32_xor);
        b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
      });
    } else if (opcode === 0x5) {
      // ADC: C = (t <u a) | (res <u t) where t = a+b is in L_T.
      setFlag(cb, OFF_CF, (b) => {
        b.local_get(L_T).local_get(L_A).op(OP.i32_lt_u);
        b.local_get(L_RES).local_get(L_T).op(OP.i32_lt_u);
        b.op(OP.i32_or);
      });
      setFlag(cb, OFF_VF, (b) => {
        b.local_get(L_A).local_get(L_B).op(OP.i32_xor).i32_const(-1).op(OP.i32_xor);
        b.local_get(L_A).local_get(L_RES).op(OP.i32_xor);
        b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
      });
    } else if (opcode === 0x6 || opcode === 0x7) {
      // SBC/RSC: C = (m >u s) | ((m == s) & cin) — evaluated against the ORIGINAL C (cin),
      // which is still in OFF_CF because we store the new C only here.
      const m = opcode === 0x6 ? L_A : L_B;
      const s2 = opcode === 0x6 ? L_B : L_A;
      setFlag(cb, OFF_CF, (b) => {
        b.local_get(m).local_get(s2).op(OP.i32_gt_u);
        b.local_get(m).local_get(s2).op(OP.i32_eq);
        b.i32_const(OFF_CF).i32_load(0);
        b.op(OP.i32_and);
        b.op(OP.i32_or);
      });
      setFlag(cb, OFF_VF, (b) => {
        b.local_get(m).local_get(s2).op(OP.i32_xor);
        b.local_get(m).local_get(L_RES).op(OP.i32_xor);
        b.op(OP.i32_and).i32_const(31).op(OP.i32_shr_u);
      });
    } else if (isLogical(opcode)) {
      // Logical: C from the shifter; V untouched.
      if (carryMode === 1) setFlag(cb, OFF_CF, (b) => b.i32_const(carryConst));
      else if (carryMode === 2 && carryExpr) setFlag(cb, OFF_CF, carryExpr);
      // carryMode 0: C unchanged.
    }
  }

  return { status: 'ok' };
}

/**
 * Register-amount shift VALUE (barrel.ts shiftReg semantics, no carry).
 * Input value in L_T, amount (0..255) in L_B. Result left in L_T.
 */
function emitShiftRegValue(cb: CodeBuilder, stype: number) {
  cb.local_get(L_B).op(OP.i32_eqz);
  cb.if_();
  // amount == 0: value unchanged
  cb.else_();
  if (stype === 0 || stype === 1) {
    const shiftOp = stype === 0 ? OP.i32_shl : OP.i32_shr_u;
    cb.local_get(L_B).i32_const(32).op(OP.i32_lt_u);
    cb.if_();
    cb.local_get(L_T).local_get(L_B).op(shiftOp).local_set(L_T);
    cb.else_();
    cb.i32_const(0).local_set(L_T);
    cb.end();
  } else if (stype === 2) {
    cb.local_get(L_B).i32_const(32).op(OP.i32_lt_u);
    cb.if_();
    cb.local_get(L_T).local_get(L_B).op(OP.i32_shr_s).local_set(L_T);
    cb.else_();
    cb.local_get(L_T).i32_const(31).op(OP.i32_shr_s).local_set(L_T);
    cb.end();
  } else {
    // ROR: a = amount & 31; a==0 -> unchanged; else rotr.
    cb.local_get(L_B).i32_const(31).op(OP.i32_and).local_set(L_RES);
    cb.local_get(L_RES).op(OP.i32_eqz);
    cb.if_();
    cb.else_();
    cb.local_get(L_T).local_get(L_RES).op(OP.i32_rotr).local_set(L_T);
    cb.end();
  }
  cb.end();
}

// ---------------------------------------------------------------------------
// Single data transfer (LDR/STR word/byte)
// ---------------------------------------------------------------------------

function liftSingleXfer(
  cb: CodeBuilder, instr: number, pc: number, pcPlus8: number, pcPlus12: number, ctx?: LiftCtx,
): LiftResult {
  const regOffsetForm = (instr & 0x02000000) !== 0; // bit25=1 -> (shifted) register offset
  const pre = (instr & 0x01000000) !== 0;
  const up = (instr & 0x00800000) !== 0;
  const byte = (instr & 0x00400000) !== 0;
  const W = (instr & 0x00200000) !== 0;
  const L = (instr & 0x00100000) !== 0;
  const Rn = (instr >>> 16) & 0xf;
  const Rd = (instr >>> 12) & 0xf;

  if (Rn === 15 && (W || !pre)) return { status: 'bail', reason: 'ldr-pc-wb' };

  // ---- PC-relative literal folding: ldr rd, [pc, #imm] from immutable ROM/BIOS ----
  if (L && Rn === 15 && pre && !W && !regOffsetForm && ctx?.romRead32) {
    const off = instr & 0xfff;
    const addr = (up ? pcPlus8 + off : pcPlus8 - off) >>> 0;
    const w = ctx.romRead32(addr & ~3);
    if (w !== null && w !== undefined) {
      let val: number;
      if (byte) val = (w >>> ((addr & 3) * 8)) & 0xff;
      else {
        const rot = (addr & 3) * 8;
        val = rot === 0 ? (w >>> 0) : (((w >>> rot) | (w << (32 - rot))) >>> 0);
      }
      if (Rd === 15) {
        cb.i32_const(regOff(15)).i32_const((val & ~3) | 0).i32_store(0);
        return { status: 'endsBlock' };
      }
      cb.i32_const(regOff(Rd)).i32_const(val | 0).i32_store(0);
      return { status: 'ok' };
    }
  }

  // offset value -> L_B
  if (!regOffsetForm) {
    cb.i32_const(instr & 0xfff).local_set(L_B);
  } else {
    const rm = instr & 0xf;
    if (rm === 15) return { status: 'bail', reason: 'ldr-rm15' };
    const stype = (instr >>> 5) & 3;
    const amount = (instr >>> 7) & 0x1f;
    loadReg(cb, rm, pcPlus8);
    if (stype === 0) { if (amount !== 0) cb.i32_const(amount).op(OP.i32_shl); }
    else if (stype === 1) { cb.drop(); cb.i32_const(0); if (amount !== 0) { cb.drop(); loadReg(cb, rm, pcPlus8).i32_const(amount).op(OP.i32_shr_u); } }
    else if (stype === 2) { cb.i32_const(amount === 0 ? 31 : amount).op(OP.i32_shr_s); }
    else {
      if (amount === 0) {
        // RRX: (C << 31) | (rm >>> 1)
        cb.i32_const(1).op(OP.i32_shr_u);
        cb.i32_const(OFF_CF).i32_load(0).i32_const(31).op(OP.i32_shl);
        cb.op(OP.i32_or);
      } else cb.i32_const(amount).op(OP.i32_rotr);
    }
    cb.local_set(L_B);
  }

  // base -> L_A ; access address -> L_T
  loadReg(cb, Rn, pcPlus8).local_set(L_A);
  if (pre) {
    cb.local_get(L_A).local_get(L_B).op(up ? OP.i32_add : OP.i32_sub).local_set(L_T);
  } else {
    cb.local_get(L_A).local_set(L_T);
  }
  const emitWbAddr = (b: CodeBuilder) => {
    if (pre) b.local_get(L_T);
    else b.local_get(L_A).local_get(L_B).op(up ? OP.i32_add : OP.i32_sub);
  };

  if (L) {
    // value -> L_RES
    if (byte) cb.local_get(L_T).call(HOST.read8).local_set(L_RES);
    else { emitLdrWord(cb, L_T); cb.local_set(L_RES); }
    // writeback (before rd write, mirroring interpreter order; rn==rd -> loaded value wins)
    if ((W || !pre) && Rn !== Rd && Rn !== 15) {
      cb.i32_const(regOff(Rn)); emitWbAddr(cb); cb.i32_store(0);
    }
    if (Rd === 15) {
      cb.i32_const(regOff(15)).local_get(L_RES).i32_const(-4).op(OP.i32_and).i32_store(0);
      return { status: 'endsBlock', mayLoad: true };
    }
    cb.i32_const(regOff(Rd)).local_get(L_RES).i32_store(0);
    return { status: 'ok', mayLoad: true };
  }

  // STR/STRB: value read BEFORE writeback. STR pc stores pc+12.
  if (byte) {
    cb.local_get(L_T);
    loadReg(cb, Rd, pcPlus12);
    cb.call(HOST.write8);
  } else {
    cb.local_get(L_T).i32_const(-4).op(OP.i32_and);
    loadReg(cb, Rd, pcPlus12);
    cb.call(HOST.write32);
  }
  if ((W || !pre) && Rn !== 15) {
    cb.i32_const(regOff(Rn)); emitWbAddr(cb); cb.i32_store(0);
  }
  return { status: 'ok', mayStore: true };
}

// ---------------------------------------------------------------------------
// Halfword / signed transfers (LDRH/STRH/LDRSB/LDRSH)
// ---------------------------------------------------------------------------

function liftHalfXfer(cb: CodeBuilder, instr: number, pcPlus8: number): LiftResult {
  const pre = (instr & 0x01000000) !== 0;
  const up = (instr & 0x00800000) !== 0;
  const immForm = (instr & 0x00400000) !== 0;
  const W = (instr & 0x00200000) !== 0;
  const L = (instr & 0x00100000) !== 0;
  const Rn = (instr >>> 16) & 0xf;
  const Rd = (instr >>> 12) & 0xf;
  const sh = (instr >>> 5) & 3;

  if (Rn === 15 || Rd === 15) return { status: 'bail', reason: 'half-pc' };

  // offset -> L_B
  if (immForm) cb.i32_const(((instr >>> 4) & 0xf0) | (instr & 0xf)).local_set(L_B);
  else {
    const ro = instr & 0xf;
    if (ro === 15) return { status: 'bail', reason: 'half-ro15' };
    loadReg(cb, ro, pcPlus8).local_set(L_B);
  }

  loadReg(cb, Rn, pcPlus8).local_set(L_A);
  if (pre) cb.local_get(L_A).local_get(L_B).op(up ? OP.i32_add : OP.i32_sub).local_set(L_T);
  else cb.local_get(L_A).local_set(L_T);
  const emitWbAddr = (b: CodeBuilder) => {
    if (pre) b.local_get(L_T);
    else b.local_get(L_A).local_get(L_B).op(up ? OP.i32_add : OP.i32_sub);
  };

  if (L) {
    // value -> L_RES
    if (sh === 1) {
      // LDRH with unaligned rotation: rotr(read16(addr & ~1), 8*(addr&1)).
      cb.local_get(L_T).i32_const(-2).op(OP.i32_and).call(HOST.read16);
      cb.local_get(L_T).i32_const(1).op(OP.i32_and).i32_const(3).op(OP.i32_shl);
      cb.op(OP.i32_rotr);
      cb.local_set(L_RES);
    } else if (sh === 2) {
      cb.local_get(L_T).call(HOST.read8);
      emitSignExt(cb, 8);
      cb.local_set(L_RES);
    } else {
      // LDRSH: odd address degrades to LDRSB (ARM7 quirk, mirrored from the interpreter).
      cb.local_get(L_T).i32_const(1).op(OP.i32_and);
      cb.if_(I32);
      cb.local_get(L_T).call(HOST.read8);
      emitSignExt(cb, 8);
      cb.else_();
      cb.local_get(L_T).call(HOST.read16);
      emitSignExt(cb, 16);
      cb.end();
      cb.local_set(L_RES);
    }
    if ((W || !pre) && Rn !== Rd) {
      cb.i32_const(regOff(Rn)); emitWbAddr(cb); cb.i32_store(0);
    }
    cb.i32_const(regOff(Rd)).local_get(L_RES).i32_store(0);
    return { status: 'ok', mayLoad: true };
  }

  // STRH (the interpreter stores rd & 0xffff for any non-load sh; write16 masks).
  cb.local_get(L_T).i32_const(-2).op(OP.i32_and);
  loadReg(cb, Rd, pcPlus8);
  cb.call(HOST.write16);
  if (W || !pre) {
    cb.i32_const(regOff(Rn)); emitWbAddr(cb); cb.i32_store(0);
  }
  return { status: 'ok', mayStore: true };
}

// ---------------------------------------------------------------------------
// Block transfer (LDM/STM)
// ---------------------------------------------------------------------------

function liftBlockXfer(cb: CodeBuilder, instr: number, pcPlus12: number): LiftResult {
  const pre = (instr & 0x01000000) !== 0;
  const up = (instr & 0x00800000) !== 0;
  const psrForce = (instr & 0x00400000) !== 0;
  const W = (instr & 0x00200000) !== 0;
  const L = (instr & 0x00100000) !== 0;
  const Rn = (instr >>> 16) & 0xf;
  const list = instr & 0xffff;

  if (psrForce) return { status: 'bail', reason: 'ldm-sbit' };
  if (Rn === 15) return { status: 'bail', reason: 'ldm-rn15' };

  cb.i32_const(regOff(Rn)).i32_load(0).local_set(L_A);

  // ---- empty register list quirk ----
  if (list === 0) {
    const delta = 0x40;
    // ea/wb derived from base; accAddr = ea (+4 per pre/post rules).
    const eaOff = up ? 0 : -delta;
    const wbOff = up ? delta : -delta;
    const accOff = eaOff + ((up ? pre : !pre) ? 4 : 0);
    if (L) {
      cb.i32_const(regOff(15));
      cb.local_get(L_A).i32_const(accOff).op(OP.i32_add).i32_const(-4).op(OP.i32_and).call(HOST.read32);
      cb.i32_const(-4).op(OP.i32_and); // ARM mode (T=0): PC masked ~3
      cb.i32_store(0);
      if (W) { cb.i32_const(regOff(Rn)); cb.local_get(L_A).i32_const(wbOff).op(OP.i32_add); cb.i32_store(0); }
      return { status: 'endsBlock', mayLoad: true };
    }
    cb.local_get(L_A).i32_const(accOff).op(OP.i32_add).i32_const(-4).op(OP.i32_and);
    cb.i32_const(pcPlus12 | 0);
    cb.call(HOST.write32);
    if (W) { cb.i32_const(regOff(Rn)); cb.local_get(L_A).i32_const(wbOff).op(OP.i32_add); cb.i32_store(0); }
    return { status: 'ok', mayStore: true };
  }

  let count = 0; for (let i = 0; i < 16; i++) if (list & (1 << i)) count++;
  const startOff = up ? 0 : -(count * 4);
  const finalOff = up ? count * 4 : -(count * 4);
  const preInc = up ? pre : !pre;
  const baseInList = (list & (1 << Rn)) !== 0;
  let lowest = -1; for (let i = 0; i < 16; i++) if (list & (1 << i)) { lowest = i; break; }
  const storeFinalForBase = !L && baseInList && W && Rn !== lowest;
  const loadsPc = L && (list & 0x8000) !== 0;

  let k = 0;
  for (let i = 0; i < 16; i++) {
    if (!(list & (1 << i))) continue;
    const slotOff = startOff + k * 4 + (preInc ? 4 : 0);
    if (L) {
      if (i === 15) {
        cb.i32_const(regOff(15));
        cb.local_get(L_A).i32_const(slotOff).op(OP.i32_add).i32_const(-4).op(OP.i32_and).call(HOST.read32);
        cb.i32_const(-4).op(OP.i32_and); // ARM mode: PC &= ~3 (psrForce already bailed)
        cb.i32_store(0);
      } else {
        cb.i32_const(regOff(i));
        cb.local_get(L_A).i32_const(slotOff).op(OP.i32_add).i32_const(-4).op(OP.i32_and).call(HOST.read32);
        cb.i32_store(0);
      }
    } else {
      cb.local_get(L_A).i32_const(slotOff).op(OP.i32_add).i32_const(-4).op(OP.i32_and);
      if (i === 15) cb.i32_const(pcPlus12 | 0);
      else if (i === Rn && storeFinalForBase) cb.local_get(L_A).i32_const(finalOff).op(OP.i32_add);
      else cb.i32_const(regOff(i)).i32_load(0);
      cb.call(HOST.write32);
    }
    k++;
  }

  // Writeback. LDM with Rn in list: loaded value wins (no writeback). STM: always when W.
  if (W && !(L && baseInList)) {
    cb.i32_const(regOff(Rn));
    cb.local_get(L_A).i32_const(finalOff).op(OP.i32_add);
    cb.i32_store(0);
  }

  if (loadsPc) return { status: 'endsBlock', mayLoad: true };
  return L ? { status: 'ok', mayLoad: true } : { status: 'ok', mayStore: true };
}
