// src/cpu/arm_state.ts
var Mode = {
  USR: 16,
  FIQ: 17,
  IRQ: 18,
  SVC: 19,
  ABT: 23,
  UND: 27,
  SYS: 31
};
var FLAG_N = 1 << 31;
var FLAG_Z = 1 << 30;
var FLAG_C = 1 << 29;
var FLAG_V = 1 << 28;
var FLAG_I = 1 << 7;
var FLAG_F = 1 << 6;
var FLAG_T = 1 << 5;
var ArmState = class {
  // Current visible register file r0..r15. r15 is PC.
  r = new Int32Array(16);
  // Current Program Status Register.
  cpsr = Mode.SVC | FLAG_I | FLAG_F;
  // Banked registers. We store the *other* modes' versions and swap on mode change.
  // User/System share one bank for r8-r14.
  bankUsr = new Int32Array(7);
  // r8..r14
  bankFiq = new Int32Array(7);
  // r8..r14
  bankIrq = new Int32Array(2);
  // r13..r14
  bankSvc = new Int32Array(2);
  bankAbt = new Int32Array(2);
  bankUnd = new Int32Array(2);
  // Saved PSRs per privileged mode.
  spsrFiq = 0;
  spsrIrq = 0;
  spsrSvc = 0;
  spsrAbt = 0;
  spsrUnd = 0;
  curMode = Mode.SVC;
  // ---- flag helpers ----
  get n() {
    return (this.cpsr & FLAG_N) !== 0;
  }
  get z() {
    return (this.cpsr & FLAG_Z) !== 0;
  }
  get c() {
    return (this.cpsr & FLAG_C) !== 0;
  }
  get v() {
    return (this.cpsr & FLAG_V) !== 0;
  }
  get thumb() {
    return (this.cpsr & FLAG_T) !== 0;
  }
  get irqDisabled() {
    return (this.cpsr & FLAG_I) !== 0;
  }
  setFlag(mask, on) {
    if (on) this.cpsr |= mask;
    else this.cpsr &= ~mask;
  }
  setNZ(value) {
    this.setFlag(FLAG_N, (value & 2147483648) !== 0);
    this.setFlag(FLAG_Z, (value | 0) === 0);
  }
  get mode() {
    return this.curMode;
  }
  /** PC convenience (r15). */
  get pc() {
    return this.r[15] >>> 0;
  }
  set pc(v) {
    this.r[15] = v | 0;
  }
  /** Read a register as unsigned 32-bit. */
  get(i) {
    return this.r[i] >>> 0;
  }
  set(i, v) {
    this.r[i] = v | 0;
  }
  /** SPSR of the current mode (USR/SYS have no SPSR; return CPSR per ARM convention). */
  getSpsr() {
    switch (this.curMode) {
      case Mode.FIQ:
        return this.spsrFiq;
      case Mode.IRQ:
        return this.spsrIrq;
      case Mode.SVC:
        return this.spsrSvc;
      case Mode.ABT:
        return this.spsrAbt;
      case Mode.UND:
        return this.spsrUnd;
      default:
        return this.cpsr;
    }
  }
  setSpsr(v) {
    switch (this.curMode) {
      case Mode.FIQ:
        this.spsrFiq = v | 0;
        break;
      case Mode.IRQ:
        this.spsrIrq = v | 0;
        break;
      case Mode.SVC:
        this.spsrSvc = v | 0;
        break;
      case Mode.ABT:
        this.spsrAbt = v | 0;
        break;
      case Mode.UND:
        this.spsrUnd = v | 0;
        break;
      default:
        break;
    }
  }
  hasSpsr() {
    return this.curMode !== Mode.USR && this.curMode !== Mode.SYS;
  }
  /**
   * Switch processor mode, banking r8..r14 in/out. r0-r7 and r15 are never banked.
   * Call this whenever the CPSR mode field changes (MSR, exception entry, mode restore).
   */
  switchMode(next) {
    if (next === this.curMode) {
      this.cpsr = this.cpsr & ~31 | next;
      return;
    }
    this.saveBank(this.curMode);
    this.loadBank(next);
    this.curMode = next;
    this.cpsr = this.cpsr & ~31 | next;
  }
  /** Apply a new CPSR value, performing a mode switch if the mode field changed. */
  writeCpsr(value, allowModeChange = true) {
    const newMode = value & 31;
    if (allowModeChange && newMode !== this.curMode && this.isValidMode(newMode)) {
      this.switchMode(newMode);
    }
    this.cpsr = value & ~31 | this.cpsr & 31;
  }
  isValidMode(m) {
    return m === Mode.USR || m === Mode.FIQ || m === Mode.IRQ || m === Mode.SVC || m === Mode.ABT || m === Mode.UND || m === Mode.SYS;
  }
  saveBank(mode) {
    switch (mode) {
      case Mode.FIQ:
        for (let i = 0; i < 7; i++) this.bankFiq[i] = this.r[8 + i];
        break;
      case Mode.IRQ:
        this.bankIrq[0] = this.r[13];
        this.bankIrq[1] = this.r[14];
        this.saveUsrHigh();
        break;
      case Mode.SVC:
        this.bankSvc[0] = this.r[13];
        this.bankSvc[1] = this.r[14];
        this.saveUsrHigh();
        break;
      case Mode.ABT:
        this.bankAbt[0] = this.r[13];
        this.bankAbt[1] = this.r[14];
        this.saveUsrHigh();
        break;
      case Mode.UND:
        this.bankUnd[0] = this.r[13];
        this.bankUnd[1] = this.r[14];
        this.saveUsrHigh();
        break;
      default:
        for (let i = 0; i < 7; i++) this.bankUsr[i] = this.r[8 + i];
        break;
    }
  }
  // For non-FIQ privileged modes, r8-r12 come from the user bank.
  saveUsrHigh() {
    for (let i = 0; i < 5; i++) this.bankUsr[i] = this.r[8 + i];
  }
  loadUsrHigh() {
    for (let i = 0; i < 5; i++) this.r[8 + i] = this.bankUsr[i];
  }
  loadBank(mode) {
    switch (mode) {
      case Mode.FIQ:
        for (let i = 0; i < 7; i++) this.r[8 + i] = this.bankFiq[i];
        break;
      case Mode.IRQ:
        this.loadUsrHigh();
        this.r[13] = this.bankIrq[0];
        this.r[14] = this.bankIrq[1];
        break;
      case Mode.SVC:
        this.loadUsrHigh();
        this.r[13] = this.bankSvc[0];
        this.r[14] = this.bankSvc[1];
        break;
      case Mode.ABT:
        this.loadUsrHigh();
        this.r[13] = this.bankAbt[0];
        this.r[14] = this.bankAbt[1];
        break;
      case Mode.UND:
        this.loadUsrHigh();
        this.r[13] = this.bankUnd[0];
        this.r[14] = this.bankUnd[1];
        break;
      default:
        for (let i = 0; i < 7; i++) this.r[8 + i] = this.bankUsr[i];
        break;
    }
  }
};

// src/cpu/barrel.ts
var ShiftType = { LSL: 0, LSR: 1, ASR: 2, ROR: 3 };
function shiftImm(type, value, amount, carryIn) {
  value = value | 0;
  switch (type) {
    case ShiftType.LSL:
      if (amount === 0) return { value, carry: carryIn };
      return { value: value << amount | 0, carry: (value >>> 32 - amount & 1) !== 0 };
    case ShiftType.LSR:
      if (amount === 0) return { value: 0, carry: (value & 2147483648) !== 0 };
      return { value: value >>> amount | 0, carry: (value >>> amount - 1 & 1) !== 0 };
    case ShiftType.ASR:
      if (amount === 0) {
        const c = (value & 2147483648) !== 0;
        return { value: c ? -1 : 0, carry: c };
      }
      return { value: value >> amount | 0, carry: (value >> amount - 1 & 1) !== 0 };
    case ShiftType.ROR:
      if (amount === 0) {
        const cOut = (value & 1) !== 0;
        const v = (carryIn ? 2147483648 : 0) | value >>> 1 & 2147483647 | 0;
        return { value: v, carry: cOut };
      }
      amount &= 31;
      if (amount === 0) return { value, carry: (value & 2147483648) !== 0 };
      return { value: value >>> amount | value << 32 - amount | 0, carry: (value >>> amount - 1 & 1) !== 0 };
  }
}
function shiftReg(type, value, amount, carryIn) {
  value = value | 0;
  amount &= 255;
  if (amount === 0) return { value, carry: carryIn };
  switch (type) {
    case ShiftType.LSL:
      if (amount < 32) return { value: value << amount | 0, carry: (value >>> 32 - amount & 1) !== 0 };
      if (amount === 32) return { value: 0, carry: (value & 1) !== 0 };
      return { value: 0, carry: false };
    case ShiftType.LSR:
      if (amount < 32) return { value: value >>> amount | 0, carry: (value >>> amount - 1 & 1) !== 0 };
      if (amount === 32) return { value: 0, carry: (value & 2147483648) !== 0 };
      return { value: 0, carry: false };
    case ShiftType.ASR:
      if (amount < 32) return { value: value >> amount | 0, carry: (value >> amount - 1 & 1) !== 0 };
      {
        const c = (value & 2147483648) !== 0;
        return { value: c ? -1 : 0, carry: c };
      }
    case ShiftType.ROR: {
      const a = amount & 31;
      if (a === 0) return { value, carry: (value & 2147483648) !== 0 };
      return { value: value >>> a | value << 32 - a | 0, carry: (value >>> a - 1 & 1) !== 0 };
    }
  }
}

// src/cpu/thumb_core.ts
function thumbStep(cpu) {
  const st = cpu.st;
  const pc = st.r[15] >>> 0;
  const instr = cpu.bus.read16(pc) & 65535;
  st.r[15] = pc + 2 | 0;
  cpu.cycles += 1;
  const top = instr >>> 13;
  switch (top) {
    case 0:
      fmtShiftedOrAddSub(cpu, instr);
      break;
    case 1:
      fmtImmediate(cpu, instr);
      break;
    case 2:
      if ((instr & 7168) === 0 && (instr & 64512) === 16384) {
        fmtAluReg(cpu, instr);
        break;
      }
      if ((instr & 64512) === 17408) {
        fmtHiRegBx(cpu, instr);
        break;
      }
      if ((instr & 63488) === 18432) {
        fmtPcRelLoad(cpu, instr);
        break;
      }
      if ((instr & 61952) === 20480) {
        fmtLoadStoreReg(cpu, instr);
        break;
      }
      if ((instr & 61952) === 20992) {
        fmtLoadStoreSignExt(cpu, instr);
        break;
      }
      break;
    case 3:
      fmtLoadStoreImm(cpu, instr);
      break;
    case 4:
      if ((instr & 61440) === 32768) fmtLoadStoreHalf(cpu, instr);
      else fmtSpRelLoadStore(cpu, instr);
      break;
    case 5:
      if ((instr & 61440) === 40960) fmtLoadAddress(cpu, instr);
      else fmtMisc(cpu, instr);
      break;
    case 6:
      if ((instr & 61440) === 49152) fmtBlockTransfer(cpu, instr);
      else fmtCondBranchOrSwi(cpu, instr);
      break;
    case 7:
      fmtLongBranch(cpu, instr);
      break;
  }
}
function setNZ(cpu, v) {
  cpu.st.setFlag(FLAG_N, (v & 2147483648) !== 0);
  cpu.st.setFlag(FLAG_Z, v >>> 0 === 0);
}
function fmtShiftedOrAddSub(cpu, instr) {
  const st = cpu.st;
  const op = instr >>> 11 & 3;
  if (op === 3) {
    const sub = (instr & 512) !== 0;
    const immFlag = (instr & 1024) !== 0;
    const rn = instr >>> 6 & 7;
    const rs = instr >>> 3 & 7;
    const rd = instr & 7;
    const a = st.r[rs] >>> 0;
    const b = immFlag ? rn : st.r[rn] >>> 0;
    let r;
    if (sub) {
      r = a - b >>> 0;
      st.setFlag(FLAG_C, a >= b);
      st.setFlag(FLAG_V, ((a ^ b) & (a ^ r) & 2147483648) !== 0);
    } else {
      const s = a + b;
      r = s >>> 0;
      st.setFlag(FLAG_C, s > 4294967295);
      st.setFlag(FLAG_V, (~(a ^ b) & (a ^ r) & 2147483648) !== 0);
    }
    st.r[rd] = r | 0;
    setNZ(cpu, r);
  } else {
    const offset = instr >>> 6 & 31;
    const rs = instr >>> 3 & 7;
    const rd = instr & 7;
    const type = op;
    const carryIn = (st.cpsr & FLAG_C) !== 0;
    const amount = offset === 0 && type !== ShiftType.LSL ? 32 : offset;
    const res = shiftReg(type, st.r[rs] | 0, amount === 0 ? 0 : amount, carryIn);
    if (!(type === ShiftType.LSL && offset === 0)) st.setFlag(FLAG_C, res.carry);
    st.r[rd] = res.value | 0;
    setNZ(cpu, res.value);
  }
}
function fmtImmediate(cpu, instr) {
  const st = cpu.st;
  const op = instr >>> 11 & 3;
  const rd = instr >>> 8 & 7;
  const imm = instr & 255;
  const a = st.r[rd] >>> 0;
  switch (op) {
    case 0:
      st.r[rd] = imm | 0;
      setNZ(cpu, imm);
      break;
    // MOV
    case 1: {
      const r = a - imm >>> 0;
      st.setFlag(FLAG_C, a >= imm);
      st.setFlag(FLAG_V, ((a ^ imm) & (a ^ r) & 2147483648) !== 0);
      setNZ(cpu, r);
      break;
    }
    // CMP
    case 2: {
      const s = a + imm;
      const r = s >>> 0;
      st.setFlag(FLAG_C, s > 4294967295);
      st.setFlag(FLAG_V, (~(a ^ imm) & (a ^ r) & 2147483648) !== 0);
      st.r[rd] = r | 0;
      setNZ(cpu, r);
      break;
    }
    // ADD
    case 3: {
      const r = a - imm >>> 0;
      st.setFlag(FLAG_C, a >= imm);
      st.setFlag(FLAG_V, ((a ^ imm) & (a ^ r) & 2147483648) !== 0);
      st.r[rd] = r | 0;
      setNZ(cpu, r);
      break;
    }
  }
}
function fmtAluReg(cpu, instr) {
  const st = cpu.st;
  const op = instr >>> 6 & 15;
  const rs = instr >>> 3 & 7;
  const rd = instr & 7;
  const a = st.r[rd] >>> 0;
  const b = st.r[rs] >>> 0;
  const carryIn = (st.cpsr & FLAG_C) !== 0;
  let r = 0;
  switch (op) {
    case 0:
      r = (a & b) >>> 0;
      st.r[rd] = r | 0;
      setNZ(cpu, r);
      break;
    // AND
    case 1:
      r = (a ^ b) >>> 0;
      st.r[rd] = r | 0;
      setNZ(cpu, r);
      break;
    // EOR
    case 2: {
      const res = shiftReg(ShiftType.LSL, a | 0, b & 255, carryIn);
      st.setFlag(FLAG_C, res.carry);
      st.r[rd] = res.value | 0;
      setNZ(cpu, res.value);
      break;
    }
    // LSL
    case 3: {
      const res = shiftReg(ShiftType.LSR, a | 0, b & 255, carryIn);
      st.setFlag(FLAG_C, res.carry);
      st.r[rd] = res.value | 0;
      setNZ(cpu, res.value);
      break;
    }
    // LSR
    case 4: {
      const res = shiftReg(ShiftType.ASR, a | 0, b & 255, carryIn);
      st.setFlag(FLAG_C, res.carry);
      st.r[rd] = res.value | 0;
      setNZ(cpu, res.value);
      break;
    }
    // ASR
    case 5: {
      const cin = st.cpsr & FLAG_C ? 1 : 0;
      const s = a + b + cin;
      r = s >>> 0;
      st.setFlag(FLAG_C, s > 4294967295);
      st.setFlag(FLAG_V, (~(a ^ b) & (a ^ r) & 2147483648) !== 0);
      st.r[rd] = r | 0;
      setNZ(cpu, r);
      break;
    }
    // ADC
    case 6: {
      const cin = st.cpsr & FLAG_C ? 1 : 0;
      const r2 = a - b - (1 - cin) >>> 0;
      st.setFlag(FLAG_C, a >= b + (1 - cin));
      st.setFlag(FLAG_V, ((a ^ b) & (a ^ r2) & 2147483648) !== 0);
      st.r[rd] = r2 | 0;
      setNZ(cpu, r2);
      break;
    }
    // SBC
    case 7: {
      const res = shiftReg(ShiftType.ROR, a | 0, b & 255, carryIn);
      st.setFlag(FLAG_C, res.carry);
      st.r[rd] = res.value | 0;
      setNZ(cpu, res.value);
      break;
    }
    // ROR
    case 8:
      r = (a & b) >>> 0;
      setNZ(cpu, r);
      break;
    // TST
    case 9: {
      const r2 = 0 - b >>> 0;
      st.setFlag(FLAG_C, 0 >= b ? b === 0 : false);
      st.setFlag(FLAG_V, (b & r2 & 2147483648) !== 0);
      st.r[rd] = r2 | 0;
      setNZ(cpu, r2);
      break;
    }
    // NEG
    case 10: {
      const r2 = a - b >>> 0;
      st.setFlag(FLAG_C, a >= b);
      st.setFlag(FLAG_V, ((a ^ b) & (a ^ r2) & 2147483648) !== 0);
      setNZ(cpu, r2);
      break;
    }
    // CMP
    case 11: {
      const s = a + b;
      const r2 = s >>> 0;
      st.setFlag(FLAG_C, s > 4294967295);
      st.setFlag(FLAG_V, (~(a ^ b) & (a ^ r2) & 2147483648) !== 0);
      setNZ(cpu, r2);
      break;
    }
    // CMN
    case 12:
      r = (a | b) >>> 0;
      st.r[rd] = r | 0;
      setNZ(cpu, r);
      break;
    // ORR
    case 13:
      r = Math.imul(a | 0, b | 0) | 0;
      st.r[rd] = r;
      setNZ(cpu, r);
      break;
    // MUL
    case 14:
      r = (a & ~b) >>> 0;
      st.r[rd] = r | 0;
      setNZ(cpu, r);
      break;
    // BIC
    case 15:
      r = ~b >>> 0;
      st.r[rd] = r | 0;
      setNZ(cpu, r);
      break;
  }
}
function fmtHiRegBx(cpu, instr) {
  const st = cpu.st;
  const op = instr >>> 8 & 3;
  const h1 = (instr & 128) !== 0;
  const h2 = (instr & 64) !== 0;
  let rs = instr >>> 3 & 7;
  let rd = instr & 7;
  if (h1) rd += 8;
  if (h2) rs += 8;
  const readSrc = (i) => i === 15 ? st.r[15] + 2 >>> 0 : st.r[i] >>> 0;
  switch (op) {
    case 0: {
      const v = st.r[rd] + readSrc(rs) | 0;
      st.r[rd] = v;
      if (rd === 15) st.r[15] = st.r[15] & ~1;
      break;
    }
    case 1: {
      const a = rd === 15 ? st.r[15] + 2 >>> 0 : st.r[rd] >>> 0;
      const b = readSrc(rs);
      const r = a - b >>> 0;
      st.setFlag(FLAG_C, a >= b);
      st.setFlag(FLAG_V, ((a ^ b) & (a ^ r) & 2147483648) !== 0);
      setNZ(cpu, r);
      break;
    }
    case 2: {
      const v = readSrc(rs);
      st.r[rd] = v | 0;
      if (rd === 15) st.r[15] = st.r[15] & ~1;
      break;
    }
    case 3: {
      const addr = readSrc(rs);
      if (addr & 1) {
        st.cpsr |= FLAG_T;
        st.r[15] = addr & ~1;
      } else {
        st.cpsr &= ~FLAG_T;
        st.r[15] = addr & ~3;
      }
      break;
    }
  }
}
function fmtPcRelLoad(cpu, instr) {
  const st = cpu.st;
  const rd = instr >>> 8 & 7;
  const off = (instr & 255) << 2;
  const addr = (st.r[15] + 2 & ~3) + off >>> 0;
  st.r[rd] = cpu.bus.read32(addr & ~3) | 0;
}
function fmtLoadStoreReg(cpu, instr) {
  const st = cpu.st;
  const load = (instr & 2048) !== 0;
  const byte = (instr & 1024) !== 0;
  const ro = instr >>> 6 & 7;
  const rb = instr >>> 3 & 7;
  const rd = instr & 7;
  const addr = st.r[rb] + st.r[ro] >>> 0;
  if (load) {
    st.r[rd] = (byte ? cpu.bus.read8(addr) : ldrWord(cpu, addr)) | 0;
  } else {
    if (byte) cpu.bus.write8(addr, st.r[rd] & 255);
    else cpu.bus.write32(addr & ~3, st.r[rd] >>> 0);
  }
}
function fmtLoadStoreSignExt(cpu, instr) {
  const st = cpu.st;
  const h = (instr & 2048) !== 0;
  const s = (instr & 1024) !== 0;
  const ro = instr >>> 6 & 7;
  const rb = instr >>> 3 & 7;
  const rd = instr & 7;
  const addr = st.r[rb] + st.r[ro] >>> 0;
  if (!s && !h) {
    cpu.bus.write16(addr & ~1, st.r[rd] & 65535);
  } else if (!s && h) {
    st.r[rd] = cpu.bus.read16(addr & ~1) | 0;
  } else if (s && !h) {
    const b = cpu.bus.read8(addr);
    st.r[rd] = b & 128 ? b | 4294967040 : b;
  } else {
    const hw = cpu.bus.read16(addr & ~1);
    st.r[rd] = hw & 32768 ? hw | 4294901760 : hw;
  }
}
function fmtLoadStoreImm(cpu, instr) {
  const st = cpu.st;
  const byte = (instr & 4096) !== 0;
  const load = (instr & 2048) !== 0;
  let off = instr >>> 6 & 31;
  const rb = instr >>> 3 & 7;
  const rd = instr & 7;
  const addr = byte ? st.r[rb] + off >>> 0 : st.r[rb] + (off << 2) >>> 0;
  if (load) {
    st.r[rd] = (byte ? cpu.bus.read8(addr) : ldrWord(cpu, addr)) | 0;
  } else {
    if (byte) cpu.bus.write8(addr, st.r[rd] & 255);
    else cpu.bus.write32(addr & ~3, st.r[rd] >>> 0);
  }
}
function fmtLoadStoreHalf(cpu, instr) {
  const st = cpu.st;
  const load = (instr & 2048) !== 0;
  const off = (instr >>> 6 & 31) << 1;
  const rb = instr >>> 3 & 7;
  const rd = instr & 7;
  const addr = st.r[rb] + off >>> 0;
  if (load) st.r[rd] = cpu.bus.read16(addr & ~1) | 0;
  else cpu.bus.write16(addr & ~1, st.r[rd] & 65535);
}
function fmtSpRelLoadStore(cpu, instr) {
  const st = cpu.st;
  const load = (instr & 2048) !== 0;
  const rd = instr >>> 8 & 7;
  const off = (instr & 255) << 2;
  const addr = st.r[13] + off >>> 0;
  if (load) st.r[rd] = ldrWord(cpu, addr) | 0;
  else cpu.bus.write32(addr & ~3, st.r[rd] >>> 0);
}
function fmtLoadAddress(cpu, instr) {
  const st = cpu.st;
  const sp = (instr & 2048) !== 0;
  const rd = instr >>> 8 & 7;
  const off = (instr & 255) << 2;
  st.r[rd] = (sp ? st.r[13] + off : (st.r[15] + 2 & ~3) + off) | 0;
}
function fmtMisc(cpu, instr) {
  const st = cpu.st;
  if ((instr & 65280) === 45056) {
    const off = (instr & 127) << 2;
    st.r[13] = instr & 128 ? st.r[13] - off | 0 : st.r[13] + off | 0;
    return;
  }
  if ((instr & 62976) === 46080) {
    const load = (instr & 2048) !== 0;
    const pcLr = (instr & 256) !== 0;
    const list = instr & 255;
    if (load) {
      let sp = st.r[13] >>> 0;
      for (let i = 0; i < 8; i++) if (list & 1 << i) {
        st.r[i] = cpu.bus.read32(sp & ~3) | 0;
        sp = sp + 4 >>> 0;
      }
      if (pcLr) {
        const v = cpu.bus.read32(sp & ~3) >>> 0;
        sp = sp + 4 >>> 0;
        if (v & 1) st.cpsr |= FLAG_T;
        else st.cpsr &= ~FLAG_T;
        st.r[15] = v & ~1;
      }
      st.r[13] = sp | 0;
    } else {
      let count = 0;
      for (let i = 0; i < 8; i++) if (list & 1 << i) count++;
      if (pcLr) count++;
      let sp = st.r[13] - count * 4 >>> 0;
      const base = sp;
      for (let i = 0; i < 8; i++) if (list & 1 << i) {
        cpu.bus.write32(sp & ~3, st.r[i] >>> 0);
        sp = sp + 4 >>> 0;
      }
      if (pcLr) {
        cpu.bus.write32(sp & ~3, st.r[14] >>> 0);
      }
      st.r[13] = base | 0;
    }
  }
}
function fmtBlockTransfer(cpu, instr) {
  const st = cpu.st;
  const load = (instr & 2048) !== 0;
  const rb = instr >>> 8 & 7;
  const list = instr & 255;
  let addr = st.r[rb] >>> 0;
  if (list === 0) {
    if (load) {
      const v = cpu.bus.read32(addr & ~3) >>> 0;
      st.r[15] = v & ~1;
    } else cpu.bus.write32(addr & ~3, st.r[15] + 2 >>> 0);
    st.r[rb] = addr + 64 | 0;
    return;
  }
  for (let i = 0; i < 8; i++) {
    if (!(list & 1 << i)) continue;
    if (load) st.r[i] = cpu.bus.read32(addr & ~3) | 0;
    else cpu.bus.write32(addr & ~3, st.r[i] >>> 0);
    addr = addr + 4 >>> 0;
  }
  if (!(load && list & 1 << rb)) st.r[rb] = addr | 0;
}
function fmtCondBranchOrSwi(cpu, instr) {
  const st = cpu.st;
  const cond = instr >>> 8 & 15;
  if (cond === 15) {
    const comment = instr & 255;
    if (cpu.swiHandler && cpu.swiHandler(comment, cpu)) return;
    cpu.enterException(Mode.SVC, 8, true);
    return;
  }
  if (cond === 14) return;
  if (!condPass(cpu, cond)) return;
  let off = instr & 255;
  if (off & 128) off |= 4294967040;
  off <<= 1;
  st.r[15] = st.r[15] + 2 + off | 0;
}
function fmtLongBranch(cpu, instr) {
  const st = cpu.st;
  const sub = instr >>> 11 & 31;
  if (sub === 28) {
    let off = instr & 2047;
    if (off & 1024) off |= 4294965248;
    off <<= 1;
    st.r[15] = st.r[15] + 2 + off | 0;
    return;
  }
  const offset = instr & 2047;
  if (sub === 30) {
    let hi = offset << 12;
    if (hi & 4194304) hi |= 4286578688;
    st.r[14] = st.r[15] + 2 + hi | 0;
  } else if (sub === 31) {
    const next = (st.r[15] | 1) >>> 0;
    st.r[15] = st.r[14] + (offset << 1) | 0;
    st.r[14] = next | 0;
  }
}
function condPass(cpu, cond) {
  const f = cpu.st.cpsr;
  const N = (f & FLAG_N) !== 0, Z = (f & FLAG_Z) !== 0, C = (f & FLAG_C) !== 0, V = (f & FLAG_V) !== 0;
  switch (cond) {
    case 0:
      return Z;
    case 1:
      return !Z;
    case 2:
      return C;
    case 3:
      return !C;
    case 4:
      return N;
    case 5:
      return !N;
    case 6:
      return V;
    case 7:
      return !V;
    case 8:
      return C && !Z;
    case 9:
      return !C || Z;
    case 10:
      return N === V;
    case 11:
      return N !== V;
    case 12:
      return !Z && N === V;
    case 13:
      return Z || N !== V;
    default:
      return true;
  }
}
function ldrWord(cpu, addr) {
  const aligned = cpu.bus.read32(addr & ~3) >>> 0;
  const rot = (addr & 3) * 8;
  return rot === 0 ? aligned : (aligned >>> rot | aligned << 32 - rot) >>> 0;
}

// src/cpu/arm_core.ts
var ArmCore = class {
  st = new ArmState();
  bus;
  cycles = 0;
  swiHandler = null;
  halted = false;
  // True while inside an active BIOS IntrWait/VBlankIntrWait that has halted and is waiting to be
  // re-polled after an IRQ wake. Used by the BIOS HLE to skip the discardOld clear on re-entry.
  intrWaitActive = false;
  constructor(bus) {
    this.bus = bus;
  }
  /**
   * Reset to GBA cartridge entry behavior.
   *
   * Real hardware runs the Nintendo BIOS before jumping to the cartridge; that BIOS initializes
   * the THREE banked stack pointers and leaves the CPU in System mode. Cartridges (including the
   * jsmolka test ROMs and Pokemon) rely on these being set, since the header just branches to the
   * entry with no stack setup of its own. We replicate the documented BIOS post-boot state:
   *   SP_svc = 0x03007FE0, SP_irq = 0x03007FA0, SP_sys/usr = 0x03007F00, CPU in System mode.
   */
  resetToCartridge() {
    this.st.switchMode(Mode.SVC);
    this.st.r[13] = 50364384;
    this.st.switchMode(Mode.IRQ);
    this.st.r[13] = 50364320;
    this.st.switchMode(Mode.SYS);
    this.st.r[13] = 50364160;
    this.st.cpsr = Mode.SYS | FLAG_I | 1 << 6;
    this.st.r[15] = 134217728;
    this.refillPipeline();
  }
  // ---- condition codes ----
  condPass(cond) {
    const f = this.st.cpsr;
    const N = (f & FLAG_N) !== 0, Z = (f & FLAG_Z) !== 0, C = (f & FLAG_C) !== 0, V = (f & FLAG_V) !== 0;
    switch (cond) {
      case 0:
        return Z;
      // EQ
      case 1:
        return !Z;
      // NE
      case 2:
        return C;
      // CS/HS
      case 3:
        return !C;
      // CC/LO
      case 4:
        return N;
      // MI
      case 5:
        return !N;
      // PL
      case 6:
        return V;
      // VS
      case 7:
        return !V;
      // VC
      case 8:
        return C && !Z;
      // HI
      case 9:
        return !C || Z;
      // LS
      case 10:
        return N === V;
      // GE
      case 11:
        return N !== V;
      // LT
      case 12:
        return !Z && N === V;
      // GT
      case 13:
        return Z || N !== V;
      // LE
      case 14:
        return true;
      // AL
      default:
        return true;
    }
  }
  /** After any direct PC write, re-sync the visible PC (no real prefetch buffer modeled). */
  refillPipeline() {
  }
  // r15 as seen by an executing instruction. NOTE: stepArm/stepThumb already advanced r15 to
  // (instruction_address + instr_size). ARM code observes PC = instruction + 8, so a normal read
  // adds +4 here (since r15 already holds +4); a register-specified shift observes PC = instr + 12,
  // so it adds +8. THUMB reads add +2 (PC observed as instr + 4). Callers pass the right delta.
  readReg(i, pcAhead) {
    if (i === 15) return this.st.r[15] + pcAhead >>> 0;
    return this.st.r[i] >>> 0;
  }
  /** Execute a single instruction (ARM or THUMB depending on T flag). Returns cycles consumed (approx). */
  step() {
    const before = this.cycles;
    if (this.st.cpsr & FLAG_T) this.stepThumb();
    else this.stepArm();
    return this.cycles - before;
  }
  // =========================================================================
  // ARM mode
  // =========================================================================
  stepArm() {
    const pc = this.st.r[15] >>> 0;
    const instr = this.bus.read32(pc) >>> 0;
    this.st.r[15] = pc + 4 | 0;
    this.cycles += 1;
    const cond = instr >>> 28;
    if (!this.condPass(cond)) return;
    if ((instr & 268435440) === 19922704) {
      this.armBX(instr);
      return;
    }
    if ((instr & 201326592) === 0) {
      if ((instr & 264241392) === 144) {
        this.armMUL(instr);
        return;
      }
      if ((instr & 260047088) === 8388752) {
        this.armMULL(instr);
        return;
      }
      if ((instr & 263196656) === 16777360) {
        this.armSWP(instr);
        return;
      }
      if ((instr & 234881168) === 144 && (instr & 96) !== 0) {
        this.armHalfXfer(instr);
        return;
      }
      this.armDataProc(instr);
      return;
    }
    if ((instr & 201326592) === 67108864) {
      this.armSingleXfer(instr);
      return;
    }
    if ((instr & 234881024) === 134217728) {
      this.armBlockXfer(instr);
      return;
    }
    if ((instr & 234881024) === 167772160) {
      this.armBranch(instr);
      return;
    }
    if ((instr & 251658240) === 251658240) {
      this.armSWI(instr);
      return;
    }
  }
  armBX(instr) {
    const rn = instr & 15;
    const addr = this.st.r[rn] >>> 0;
    if (addr & 1) {
      this.st.cpsr |= FLAG_T;
      this.st.r[15] = addr & ~1;
    } else {
      this.st.cpsr &= ~FLAG_T;
      this.st.r[15] = addr & ~3;
    }
  }
  armBranch(instr) {
    const link = (instr & 16777216) !== 0;
    let off = instr & 16777215;
    if (off & 8388608) off |= 4278190080;
    off <<= 2;
    const pc = this.st.r[15] + 4 >>> 0;
    if (link) this.st.r[14] = this.st.r[15] | 0;
    this.st.r[15] = pc + off | 0;
  }
  armSWI(instr) {
    const comment = instr >>> 16 & 255;
    if (this.swiHandler && this.swiHandler(comment, this)) return;
    this.enterException(Mode.SVC, 8, true);
  }
  /** Common exception entry: bank LR/SPSR, set mode, jump to vector. */
  enterException(mode, vector, fromSwi) {
    const retAddr = fromSwi ? this.st.r[15] | 0 : this.st.r[15] | 0;
    const savedCpsr = this.st.cpsr;
    this.st.switchMode(mode);
    this.st.setSpsr(savedCpsr);
    this.st.r[14] = retAddr;
    this.st.cpsr |= FLAG_I;
    this.st.cpsr &= ~FLAG_T;
    this.st.r[15] = vector;
  }
  // ---- data processing ----
  armDataProc(instr) {
    const imm = (instr & 33554432) !== 0;
    const opcode = instr >>> 21 & 15;
    const setFlags = (instr & 1048576) !== 0;
    const rn = instr >>> 16 & 15;
    const rd = instr >>> 12 & 15;
    if (!setFlags && opcode >= 8 && opcode <= 11) {
      this.armPsrTransfer(instr);
      return;
    }
    let op2;
    let shifterCarry = (this.st.cpsr & FLAG_C) !== 0;
    if (imm) {
      const rot = (instr >>> 8 & 15) * 2;
      const val = instr & 255;
      if (rot === 0) op2 = val;
      else {
        op2 = (val >>> rot | val << 32 - rot) >>> 0;
        shifterCarry = (op2 & 2147483648) !== 0;
      }
    } else {
      const rm = instr & 15;
      const type = instr >>> 5 & 3;
      if (instr & 16) {
        const rs = instr >>> 8 & 15;
        const amount = this.readReg(rs, 8) & 255;
        const rmAdj = this.readReg(rm, 8);
        const r = shiftReg(type, rmAdj, amount, shifterCarry);
        op2 = r.value >>> 0;
        shifterCarry = r.carry;
      } else {
        const amount = instr >>> 7 & 31;
        const rmVal = this.readReg(rm, 4);
        const r = shiftImm(type, rmVal, amount, shifterCarry);
        op2 = r.value >>> 0;
        shifterCarry = r.carry;
      }
    }
    const rnAhead = !imm && instr & 16 ? 8 : 4;
    const a = this.readReg(rn, rnAhead) >>> 0;
    const b = op2 >>> 0;
    let result = 0;
    let writeback = true;
    let carry = (this.st.cpsr & FLAG_C) !== 0;
    let overflow = (this.st.cpsr & FLAG_V) !== 0;
    let logical = false;
    switch (opcode) {
      case 0:
        result = (a & b) >>> 0;
        logical = true;
        break;
      // AND
      case 1:
        result = (a ^ b) >>> 0;
        logical = true;
        break;
      // EOR
      case 2: {
        const r = a - b >>> 0;
        carry = a >= b;
        overflow = ((a ^ b) & (a ^ r) & 2147483648) !== 0;
        result = r;
        break;
      }
      // SUB
      case 3: {
        const r = b - a >>> 0;
        carry = b >= a;
        overflow = ((b ^ a) & (b ^ r) & 2147483648) !== 0;
        result = r;
        break;
      }
      // RSB
      case 4: {
        const r = a + b;
        carry = r > 4294967295;
        result = r >>> 0;
        overflow = (~(a ^ b) & (a ^ result) & 2147483648) !== 0;
        break;
      }
      // ADD
      case 5: {
        const cin = this.st.cpsr & FLAG_C ? 1 : 0;
        const r = a + b + cin;
        carry = r > 4294967295;
        result = r >>> 0;
        overflow = (~(a ^ b) & (a ^ result) & 2147483648) !== 0;
        break;
      }
      // ADC
      case 6: {
        const cin = this.st.cpsr & FLAG_C ? 1 : 0;
        const r = a - b - (1 - cin) >>> 0;
        carry = a >= b + (1 - cin);
        overflow = ((a ^ b) & (a ^ r) & 2147483648) !== 0;
        result = r;
        break;
      }
      // SBC
      case 7: {
        const cin = this.st.cpsr & FLAG_C ? 1 : 0;
        const r = b - a - (1 - cin) >>> 0;
        carry = b >= a + (1 - cin);
        overflow = ((b ^ a) & (b ^ r) & 2147483648) !== 0;
        result = r;
        break;
      }
      // RSC
      case 8:
        result = (a & b) >>> 0;
        logical = true;
        writeback = false;
        break;
      // TST
      case 9:
        result = (a ^ b) >>> 0;
        logical = true;
        writeback = false;
        break;
      // TEQ
      case 10: {
        const r = a - b >>> 0;
        carry = a >= b;
        overflow = ((a ^ b) & (a ^ r) & 2147483648) !== 0;
        result = r;
        writeback = false;
        break;
      }
      // CMP
      case 11: {
        const r = a + b;
        carry = r > 4294967295;
        result = r >>> 0;
        overflow = (~(a ^ b) & (a ^ result) & 2147483648) !== 0;
        writeback = false;
        break;
      }
      // CMN
      case 12:
        result = (a | b) >>> 0;
        logical = true;
        break;
      // ORR
      case 13:
        result = b >>> 0;
        logical = true;
        break;
      // MOV
      case 14:
        result = (a & ~b) >>> 0;
        logical = true;
        break;
      // BIC
      case 15:
        result = ~b >>> 0;
        logical = true;
        break;
    }
    if (setFlags) {
      if (rd === 15) {
        if (this.st.hasSpsr()) this.st.writeCpsr(this.st.getSpsr());
      } else {
        this.st.setFlag(FLAG_N, (result & 2147483648) !== 0);
        this.st.setFlag(FLAG_Z, result >>> 0 === 0);
        if (logical) {
          this.st.setFlag(FLAG_C, shifterCarry);
        } else {
          this.st.setFlag(FLAG_C, carry);
          this.st.setFlag(FLAG_V, overflow);
        }
      }
    }
    if (writeback) {
      this.st.r[rd] = result | 0;
      if (rd === 15) {
        this.st.r[15] = this.st.r[15] & ~3;
      }
    }
  }
  armPsrTransfer(instr) {
    const toSpsr = (instr & 4194304) !== 0;
    const isMsr = (instr & 2097152) !== 0;
    if (!isMsr) {
      const rd = instr >>> 12 & 15;
      this.st.r[rd] = (toSpsr ? this.st.getSpsr() : this.st.cpsr) | 0;
      return;
    }
    let value;
    if (instr & 33554432) {
      const rot = (instr >>> 8 & 15) * 2;
      const v = instr & 255;
      value = rot === 0 ? v : (v >>> rot | v << 32 - rot) >>> 0;
    } else {
      value = this.st.r[instr & 15] >>> 0;
    }
    let mask = 0;
    if (instr & 524288) mask |= 4278190080;
    if (instr & 262144) mask |= 16711680;
    if (instr & 131072) mask |= 65280;
    if (instr & 65536) mask |= 255;
    if (this.st.mode === Mode.USR) mask &= 4278190080;
    if (toSpsr) {
      this.st.setSpsr(this.st.getSpsr() & ~mask | value & mask);
    } else {
      const newCpsr = this.st.cpsr & ~mask | value & mask;
      this.st.writeCpsr(newCpsr);
    }
  }
  armMUL(instr) {
    const rd = instr >>> 16 & 15;
    const rn = instr >>> 12 & 15;
    const rs = instr >>> 8 & 15;
    const rm = instr & 15;
    const accumulate = (instr & 2097152) !== 0;
    const setFlags = (instr & 1048576) !== 0;
    let result = Math.imul(this.st.r[rm] | 0, this.st.r[rs] | 0) | 0;
    if (accumulate) result = result + (this.st.r[rn] | 0) | 0;
    this.st.r[rd] = result;
    if (setFlags) {
      this.st.setFlag(FLAG_N, (result & 2147483648) !== 0);
      this.st.setFlag(FLAG_Z, result >>> 0 === 0);
    }
  }
  armMULL(instr) {
    const rdHi = instr >>> 16 & 15;
    const rdLo = instr >>> 12 & 15;
    const rs = instr >>> 8 & 15;
    const rm = instr & 15;
    const signed = (instr & 4194304) !== 0;
    const accumulate = (instr & 2097152) !== 0;
    const setFlags = (instr & 1048576) !== 0;
    const m = signed ? BigInt(this.st.r[rm] | 0) : BigInt(this.st.r[rm] >>> 0);
    const s = signed ? BigInt(this.st.r[rs] | 0) : BigInt(this.st.r[rs] >>> 0);
    let product = m * s;
    if (accumulate) {
      const acc = BigInt(this.st.r[rdHi] >>> 0) << 32n | BigInt(this.st.r[rdLo] >>> 0);
      product = product + acc;
    }
    const lo = Number(product & 0xffffffffn) | 0;
    const hi = Number(product >> 32n & 0xffffffffn) | 0;
    this.st.r[rdLo] = lo;
    this.st.r[rdHi] = hi;
    if (setFlags) {
      this.st.setFlag(FLAG_N, (hi & 2147483648) !== 0);
      this.st.setFlag(FLAG_Z, lo === 0 && hi === 0);
    }
  }
  armSWP(instr) {
    const rn = instr >>> 16 & 15;
    const rd = instr >>> 12 & 15;
    const rm = instr & 15;
    const byte = (instr & 4194304) !== 0;
    const addr = this.st.r[rn] >>> 0;
    if (byte) {
      const tmp = this.bus.read8(addr);
      this.bus.write8(addr, this.st.r[rm] & 255);
      this.st.r[rd] = tmp;
    } else {
      const tmp = this.ldrWord(addr);
      this.bus.write32(addr & ~3, this.st.r[rm] >>> 0);
      this.st.r[rd] = tmp | 0;
    }
  }
  // Rotated unaligned word read (ARM LDR semantics).
  ldrWord(addr) {
    const aligned = this.bus.read32(addr & ~3) >>> 0;
    const rot = (addr & 3) * 8;
    return rot === 0 ? aligned : (aligned >>> rot | aligned << 32 - rot) >>> 0;
  }
  armSingleXfer(instr) {
    const imm = (instr & 33554432) === 0;
    const pre = (instr & 16777216) !== 0;
    const up = (instr & 8388608) !== 0;
    const byte = (instr & 4194304) !== 0;
    const writeback = (instr & 2097152) !== 0;
    const load = (instr & 1048576) !== 0;
    const rn = instr >>> 16 & 15;
    const rd = instr >>> 12 & 15;
    let offset;
    if (imm) offset = instr & 4095;
    else {
      const rm = instr & 15;
      const type = instr >>> 5 & 3;
      const amount = instr >>> 7 & 31;
      offset = shiftImm(type, this.st.r[rm] | 0, amount, (this.st.cpsr & FLAG_C) !== 0).value >>> 0;
    }
    let base = this.readReg(rn, 4) >>> 0;
    let addr = base;
    if (pre) addr = up ? base + offset >>> 0 : base - offset >>> 0;
    const wbAddr = pre ? addr : up ? base + offset >>> 0 : base - offset >>> 0;
    if (load) {
      const val = byte ? this.bus.read8(addr) : this.ldrWord(addr);
      if ((writeback || !pre) && rn !== rd) this.st.r[rn] = wbAddr | 0;
      this.st.r[rd] = val | 0;
      if (rd === 15) this.st.r[15] = this.st.r[15] & ~3;
    } else {
      const val = rd === 15 ? this.st.r[15] + 8 >>> 0 : this.st.r[rd] >>> 0;
      if (byte) this.bus.write8(addr, val & 255);
      else this.bus.write32(addr & ~3, val >>> 0);
      if (writeback || !pre) this.st.r[rn] = wbAddr | 0;
    }
  }
  armHalfXfer(instr) {
    const pre = (instr & 16777216) !== 0;
    const up = (instr & 8388608) !== 0;
    const immForm = (instr & 4194304) !== 0;
    const writeback = (instr & 2097152) !== 0;
    const load = (instr & 1048576) !== 0;
    const rn = instr >>> 16 & 15;
    const rd = instr >>> 12 & 15;
    const sh = instr >>> 5 & 3;
    let offset = immForm ? instr >>> 4 & 240 | instr & 15 : this.st.r[instr & 15] >>> 0;
    let base = this.readReg(rn, 4) >>> 0;
    let addr = base;
    if (pre) addr = up ? base + offset >>> 0 : base - offset >>> 0;
    const wbAddr = pre ? addr : up ? base + offset >>> 0 : base - offset >>> 0;
    if (load) {
      let val = 0;
      switch (sh) {
        case 1:
          val = this.bus.read16(addr & ~1);
          if (addr & 1) val = (val >>> 8 | val << 24) >>> 0;
          break;
        // LDRH (rotated)
        case 2: {
          const b = this.bus.read8(addr);
          val = b & 128 ? b | 4294967040 : b;
          break;
        }
        // LDRSB
        case 3: {
          if (addr & 1) {
            const b = this.bus.read8(addr);
            val = b & 128 ? b | 4294967040 : b;
          } else {
            const h = this.bus.read16(addr);
            val = h & 32768 ? h | 4294901760 : h;
          }
          break;
        }
      }
      if ((writeback || !pre) && rn !== rd) this.st.r[rn] = wbAddr | 0;
      this.st.r[rd] = val | 0;
    } else {
      const val = this.st.r[rd] & 65535;
      this.bus.write16(addr & ~1, val);
      if (writeback || !pre) this.st.r[rn] = wbAddr | 0;
    }
  }
  armBlockXfer(instr) {
    const pre = (instr & 16777216) !== 0;
    const up = (instr & 8388608) !== 0;
    const psrForce = (instr & 4194304) !== 0;
    const writeback = (instr & 2097152) !== 0;
    const load = (instr & 1048576) !== 0;
    const rn = instr >>> 16 & 15;
    const list = instr & 65535;
    let count = 0;
    for (let i = 0; i < 16; i++) if (list & 1 << i) count++;
    const base = this.st.r[rn] >>> 0;
    if (list === 0) {
      const delta = 64;
      let ea;
      let wb;
      if (up) {
        ea = base;
        wb = base + delta >>> 0;
      } else {
        ea = base - delta >>> 0;
        wb = ea;
      }
      const accAddr = (up ? pre ? ea + 4 : ea : pre ? ea : ea + 4) >>> 0;
      if (load) {
        const v = this.bus.read32(accAddr & ~3) >>> 0;
        this.st.r[15] = v & (this.st.cpsr & FLAG_T ? ~1 : ~3);
        this.refillPipeline?.();
      } else {
        this.bus.write32(accAddr & ~3, this.st.r[15] + 8 >>> 0);
      }
      if (writeback) this.st.r[rn] = wb | 0;
      return;
    }
    let addr;
    let finalBase;
    if (up) {
      addr = base;
      finalBase = base + count * 4 >>> 0;
    } else {
      addr = base - count * 4 >>> 0;
      finalBase = addr;
    }
    let ptr = addr;
    const preInc = up ? pre : !pre;
    const baseInList = (list & 1 << rn) !== 0;
    let lowest = -1;
    for (let i = 0; i < 16; i++) if (list & 1 << i) {
      lowest = i;
      break;
    }
    const storeFinalForBase = !load && baseInList && writeback && rn !== lowest;
    const userBank = psrForce && !(load && list & 32768);
    const savedMode = this.st.mode;
    if (userBank && savedMode !== Mode.USR && savedMode !== Mode.SYS) this.st.switchMode(Mode.USR);
    for (let i = 0; i < 16; i++) {
      if (!(list & 1 << i)) continue;
      if (preInc) ptr = ptr + 4 >>> 0;
      if (load) {
        const v = this.bus.read32(ptr & ~3) >>> 0;
        this.st.r[i] = v | 0;
        if (i === 15) {
          if (psrForce && this.st.hasSpsr()) this.st.writeCpsr(this.st.getSpsr());
          this.st.r[15] = this.st.r[15] & (this.st.cpsr & FLAG_T ? ~1 : ~3);
        }
      } else {
        let v;
        if (i === 15) v = this.st.r[15] + 8 >>> 0;
        else if (i === rn && storeFinalForBase) v = finalBase >>> 0;
        else v = this.st.r[i] >>> 0;
        this.bus.write32(ptr & ~3, v);
      }
      if (!preInc) ptr = ptr + 4 >>> 0;
    }
    if (userBank && savedMode !== Mode.USR && savedMode !== Mode.SYS) this.st.switchMode(savedMode);
    if (writeback && !(load && list & 1 << rn)) this.st.r[rn] = finalBase | 0;
  }
  // =========================================================================
  // THUMB mode (delegated to thumb_core for clarity)
  // =========================================================================
  stepThumb() {
    thumbStep(this);
  }
};

// src/runtime/memory.ts
var GbaMemory = class {
  bios = new Uint8Array(16384);
  ewram = new Uint8Array(262144);
  iwram = new Uint8Array(32768);
  palette = new Uint8Array(1024);
  vram = new Uint8Array(98304);
  oam = new Uint8Array(1024);
  rom = new Uint8Array(0);
  sram = new Uint8Array(65536);
  flash = null;
  // when set, region 0x0E is backed by Flash instead of SRAM
  rtc = null;
  // GPIO RTC (Ruby/Sapphire/Emerald)
  io = null;
  // Raw IO register backing store for simple registers the IoBus doesn't intercept.
  ioRegs = new Uint8Array(1024);
  loadRom(bytes) {
    this.rom = bytes;
  }
  /** Provide a tiny BIOS stub so reads from the BIOS region don't fault. Real SWIs are HLE'd. */
  installBiosStub() {
    this.bios.fill(0);
    this.bios[0] = 254;
    this.bios[1] = 255;
    this.bios[2] = 255;
    this.bios[3] = 234;
  }
  romByte(off) {
    return off < this.rom.length ? this.rom[off] : 0;
  }
  // ---------- 8-bit ----------
  read8(addr) {
    addr >>>= 0;
    const region = addr >>> 24 & 255;
    switch (region) {
      case 0:
      case 1:
        return this.bios[addr & 16383];
      case 2:
        return this.ewram[addr & 262143];
      case 3:
        return this.iwram[addr & 32767];
      case 4: {
        const r = addr & 1023;
        if (this.io) return this.io.readIo8(addr & 16777215) & 255;
        return this.ioRegs[r];
      }
      case 5:
        return this.palette[addr & 1023];
      case 6: {
        let o = addr & 131071;
        if (o >= 98304) o -= 32768;
        return this.vram[o];
      }
      case 7:
        return this.oam[addr & 1023];
      case 8:
      case 9:
      case 10:
      case 11:
      case 12:
      case 13: {
        const off = addr & 33554431;
        if (this.rtc && off >= 196 && off <= 201) {
          const v = this.rtc.read(off & ~1);
          return off & 1 ? v >>> 8 & 255 : v & 255;
        }
        return this.romByte(off);
      }
      case 14:
      case 15:
        return this.flash ? this.flash.read(addr & 65535) : this.sram[addr & 65535];
      default:
        return 0;
    }
  }
  read16(addr) {
    addr &= ~1;
    return this.read8(addr) | this.read8(addr + 1) << 8;
  }
  read32(addr) {
    addr &= ~3;
    return (this.read8(addr) | this.read8(addr + 1) << 8 | this.read8(addr + 2) << 16 | this.read8(addr + 3) << 24) >>> 0;
  }
  // ---------- writes ----------
  write8(addr, value) {
    addr >>>= 0;
    value &= 255;
    const region = addr >>> 24 & 255;
    switch (region) {
      case 2:
        this.ewram[addr & 262143] = value;
        break;
      case 3:
        this.iwram[addr & 32767] = value;
        break;
      case 4:
        if (this.io) this.io.writeIo8(addr & 16777215, value);
        else this.ioRegs[addr & 1023] = value;
        break;
      case 5:
        this.palette[addr & 1023] = value;
        break;
      // note: byte writes to palette/VRAM/OAM have quirks; handled at 16-bit
      case 6: {
        let o = addr & 131071;
        if (o >= 98304) o -= 32768;
        this.vram[o] = value;
        break;
      }
      case 7:
        this.oam[addr & 1023] = value;
        break;
      case 8:
      case 9:
      case 10:
      case 11:
      case 12:
      case 13: {
        const off = addr & 33554431;
        if (this.rtc && off >= 196 && off <= 201) {
          const base = off & ~1;
          const prev = this.rtc.read(base);
          const v = off & 1 ? prev & 255 | value << 8 : prev & 65280 | value;
          this.rtc.write(base, v & 65535);
        }
        break;
      }
      case 14:
      case 15:
        if (this.flash) this.flash.write(addr & 65535, value);
        else this.sram[addr & 65535] = value;
        break;
      default:
        break;
    }
  }
  write16(addr, value) {
    addr &= ~1;
    value &= 65535;
    const region = addr >>> 24 & 255;
    if (region === 14 || region === 15) {
      if (this.flash) this.flash.write(addr & 65535, value & 255);
      else this.sram[addr & 65535] = value & 255;
      return;
    }
    if (region === 4 && this.io) {
      this.io.writeIo16(addr & 16777215, value);
      return;
    }
    this.write8(addr, value & 255);
    this.write8(addr + 1, value >>> 8 & 255);
  }
  write32(addr, value) {
    addr &= ~3;
    value >>>= 0;
    const region = addr >>> 24 & 255;
    if (region === 4 && this.io) {
      this.io.writeIo32(addr & 16777215, value);
      return;
    }
    this.write16(addr, value & 65535);
    this.write16(addr + 2, value >>> 16 & 65535);
  }
  // Helpers for PPU/DMA fast paths
  vram16(off) {
    return this.vram[off] | this.vram[off + 1] << 8;
  }
  pal16(off) {
    return this.palette[off] | this.palette[off + 1] << 8;
  }
  oam16(off) {
    return this.oam[off] | this.oam[off + 1] << 8;
  }
};

// src/runtime/io.ts
var REG = {
  DISPCNT: 0,
  DISPSTAT: 4,
  VCOUNT: 6,
  BG0CNT: 8,
  BG1CNT: 10,
  BG2CNT: 12,
  BG3CNT: 14,
  BG0HOFS: 16,
  BG0VOFS: 18,
  BG1HOFS: 20,
  BG1VOFS: 22,
  BG2HOFS: 24,
  BG2VOFS: 26,
  BG3HOFS: 28,
  BG3VOFS: 30,
  BG2PA: 32,
  BG2PB: 34,
  BG2PC: 36,
  BG2PD: 38,
  BG2X: 40,
  BG2Y: 44,
  BG3PA: 48,
  BG3PB: 50,
  BG3PC: 52,
  BG3PD: 54,
  BG3X: 56,
  BG3Y: 60,
  WIN0H: 64,
  WIN1H: 66,
  WIN0V: 68,
  WIN1V: 70,
  WININ: 72,
  WINOUT: 74,
  MOSAIC: 76,
  BLDCNT: 80,
  BLDALPHA: 82,
  BLDY: 84,
  DMA0SAD: 176,
  DMA0DAD: 180,
  DMA0CNT_L: 184,
  DMA0CNT_H: 186,
  DMA1SAD: 188,
  DMA1DAD: 192,
  DMA1CNT_L: 196,
  DMA1CNT_H: 198,
  DMA2SAD: 200,
  DMA2DAD: 204,
  DMA2CNT_L: 208,
  DMA2CNT_H: 210,
  DMA3SAD: 212,
  DMA3DAD: 216,
  DMA3CNT_L: 220,
  DMA3CNT_H: 222,
  TM0CNT_L: 256,
  TM0CNT_H: 258,
  TM1CNT_L: 260,
  TM1CNT_H: 262,
  TM2CNT_L: 264,
  TM2CNT_H: 266,
  TM3CNT_L: 268,
  TM3CNT_H: 270,
  KEYINPUT: 304,
  KEYCNT: 306,
  IE: 512,
  IF: 514,
  WAITCNT: 516,
  IME: 520,
  HALTCNT: 769
};
var GbaIo = class {
  regs = new Uint16Array(1024 >> 1);
  // halfword-addressed
  writeHook = null;
  ifReadHook = null;
  ifAckHook = null;
  haltHook = null;
  fifoWriteHook = null;
  get16(off) {
    return this.regs[(off & 1023) >> 1];
  }
  set16(off, v) {
    this.regs[(off & 1023) >> 1] = v & 65535;
  }
  readIo8(addr) {
    const off = addr & 1023;
    if (off === REG.IF || off === REG.IF + 1) {
      const v = this.ifReadHook ? this.ifReadHook() : this.get16(REG.IF);
      return off & 1 ? v >>> 8 & 255 : v & 255;
    }
    const hw = this.get16(off & ~1);
    return off & 1 ? hw >>> 8 & 255 : hw & 255;
  }
  writeFifoByte(off, value) {
    return off >= 160 && off <= 167 && !!this.fifoWriteHook?.(off, value & 255);
  }
  writeIo16(addr, value) {
    const off = addr & 1023;
    if (off >= 160 && off <= 167) {
      this.writeFifoByte(off, value & 255);
      this.writeFifoByte(off + 1, value >>> 8 & 255);
      return;
    }
    this.writeIo8(addr, value & 255);
    this.writeIo8(addr + 1, value >>> 8 & 255);
  }
  writeIo32(addr, value) {
    const off = addr & 1023;
    if (off >= 160 && off <= 167) {
      this.writeFifoByte(off, value & 255);
      this.writeFifoByte(off + 1, value >>> 8 & 255);
      this.writeFifoByte(off + 2, value >>> 16 & 255);
      this.writeFifoByte(off + 3, value >>> 24 & 255);
      return;
    }
    this.writeIo16(addr, value & 65535);
    this.writeIo16(addr + 2, value >>> 16 & 65535);
  }
  writeIo8(addr, value) {
    const off = addr & 1023;
    const wordOff = off & ~1;
    const prev = this.get16(wordOff);
    let v;
    if (off & 1) v = prev & 255 | (value & 255) << 8;
    else v = prev & 65280 | value & 255;
    if (this.writeFifoByte(off, value & 255)) return;
    if (wordOff === REG.IF) {
      const ackBits = off & 1 ? (value & 255) << 8 : value & 255;
      if (this.ifAckHook) this.ifAckHook(ackBits);
      return;
    }
    if (off === REG.HALTCNT) {
      if (this.haltHook) this.haltHook();
      return;
    }
    this.set16(wordOff, v);
    if (this.writeHook) this.writeHook(wordOff, this.get16(wordOff), prev);
  }
};

// src/runtime/bios_hle.ts
function s16(v) {
  v &= 65535;
  return v & 32768 ? v - 65536 : v;
}
function makeBiosHle(opts = {}) {
  return function handleSwi(comment, cpu) {
    const st = cpu.st;
    const r = st.r;
    const bus = cpu.bus;
    switch (comment) {
      case 0: {
        const flag = bus.read8(50364410) & 255;
        const entry = (flag === 0 ? 134217728 : 33554432) >>> 0;
        if (opts.onSoftReset) opts.onSoftReset({ pc: r[15] >>> 0, lr: r[14] >>> 0, flag, entry });
        for (let a = 50363904; a < 50364416; a += 4) bus.write32(a, 0);
        st.switchMode(Mode.SVC);
        st.r[13] = 50364384;
        st.switchMode(Mode.IRQ);
        st.r[13] = 50364320;
        st.switchMode(Mode.SYS);
        st.r[13] = 50364160;
        st.cpsr = Mode.SYS | FLAG_I;
        st.cpsr &= ~FLAG_T;
        st.r[14] = entry;
        r[15] = entry;
        return true;
      }
      case 1:
        return true;
      case 2:
      // Halt
      case 3:
        cpu.halted = true;
        return true;
      case 4:
      // IntrWait(discardOld=r0, waitFlags=r1)
      case 5: {
        const BIOS_IF = 50364408;
        const discardOld = comment === 5 ? 1 : r[0] & 1;
        const waitFlags = comment === 5 ? 1 : r[1] & 65535;
        const reentry = cpu.intrWaitActive;
        if (discardOld && !reentry) bus.write16(BIOS_IF, bus.read16(BIOS_IF) & ~waitFlags);
        if (bus.read16(BIOS_IF) & waitFlags) {
          bus.write16(BIOS_IF, bus.read16(BIOS_IF) & ~waitFlags);
          cpu.intrWaitActive = false;
          return true;
        }
        cpu.intrWaitActive = true;
        cpu.halted = true;
        if (cpu.st.thumb) cpu.st.r[15] = cpu.st.r[15] - 2 >>> 0;
        else cpu.st.r[15] = cpu.st.r[15] - 4 >>> 0;
        if (opts.onIntrWait) opts.onIntrWait();
        return true;
      }
      case 6: {
        const num = r[0] | 0, den = r[1] | 0;
        if (den === 0) {
          return true;
        }
        const q = num / den | 0;
        const rem = num % den | 0;
        r[0] = q;
        r[1] = rem;
        r[3] = Math.abs(q) | 0;
        return true;
      }
      case 7: {
        const num = r[1] | 0, den = r[0] | 0;
        if (den === 0) return true;
        const q = num / den | 0;
        const rem = num % den | 0;
        r[0] = q;
        r[1] = rem;
        r[3] = Math.abs(q) | 0;
        return true;
      }
      case 8: {
        const v = r[0] >>> 0;
        r[0] = Math.floor(Math.sqrt(v)) >>> 0;
        return true;
      }
      case 9: {
        r[0] = Math.atan((r[0] << 16 >> 16) / 16384) * (16384 / (Math.PI / 2)) | 0;
        return true;
      }
      case 11: {
        let src = r[0] >>> 0, dst = r[1] >>> 0;
        const ctrl = r[2] >>> 0;
        const count = ctrl & 2097151;
        const fixed = (ctrl & 1 << 24) !== 0;
        const word = (ctrl & 1 << 26) !== 0;
        if (word) {
          const fill = fixed ? bus.read32(src) >>> 0 : 0;
          for (let i = 0; i < count; i++) {
            const v = fixed ? fill : bus.read32(src) >>> 0;
            bus.write32(dst, v);
            if (!fixed) src = src + 4 >>> 0;
            dst = dst + 4 >>> 0;
          }
        } else {
          const fill = fixed ? bus.read16(src) & 65535 : 0;
          for (let i = 0; i < count; i++) {
            const v = fixed ? fill : bus.read16(src) & 65535;
            bus.write16(dst, v);
            if (!fixed) src = src + 2 >>> 0;
            dst = dst + 2 >>> 0;
          }
        }
        return true;
      }
      case 12: {
        let src = r[0] >>> 0, dst = r[1] >>> 0;
        const ctrl = r[2] >>> 0;
        let count = ctrl & 2097151;
        count = count + 7 & ~7;
        const fixed = (ctrl & 1 << 24) !== 0;
        const fill = fixed ? bus.read32(src) >>> 0 : 0;
        for (let i = 0; i < count; i++) {
          const v = fixed ? fill : bus.read32(src) >>> 0;
          bus.write32(dst, v);
          if (!fixed) src = src + 4 >>> 0;
          dst = dst + 4 >>> 0;
        }
        return true;
      }
      case 17:
      case 18: {
        lz77(cpu, r[0] >>> 0, r[1] >>> 0, comment === 18);
        return true;
      }
      case 19: {
        huff(cpu, r[0] >>> 0, r[1] >>> 0);
        return true;
      }
      case 20:
      case 21: {
        rlUnComp(cpu, r[0] >>> 0, r[1] >>> 0, comment === 21);
        return true;
      }
      case 14: {
        let src = r[0] >>> 0, dst = r[1] >>> 0;
        const count = r[2] >>> 0;
        for (let i = 0; i < count; i++) {
          const cx = bus.read32(src) | 0;
          const cy = bus.read32(src + 4) | 0;
          const dispX = s16(bus.read16(src + 8));
          const dispY = s16(bus.read16(src + 10));
          const sx = s16(bus.read16(src + 12)) / 256;
          const sy = s16(bus.read16(src + 14)) / 256;
          const angle = (bus.read16(src + 16) >> 8 & 255) / 256 * 2 * Math.PI;
          const ca = Math.cos(angle), sa = Math.sin(angle);
          const pa = ca * sx * 256 | 0;
          const pb = -sa * sx * 256 | 0;
          const pc = sa * sy * 256 | 0;
          const pd = ca * sy * 256 | 0;
          bus.write16(dst, pa & 65535);
          bus.write16(dst + 2, pb & 65535);
          bus.write16(dst + 4, pc & 65535);
          bus.write16(dst + 6, pd & 65535);
          const dx = cx - (pa * dispX + pb * dispY) | 0;
          const dy = cy - (pc * dispX + pd * dispY) | 0;
          bus.write32(dst + 8, dx >>> 0);
          bus.write32(dst + 12, dy >>> 0);
          src = src + 20 >>> 0;
          dst = dst + 16 >>> 0;
        }
        return true;
      }
      case 15: {
        let src = r[0] >>> 0, dst = r[1] >>> 0;
        const count = r[2] >>> 0;
        const stride = r[3] >>> 0;
        for (let i = 0; i < count; i++) {
          const sx = s16(bus.read16(src)) / 256;
          const sy = s16(bus.read16(src + 2)) / 256;
          const angle = (bus.read16(src + 4) >> 8 & 255) / 256 * 2 * Math.PI;
          const ca = Math.cos(angle), sa = Math.sin(angle);
          const pa = ca * sx * 256 | 0;
          const pb = -sa * sx * 256 | 0;
          const pc = sa * sy * 256 | 0;
          const pd = ca * sy * 256 | 0;
          bus.write16(dst, pa & 65535);
          bus.write16(dst + stride >>> 0, pb & 65535);
          bus.write16(dst + 2 * stride >>> 0, pc & 65535);
          bus.write16(dst + 3 * stride >>> 0, pd & 65535);
          src = src + 8 >>> 0;
          dst = dst + 4 * stride >>> 0;
        }
        return true;
      }
      case 16: {
        bitUnpack(cpu, r[0] >>> 0, r[1] >>> 0, r[2] >>> 0);
        return true;
      }
      case 37:
        r[0] = 1;
        return true;
      default:
        return true;
    }
  };
}
function makeSink(cpu, dst, size, vram) {
  const bus = cpu.bus;
  const buf = new Uint8Array(size + 4);
  let written = 0;
  const push = (byte) => {
    if (written < buf.length) buf[written] = byte & 255;
    written++;
  };
  const at = (i) => i >= 0 && i < buf.length ? buf[i] : 0;
  const flush = () => {
    if (vram) {
      for (let i = 0; i < size; i += 2) {
        const lo = buf[i] & 255;
        const hi = (i + 1 < size ? buf[i + 1] : 0) & 255;
        bus.write16(dst + i >>> 0, (lo | hi << 8) & 65535);
      }
    } else {
      for (let i = 0; i < size; i++) bus.write8(dst + i >>> 0, buf[i] & 255);
    }
  };
  return { push, at, flush, count: () => written };
}
function lz77(cpu, src, dst, vram) {
  const bus = cpu.bus;
  const header = bus.read32(src) >>> 0;
  src += 4;
  const size = header >>> 8;
  const sink = makeSink(cpu, dst, size, vram);
  const peek = (a) => bus.read8(a);
  while (sink.count() < size) {
    const flags = peek(src++);
    for (let b = 0; b < 8 && sink.count() < size; b++) {
      if (flags & 128 >> b) {
        const b1 = peek(src++);
        const b2 = peek(src++);
        const len = (b1 >> 4) + 3;
        const disp = ((b1 & 15) << 8 | b2) + 1;
        let pos = sink.count() - disp;
        for (let i = 0; i < len && sink.count() < size; i++) {
          sink.push(sink.at(pos));
          pos++;
        }
      } else {
        sink.push(peek(src++));
      }
    }
  }
  sink.flush();
}
function rlUnComp(cpu, src, dst, vram) {
  const bus = cpu.bus;
  const header = bus.read32(src) >>> 0;
  src += 4;
  const size = header >>> 8;
  const sink = makeSink(cpu, dst, size, vram);
  while (sink.count() < size) {
    const flag = bus.read8(src++);
    if (flag & 128) {
      const len = (flag & 127) + 3;
      const byte = bus.read8(src++);
      for (let i = 0; i < len && sink.count() < size; i++) sink.push(byte);
    } else {
      const len = (flag & 127) + 1;
      for (let i = 0; i < len && sink.count() < size; i++) sink.push(bus.read8(src++));
    }
  }
  sink.flush();
}
function huff(cpu, src, dst) {
  const bus = cpu.bus;
  const header = bus.read32(src) >>> 0;
  const dataSize = header & 15;
  const size = header >>> 8;
  const treeSize = (bus.read8(src + 4) + 1) * 2;
  const treeStart = src + 5;
  let bitstream = src + 4 + treeSize;
  const buf = new Uint8Array(size + 4);
  let outBytes = 0, outAcc = 0, outAccBits = 0;
  const emit = (sym) => {
    outAcc |= (sym & (1 << dataSize) - 1) << outAccBits;
    outAccBits += dataSize;
    while (outAccBits >= 8 && outBytes < buf.length) {
      buf[outBytes++] = outAcc & 255;
      outAcc >>>= 8;
      outAccBits -= 8;
    }
  };
  let curWord = 0, bitsLeft = 0;
  const nextBit = () => {
    if (bitsLeft === 0) {
      curWord = bus.read32(bitstream) >>> 0;
      bitstream += 4;
      bitsLeft = 32;
    }
    const bit = curWord >>> 31 & 1;
    curWord = curWord << 1 >>> 0;
    bitsLeft--;
    return bit;
  };
  let cur = treeStart;
  while (outBytes < size) {
    const bit = nextBit();
    const nodeVal = bus.read8(cur);
    const offset = nodeVal & 63;
    const next = (cur & ~1) + offset * 2 + 2 + bit >>> 0;
    const isLeaf = bit ? nodeVal & 64 : nodeVal & 128;
    if (isLeaf) {
      emit(bus.read8(next));
      cur = treeStart;
    } else cur = next;
  }
  for (let i = 0; i < size; i += 2) {
    const lo = buf[i] & 255, hi = (i + 1 < size ? buf[i + 1] : 0) & 255;
    bus.write16(dst + i >>> 0, (lo | hi << 8) & 65535);
  }
}
function bitUnpack(cpu, src, dst, info) {
  const bus = cpu.bus;
  const srcLen = bus.read16(info) & 65535;
  const srcWidth = bus.read8(info + 2);
  const dstWidth = bus.read8(info + 3);
  const dataOffset = bus.read32(info + 4) >>> 0;
  const zeroFlag = (dataOffset & 2147483648) !== 0;
  const offset = dataOffset & 2147483647;
  let outBuf = 0, outBits = 0;
  let srcByteIdx = 0;
  const mask = (1 << srcWidth) - 1;
  for (let i = 0; i < srcLen; i++) {
    const byte = bus.read8(src + i);
    for (let b = 0; b < 8; b += srcWidth) {
      let unit = byte >> b & mask;
      if (unit !== 0 || zeroFlag) unit = unit + offset >>> 0;
      outBuf |= unit << outBits;
      outBits += dstWidth;
      if (outBits >= 32) {
        bus.write32(dst, outBuf >>> 0);
        dst += 4;
        outBuf = 0;
        outBits = 0;
      }
    }
  }
  if (outBits > 0) bus.write32(dst, outBuf >>> 0);
}

// src/runtime/header.ts
function parseHeader(rom) {
  const ascii = (a, b) => {
    let s = "";
    for (let i = a; i <= b; i++) {
      const c = rom[i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const entryOpcode = (rom[0] | rom[1] << 8 | rom[2] << 16 | rom[3] << 24) >>> 0;
  let chk = 0;
  for (let i = 160; i <= 188; i++) chk = chk - rom[i] & 255;
  chk = chk - 25 & 255;
  return {
    entryOpcode,
    title: ascii(160, 171),
    gameCode: ascii(172, 175),
    makerCode: ascii(176, 177),
    fixedByte: rom[178],
    headerChecksumOk: chk === rom[189]
  };
}

// src/runtime/ppu.ts
var SCREEN_W = 240;
var SCREEN_H = 160;
var CYCLES_PER_SCANLINE = 1232;
var HDRAW_CYCLES = 960;
var TOTAL_SCANLINES = 228;
var DS_VBLANK = 1 << 0;
var DS_HBLANK = 1 << 1;
var DS_VCOUNT = 1 << 2;
var DS_VBLANK_IRQ = 1 << 3;
var DS_HBLANK_IRQ = 1 << 4;
var DS_VCOUNT_IRQ = 1 << 5;
var IRQ_VBLANK = 1 << 0;
var IRQ_HBLANK = 1 << 1;
var IRQ_VCOUNT = 1 << 2;
var GbaPpu = class {
  mem;
  io;
  framebuffer = new Uint8Array(SCREEN_W * SCREEN_H * 4);
  frameReady = false;
  scanlineCycles = 0;
  inHblank = false;
  colorLine = new Uint16Array(SCREEN_W);
  priLine = new Uint8Array(SCREEN_W);
  drawnLine = new Uint8Array(SCREEN_W);
  // Layer id of the top-most pixel: 0-3 = BG0-3, 4 = OBJ, 5 = backdrop.
  topLayer = new Uint8Array(SCREEN_W);
  // Second-from-top color/layer for alpha blending (target B).
  subColor = new Uint16Array(SCREEN_W);
  subLayer = new Uint8Array(SCREEN_W);
  // OBJ window mask + per-OBJ semi-transparent flag for the current scanline.
  objWinMask = new Uint8Array(SCREEN_W);
  objSemiTrans = new Uint8Array(SCREEN_W);
  // Interrupt request callback (set by runtime). Bits per IRQ_* above.
  requestIrq = () => {
  };
  // Called at the start of each HBlank (visible lines) so the runtime can run HBlank DMA.
  onHblank = () => {
  };
  onVblank = () => {
  };
  constructor(mem, io) {
    this.mem = mem;
    this.io = io;
  }
  get vcount() {
    return this.io.get16(REG.VCOUNT) & 255;
  }
  /** Advance the PPU by `cycles` CPU cycles. */
  step(cycles) {
    this.scanlineCycles += cycles;
    if (!this.inHblank && this.scanlineCycles >= HDRAW_CYCLES) {
      this.inHblank = true;
      const line = this.vcount;
      if (line < SCREEN_H) {
        this.renderScanline(line);
        this.onHblank(line);
      }
      let ds = this.io.get16(REG.DISPSTAT);
      ds |= DS_HBLANK;
      this.io.set16(REG.DISPSTAT, ds);
      if (ds & DS_HBLANK_IRQ) this.requestIrq(IRQ_HBLANK);
    }
    if (this.scanlineCycles >= CYCLES_PER_SCANLINE) {
      this.scanlineCycles -= CYCLES_PER_SCANLINE;
      this.inHblank = false;
      let line = this.vcount + 1;
      if (line >= TOTAL_SCANLINES) line = 0;
      this.io.set16(REG.VCOUNT, line);
      let ds = this.io.get16(REG.DISPSTAT) & ~DS_HBLANK;
      const lyc = ds >> 8 & 255;
      if (line === lyc) {
        ds |= DS_VCOUNT;
        if (ds & DS_VCOUNT_IRQ) this.requestIrq(IRQ_VCOUNT);
      } else ds &= ~DS_VCOUNT;
      if (line === SCREEN_H) {
        ds |= DS_VBLANK;
        if (ds & DS_VBLANK_IRQ) this.requestIrq(IRQ_VBLANK);
        this.onVblank();
        this.frameReady = true;
      } else if (line === 0) {
        ds &= ~DS_VBLANK;
      }
      this.io.set16(REG.DISPSTAT, ds);
    }
  }
  // ---- rendering ----
  putPixel(x, y, rgb15) {
    const o = (y * SCREEN_W + x) * 4;
    const r = (rgb15 & 31) << 3, g = (rgb15 >> 5 & 31) << 3, b = (rgb15 >> 10 & 31) << 3;
    this.framebuffer[o] = r | r >> 5;
    this.framebuffer[o + 1] = g | g >> 5;
    this.framebuffer[o + 2] = b | b >> 5;
    this.framebuffer[o + 3] = 255;
  }
  renderScanline(line) {
    const dispcnt = this.io.get16(REG.DISPCNT);
    const mode = dispcnt & 7;
    const backdrop = this.mem.pal16(0);
    const colorLine = this.colorLine;
    const priLine = this.priLine;
    const drawn = this.drawnLine;
    drawn.fill(0);
    this.topLayer.fill(5);
    this.subLayer.fill(5);
    this.objWinMask.fill(0);
    this.objSemiTrans.fill(0);
    for (let x = 0; x < SCREEN_W; x++) {
      colorLine[x] = backdrop;
      priLine[x] = 5;
      this.subColor[x] = backdrop;
    }
    if (mode === 0 || mode === 1 || mode === 2) {
      for (let pr = 3; pr >= 0; pr--) {
        for (let bg = 3; bg >= 0; bg--) {
          if (!(dispcnt & 256 << bg)) continue;
          const bgcnt = this.io.get16(REG.BG0CNT + bg * 2);
          if ((bgcnt & 3) !== pr) continue;
          const affine = mode === 1 && bg === 2 || mode === 2 && (bg === 2 || bg === 3);
          if (affine) this.renderAffineBg(line, bg, bgcnt, colorLine, priLine, drawn);
          else if (mode === 0 || bg < 2) this.renderTextBg(line, bg, bgcnt, colorLine, priLine, drawn);
        }
      }
    } else if (mode === 3) {
      const base = 0;
      for (let x = 0; x < SCREEN_W; x++) {
        const off = base + (line * SCREEN_W + x) * 2;
        colorLine[x] = this.mem.vram16(off);
        drawn[x] = 1;
      }
    } else if (mode === 4) {
      const frame = dispcnt & 16 ? 40960 : 0;
      for (let x = 0; x < SCREEN_W; x++) {
        const idx = this.mem.vram[frame + line * SCREEN_W + x];
        if (idx) {
          colorLine[x] = this.mem.pal16(idx * 2);
          drawn[x] = 1;
        }
      }
    } else if (mode === 5) {
      const frame = dispcnt & 16 ? 40960 : 0;
      if (line < 128) {
        for (let x = 0; x < 160; x++) {
          const off = frame + (line * 160 + x) * 2;
          colorLine[x] = this.mem.vram16(off);
          drawn[x] = 1;
        }
      }
    }
    if (dispcnt & 4096) this.renderSprites(line, dispcnt, colorLine, priLine, drawn);
    this.applyColorEffects(line, dispcnt, colorLine);
    for (let x = 0; x < SCREEN_W; x++) this.putPixel(x, line, colorLine[x]);
  }
  applyColorEffects(line, dispcnt, colorLine) {
    const win0On = (dispcnt & 8192) !== 0;
    const win1On = (dispcnt & 16384) !== 0;
    const winObjOn = (dispcnt & 32768) !== 0;
    const bldcnt = this.io.get16(REG.BLDCNT);
    const effect = bldcnt >> 6 & 3;
    const anyWindow = win0On || win1On || winObjOn;
    if (effect === 0) return;
    const win0h = this.io.get16(REG.WIN0H), win0v = this.io.get16(REG.WIN0V);
    const win1h = this.io.get16(REG.WIN1H), win1v = this.io.get16(REG.WIN1V);
    const w0x1 = win0h >> 8;
    let w0x2 = win0h & 255;
    if (w0x2 > SCREEN_W || w0x2 < w0x1) w0x2 = SCREEN_W;
    const w0y1 = win0v >> 8;
    let w0y2 = win0v & 255;
    if (w0y2 > SCREEN_H || w0y2 < w0y1) w0y2 = SCREEN_H;
    const w1x1 = win1h >> 8;
    let w1x2 = win1h & 255;
    if (w1x2 > SCREEN_W || w1x2 < w1x1) w1x2 = SCREEN_W;
    const w1y1 = win1v >> 8;
    let w1y2 = win1v & 255;
    if (w1y2 > SCREEN_H || w1y2 < w1y1) w1y2 = SCREEN_H;
    const inWin0Row = win0On && line >= w0y1 && line < w0y2;
    const inWin1Row = win1On && line >= w1y1 && line < w1y2;
    const winin = this.io.get16(REG.WININ);
    const winout = this.io.get16(REG.WINOUT);
    const win0Eff = (winin & 32) !== 0;
    const win1Eff = (winin & 8192) !== 0;
    const winObjEff = (winout & 8192) !== 0;
    const winOutEff = (winout & 32) !== 0;
    const bldy = Math.min(16, this.io.get16(REG.BLDY) & 31);
    const bldAlpha = this.io.get16(REG.BLDALPHA);
    const targA = bldcnt & 63;
    for (let x = 0; x < SCREEN_W; x++) {
      let effectEnabled = true;
      if (anyWindow) {
        if (inWin0Row && x >= w0x1 && x < w0x2) effectEnabled = win0Eff;
        else if (inWin1Row && x >= w1x1 && x < w1x2) effectEnabled = win1Eff;
        else if (winObjOn && this.objWinMask[x]) effectEnabled = winObjEff;
        else effectEnabled = winOutEff;
      }
      if (!effectEnabled) continue;
      const layer = this.topLayer[x];
      const layerBit = layer === 5 ? 32 : 1 << layer;
      if ((targA & layerBit) === 0) continue;
      const c = colorLine[x];
      if (effect === 2) colorLine[x] = brighten555(c, bldy);
      else if (effect === 3) colorLine[x] = darken555(c, bldy);
      else if (effect === 1) colorLine[x] = blend555(c, this.subColor[x], bldAlpha);
    }
  }
  renderTextBg(line, bg, bgcnt, colorLine, priLine, drawn) {
    const charBase = (bgcnt >> 2 & 3) * 16384;
    const screenBase = (bgcnt >> 8 & 31) * 2048;
    const colors256 = (bgcnt & 128) !== 0;
    const size = bgcnt >> 14 & 3;
    const widthTiles = size & 1 ? 64 : 32;
    const heightTiles = size & 2 ? 64 : 32;
    const hofs = this.io.get16(REG.BG0HOFS + bg * 4) & 511;
    const vofs = this.io.get16(REG.BG0VOFS + bg * 4) & 511;
    const pr = bgcnt & 3;
    const y = line + vofs & heightTiles * 8 - 1;
    const tileY = y >> 3;
    const inTileY = y & 7;
    for (let sx = 0; sx < SCREEN_W; sx++) {
      const x = sx + hofs & widthTiles * 8 - 1;
      const tileX = x >> 3;
      let blockX = tileX & 31, blockY = tileY & 31;
      let blockIndex = 0;
      if (widthTiles === 64 && tileX & 32) blockIndex += 1;
      if (heightTiles === 64 && tileY & 32) blockIndex += widthTiles === 64 ? 2 : 1;
      const mapOff = screenBase + blockIndex * 2048 + (blockY * 32 + blockX) * 2;
      const entry = this.mem.vram16(mapOff);
      const tileNum = entry & 1023;
      const flipX = (entry & 1024) !== 0;
      const flipY = (entry & 2048) !== 0;
      const palBank = entry >> 12 & 15;
      const py = flipY ? 7 - inTileY : inTileY;
      const px = flipX ? 7 - (x & 7) : x & 7;
      let colorIndex;
      if (colors256) {
        const off = charBase + tileNum * 64 + py * 8 + px;
        colorIndex = this.mem.vram[off];
        if (colorIndex === 0) continue;
        const c = this.mem.pal16(colorIndex * 2);
        if (pr < priLine[sx] || !drawn[sx]) {
          this.subColor[sx] = colorLine[sx];
          this.subLayer[sx] = this.topLayer[sx];
          colorLine[sx] = c;
          priLine[sx] = pr;
          drawn[sx] = 1;
          this.topLayer[sx] = bg;
        }
      } else {
        const off = charBase + tileNum * 32 + py * 4 + (px >> 1);
        const byte = this.mem.vram[off];
        colorIndex = px & 1 ? byte >> 4 : byte & 15;
        if (colorIndex === 0) continue;
        const c = this.mem.pal16((palBank * 16 + colorIndex) * 2);
        if (pr < priLine[sx] || !drawn[sx]) {
          this.subColor[sx] = colorLine[sx];
          this.subLayer[sx] = this.topLayer[sx];
          colorLine[sx] = c;
          priLine[sx] = pr;
          drawn[sx] = 1;
          this.topLayer[sx] = bg;
        }
      }
    }
  }
  renderAffineBg(line, bg, bgcnt, colorLine, priLine, drawn) {
    const charBase = (bgcnt >> 2 & 3) * 16384;
    const screenBase = (bgcnt >> 8 & 31) * 2048;
    const size = bgcnt >> 14 & 3;
    const dim = 128 << size;
    const mask = dim - 1;
    const pr = bgcnt & 3;
    const wrap = (bgcnt & 8192) !== 0;
    const base = bg === 2 ? REG.BG2PA : REG.BG3PA;
    const pa = sign16(this.io.get16(base));
    const pb = sign16(this.io.get16(base + 2));
    const pc = sign16(this.io.get16(base + 4));
    const pd = sign16(this.io.get16(base + 6));
    const xReg = bg === 2 ? REG.BG2X : REG.BG3X;
    const yReg = bg === 2 ? REG.BG2Y : REG.BG3Y;
    const refX = sign28(this.io.get16(xReg) | this.io.get16(xReg + 2) << 16);
    const refY = sign28(this.io.get16(yReg) | this.io.get16(yReg + 2) << 16);
    let texX = refX + pb * line | 0;
    let texY = refY + pd * line | 0;
    for (let sx = 0; sx < SCREEN_W; sx++) {
      let x = texX >> 8, y = texY >> 8;
      texX = texX + pa | 0;
      texY = texY + pc | 0;
      if (wrap) {
        x &= mask;
        y &= mask;
      } else if (x < 0 || y < 0 || x >= dim || y >= dim) continue;
      const tileX = x >> 3, tileY = y >> 3;
      const tileIndex = this.mem.vram[screenBase + tileY * (dim >> 3) + tileX];
      const px = x & 7, py = y & 7;
      const colorIndex = this.mem.vram[charBase + tileIndex * 64 + py * 8 + px];
      if (colorIndex === 0) continue;
      const c = this.mem.pal16(colorIndex * 2);
      if (pr < priLine[sx] || !drawn[sx]) {
        this.subColor[sx] = colorLine[sx];
        this.subLayer[sx] = this.topLayer[sx];
        colorLine[sx] = c;
        priLine[sx] = pr;
        drawn[sx] = 1;
        this.topLayer[sx] = bg;
      }
    }
  }
  renderSprites(line, dispcnt, colorLine, priLine, drawn) {
    const oneDim = (dispcnt & 64) !== 0;
    const objBase = (dispcnt & 7) >= 3 ? 81920 : 65536;
    const bldcnt = this.io.get16(REG.BLDCNT);
    const bldAlpha = this.io.get16(REG.BLDALPHA);
    const alphaEffect = (bldcnt >> 6 & 3) === 1;
    const objFirstTarget = (bldcnt & 16) !== 0;
    for (let i = 127; i >= 0; i--) {
      const a0 = this.mem.oam16(i * 8);
      const a1 = this.mem.oam16(i * 8 + 2);
      const a2 = this.mem.oam16(i * 8 + 4);
      const affine = (a0 & 256) !== 0;
      const disabled = !affine && (a0 & 512) !== 0;
      if (disabled) continue;
      const doubleSize = affine && (a0 & 512) !== 0;
      const objMode = a0 >> 10 & 3;
      const isObjWindow = objMode === 2;
      let y = a0 & 255;
      const shape = a0 >> 14 & 3;
      const sizeBits = a1 >> 14 & 3;
      const [w, h] = spriteSize(shape, sizeBits);
      const bw = doubleSize ? w * 2 : w;
      const bh = doubleSize ? h * 2 : h;
      let x = a1 & 511;
      if (x & 256) x -= 512;
      if (y >= 160) y -= 256;
      if (line < y || line >= y + bh) continue;
      const colors256 = (a0 & 8192) !== 0;
      const tileNum = a2 & 1023;
      const pr = a2 >> 10 & 3;
      const palBank = a2 >> 12 & 15;
      const tilesPerRow = oneDim ? w >> 3 : colors256 ? 16 : 32;
      let pa = 256, pb = 0, pc = 0, pd = 256;
      if (affine) {
        const grp = a1 >> 9 & 31;
        pa = sign16(this.mem.oam16(grp * 32 + 6));
        pb = sign16(this.mem.oam16(grp * 32 + 14));
        pc = sign16(this.mem.oam16(grp * 32 + 22));
        pd = sign16(this.mem.oam16(grp * 32 + 30));
      }
      const flipX = !affine && (a1 & 4096) !== 0;
      const flipY = !affine && (a1 & 8192) !== 0;
      const halfW = bw / 2, halfH = bh / 2;
      const iy = line - y - halfH;
      for (let col = 0; col < bw; col++) {
        const sx = x + col;
        if (sx < 0 || sx >= SCREEN_W) continue;
        const ix = col - halfW;
        let tx, ty;
        if (affine) {
          tx = (pa * ix + pb * iy >> 8) + (w >> 1);
          ty = (pc * ix + pd * iy >> 8) + (h >> 1);
        } else {
          tx = col;
          ty = line - y;
          if (flipX) tx = w - 1 - tx;
          if (flipY) ty = h - 1 - ty;
        }
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        const tileCol = tx >> 3, inTileX = tx & 7;
        const tileRow = ty >> 3, inTileY = ty & 7;
        let ci;
        if (colors256) {
          const tIndex = tileNum + tileRow * tilesPerRow * 2 + tileCol * 2;
          ci = this.mem.vram[objBase + tIndex * 32 + inTileY * 8 + inTileX];
        } else {
          const tIndex = tileNum + tileRow * tilesPerRow + tileCol;
          const byte = this.mem.vram[objBase + tIndex * 32 + inTileY * 4 + (inTileX >> 1)];
          ci = inTileX & 1 ? byte >> 4 : byte & 15;
        }
        if (ci === 0) continue;
        if (isObjWindow) {
          this.objWinMask[sx] = 1;
          continue;
        }
        if (pr <= priLine[sx]) {
          const c = colors256 ? this.mem.pal16(512 + ci * 2) : this.mem.pal16(512 + (palBank * 16 + ci) * 2);
          const doBlend = objMode === 1 || alphaEffect && objFirstTarget;
          this.subColor[sx] = colorLine[sx];
          this.subLayer[sx] = this.topLayer[sx];
          colorLine[sx] = doBlend ? blend555(c, colorLine[sx], bldAlpha) : c;
          priLine[sx] = pr;
          drawn[sx] = 1;
          this.topLayer[sx] = 4;
          this.objSemiTrans[sx] = objMode === 1 ? 1 : 0;
        }
      }
    }
  }
  serializeState() {
    return { scanlineCycles: this.scanlineCycles, inHblank: this.inHblank };
  }
  loadState(s) {
    this.scanlineCycles = s.scanlineCycles;
    this.inHblank = s.inHblank;
  }
};
function blend555(a, b, alpha) {
  let eva = alpha & 31, evb = alpha >> 8 & 31;
  if (eva > 16) eva = 16;
  if (evb > 16) evb = 16;
  const ar = a & 31, ag = a >> 5 & 31, ab = a >> 10 & 31;
  const br = b & 31, bg = b >> 5 & 31, bb = b >> 10 & 31;
  const r = Math.min(31, ar * eva + br * evb >> 4);
  const g = Math.min(31, ag * eva + bg * evb >> 4);
  const bl = Math.min(31, ab * eva + bb * evb >> 4);
  return r | g << 5 | bl << 10;
}
function brighten555(c, evy) {
  const r = c & 31, g = c >> 5 & 31, b = c >> 10 & 31;
  const nr = r + ((31 - r) * evy >> 4);
  const ng = g + ((31 - g) * evy >> 4);
  const nb = b + ((31 - b) * evy >> 4);
  return nr & 31 | (ng & 31) << 5 | (nb & 31) << 10;
}
function darken555(c, evy) {
  const r = c & 31, g = c >> 5 & 31, b = c >> 10 & 31;
  const nr = r - (r * evy >> 4);
  const ng = g - (g * evy >> 4);
  const nb = b - (b * evy >> 4);
  return nr & 31 | (ng & 31) << 5 | (nb & 31) << 10;
}
function sign16(v) {
  v &= 65535;
  return v & 32768 ? v - 65536 : v;
}
function sign28(v) {
  v &= 268435455;
  return v & 134217728 ? v - 268435456 : v;
}
function spriteSize(shape, size) {
  const table = {
    0: [[8, 8], [16, 16], [32, 32], [64, 64]],
    // square
    1: [[16, 8], [32, 8], [32, 16], [64, 32]],
    // wide
    2: [[8, 16], [8, 32], [16, 32], [32, 64]]
    // tall
  };
  return (table[shape] || table[0])[size];
}

// src/runtime/dma.ts
var IRQ_DMA = [1 << 8, 1 << 9, 1 << 10, 1 << 11];
var GbaDma = class {
  mem;
  io;
  requestIrq = () => {
  };
  // Latched internal address/count per channel (reload on enable / repeat).
  srcAddr = [0, 0, 0, 0];
  dstAddr = [0, 0, 0, 0];
  count = [0, 0, 0, 0];
  enabled = [false, false, false, false];
  CNT_H = [REG.DMA0CNT_H, REG.DMA1CNT_H, REG.DMA2CNT_H, REG.DMA3CNT_H];
  SAD = [REG.DMA0SAD, REG.DMA1SAD, REG.DMA2SAD, REG.DMA3SAD];
  DAD = [REG.DMA0DAD, REG.DMA1DAD, REG.DMA2DAD, REG.DMA3DAD];
  CNT_L = [REG.DMA0CNT_L, REG.DMA1CNT_L, REG.DMA2CNT_L, REG.DMA3CNT_L];
  constructor(mem, io) {
    this.mem = mem;
    this.io = io;
  }
  read32IO(off) {
    return (this.io.get16(off) | this.io.get16(off + 2) << 16) >>> 0;
  }
  /** Called when a DMAxCNT_H register is written. Detect enable rising edge. */
  onControlWrite(channel) {
    const ctrl = this.io.get16(this.CNT_H[channel]);
    const wasEnabled = this.enabled[channel];
    const nowEnabled = (ctrl & 32768) !== 0;
    if (nowEnabled && !wasEnabled) {
      this.srcAddr[channel] = this.read32IO(this.SAD[channel]) >>> 0;
      this.dstAddr[channel] = this.read32IO(this.DAD[channel]) >>> 0;
      let cnt = this.io.get16(this.CNT_L[channel]);
      if (cnt === 0) cnt = channel === 3 ? 65536 : 16384;
      this.count[channel] = cnt;
      this.enabled[channel] = true;
      const timing = ctrl >> 12 & 3;
      if (timing === 0) this.runChannel(channel);
    } else if (!nowEnabled) {
      this.enabled[channel] = false;
    }
  }
  /** Trigger timing-based DMAs (VBlank=1, HBlank=2, Special/FIFO=3). */
  trigger(timing) {
    for (let ch = 0; ch < 4; ch++) {
      if (!this.enabled[ch]) continue;
      const ctrl = this.io.get16(this.CNT_H[ch]);
      if ((ctrl >> 12 & 3) === timing) this.runChannel(ch, timing === 3);
    }
  }
  /** Trigger one Direct Sound FIFO DMA channel. FIFO A conventionally uses DMA1, FIFO B DMA2. */
  triggerSoundChannel(ch) {
    if (!this.enabled[ch]) return;
    const ctrl = this.io.get16(this.CNT_H[ch]);
    if ((ctrl >> 12 & 3) === 3) this.runChannel(ch, true);
  }
  runChannel(ch, soundFifo = false) {
    const ctrl = this.io.get16(this.CNT_H[ch]);
    const word = (ctrl & 1024) !== 0;
    const dstCtl = ctrl >> 5 & 3;
    const srcCtl = ctrl >> 7 & 3;
    const repeat = (ctrl & 512) !== 0;
    const irq = (ctrl & 16384) !== 0;
    const unit = word ? 4 : 2;
    let src = this.srcAddr[ch] >>> 0;
    let dst = this.dstAddr[ch] >>> 0;
    const fifoDst = (dst & 268435452) === 67109024 || (dst & 268435452) === 67109028;
    const n = soundFifo && (ch === 1 || ch === 2) && fifoDst ? 4 : this.count[ch];
    for (let i = 0; i < n; i++) {
      const value = word ? this.mem.read32(src) : this.mem.read16(src);
      if (soundFifo && fifoDst && word && this.io.fifoWriteHook) {
        const base = dst & 1023;
        this.io.fifoWriteHook(base, value & 255);
        this.io.fifoWriteHook(base + 1, value >>> 8 & 255);
        this.io.fifoWriteHook(base + 2, value >>> 16 & 255);
        this.io.fifoWriteHook(base + 3, value >>> 24 & 255);
      } else if (word) this.mem.write32(dst, value);
      else this.mem.write16(dst, value);
      src = src + (srcCtl === 1 ? -unit : srcCtl === 2 ? 0 : unit) >>> 0;
      if (!(soundFifo && fifoDst)) dst = dst + (dstCtl === 1 ? -unit : dstCtl === 2 ? 0 : unit) >>> 0;
    }
    this.srcAddr[ch] = src;
    if (soundFifo && fifoDst) this.dstAddr[ch] = this.dstAddr[ch] >>> 0;
    else if (dstCtl !== 3) this.dstAddr[ch] = dst;
    if (irq) this.requestIrq(IRQ_DMA[ch]);
    const timing = ctrl >> 12 & 3;
    if (!repeat || timing === 0) {
      this.enabled[ch] = false;
      this.io.set16(this.CNT_H[ch], ctrl & ~32768);
    }
  }
  serializeState() {
    return { srcAddr: [...this.srcAddr], dstAddr: [...this.dstAddr], count: [...this.count], enabled: [...this.enabled] };
  }
  loadState(s) {
    this.srcAddr = [...s.srcAddr];
    this.dstAddr = [...s.dstAddr];
    this.count = [...s.count];
    this.enabled = [...s.enabled];
  }
};

// src/runtime/timers.ts
var PRESCALER = [1, 64, 256, 1024];
var IRQ_TIMER = [1 << 3, 1 << 4, 1 << 5, 1 << 6];
var GbaTimers = class {
  io;
  requestIrq = () => {
  };
  onOverflow = () => {
  };
  counter = [0, 0, 0, 0];
  reload = [0, 0, 0, 0];
  subcycle = [0, 0, 0, 0];
  enabled = [false, false, false, false];
  CNT_L = [REG.TM0CNT_L, REG.TM1CNT_L, REG.TM2CNT_L, REG.TM3CNT_L];
  CNT_H = [REG.TM0CNT_H, REG.TM1CNT_H, REG.TM2CNT_H, REG.TM3CNT_H];
  constructor(io) {
    this.io = io;
  }
  onReloadWrite(ch) {
    this.reload[ch] = this.io.get16(this.CNT_L[ch]);
  }
  onControlWrite(ch) {
    const ctrl = this.io.get16(this.CNT_H[ch]);
    const en = (ctrl & 128) !== 0;
    if (en && !this.enabled[ch]) {
      this.counter[ch] = this.reload[ch];
      this.subcycle[ch] = 0;
    }
    this.enabled[ch] = en;
  }
  step(cycles) {
    for (let ch = 0; ch < 4; ch++) {
      if (!this.enabled[ch]) continue;
      const ctrl = this.io.get16(this.CNT_H[ch]);
      const countUp = ch > 0 && (ctrl & 4) !== 0;
      if (countUp) continue;
      const ps = PRESCALER[ctrl & 3];
      this.subcycle[ch] += cycles;
      while (this.subcycle[ch] >= ps) {
        this.subcycle[ch] -= ps;
        this.tick(ch, ctrl);
      }
      this.io.set16(this.CNT_L[ch], this.counter[ch] & 65535);
    }
  }
  tick(ch, ctrl) {
    this.counter[ch]++;
    if (this.counter[ch] > 65535) {
      this.counter[ch] = this.reload[ch];
      this.onOverflow(ch);
      if (ctrl & 64) this.requestIrq(IRQ_TIMER[ch]);
      if (ch < 3) {
        const nextCtrl = this.io.get16(this.CNT_H[ch + 1]);
        if (this.enabled[ch + 1] && nextCtrl & 4) this.cascadeTick(ch + 1, nextCtrl);
      }
    }
  }
  cascadeTick(ch, ctrl) {
    this.counter[ch]++;
    if (this.counter[ch] > 65535) {
      this.counter[ch] = this.reload[ch];
      this.onOverflow(ch);
      if (ctrl & 64) this.requestIrq(IRQ_TIMER[ch]);
      if (ch < 3) {
        const nc = this.io.get16(this.CNT_H[ch + 1]);
        if (this.enabled[ch + 1] && nc & 4) this.cascadeTick(ch + 1, nc);
      }
    }
    this.io.set16(this.CNT_L[ch], this.counter[ch] & 65535);
  }
  serializeState() {
    return { counter: [...this.counter], reload: [...this.reload], subcycle: [...this.subcycle], enabled: [...this.enabled] };
  }
  loadState(s) {
    this.counter = [...s.counter];
    this.reload = [...s.reload];
    this.subcycle = [...s.subcycle];
    this.enabled = [...s.enabled];
  }
};

// src/runtime/interrupts.ts
var GbaInterrupts = class {
  io;
  cpu;
  ifFlags = 0;
  // internal IF (the IO IF mirrors this on read)
  // Read accessor for the BIOS interrupt-check halfword (0x03007FF8 / mirror 0x03FFFFF8) that
  // IntrWait/VBlankIntrWait poll. Set by machine after wiring memory; used so request() can mirror
  // the real BIOS handler's behaviour of OR-ing fired+enabled bits into BIOS-IF the instant an IRQ
  // is raised. Without this, a CPU halted in IntrWait races its own SWI re-execution against the
  // IRQ dispatch and can re-halt before BIOS-IF is set — deadlocking the wait (observed as the
  // player-profile / wild-encounter freeze: pc=IntrWait spin, IF=1, biosIF=0 forever).
  biosIfOr = () => {
  };
  // Gate set by the runtime: returns false while a BIOS IRQ-handler frame is still outstanding
  // (dispatched but not yet returned). The interrupt controller must NOT deliver a new IRQ (i.e. must
  // not vector the CPU to 0x18) during that window, otherwise — because the HLE BIOS dispatch is what
  // actually redirects 0x18 to the user handler — the CPU would be stranded at the 0x18 vector with no
  // dispatch, executing whatever lies there and crashing into EWRAM. The pending IRQ instead stays
  // latched in IF and is delivered the instant the current handler returns. This is the correct place
  // for the nested-IRQ guard (NOT inside serviceIrqDispatch, which would early-return and strand the
  // CPU at 0x18).
  canDeliver = () => true;
  constructor(io, cpu) {
    this.io = io;
    this.cpu = cpu;
    io.ifReadHook = () => this.ifFlags & 65535;
    io.ifAckHook = (bits) => {
      this.ifFlags &= ~bits;
    };
  }
  request(bits) {
    this.ifFlags |= bits & 65535;
    this.io.set16(REG.IF, this.ifFlags & 65535);
    const ie = this.io.get16(REG.IE);
    const enabledFired = ie & this.ifFlags & 65535;
    if (enabledFired) {
      this.cpu.halted = false;
    }
  }
  /** Check and possibly deliver an IRQ to the CPU. Call between instructions. */
  poll() {
    const ime = this.io.get16(REG.IME) & 1;
    if (!ime) return;
    if (this.cpu.st.cpsr & FLAG_I) return;
    const ie = this.io.get16(REG.IE);
    const pending = ie & this.ifFlags;
    if (!pending) return;
    if (!this.canDeliver()) return;
    this.deliver();
  }
  deliver() {
    const st = this.cpu.st;
    const retAddr = st.r[15] + 4 >>> 0;
    const savedCpsr = st.cpsr;
    st.switchMode(Mode.IRQ);
    st.setSpsr(savedCpsr);
    st.r[14] = retAddr;
    st.cpsr |= FLAG_I;
    st.cpsr &= ~FLAG_T;
    st.r[15] = 24;
    this.cpu.halted = false;
  }
};

// src/runtime/flash.ts
var FLASH_SIZE = 131072;
var BANK_SIZE = 65536;
var SECTOR_SIZE = 4096;
var ID_MANUFACTURER = 194;
var ID_DEVICE = 9;
var St = { READY: 0, UNLOCK1: 1, UNLOCK2: 2, ERASE1: 3, ERASE2: 4, ERASE3: 5, PROGRAM: 6, BANK: 7 };
var GbaFlash = class {
  data = new Uint8Array(FLASH_SIZE);
  state = St.READY;
  idMode = false;
  bank = 0;
  dirty = false;
  // Operations complete immediately. Ruby verifies Flash writes by reading the target byte back;
  // returning toggle/status bytes here can make the save routine think the write failed/hung.
  constructor(initial) {
    this.data.fill(255);
    if (initial?.length) this.data.set(initial.subarray(0, FLASH_SIZE));
  }
  abs(off) {
    return this.bank * BANK_SIZE + (off & 65535) & FLASH_SIZE - 1;
  }
  setReady(_addr = 0) {
  }
  // Flash command addresses are byte addresses in docs, but GBA halfword writes are aligned by the
  // CPU/bus before reaching memory. Accept both 0x5555 and its aligned 0x5554 form.
  is5555(off) {
    return off === 21845 || off === 21844;
  }
  is2aaa(off) {
    return off === 10922;
  }
  read(addr) {
    const off = addr & 65535;
    if (off === 21845 && !this.idMode) return this.data[this.abs(off)];
    if (this.idMode) {
      if (off === 0) return ID_MANUFACTURER;
      if (off === 1) return ID_DEVICE;
    }
    return this.data[this.abs(off)];
  }
  /** Save-region writes are command-byte writes. For 16-bit bus writes, pass the low byte only. */
  write(addr, value) {
    const off = addr & 65535;
    value &= 255;
    if (value === 240) {
      this.idMode = false;
      this.state = St.READY;
      return;
    }
    if (this.state === St.PROGRAM) {
      const a = this.abs(off);
      this.data[a] &= value;
      this.dirty = true;
      this.state = St.READY;
      this.setReady(off);
      return;
    }
    if (this.state === St.BANK) {
      if (off === 0) this.bank = value & 1;
      this.state = St.READY;
      return;
    }
    switch (this.state) {
      case St.READY:
        if (this.is5555(off) && value === 170) this.state = St.UNLOCK1;
        break;
      case St.UNLOCK1:
        this.state = this.is2aaa(off) && value === 85 ? St.UNLOCK2 : St.READY;
        break;
      case St.UNLOCK2:
        if (!this.is5555(off)) {
          this.state = St.READY;
          break;
        }
        switch (value) {
          case 144:
            this.idMode = true;
            this.state = St.READY;
            break;
          case 128:
            this.state = St.ERASE1;
            break;
          case 160:
            this.state = St.PROGRAM;
            break;
          case 176:
            this.state = St.BANK;
            break;
          default:
            this.state = St.READY;
            break;
        }
        break;
      case St.ERASE1:
        this.state = this.is5555(off) && value === 170 ? St.ERASE2 : St.READY;
        break;
      case St.ERASE2:
        this.state = this.is2aaa(off) && value === 85 ? St.ERASE3 : St.READY;
        break;
      case St.ERASE3:
        if (value === 16 && this.is5555(off)) {
          this.data.fill(255);
          this.dirty = true;
          this.setReady(0);
        } else if (value === 48) {
          const base = this.abs(off) & ~(SECTOR_SIZE - 1);
          this.data.fill(255, base, base + SECTOR_SIZE);
          this.dirty = true;
          this.setReady(off);
        }
        this.state = St.READY;
        break;
    }
  }
  getBank() {
    return this.bank;
  }
  serializeState() {
    return { data: Array.from(this.data), bank: this.bank };
  }
  loadState(s) {
    if (s?.data) this.data.set(s.data);
    this.bank = s?.bank & 1 || 0;
  }
};

// src/runtime/rtc.ts
var Pin = { SCK: 1, SIO: 2, CS: 4 };
var CMD_STATUS = 1;
var CMD_DATETIME = 2;
var CMD_TIME = 3;
function bcd(n) {
  return Math.floor(n / 10) % 10 << 4 | n % 10;
}
function bitReverse8(v) {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    r = r << 1 | v >> i & 1;
  }
  return r & 255;
}
var GbaRtc = class {
  // Pin state as last written by the GBA.
  sck = 0;
  sio = 0;
  cs = 0;
  dir = 0;
  // direction bits (1 = GBA output)
  control = 0;
  // 0x80000c8 bit0 enables pin readback
  // Serial transfer state machine.
  active = false;
  // CS high, transfer in progress
  commandDone = false;
  bitsIn = 0;
  // bits accumulated for the current incoming byte
  curByte = 0;
  command = 0;
  // decoded command byte
  reg = 0;
  // selected register
  reading = false;
  // true once command says "read"
  byteIndex = 0;
  // which parameter byte we're on
  outByte = 0;
  // byte currently being shifted out
  outBits = 0;
  // bits already shifted out of outByte
  // S-3511A status register (24h flag in bit6, power-fail in bit7). 0x40 = 24-hour mode.
  status = 64;
  // Optional debug hook used by bring-up scripts. Kept inert unless a tool assigns it.
  debug = null;
  // Virtual-clock base. We snapshot the host wall clock ONCE at construction and derive the
  // reported time from a monotonic offset. Pokemon validates its save by reading the RTC at two
  // different points during boot and comparing them; if the live host clock ticks a second between
  // those two reads (which happens roughly half the time, depending on exactly when the player
  // presses A), the comparison disagrees and the game reports "save file corrupted". Latching a
  // virtual base makes consecutive reads stable and monotonic, eliminating the race.
  baseEpochMs = Date.now();
  basePerfMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  // While the boot validation window is open, freeze the reported time entirely so the two boot
  // reads are byte-identical. We release the freeze after enough real time has passed that boot is
  // certainly complete; from then on the clock advances normally for in-game day/night.
  bootFreeze = true;
  firstReadPerfMs = -1;
  /** Current virtual time as a Date, latched during boot to defeat the read-vs-read race. */
  virtualNow() {
    const nowPerf = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (this.firstReadPerfMs < 0) this.firstReadPerfMs = nowPerf;
    if (this.bootFreeze) {
      if (nowPerf - this.firstReadPerfMs > 3e3) this.bootFreeze = false;
      else return new Date(this.baseEpochMs);
    }
    return new Date(this.baseEpochMs + (nowPerf - this.basePerfMs));
  }
  /** Build the parameter bytes for a read of the selected register, from the virtual clock. */
  buildReadBytes(reg) {
    const d = this.virtualNow();
    switch (reg) {
      case CMD_STATUS:
        this.status = (this.status | 64) & ~128;
        return [this.status];
      case CMD_DATETIME: {
        const year = d.getFullYear() % 100;
        const month = d.getMonth() + 1;
        const day = d.getDate();
        const weekday = d.getDay();
        let hour = d.getHours();
        const min = d.getMinutes();
        const sec = d.getSeconds();
        return [bcd(year), bcd(month), bcd(day), bcd(weekday), bcd(hour), bcd(min), bcd(sec)];
      }
      case CMD_TIME: {
        return [bcd(d.getHours()), bcd(d.getMinutes()), bcd(d.getSeconds())];
      }
      default:
        return [0, 0, 0, 0, 0, 0, 0];
    }
  }
  outBuf = [];
  /** Called when CS goes high → start of a new command. */
  beginTransfer() {
    this.active = true;
    this.commandDone = false;
    this.bitsIn = 0;
    this.curByte = 0;
    this.reading = false;
    this.byteIndex = 0;
    this.outBuf = [];
    this.outBits = 0;
    this.outByte = 0;
  }
  endTransfer() {
    this.active = false;
    this.commandDone = false;
  }
  /** Decode the just-received command byte and set up read/write of the target register. */
  decodeCommand(byte) {
    this.command = byte;
    let reg = byte >> 1 & 7;
    let read = (byte & 1) !== 0;
    if (byte >> 4 !== 6) {
      const rev = bitReverse8(byte);
      if (rev >> 4 === 6) {
        reg = rev >> 1 & 7;
        read = (rev & 1) !== 0;
      }
    }
    this.reg = reg;
    this.reading = read;
    if (this.debug) this.debug(`RTC cmd raw=0x${byte.toString(16).padStart(2, "0")} reg=${this.reg} read=${this.reading}`);
    if (this.reading) {
      this.outBuf = this.buildReadBytes(this.reg);
      if (this.debug) this.debug(`RTC out=[${this.outBuf.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(",")}]`);
      this.byteIndex = 0;
      this.outByte = this.outBuf.length ? this.outBuf[0] : 0;
      this.outBits = 0;
    }
  }
  /**
   * Clock edge handler. The GBA toggles SCK; data is sampled on the rising edge (write, GBA→RTC)
   * and presented on the falling edge (read, RTC→GBA). We keep it simple: on each SCK low→high we
   * process one bit in the current direction.
   */
  onClockRise() {
    if (!this.active) return;
    if (!this.commandDone) {
      this.curByte = (this.curByte << 1 | this.sio & 1) & 255;
      if (++this.bitsIn === 8) {
        this.commandDone = true;
        this.bitsIn = 0;
        this.decodeCommand(this.curByte);
        this.curByte = 0;
      }
      return;
    }
    if (this.reading) {
      return;
    }
    this.curByte = (this.curByte >> 1 | (this.sio & 1) << 7) & 255;
    if (++this.bitsIn === 8) {
      if (this.reg === CMD_STATUS && this.byteIndex === 0) this.status = (this.curByte | 64) & ~128;
      this.bitsIn = 0;
      this.curByte = 0;
      this.byteIndex++;
    }
  }
  /** Advance the outgoing data bit after the GBA reads it on a clock low (read direction). */
  onClockFall() {
    if (!this.active || !this.commandDone || !this.reading) return;
    if (++this.outBits === 8) {
      this.outBits = 0;
      this.byteIndex++;
      this.outByte = this.byteIndex < this.outBuf.length ? this.outBuf[this.byteIndex] : 0;
    }
  }
  /** Handle a GBA write to a GPIO register. addr is the low 24 bits (e.g. 0xc4/0xc6/0xc8). */
  write(addr, value) {
    switch (addr & 255) {
      case 196: {
        const prevSck = this.sck, prevCs = this.cs;
        const v = value & 15;
        this.cs = v & Pin.CS;
        this.sck = v & Pin.SCK;
        if (this.dir & Pin.SIO) this.sio = v & Pin.SIO ? 1 : 0;
        if (!prevCs && this.cs) {
          if (this.debug) this.debug("RTC CS rise");
          this.beginTransfer();
        } else if (prevCs && !this.cs) {
          if (this.debug) this.debug("RTC CS fall");
          this.endTransfer();
        }
        if (!prevSck && this.sck) this.onClockRise();
        else if (prevSck && !this.sck) this.onClockFall();
        break;
      }
      case 198:
        this.dir = value & 15;
        break;
      // direction
      case 200:
        this.control = value & 1;
        break;
    }
  }
  /** Handle a GBA read from a GPIO register; returns the 16-bit value (only low nibble meaningful). */
  read(addr) {
    switch (addr & 255) {
      case 196: {
        if (!this.control) return 0;
        let v = 0;
        v |= this.sck & Pin.SCK;
        v |= this.cs & Pin.CS;
        if (!(this.dir & Pin.SIO) && this.active && this.commandDone && this.reading) {
          const bit = this.outByte >> this.outBits & 1;
          if (bit) v |= Pin.SIO;
        } else {
          if (this.sio) v |= Pin.SIO;
        }
        return v;
      }
      case 198:
        return this.dir;
      case 200:
        return this.control;
    }
    return 0;
  }
  /** True if the address falls in the GPIO window (so memory.ts knows to route here). */
  static isGpio(off) {
    const a = off & 33554431;
    return a >= 196 && a <= 201;
  }
  serializeState() {
    return { status: this.status };
  }
  loadState(_s) {
  }
};

// src/runtime/audio.ts
var CPU_HZ = 16777216;
var OUT_HZ = 44100;
var FIFO_CAP = 64;
var PcmFifo = class {
  q = [];
  current = 0;
  needsDma = false;
  reset() {
    this.q.length = 0;
    this.current = 0;
    this.needsDma = true;
  }
  pushByte(byte) {
    const s = (byte << 24 >> 24) / 128;
    if (this.q.length >= FIFO_CAP) this.q.shift();
    this.q.push(s);
    if (this.q.length > 16) this.needsDma = false;
  }
  pop() {
    if (this.q.length) this.current = this.q.shift();
    if (this.q.length <= 16) this.needsDma = true;
    return this.current;
  }
  consumeDmaRequest() {
    const r = this.needsDma;
    this.needsDma = false;
    return r;
  }
  get level() {
    return this.q.length;
  }
};
var GbaAudio = class {
  io;
  fifoA = new PcmFifo();
  fifoB = new PcmFifo();
  left = 0;
  right = 0;
  output = [];
  outRead = 0;
  // index into output; avoids O(n) splice/shift on every drain
  sampleAcc = 0;
  lastCycles = 0;
  maxBufferedSamples = OUT_HZ * 2;
  constructor(io) {
    this.io = io;
  }
  /** Handle byte writes to FIFO_A/B IO addresses. DMA writes 32-bit, which arrives as 4 byte writes. */
  writeFifo8(off, value) {
    if (off >= 160 && off <= 163) {
      this.fifoA.pushByte(value & 255);
      return true;
    }
    if (off >= 164 && off <= 167) {
      this.fifoB.pushByte(value & 255);
      return true;
    }
    return false;
  }
  /** Called by IO write side effects for SOUNDCNT_H FIFO reset bits. */
  onSoundCntHWrite() {
    const h = this.io.get16(130);
    if (h & 2048) this.fifoA.reset();
    if (h & 32768) this.fifoB.reset();
  }
  /** Timer overflow clocks Direct Sound FIFO samples. */
  onTimerOverflow(timer) {
    const h = this.io.get16(130);
    const aUsesTimer1 = (h & 1024) !== 0;
    const bUsesTimer1 = (h & 16384) !== 0;
    let a = this.fifoA.current, b = this.fifoB.current;
    if (timer === 0 && !aUsesTimer1 || timer === 1 && aUsesTimer1) a = this.fifoA.pop();
    if (timer === 0 && !bUsesTimer1 || timer === 1 && bUsesTimer1) b = this.fifoB.pop();
    const aVol = h & 4 ? 1 : 0.5;
    const bVol = h & 8 ? 1 : 0.5;
    const ar = (h & 256) !== 0, al = (h & 512) !== 0;
    const br = (h & 4096) !== 0, bl = (h & 8192) !== 0;
    this.left = ((al ? a * aVol : 0) + (bl ? b * bVol : 0)) * 0.35;
    this.right = ((ar ? a * aVol : 0) + (br ? b * bVol : 0)) * 0.35;
  }
  consumeDmaRequest(channel) {
    return channel === 1 ? this.fifoA.consumeDmaRequest() : this.fifoB.consumeDmaRequest();
  }
  /** Advance audio output resampling by CPU cycles. Call once per CPU/hardware step. */
  step(cycles) {
    if ((this.io.get16(132) & 128) === 0) return;
    this.sampleAcc += cycles * OUT_HZ;
    while (this.sampleAcc >= CPU_HZ) {
      this.sampleAcc -= CPU_HZ;
      let l = this.left, r = this.right;
      l = Math.max(-1, Math.min(1, l));
      r = Math.max(-1, Math.min(1, r));
      this.output.push(l, r);
      const maxFloats = this.maxBufferedSamples * 2;
      if (this.output.length - this.outRead > maxFloats) this.outRead = this.output.length - maxFloats;
      if (this.outRead > 16384 && this.outRead > this.output.length >> 1) {
        this.output = this.output.slice(this.outRead);
        this.outRead = 0;
      }
    }
  }
  /** Drain interleaved stereo Float32-ish samples for the browser audio queue. */
  drainSamples(maxFrames = 4096) {
    const available = this.output.length - this.outRead;
    const frames = Math.min(maxFrames, available >> 1);
    const n = frames * 2;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.output[this.outRead + i] || 0;
    this.outRead += n;
    if (this.outRead > 16384 && this.outRead > this.output.length >> 1) {
      this.output = this.output.slice(this.outRead);
      this.outRead = 0;
    }
    return out;
  }
  get bufferedFrames() {
    return this.output.length - this.outRead >> 1;
  }
  serializeState() {
    return { a: this.fifoA.q, b: this.fifoB.q, left: this.left, right: this.right };
  }
  loadState(_s) {
  }
};

// src/runtime/machine.ts
var CYCLES_PER_FRAME = 1232 * 228;
var GbaMachine = class {
  mem = new GbaMemory();
  io = new GbaIo();
  cpu;
  ppu;
  dma;
  timers;
  irq;
  flash;
  rtc;
  audio;
  header;
  instrCount = 0;
  frameCount = 0;
  // Ring buffer of the most recent SWI calls (for SoftReset post-mortem diagnostics).
  _swiRing = [];
  // Key state: 0 = pressed (GBA is active-low). Bit order: A,B,Select,Start,Right,Left,Up,Down,R,L.
  keyState = 1023;
  rom;
  constructor(rom) {
    this.rom = rom;
    this.mem.loadRom(rom);
    this.mem.installBiosStub();
    this.mem.io = this.io;
    this.flash = new GbaFlash();
    this.mem.flash = this.flash;
    this.cpu = new ArmCore(this.mem);
    this.header = parseHeader(rom);
    this.rtc = new GbaRtc();
    this.mem.rtc = this.rtc;
    this.ppu = new GbaPpu(this.mem, this.io);
    this.dma = new GbaDma(this.mem, this.io);
    this.timers = new GbaTimers(this.io);
    this.audio = new GbaAudio(this.io);
    this.irq = new GbaInterrupts(this.io, this.cpu);
    this.irq.canDeliver = () => this._irqDepth < 4 && !(this.cpu.st.r[15] === 24 && this.cpu.st.mode === Mode.IRQ);
    this.irq.biosIfOr = (bits) => {
      const cur = this.mem.read16(50364408) & 65535;
      this.mem.write16(50364408, (cur | bits) & 65535);
    };
    this.ppu.requestIrq = (b) => this.irq.request(b);
    this.dma.requestIrq = (b) => this.irq.request(b);
    this.timers.requestIrq = (b) => this.irq.request(b);
    this.timers.onOverflow = (ch) => {
      this.audio.onTimerOverflow(ch);
      if (ch === 0 || ch === 1) {
        if (this.audio.consumeDmaRequest(1)) this.dma.triggerSoundChannel(1);
        if (this.audio.consumeDmaRequest(2)) this.dma.triggerSoundChannel(2);
      }
    };
    this.io.fifoWriteHook = (off, value) => this.audio.writeFifo8(off, value);
    this.ppu.onVblank = () => this.dma.trigger(1);
    this.ppu.onHblank = () => this.dma.trigger(2);
    this.io.writeHook = (off, _val, _prev) => {
      switch (off) {
        case REG.DMA0CNT_H:
          this.dma.onControlWrite(0);
          break;
        case REG.DMA1CNT_H:
          this.dma.onControlWrite(1);
          break;
        case REG.DMA2CNT_H:
          this.dma.onControlWrite(2);
          break;
        case REG.DMA3CNT_H:
          this.dma.onControlWrite(3);
          break;
        case REG.TM0CNT_L:
          this.timers.onReloadWrite(0);
          break;
        case REG.TM1CNT_L:
          this.timers.onReloadWrite(1);
          break;
        case REG.TM2CNT_L:
          this.timers.onReloadWrite(2);
          break;
        case REG.TM3CNT_L:
          this.timers.onReloadWrite(3);
          break;
        case REG.TM0CNT_H:
          this.timers.onControlWrite(0);
          break;
        case REG.TM1CNT_H:
          this.timers.onControlWrite(1);
          break;
        case REG.TM2CNT_H:
          this.timers.onControlWrite(2);
          break;
        case REG.TM3CNT_H:
          this.timers.onControlWrite(3);
          break;
        case 130:
          this.audio.onSoundCntHWrite();
          break;
      }
    };
    this.io.haltHook = () => {
      this.cpu.halted = true;
    };
    this.io.set16(REG.KEYINPUT, this.keyState);
    this.cpu.swiHandler = makeBiosHle({
      onIntrWait: () => {
        this.cpu.halted = true;
      },
      onSoftReset: (info) => {
        try {
          const mem = this.mem;
          const callerCode = [];
          for (let i = -6; i <= 6; i++) callerCode.push("0x" + (mem.read16(info.lr + i * 2 >>> 0) & 65535).toString(16).padStart(4, "0"));
          const ctx = {
            ...info,
            frame: this.frameCount,
            recentSwis: [...this._swiRing],
            callerCode,
            IE: "0x" + this.io.get16(REG.IE).toString(16),
            IF: "0x" + this.io.get16(REG.IF).toString(16),
            DISPCNT: "0x" + this.io.get16(67108864).toString(16),
            flashDirty: this.flash.dirty
          };
          globalThis.console?.warn(
            `[gba] SoftReset: returning to 0x${info.entry.toString(16)} (flag@0x3007FFA=${info.flag}, swi-from pc=0x${info.pc.toString(16)} lr=0x${info.lr.toString(16)})`,
            ctx
          );
          globalThis.__GBA_LAST_SOFTRESET__ = ctx;
        } catch {
        }
      }
    });
    const innerSwi = this.cpu.swiHandler;
    this.cpu.swiHandler = (comment, cpu) => {
      this._swiRing.push(`0x${comment.toString(16)}@pc0x${(cpu.st.r[15] >>> 0).toString(16)}`);
      if (this._swiRing.length > 24) this._swiRing.shift();
      return innerSwi(comment, cpu);
    };
    this.reset();
  }
  reset() {
    this.cpu.resetToCartridge();
    this.instrCount = 0;
    this.frameCount = 0;
  }
  setKeys(state10bit) {
    this.keyState = state10bit & 1023;
    this.io.set16(REG.KEYINPUT, this.keyState);
  }
  /**
   * BIOS IRQ dispatch (HLE). The real BIOS handler at 0x18 reads the user handler from 0x03007FFC.
   * We detect when the CPU is about to vector to 0x18 and instead jump straight to the user handler
   * with the BIOS calling convention (handler returns via BX LR back into our bridge that restores).
   */
  // IRQ dispatch nesting depth. A user IRQ handler runs with the saved-register frame pushed onto
  // the IRQ stack and returns via the BIOS_IRQ_RETURN sentinel. If a second IRQ were dispatched
  // while we are still inside the first handler's BIOS-frame (before its matching return), the two
  // sentinel returns would alias and the inner restore would pop the OUTER frame — corrupting lr/PC
  // (observed live as lr=0x0 and the CPU running off into EWRAM garbage, then SoftReset, on the
  // HBlank-heavy trainer-card / battle screens where HBlank IRQs fire ~160x/frame and can re-enter
  // a handler that re-enabled IRQs). We therefore refuse to re-dispatch while a BIOS frame is
  // outstanding; the pending IRQ simply stays in IF and is taken the instant the current handler
  // returns. This matches the practical behaviour of the real BIOS handler, which finishes its
  // critical section before the next IRQ is serviced.
  _irqDepth = 0;
  serviceIrqDispatch() {
    if (this.cpu.st.r[15] === 24 && this.cpu.st.mode === Mode.IRQ) {
      if (this._irqDepth >= 4) return;
      const userHandler = this.mem.read32(50364412) >>> 0;
      const fired = this.irq.ifFlags & this.io.get16(REG.IE);
      this.mem.write16(50364408, (this.mem.read16(50364408) | fired) & 65535);
      if (userHandler >= 33554432) {
        const st = this.cpu.st;
        const saved = [st.r[0], st.r[1], st.r[2], st.r[3], st.r[12], st.r[14]];
        for (let i = saved.length - 1; i >= 0; i--) {
          st.r[13] = st.r[13] - 4 >>> 0;
          this.mem.write32(st.r[13], saved[i] >>> 0);
        }
        st.r[14] = BIOS_IRQ_RETURN + this._irqDepth * 4 >>> 0;
        st.cpsr &= ~FLAG_T;
        st.r[15] = userHandler & ~3;
        this._irqDepth++;
      }
    }
  }
  /** Detect the sentinel return from a user IRQ handler and unwind back to interrupted code. */
  handleIrqReturn() {
    const pc15 = this.cpu.st.r[15] >>> 0;
    if (pc15 >= BIOS_IRQ_RETURN && pc15 < BIOS_IRQ_RETURN + 4 * 4 && (pc15 - BIOS_IRQ_RETURN & 3) === 0) {
      const st = this.cpu.st;
      if (this._irqDepth > 0) this._irqDepth--;
      st.r[0] = this.mem.read32(st.r[13]) | 0;
      st.r[13] = st.r[13] + 4 >>> 0;
      st.r[1] = this.mem.read32(st.r[13]) | 0;
      st.r[13] = st.r[13] + 4 >>> 0;
      st.r[2] = this.mem.read32(st.r[13]) | 0;
      st.r[13] = st.r[13] + 4 >>> 0;
      st.r[3] = this.mem.read32(st.r[13]) | 0;
      st.r[13] = st.r[13] + 4 >>> 0;
      st.r[12] = this.mem.read32(st.r[13]) | 0;
      st.r[13] = st.r[13] + 4 >>> 0;
      const ret = this.mem.read32(st.r[13]) >>> 0;
      st.r[13] = st.r[13] + 4 >>> 0;
      if (st.hasSpsr()) st.writeCpsr(st.getSpsr());
      const thumb = (st.cpsr & FLAG_T) !== 0;
      st.r[15] = ret - (thumb ? 4 : 4) >>> 0;
      return true;
    }
    return false;
  }
  isPokemonRubySapphire() {
    return this.header.gameCode === "AXVE" || this.header.gameCode === "AXPE";
  }
  returnFromThumbHle() {
    const st = this.cpu.st;
    const lr = st.r[14] >>> 0;
    st.cpsr |= FLAG_T;
    st.r[15] = lr & ~1;
  }
  hlePokemonGen3FlashHelpers() {
    if (!this.isPokemonRubySapphire()) return null;
    const st = this.cpu.st;
    const pc = st.r[15] >>> 0;
    if (pc === 136182424) {
      const sector = st.r[0] & 255;
      const src = st.r[1] >>> 0;
      if (sector < 32) {
        const base = (sector >= 16 ? 65536 : 0) + (sector & 15) * 4096 >>> 0;
        for (let i = 0; i < 4096; i++) this.flash.data[base + i] = this.mem.read8(src + i);
        this.flash.dirty = true;
        st.r[0] = 0;
      } else {
        st.r[0] = 1;
      }
      this.returnFromThumbHle();
      return 64;
    }
    return null;
  }
  applyPokemonGen3RuntimeFixes() {
    if (!this.isPokemonRubySapphire()) return;
    const st = this.cpu.st;
    const pc = st.r[15] >>> 0;
    if (pc === 134257318 || pc === 134257320 || pc === 134257322 || pc === 134257324) st.r[0] = 0;
  }
  step() {
    if (this.handleIrqReturn()) {
      this.instrCount++;
      return 1;
    }
    const hleCycles = this.hlePokemonGen3FlashHelpers();
    if (hleCycles !== null) {
      this.instrCount++;
      this.ppu.step(hleCycles);
      this.timers.step(hleCycles);
      this.audio.step(hleCycles);
      if (!this.cpu.halted) {
        this.irq.poll();
        this.serviceIrqDispatch();
      }
      return hleCycles;
    }
    const c = this.cpu.step();
    this.applyPokemonGen3RuntimeFixes();
    this.instrCount++;
    this.ppu.step(c);
    this.timers.step(c);
    this.audio.step(c);
    if (!this.cpu.halted) {
      this.irq.poll();
      this.serviceIrqDispatch();
    }
    return c;
  }
  /**
   * Run one full frame worth of cycles (~280896). We deliberately run the WHOLE cycle budget and
   * do NOT bail out the instant VBlank flips — otherwise a main thread that spends most of the
   * frame halted in VBlankIntrWait would never get the post-VBlank CPU time it needs to advance.
   * The framebuffer for display is the one latched at the most recent VBlank.
   */
  runFrame() {
    this.ppu.frameReady = false;
    let guard = 0;
    let cyclesThisFrame = 0;
    const liveSet = this._liveSet;
    liveSet.clear();
    let liveSamples = 0;
    while (cyclesThisFrame < CYCLES_PER_FRAME && guard < 4e6) {
      if (this.cpu.halted) {
        const c2 = 8;
        this.ppu.step(c2);
        this.timers.step(c2);
        this.audio.step(c2);
        this.irq.poll();
        if (!this.cpu.halted) this.serviceIrqDispatch();
        cyclesThisFrame += c2;
        guard++;
        continue;
      }
      const c = this.step();
      cyclesThisFrame += c;
      guard++;
      if ((guard & 63) === 0) {
        liveSet.add(this.cpu.st.r[15] >>> 6 & 262143);
        liveSamples++;
      }
    }
    this.lastFrameLiveness = liveSet.size;
    this.frameCount++;
    return this.ppu.framebuffer;
  }
  /** Distinct PC buckets visited in the last frame (liveness signal for the watchdog). */
  lastFrameLiveness = 0;
  _liveSet = /* @__PURE__ */ new Set();
  pc() {
    return this.cpu.st.r[15] >>> 0;
  }
  thumb() {
    return this.cpu.st.thumb;
  }
  wake() {
    this.cpu.halted = false;
  }
};
var BIOS_IRQ_RETURN = 316;

// src/browser/main.ts
var SCREEN_W2 = 240;
var SCREEN_H2 = 160;
var KEY = {
  A: 0,
  B: 1,
  SELECT: 2,
  START: 3,
  RIGHT: 4,
  LEFT: 5,
  UP: 6,
  DOWN: 7,
  R: 8,
  L: 9
};
var DEFAULT_BINDINGS = {
  // Match the common VBA/No$GBA-style bindings: Z = A, X = B.
  KeyZ: KEY.A,
  KeyX: KEY.B,
  KeyA: KEY.L,
  KeyS: KEY.R,
  Enter: KEY.START,
  ShiftRight: KEY.SELECT,
  Backspace: KEY.SELECT,
  ArrowRight: KEY.RIGHT,
  ArrowLeft: KEY.LEFT,
  ArrowUp: KEY.UP,
  ArrowDown: KEY.DOWN
};
var BrowserAudioSink = class {
  ctx = null;
  node = null;
  ring = new Float32Array(44100 * 2 * 2);
  // 2 seconds stereo
  readIdx = 0;
  writeIdx = 0;
  queued = 0;
  // float samples, not frames
  enabled = false;
  volume = 0.75;
  popSample() {
    if (this.queued <= 0) return 0;
    const v = this.ring[this.readIdx];
    this.readIdx = (this.readIdx + 1) % this.ring.length;
    this.queued--;
    return v;
  }
  pushSample(v) {
    if (this.queued >= this.ring.length) {
      this.readIdx = (this.readIdx + 1) % this.ring.length;
      this.queued--;
    }
    this.ring[this.writeIdx] = v;
    this.writeIdx = (this.writeIdx + 1) % this.ring.length;
    this.queued++;
  }
  async start() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) throw new Error("Web Audio is not supported in this browser");
    if (!this.ctx) {
      this.ctx = new AudioCtor({ sampleRate: 44100 });
      this.node = this.ctx.createScriptProcessor(2048, 0, 2);
      this.node.onaudioprocess = (e) => {
        const l = e.outputBuffer.getChannelData(0), r = e.outputBuffer.getChannelData(1);
        for (let i = 0; i < l.length; i++) {
          l[i] = this.popSample() * this.volume;
          r[i] = this.popSample() * this.volume;
        }
      };
      this.node.connect(this.ctx.destination);
    }
    await this.ctx.resume();
    this.enabled = true;
  }
  stop() {
    this.enabled = false;
    this.readIdx = this.writeIdx = this.queued = 0;
  }
  push(samples) {
    if (!this.enabled || !samples.length) return;
    for (let i = 0; i < samples.length; i++) this.pushSample(samples[i]);
  }
};
var Frontend = class {
  canvas;
  ctx;
  image;
  machine = null;
  saveKey = "";
  legacySaveKeys = [];
  lastSaveFlush = 0;
  lastDirtyState = false;
  pressed = /* @__PURE__ */ new Set();
  running = false;
  speed = 1;
  rafId = 0;
  fps = 0;
  acc = 0;
  lastT = 0;
  frameCounter = 0;
  fpsT = 0;
  // --- Stuck/crash watchdog state ---
  wdLastDispcnt = -1;
  wdLastFbSig = -1;
  wdStuckFrames = 0;
  wdReported = false;
  wdVblankSeen = 0;
  audio = new BrowserAudioSink();
  onStatus = () => {
  };
  onFps = () => {
  };
  onSaveStatus = () => {
  };
  constructor(canvas) {
    this.canvas = canvas;
    this.canvas.width = SCREEN_W2;
    this.canvas.height = SCREEN_H2;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.ctx.imageSmoothingEnabled = false;
    this.image = this.ctx.createImageData(SCREEN_W2, SCREEN_H2);
  }
  loadRom(bytes) {
    this.machine = new GbaMachine(bytes);
    const title = this.machine.header?.title ?? "UNKNOWN";
    const code = this.machine.header?.gameCode ?? "GAME";
    this.saveKey = `gba-save-v3:${code}:${title}`;
    this.legacySaveKeys = [`gba-save:${code}:${title}`, `gba-save-v2:${code}:${title}`];
    this.loadBatterySave();
    this.onStatus(`Loaded: ${title}`);
    this.frameCounter = 0;
    this.start();
  }
  reset() {
    if (!this.machine) return;
    const rom = this.machine.rom ?? this.machine.mem?.rom;
    this.flushBatterySave(true);
    if (rom) {
      this.machine = new GbaMachine(rom);
      this.loadBatterySave();
    }
    this.onStatus("Reset");
  }
  clearBatterySave() {
    const keys = [this.saveKey, ...this.legacySaveKeys].filter(Boolean);
    for (const k of keys) localStorage.removeItem(k);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i) || "";
      if (k.startsWith("gba-save")) localStorage.removeItem(k);
    }
    if (this.machine) {
      this.machine.flash.data.fill(255);
      this.machine.flash.dirty = false;
    }
    this.onStatus("All browser battery saves cleared; reload ROM");
  }
  exportBatterySave() {
    if (!this.machine) return;
    const blob = new Blob([this.machine.flash.data], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pokemon-ruby-flash-128k.sav";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1e3);
    this.updateSaveStatus();
    this.onStatus(`Exported 128K Flash save (${this.countNonFF()} bytes written)`);
  }
  setKey(bit, down) {
    if (down) this.pressed.add(bit);
    else this.pressed.delete(bit);
  }
  applyKeys() {
    if (!this.machine) return;
    let mask = 1023;
    for (const bit of this.pressed) mask &= ~(1 << bit);
    this.machine.setKeys(mask);
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    this.loop(this.lastT);
  }
  pause() {
    this.flushBatterySave(true);
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }
  toggle() {
    this.running ? this.pause() : this.start();
  }
  loop = (t) => {
    if (!this.running || !this.machine) return;
    this.rafId = requestAnimationFrame(this.loop);
    const dt = t - this.lastT;
    this.lastT = t;
    this.acc += dt;
    const frameMs = 1e3 / 60;
    let budget = Math.min(8, Math.floor(this.acc / frameMs * this.speed));
    if (budget < 1 && this.acc >= frameMs) budget = 1;
    for (let i = 0; i < budget; i++) {
      this.applyKeys();
      this.machine.runFrame();
      this.audio.push(this.machine.audio.drainSamples(4096));
      this.flushBatterySave(false);
      if ((this.frameCounter & 31) === 0) this.updateSaveStatus();
      this.frameCounter++;
      this.acc -= frameMs;
      if (this.acc < 0) this.acc = 0;
    }
    if (budget > 0) {
      this.blit();
      this.watchdog();
    }
    this.frameCounter;
    this.fpsT += dt;
    if (this.fpsT >= 500) {
      this.onFps(Math.round(budget > 0 ? 1e3 / (frameMs / this.speed) : 0));
      this.fpsT = 0;
    }
  };
  /**
   * Stuck/crash detector. The player-profile screen and wild-encounter transitions were reported
   * to "crash" (freeze). We can't always reproduce that headlessly, so this records the exact CPU +
   * IO fingerprint the moment the screen stops progressing, and exposes it on window.__GBA_DIAG__
   * plus a one-line console summary. It is purely diagnostic: it never alters emulation.
   */
  watchdog() {
    if (!this.machine) return;
    const m = this.machine;
    const dispcnt = m.io.get16(67108864) & 65535;
    const fb = m.ppu.framebuffer;
    let sig = 0;
    for (let i = 0; i < fb.length; i += 997) sig = sig * 31 + fb[i] >>> 0;
    const liveness = m.lastFrameLiveness | 0;
    const cpuAlive = liveness > 12;
    const progressed = dispcnt !== this.wdLastDispcnt || sig !== this.wdLastFbSig || cpuAlive;
    this.wdLastDispcnt = dispcnt;
    this.wdLastFbSig = sig;
    if (progressed) {
      this.wdStuckFrames = 0;
      if (this.wdReported) {
        this.wdReported = false;
        this.onStatus("Recovered \u2014 screen progressing again");
      }
      return;
    }
    this.wdStuckFrames++;
    if (this.wdStuckFrames === 180 && !this.wdReported) {
      this.wdReported = true;
      const st = m.cpu.st;
      const diag = {
        when: (/* @__PURE__ */ new Date()).toISOString(),
        frame: this.frameCounter,
        pc: "0x" + (st.r[15] >>> 0).toString(16),
        lr: "0x" + (st.r[14] >>> 0).toString(16),
        sp: "0x" + (st.r[13] >>> 0).toString(16),
        cpsr: "0x" + (st.cpsr >>> 0).toString(16),
        thumb: !!(st.cpsr & 32),
        mode: (st.cpsr & 31).toString(16),
        halted: !!m.cpu.halted,
        intrWaitActive: !!m.cpu.intrWaitActive,
        regs: Array.from({ length: 16 }, (_, i) => "0x" + (st.r[i] >>> 0).toString(16)),
        IE: "0x" + m.io.get16(67109376).toString(16),
        IF: "0x" + m.io.get16(67109378).toString(16),
        IME: "0x" + m.io.get16(67109384).toString(16),
        biosIF: "0x" + (m.mem.read16(50364408) & 65535).toString(16),
        userHandler: "0x" + (m.mem.read32(50364412) >>> 0).toString(16),
        DISPCNT: "0x" + dispcnt.toString(16),
        DISPSTAT: "0x" + m.io.get16(67108868).toString(16),
        VCOUNT: m.io.get16(67108870) & 255,
        BLDCNT: "0x" + m.io.get16(67108944).toString(16),
        BLDY: "0x" + m.io.get16(67108948).toString(16),
        MOSAIC: "0x" + m.io.get16(67108940).toString(16),
        DMA0CNT: "0x" + m.io.get16(67109050).toString(16),
        DMA3CNT: "0x" + m.io.get16(67109086).toString(16)
      };
      window.__GBA_DIAG__ = diag;
      console.warn("[gba] WATCHDOG: screen frozen ~3s. Fingerprint captured on window.__GBA_DIAG__:\n", diag);
      this.onStatus("\u26A0 Screen frozen \u2014 diagnostic captured (see console: __GBA_DIAG__)");
    }
  }
  blit() {
    const fb = this.machine.ppu.framebuffer;
    this.image.data.set(fb);
    this.ctx.putImageData(this.image, 0, 0);
  }
  loadBatterySave() {
    if (!this.machine || !this.saveKey) return;
    try {
      const s = localStorage.getItem(this.saveKey);
      if (!s) {
        this.onStatus("Fresh battery save");
        return;
      }
      const bin = atob(s);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      this.machine.flash.data.set(data.subarray(0, this.machine.flash.data.length));
      this.machine.flash.dirty = false;
      this.lastDirtyState = false;
      this.onStatus("Loaded battery save");
    } catch (e) {
      console.warn("Failed to load battery save", e);
    }
  }
  countNonFF() {
    if (!this.machine) return 0;
    let n = 0;
    for (const b of this.machine.flash.data) if (b !== 255) n++;
    return n;
  }
  updateSaveStatus() {
    if (!this.machine) return;
    this.onSaveStatus(`Flash: ${this.countNonFF()} bytes written | dirty=${this.machine.flash.dirty ? "yes" : "no"}`);
  }
  flushBatterySave(force) {
    if (!this.machine || !this.saveKey) return;
    const now = performance.now();
    this.lastDirtyState = this.machine.flash.dirty;
    if (!force && (!this.machine.flash.dirty || now - this.lastSaveFlush < 3e3)) return;
    try {
      let s = "";
      const d = this.machine.flash.data;
      for (let i = 0; i < d.length; i += 32768) {
        s += String.fromCharCode(...d.subarray(i, Math.min(i + 32768, d.length)));
      }
      localStorage.setItem(this.saveKey, btoa(s));
      this.machine.flash.dirty = false;
      this.lastDirtyState = false;
      this.lastSaveFlush = now;
      this.updateSaveStatus();
      if (force) this.onStatus(`Battery save flushed (${this.countNonFF()} bytes written)`);
    } catch (e) {
      console.warn("Failed to persist battery save", e);
    }
  }
  async enableAudio() {
    await this.audio.start();
    this.onStatus("Live game audio enabled");
  }
  disableAudio() {
    this.audio.stop();
    this.onStatus("Audio muted");
  }
  screenshot() {
    return this.canvas.toDataURL("image/png");
  }
};
function boot() {
  const canvas = document.getElementById("screen");
  const fe = new Frontend(canvas);
  const status = document.getElementById("status");
  const fpsEl = document.getElementById("fps");
  const saveStatusEl = document.getElementById("save-status");
  fe.onStatus = (s) => {
    status.textContent = s;
  };
  fe.onFps = (n) => {
    fpsEl.textContent = n > 0 ? `${n} fps` : "";
  };
  fe.onSaveStatus = (s) => {
    saveStatusEl.textContent = s;
  };
  const picker = document.getElementById("rom");
  picker.addEventListener("change", async () => {
    const f = picker.files?.[0];
    if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    fe.loadRom(buf);
  });
  document.body.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  document.body.addEventListener("drop", async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    fe.loadRom(new Uint8Array(await f.arrayBuffer()));
  });
  window.addEventListener("keydown", (e) => {
    const bit = DEFAULT_BINDINGS[e.code];
    if (bit !== void 0) {
      e.preventDefault();
      fe.setKey(bit, true);
    }
    if (e.code === "Space") {
      e.preventDefault();
      fe.toggle();
    }
  });
  window.addEventListener("keyup", (e) => {
    const bit = DEFAULT_BINDINGS[e.code];
    if (bit !== void 0) {
      e.preventDefault();
      fe.setKey(bit, false);
    }
  });
  document.querySelectorAll("[data-key]").forEach((el) => {
    const bit = parseInt(el.dataset.key, 10);
    const down = (e) => {
      e.preventDefault();
      fe.setKey(bit, true);
      el.classList.add("active");
    };
    const up = (e) => {
      e.preventDefault();
      fe.setKey(bit, false);
      el.classList.remove("active");
    };
    el.addEventListener("mousedown", down);
    el.addEventListener("mouseup", up);
    el.addEventListener("mouseleave", up);
    el.addEventListener("touchstart", down, { passive: false });
    el.addEventListener("touchend", up);
  });
  document.getElementById("btn-pause")?.addEventListener("click", () => fe.toggle());
  document.getElementById("btn-reset")?.addEventListener("click", () => fe.reset());
  document.getElementById("btn-clear-save")?.addEventListener("click", () => fe.clearBatterySave());
  document.getElementById("btn-export-save")?.addEventListener("click", () => fe.exportBatterySave());
  document.getElementById("btn-audio")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-audio");
    try {
      if (!fe.audio.enabled) {
        await fe.enableAudio();
        btn.textContent = "\u{1F50A} Audio On";
        btn.classList.add("active");
      } else {
        fe.disableAudio();
        btn.textContent = "\u{1F507} Audio Off";
        btn.classList.remove("active");
      }
    } catch (err) {
      status.textContent = "Audio error: " + (err?.message || err);
    }
  });
  window.addEventListener("beforeunload", () => fe.flushBatterySave(true));
  document.getElementById("btn-shot")?.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = fe.screenshot();
    a.download = "gba-screenshot.png";
    a.click();
  });
  const speedSel = document.getElementById("speed");
  speedSel?.addEventListener("change", () => {
    fe.speed = parseFloat(speedSel.value);
  });
  window.GBA = fe;
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
