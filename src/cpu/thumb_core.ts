/**
 * THUMB instruction interpreter.
 *
 * THUMB is a 16-bit re-encoding of a subset of ARM, used heavily by GBA games (including
 * Pokemon) because it halves code size. There are 19 documented formats. We decode by the
 * top bits and dispatch. PC reads as instruction+4 in THUMB mode.
 *
 * This module operates directly on an ArmCore instance (its register file, flags, and bus),
 * keeping the THUMB logic in one focused place.
 */

import type { ArmCore } from './arm_core.ts';
import { FLAG_C, FLAG_N, FLAG_Z, FLAG_V, FLAG_T, Mode } from './arm_state.ts';
import { ShiftType, shiftReg } from './barrel.ts';

export function thumbStep(cpu: ArmCore): void {
  const st = cpu.st;
  const pc = st.r[15] >>> 0;
  const instr = cpu.bus.read16(pc) & 0xffff;
  st.r[15] = (pc + 2) | 0;
  cpu.cycles += 1;

  const top = instr >>> 13;
  switch (top) {
    case 0b000: fmtShiftedOrAddSub(cpu, instr); break;
    case 0b001: fmtImmediate(cpu, instr); break;
    case 0b010:
      if ((instr & 0x1c00) === 0x0000 && (instr & 0xfc00) === 0x4000) { fmtAluReg(cpu, instr); break; }
      if ((instr & 0xfc00) === 0x4400) { fmtHiRegBx(cpu, instr); break; }
      if ((instr & 0xf800) === 0x4800) { fmtPcRelLoad(cpu, instr); break; }
      if ((instr & 0xf200) === 0x5000) { fmtLoadStoreReg(cpu, instr); break; }
      if ((instr & 0xf200) === 0x5200) { fmtLoadStoreSignExt(cpu, instr); break; }
      break;
    case 0b011: fmtLoadStoreImm(cpu, instr); break;
    case 0b100:
      if ((instr & 0xf000) === 0x8000) fmtLoadStoreHalf(cpu, instr);
      else fmtSpRelLoadStore(cpu, instr);
      break;
    case 0b101:
      if ((instr & 0xf000) === 0xa000) fmtLoadAddress(cpu, instr);
      else fmtMisc(cpu, instr);
      break;
    case 0b110:
      if ((instr & 0xf000) === 0xc000) fmtBlockTransfer(cpu, instr);
      else fmtCondBranchOrSwi(cpu, instr);
      break;
    case 0b111:
      fmtLongBranch(cpu, instr);
      break;
  }
}

function setNZ(cpu: ArmCore, v: number): void {
  cpu.st.setFlag(FLAG_N, (v & 0x80000000) !== 0);
  cpu.st.setFlag(FLAG_Z, (v >>> 0) === 0);
}

// Format 1/2: move shifted register, add/subtract
function fmtShiftedOrAddSub(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const op = (instr >>> 11) & 3;
  if (op === 3) {
    // add/subtract
    const sub = (instr & 0x0200) !== 0;
    const immFlag = (instr & 0x0400) !== 0;
    const rn = (instr >>> 6) & 7;
    const rs = (instr >>> 3) & 7;
    const rd = instr & 7;
    const a = st.r[rs] >>> 0;
    const b = immFlag ? rn : (st.r[rn] >>> 0);
    let r: number;
    if (sub) { r = (a - b) >>> 0; st.setFlag(FLAG_C, a >= b); st.setFlag(FLAG_V, (((a ^ b) & (a ^ r)) & 0x80000000) !== 0); }
    else { const s = a + b; r = s >>> 0; st.setFlag(FLAG_C, s > 0xffffffff); st.setFlag(FLAG_V, ((~(a ^ b) & (a ^ r)) & 0x80000000) !== 0); }
    st.r[rd] = r | 0; setNZ(cpu, r);
  } else {
    const offset = (instr >>> 6) & 0x1f;
    const rs = (instr >>> 3) & 7;
    const rd = instr & 7;
    const type = op as ShiftType; // 0 LSL,1 LSR,2 ASR
    const carryIn = (st.cpsr & FLAG_C) !== 0;
    // THUMB shift-by-immediate uses the immediate special cases (LSR/ASR #0 => #32).
    const amount = offset === 0 && type !== ShiftType.LSL ? 32 : offset;
    const res = shiftReg(type, st.r[rs] | 0, amount === 0 ? 0 : amount, carryIn);
    // LSL #0 keeps carry; others use computed carry
    if (!(type === ShiftType.LSL && offset === 0)) st.setFlag(FLAG_C, res.carry);
    st.r[rd] = res.value | 0; setNZ(cpu, res.value);
  }
}

// Format 3: move/compare/add/subtract immediate
function fmtImmediate(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const op = (instr >>> 11) & 3;
  const rd = (instr >>> 8) & 7;
  const imm = instr & 0xff;
  const a = st.r[rd] >>> 0;
  switch (op) {
    case 0: st.r[rd] = imm | 0; setNZ(cpu, imm); break; // MOV
    case 1: { const r = (a - imm) >>> 0; st.setFlag(FLAG_C, a >= imm); st.setFlag(FLAG_V, (((a ^ imm) & (a ^ r)) & 0x80000000) !== 0); setNZ(cpu, r); break; } // CMP
    case 2: { const s = a + imm; const r = s >>> 0; st.setFlag(FLAG_C, s > 0xffffffff); st.setFlag(FLAG_V, ((~(a ^ imm) & (a ^ r)) & 0x80000000) !== 0); st.r[rd] = r | 0; setNZ(cpu, r); break; } // ADD
    case 3: { const r = (a - imm) >>> 0; st.setFlag(FLAG_C, a >= imm); st.setFlag(FLAG_V, (((a ^ imm) & (a ^ r)) & 0x80000000) !== 0); st.r[rd] = r | 0; setNZ(cpu, r); break; } // SUB
  }
}

// Format 4: ALU operations
function fmtAluReg(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const op = (instr >>> 6) & 0xf;
  const rs = (instr >>> 3) & 7;
  const rd = instr & 7;
  const a = st.r[rd] >>> 0; const b = st.r[rs] >>> 0;
  const carryIn = (st.cpsr & FLAG_C) !== 0;
  let r = 0;
  switch (op) {
    case 0x0: r = (a & b) >>> 0; st.r[rd] = r | 0; setNZ(cpu, r); break;     // AND
    case 0x1: r = (a ^ b) >>> 0; st.r[rd] = r | 0; setNZ(cpu, r); break;     // EOR
    case 0x2: { const res = shiftReg(ShiftType.LSL, a | 0, b & 0xff, carryIn); st.setFlag(FLAG_C, res.carry); st.r[rd] = res.value | 0; setNZ(cpu, res.value); break; } // LSL
    case 0x3: { const res = shiftReg(ShiftType.LSR, a | 0, b & 0xff, carryIn); st.setFlag(FLAG_C, res.carry); st.r[rd] = res.value | 0; setNZ(cpu, res.value); break; } // LSR
    case 0x4: { const res = shiftReg(ShiftType.ASR, a | 0, b & 0xff, carryIn); st.setFlag(FLAG_C, res.carry); st.r[rd] = res.value | 0; setNZ(cpu, res.value); break; } // ASR
    case 0x5: { const cin = (st.cpsr & FLAG_C) ? 1 : 0; const s = a + b + cin; r = s >>> 0; st.setFlag(FLAG_C, s > 0xffffffff); st.setFlag(FLAG_V, ((~(a ^ b) & (a ^ r)) & 0x80000000) !== 0); st.r[rd] = r | 0; setNZ(cpu, r); break; } // ADC
    case 0x6: { const cin = (st.cpsr & FLAG_C) ? 1 : 0; const r2 = (a - b - (1 - cin)) >>> 0; st.setFlag(FLAG_C, a >= (b + (1 - cin))); st.setFlag(FLAG_V, (((a ^ b) & (a ^ r2)) & 0x80000000) !== 0); st.r[rd] = r2 | 0; setNZ(cpu, r2); break; } // SBC
    case 0x7: { const res = shiftReg(ShiftType.ROR, a | 0, b & 0xff, carryIn); st.setFlag(FLAG_C, res.carry); st.r[rd] = res.value | 0; setNZ(cpu, res.value); break; } // ROR
    case 0x8: r = (a & b) >>> 0; setNZ(cpu, r); break;                       // TST
    case 0x9: { const r2 = (0 - b) >>> 0; st.setFlag(FLAG_C, 0 >= b ? b === 0 : false); st.setFlag(FLAG_V, ((b & (r2)) & 0x80000000) !== 0); st.r[rd] = r2 | 0; setNZ(cpu, r2); break; } // NEG
    case 0xa: { const r2 = (a - b) >>> 0; st.setFlag(FLAG_C, a >= b); st.setFlag(FLAG_V, (((a ^ b) & (a ^ r2)) & 0x80000000) !== 0); setNZ(cpu, r2); break; } // CMP
    case 0xb: { const s = a + b; const r2 = s >>> 0; st.setFlag(FLAG_C, s > 0xffffffff); st.setFlag(FLAG_V, ((~(a ^ b) & (a ^ r2)) & 0x80000000) !== 0); setNZ(cpu, r2); break; } // CMN
    case 0xc: r = (a | b) >>> 0; st.r[rd] = r | 0; setNZ(cpu, r); break;     // ORR
    case 0xd: r = Math.imul(a | 0, b | 0) | 0; st.r[rd] = r; setNZ(cpu, r); break; // MUL
    case 0xe: r = (a & ~b) >>> 0; st.r[rd] = r | 0; setNZ(cpu, r); break;    // BIC
    case 0xf: r = (~b) >>> 0; st.r[rd] = r | 0; setNZ(cpu, r); break;        // MVN
  }
}

// Format 5: hi register operations / branch exchange
function fmtHiRegBx(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const op = (instr >>> 8) & 3;
  const h1 = (instr & 0x80) !== 0; const h2 = (instr & 0x40) !== 0;
  let rs = (instr >>> 3) & 7; let rd = instr & 7;
  if (h1) rd += 8; if (h2) rs += 8;
  const readSrc = (i: number) => i === 15 ? (st.r[15] + 2) >>> 0 : st.r[i] >>> 0;
  switch (op) {
    case 0: { // ADD
      const v = (st.r[rd] + readSrc(rs)) | 0; st.r[rd] = v;
      if (rd === 15) st.r[15] = st.r[15] & ~1;
      break;
    }
    case 1: { // CMP
      const a = (rd === 15 ? (st.r[15] + 2) >>> 0 : st.r[rd] >>> 0); const b = readSrc(rs);
      const r = (a - b) >>> 0; st.setFlag(FLAG_C, a >= b); st.setFlag(FLAG_V, (((a ^ b) & (a ^ r)) & 0x80000000) !== 0); setNZ(cpu, r); break;
    }
    case 2: { // MOV
      const v = readSrc(rs); st.r[rd] = v | 0; if (rd === 15) st.r[15] = st.r[15] & ~1; break;
    }
    case 3: { // BX
      const addr = readSrc(rs);
      if (addr & 1) { st.cpsr |= FLAG_T; st.r[15] = addr & ~1; }
      else { st.cpsr &= ~FLAG_T; st.r[15] = addr & ~3; }
      break;
    }
  }
}

// Format 6: PC-relative load
function fmtPcRelLoad(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const rd = (instr >>> 8) & 7;
  const off = (instr & 0xff) << 2;
  const addr = (((st.r[15] + 2) & ~3) + off) >>> 0;
  st.r[rd] = cpu.bus.read32(addr & ~3) | 0;
}

// Format 7: load/store with register offset
function fmtLoadStoreReg(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const load = (instr & 0x0800) !== 0;
  const byte = (instr & 0x0400) !== 0;
  const ro = (instr >>> 6) & 7; const rb = (instr >>> 3) & 7; const rd = instr & 7;
  const addr = (st.r[rb] + st.r[ro]) >>> 0;
  if (load) { st.r[rd] = (byte ? cpu.bus.read8(addr) : ldrWord(cpu, addr)) | 0; }
  else { if (byte) cpu.bus.write8(addr, st.r[rd] & 0xff); else cpu.bus.write32(addr & ~3, st.r[rd] >>> 0); }
}

// Format 8: load/store sign-extended byte/halfword
function fmtLoadStoreSignExt(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const h = (instr & 0x0800) !== 0; const s = (instr & 0x0400) !== 0;
  const ro = (instr >>> 6) & 7; const rb = (instr >>> 3) & 7; const rd = instr & 7;
  const addr = (st.r[rb] + st.r[ro]) >>> 0;
  if (!s && !h) { cpu.bus.write16(addr & ~1, st.r[rd] & 0xffff); }       // STRH
  else if (!s && h) { st.r[rd] = cpu.bus.read16(addr & ~1) | 0; }         // LDRH
  else if (s && !h) { const b = cpu.bus.read8(addr); st.r[rd] = (b & 0x80) ? (b | 0xffffff00) : b; } // LDRSB
  else { const hw = cpu.bus.read16(addr & ~1); st.r[rd] = (hw & 0x8000) ? (hw | 0xffff0000) : hw; }   // LDRSH
}

// Format 9: load/store with immediate offset
function fmtLoadStoreImm(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const byte = (instr & 0x1000) !== 0;
  const load = (instr & 0x0800) !== 0;
  let off = (instr >>> 6) & 0x1f;
  const rb = (instr >>> 3) & 7; const rd = instr & 7;
  const addr = byte ? (st.r[rb] + off) >>> 0 : (st.r[rb] + (off << 2)) >>> 0;
  if (load) { st.r[rd] = (byte ? cpu.bus.read8(addr) : ldrWord(cpu, addr)) | 0; }
  else { if (byte) cpu.bus.write8(addr, st.r[rd] & 0xff); else cpu.bus.write32(addr & ~3, st.r[rd] >>> 0); }
}

// Format 10: load/store halfword
function fmtLoadStoreHalf(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const load = (instr & 0x0800) !== 0;
  const off = ((instr >>> 6) & 0x1f) << 1;
  const rb = (instr >>> 3) & 7; const rd = instr & 7;
  const addr = (st.r[rb] + off) >>> 0;
  if (load) st.r[rd] = cpu.bus.read16(addr & ~1) | 0;
  else cpu.bus.write16(addr & ~1, st.r[rd] & 0xffff);
}

// Format 11: SP-relative load/store
function fmtSpRelLoadStore(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const load = (instr & 0x0800) !== 0;
  const rd = (instr >>> 8) & 7;
  const off = (instr & 0xff) << 2;
  const addr = (st.r[13] + off) >>> 0;
  if (load) st.r[rd] = ldrWord(cpu, addr) | 0;
  else cpu.bus.write32(addr & ~3, st.r[rd] >>> 0);
}

// Format 12: load address
function fmtLoadAddress(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const sp = (instr & 0x0800) !== 0;
  const rd = (instr >>> 8) & 7;
  const off = (instr & 0xff) << 2;
  st.r[rd] = (sp ? (st.r[13] + off) : (((st.r[15] + 2) & ~3) + off)) | 0;
}

// Format 13/14: add offset to SP, push/pop
function fmtMisc(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  if ((instr & 0xff00) === 0xb000) {
    const off = (instr & 0x7f) << 2;
    st.r[13] = (instr & 0x80) ? (st.r[13] - off) | 0 : (st.r[13] + off) | 0;
    return;
  }
  if ((instr & 0xf600) === 0xb400) {
    // PUSH/POP
    const load = (instr & 0x0800) !== 0;
    const pcLr = (instr & 0x0100) !== 0;
    const list = instr & 0xff;
    if (load) {
      // POP
      let sp = st.r[13] >>> 0;
      for (let i = 0; i < 8; i++) if (list & (1 << i)) { st.r[i] = cpu.bus.read32(sp & ~3) | 0; sp = (sp + 4) >>> 0; }
      if (pcLr) { const v = cpu.bus.read32(sp & ~3) >>> 0; sp = (sp + 4) >>> 0; if (v & 1) st.cpsr |= FLAG_T; else st.cpsr &= ~FLAG_T; st.r[15] = v & ~1; }
      st.r[13] = sp | 0;
    } else {
      // PUSH
      let count = 0; for (let i = 0; i < 8; i++) if (list & (1 << i)) count++; if (pcLr) count++;
      let sp = (st.r[13] - count * 4) >>> 0;
      const base = sp;
      for (let i = 0; i < 8; i++) if (list & (1 << i)) { cpu.bus.write32(sp & ~3, st.r[i] >>> 0); sp = (sp + 4) >>> 0; }
      if (pcLr) { cpu.bus.write32(sp & ~3, st.r[14] >>> 0); }
      st.r[13] = base | 0;
    }
  }
}

// Format 15: multiple load/store
function fmtBlockTransfer(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const load = (instr & 0x0800) !== 0;
  const rb = (instr >>> 8) & 7;
  const list = instr & 0xff;
  let addr = st.r[rb] >>> 0;
  if (list === 0) {
    // Empty list edge case: transfers PC, base += 0x40.
    if (load) { const v = cpu.bus.read32(addr & ~3) >>> 0; st.r[15] = v & ~1; }
    else cpu.bus.write32(addr & ~3, (st.r[15] + 2) >>> 0);
    st.r[rb] = (addr + 0x40) | 0;
    return;
  }
  for (let i = 0; i < 8; i++) {
    if (!(list & (1 << i))) continue;
    if (load) st.r[i] = cpu.bus.read32(addr & ~3) | 0;
    else cpu.bus.write32(addr & ~3, st.r[i] >>> 0);
    addr = (addr + 4) >>> 0;
  }
  // Writeback unless loading rb itself.
  if (!(load && (list & (1 << rb)))) st.r[rb] = addr | 0;
}

// Format 16/17: conditional branch, SWI
function fmtCondBranchOrSwi(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const cond = (instr >>> 8) & 0xf;
  if (cond === 0xf) { // SWI
    const comment = instr & 0xff;
    if (cpu.swiHandler && cpu.swiHandler(comment, cpu)) return;
    cpu.enterException(Mode.SVC, 0x08, true);
    return;
  }
  if (cond === 0xe) return; // undefined
  if (!condPass(cpu, cond)) return;
  let off = instr & 0xff; if (off & 0x80) off |= 0xffffff00; off <<= 1;
  st.r[15] = ((st.r[15] + 2) + off) | 0;
}

// Format 18/19: unconditional + long branch with link
function fmtLongBranch(cpu: ArmCore, instr: number): void {
  const st = cpu.st;
  const sub = (instr >>> 11) & 0x1f;
  if (sub === 0b11100) {
    // Format 18: unconditional branch
    let off = instr & 0x7ff; if (off & 0x400) off |= 0xfffff800; off <<= 1;
    st.r[15] = ((st.r[15] + 2) + off) | 0;
    return;
  }
  // Format 19: long branch with link (two halves)
  const offset = instr & 0x7ff;
  if (sub === 0b11110) {
    // High part: LR = PC + (offset << 12), sign-extended.
    let hi = offset << 12; if (hi & 0x00400000) hi |= 0xff800000;
    st.r[14] = ((st.r[15] + 2) + hi) | 0;
  } else if (sub === 0b11111) {
    // Low part: temp = next instr addr | 1; PC = LR + (offset<<1); LR = temp.
    const next = (st.r[15] | 1) >>> 0;
    st.r[15] = (st.r[14] + (offset << 1)) | 0;
    st.r[14] = next | 0;
  }
}

function condPass(cpu: ArmCore, cond: number): boolean {
  const f = cpu.st.cpsr;
  const N = (f & FLAG_N) !== 0, Z = (f & FLAG_Z) !== 0, C = (f & FLAG_C) !== 0, V = (f & FLAG_V) !== 0;
  switch (cond) {
    case 0x0: return Z; case 0x1: return !Z; case 0x2: return C; case 0x3: return !C;
    case 0x4: return N; case 0x5: return !N; case 0x6: return V; case 0x7: return !V;
    case 0x8: return C && !Z; case 0x9: return !C || Z; case 0xa: return N === V; case 0xb: return N !== V;
    case 0xc: return !Z && (N === V); case 0xd: return Z || (N !== V); default: return true;
  }
}

function ldrWord(cpu: ArmCore, addr: number): number {
  const aligned = cpu.bus.read32(addr & ~3) >>> 0;
  const rot = (addr & 3) * 8;
  return rot === 0 ? aligned : ((aligned >>> rot) | (aligned << (32 - rot))) >>> 0;
}
