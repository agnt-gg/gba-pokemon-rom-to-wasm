/**
 * Compact ARM7TDMI (ARMv4T) disassembler for the in-emulator debugger.
 *
 * Covers every instruction class the CPU core executes (DP, MUL/MULL, SWP, halfword/signed
 * transfers, LDR/STR, LDM/STM incl. push/pop aliases, B/BL/BX, MRS/MSR, SWI, and all 19 THUMB
 * formats). Unknown encodings render as `.word`/`.hword` so the view never throws.
 *
 * Also exports cheap mnemonic classifiers (armMnemonic / thumbMnemonic) used by the debugger's
 * execution-weighted opcode histogram — they avoid building full strings in the hot loop.
 */

const CC = ['eq', 'ne', 'cs', 'cc', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le', '', 'nv'];
const DP = ['and', 'eor', 'sub', 'rsb', 'add', 'adc', 'sbc', 'rsc', 'tst', 'teq', 'cmp', 'cmn', 'orr', 'mov', 'bic', 'mvn'];
const SH = ['lsl', 'lsr', 'asr', 'ror'];

function R(n: number): string { return n === 13 ? 'sp' : n === 14 ? 'lr' : n === 15 ? 'pc' : 'r' + n; }
function hx(n: number): string { return '0x' + (n >>> 0).toString(16); }
function rlist(list: number, max = 16): string {
  const parts: string[] = [];
  for (let i = 0; i < max; i++) {
    if (!(list & (1 << i))) continue;
    let j = i;
    while (j + 1 < max && (list & (1 << (j + 1)))) j++;
    parts.push(j > i + 1 ? `${R(i)}-${R(j)}` : j === i + 1 ? `${R(i)}, ${R(j)}` : R(i));
    i = j;
  }
  return '{' + parts.join(', ') + '}';
}

/** ARM operand2 (register form) as text. */
function op2reg(i: number): string {
  const rm = R(i & 15);
  const stype = (i >>> 5) & 3;
  if (i & 0x10) return `${rm}, ${SH[stype]} ${R((i >>> 8) & 15)}`; // register-specified shift
  const amt = (i >>> 7) & 0x1f;
  if (amt === 0 && stype === 0) return rm;                          // lsl #0 == plain
  if (amt === 0 && stype === 3) return `${rm}, rrx`;
  return `${rm}, ${SH[stype]} #${amt === 0 ? 32 : amt}`;
}

export function disasmArm(i: number, pc: number): string {
  i >>>= 0;
  const c = CC[(i >>> 28) & 15];
  if (((i >>> 28) & 15) === 15) return '.word ' + hx(i);

  if ((i & 0x0ffffff0) === 0x012fff10) return `bx${c} ${R(i & 15)}`;
  if ((i & 0x0e000000) === 0x0a000000) {
    let off = i & 0xffffff; if (off & 0x800000) off |= 0xff000000;
    return `${(i & 0x1000000) ? 'bl' : 'b'}${c} ${hx((pc + 8 + (off << 2)) >>> 0)}`;
  }
  if ((i & 0x0f000000) === 0x0f000000) return `swi${c} ${hx((i >>> 16) & 0xff)}`;
  if ((i & 0x0fc000f0) === 0x00000090) {
    const s = (i & 0x100000) ? 's' : '';
    const rd = R((i >>> 16) & 15), rm = R(i & 15), rs = R((i >>> 8) & 15), rn = R((i >>> 12) & 15);
    return (i & 0x200000) ? `mla${c}${s} ${rd}, ${rm}, ${rs}, ${rn}` : `mul${c}${s} ${rd}, ${rm}, ${rs}`;
  }
  if ((i & 0x0f8000f0) === 0x00800090) {
    const nm = ((i & 0x400000) ? 's' : 'u') + ((i & 0x200000) ? 'mlal' : 'mull');
    const s = (i & 0x100000) ? 's' : '';
    return `${nm}${c}${s} ${R((i >>> 12) & 15)}, ${R((i >>> 16) & 15)}, ${R(i & 15)}, ${R((i >>> 8) & 15)}`;
  }
  if ((i & 0x0fb00ff0) === 0x01000090) return `swp${c}${(i & 0x400000) ? 'b' : ''} ${R((i >>> 12) & 15)}, ${R(i & 15)}, [${R((i >>> 16) & 15)}]`;
  if ((i & 0x0e000090) === 0x00000090 && (i & 0x60) !== 0) {
    const pre = !!(i & 0x1000000), up = !!(i & 0x800000), imm = !!(i & 0x400000), wb = !!(i & 0x200000), ld = !!(i & 0x100000);
    const sh = (i >>> 5) & 3;
    const nm = ld ? (sh === 1 ? 'ldrh' : sh === 2 ? 'ldrsb' : 'ldrsh') : 'strh';
    const off = imm ? '#' + (up ? '' : '-') + (((i >>> 4) & 0xf0) | (i & 15)) : (up ? '' : '-') + R(i & 15);
    const rn = R((i >>> 16) & 15), rd = R((i >>> 12) & 15);
    return pre ? `${nm}${c} ${rd}, [${rn}, ${off}]${wb ? '!' : ''}` : `${nm}${c} ${rd}, [${rn}], ${off}`;
  }
  if ((i & 0x0c000000) === 0x00000000) {
    const op = (i >>> 21) & 15, S = !!(i & 0x100000);
    if (!S && op >= 8 && op <= 11) {
      // PSR transfers hide in test-op space with S=0.
      const spsr = !!(i & 0x400000);
      if (op === 8 || op === 10) return `mrs${c} ${R((i >>> 12) & 15)}, ${spsr ? 'spsr' : 'cpsr'}`;
      const f = (i >>> 16) & 15;
      const fields = (f & 1 ? 'c' : '') + (f & 2 ? 'x' : '') + (f & 4 ? 's' : '') + (f & 8 ? 'f' : '');
      const src = (i & 0x2000000) ? '#' + hx(armImmValue(i)) : R(i & 15);
      return `msr${c} ${spsr ? 'spsr' : 'cpsr'}_${fields || 'all'}, ${src}`;
    }
    const o2 = (i & 0x2000000) ? '#' + hx(armImmValue(i)) : op2reg(i);
    const rn = R((i >>> 16) & 15), rd = R((i >>> 12) & 15);
    const s = S ? 's' : '';
    if (op >= 8 && op <= 11) return `${DP[op]}${c} ${rn}, ${o2}`;
    if (op === 13 || op === 15) return `${DP[op]}${c}${s} ${rd}, ${o2}`;
    return `${DP[op]}${c}${s} ${rd}, ${rn}, ${o2}`;
  }
  if ((i & 0x0c000000) === 0x04000000) {
    const I = !!(i & 0x2000000), pre = !!(i & 0x1000000), up = !!(i & 0x800000), B = !!(i & 0x400000), W = !!(i & 0x200000), L = !!(i & 0x100000);
    const nm = (L ? 'ldr' : 'str') + (B ? 'b' : '');
    const rn = R((i >>> 16) & 15), rd = R((i >>> 12) & 15);
    const off = I ? (up ? '' : '-') + op2reg(i) : '#' + (up ? '' : '-') + (i & 0xfff);
    return pre ? `${nm}${c} ${rd}, [${rn}${(i & 0xfff) || I ? ', ' + off : ''}]${W ? '!' : ''}` : `${nm}${c} ${rd}, [${rn}], ${off}`;
  }
  if ((i & 0x0e000000) === 0x08000000) {
    const pre = !!(i & 0x1000000), up = !!(i & 0x800000), W = !!(i & 0x200000), L = !!(i & 0x100000);
    const rn = (i >>> 16) & 15;
    const list = rlist(i & 0xffff);
    if (L && rn === 13 && !pre && up && W) return `pop${c} ${list}`;
    if (!L && rn === 13 && pre && !up && W) return `push${c} ${list}`;
    const mode = up ? (pre ? 'ib' : 'ia') : (pre ? 'db' : 'da');
    return `${L ? 'ldm' : 'stm'}${c}${mode} ${R(rn)}${W ? '!' : ''}, ${list}${(i & 0x400000) ? '^' : ''}`;
  }
  return '.word ' + hx(i);
}

function armImmValue(i: number): number {
  const imm = i & 0xff, rot = ((i >> 8) & 0xf) * 2;
  return rot === 0 ? imm : (((imm >>> rot) | (imm << (32 - rot))) >>> 0);
}

const T_ALU = ['and', 'eor', 'lsl', 'lsr', 'asr', 'adc', 'sbc', 'ror', 'tst', 'neg', 'cmp', 'cmn', 'orr', 'mul', 'bic', 'mvn'];

export function disasmThumb(i: number, pc: number): string {
  i &= 0xffff;
  const top = i >>> 13;
  if (top === 0b000) {
    const op = (i >>> 11) & 3;
    const rd = R(i & 7), rs = R((i >>> 3) & 7);
    if (op === 3) {
      const rnImm = (i >>> 6) & 7;
      const nm = (i & 0x200) ? 'sub' : 'add';
      return (i & 0x400) ? `${nm} ${rd}, ${rs}, #${rnImm}` : `${nm} ${rd}, ${rs}, ${R(rnImm)}`;
    }
    return `${SH[op]} ${rd}, ${rs}, #${(i >>> 6) & 0x1f}`;
  }
  if (top === 0b001) {
    const op = ['mov', 'cmp', 'add', 'sub'][(i >>> 11) & 3];
    return `${op} ${R((i >>> 8) & 7)}, #${i & 0xff}`;
  }
  if (top === 0b010) {
    if ((i & 0xfc00) === 0x4000) {
      const op = (i >>> 6) & 15;
      return `${T_ALU[op]} ${R(i & 7)}, ${R((i >>> 3) & 7)}`;
    }
    if ((i & 0xfc00) === 0x4400) {
      const op = (i >>> 8) & 3;
      let rd = (i & 7) + ((i & 0x80) ? 8 : 0);
      const rs = ((i >>> 3) & 7) + ((i & 0x40) ? 8 : 0);
      if (op === 3) return `bx ${R(rs)}`;
      return `${['add', 'cmp', 'mov'][op]} ${R(rd)}, ${R(rs)}`;
    }
    if ((i & 0xf800) === 0x4800) {
      const addr = (((pc + 4) & ~3) + ((i & 0xff) << 2)) >>> 0;
      return `ldr ${R((i >>> 8) & 7)}, [pc, #${(i & 0xff) << 2}]  ; ${hx(addr)}`;
    }
    const ro = R((i >>> 6) & 7), rb = R((i >>> 3) & 7), rd = R(i & 7);
    if ((i & 0x0200) === 0) {
      const nm = ((i & 0x800) ? 'ldr' : 'str') + ((i & 0x400) ? 'b' : '');
      return `${nm} ${rd}, [${rb}, ${ro}]`;
    }
    const nm = [(i & 0x800) ? 'ldrh' : 'strh', (i & 0x800) ? 'ldrsh' : 'ldrsb'][(i >>> 10) & 1];
    return `${nm} ${rd}, [${rb}, ${ro}]`;
  }
  if (top === 0b011) {
    const byte = !!(i & 0x1000);
    const nm = ((i & 0x800) ? 'ldr' : 'str') + (byte ? 'b' : '');
    const off = (i >>> 6) & 0x1f;
    return `${nm} ${R(i & 7)}, [${R((i >>> 3) & 7)}, #${byte ? off : off << 2}]`;
  }
  if (top === 0b100) {
    if ((i & 0xf000) === 0x8000) {
      return `${(i & 0x800) ? 'ldrh' : 'strh'} ${R(i & 7)}, [${R((i >>> 3) & 7)}, #${((i >>> 6) & 0x1f) << 1}]`;
    }
    return `${(i & 0x800) ? 'ldr' : 'str'} ${R((i >>> 8) & 7)}, [sp, #${(i & 0xff) << 2}]`;
  }
  if (top === 0b101) {
    if ((i & 0xf000) === 0xa000) {
      return `add ${R((i >>> 8) & 7)}, ${(i & 0x800) ? 'sp' : 'pc'}, #${(i & 0xff) << 2}`;
    }
    if ((i & 0xff00) === 0xb000) return `${(i & 0x80) ? 'sub' : 'add'} sp, #${(i & 0x7f) << 2}`;
    if ((i & 0xf600) === 0xb400) {
      const pop = !!(i & 0x800);
      let list = i & 0xff;
      let extra = '';
      if (i & 0x100) extra = (list ? ', ' : '') + (pop ? 'pc' : 'lr');
      return `${pop ? 'pop' : 'push'} {${rlist(list, 8).slice(1, -1)}${extra}}`;
    }
    return '.hword ' + hx(i);
  }
  if (top === 0b110) {
    if ((i & 0xf000) === 0xc000) {
      return `${(i & 0x800) ? 'ldmia' : 'stmia'} ${R((i >>> 8) & 7)}!, ${rlist(i & 0xff, 8)}`;
    }
    const cond = (i >>> 8) & 15;
    if (cond === 15) return `swi ${hx(i & 0xff)}`;
    if (cond === 14) return '.hword ' + hx(i);
    let off = i & 0xff; if (off & 0x80) off |= 0xffffff00;
    return `b${CC[cond]} ${hx((pc + 4 + (off << 1)) >>> 0)}`;
  }
  // top === 0b111
  const sub = (i >>> 11) & 0x1f;
  if (sub === 0b11100) {
    let off = i & 0x7ff; if (off & 0x400) off |= 0xfffff800;
    return `b ${hx((pc + 4 + (off << 1)) >>> 0)}`;
  }
  if (sub === 0b11110) {
    let hi = (i & 0x7ff) << 12; if (hi & 0x400000) hi |= 0xff800000;
    return `bl.hi  ; lr = pc+4${hi >= 0 ? '+' : ''}${hx(hi)}`;
  }
  if (sub === 0b11111) return `bl.lo  ; pc = lr + #${(i & 0x7ff) << 1}`;
  return '.hword ' + hx(i);
}

// ---- cheap mnemonic classifiers for the execution-weighted opcode histogram ----

export function armMnemonic(i: number): string {
  i >>>= 0;
  if (((i >>> 28) & 15) === 15) return '???';
  if ((i & 0x0ffffff0) === 0x012fff10) return 'bx';
  if ((i & 0x0e000000) === 0x0a000000) return (i & 0x1000000) ? 'bl' : 'b';
  if ((i & 0x0f000000) === 0x0f000000) return 'swi';
  if ((i & 0x0fc000f0) === 0x00000090) return (i & 0x200000) ? 'mla' : 'mul';
  if ((i & 0x0f8000f0) === 0x00800090) return 'mull';
  if ((i & 0x0fb00ff0) === 0x01000090) return 'swp';
  if ((i & 0x0e000090) === 0x00000090 && (i & 0x60) !== 0) {
    const ld = !!(i & 0x100000), sh = (i >>> 5) & 3;
    return ld ? (sh === 1 ? 'ldrh' : sh === 2 ? 'ldrsb' : 'ldrsh') : 'strh';
  }
  if ((i & 0x0c000000) === 0x00000000) {
    const op = (i >>> 21) & 15, S = !!(i & 0x100000);
    if (!S && op >= 8 && op <= 11) return (op === 8 || op === 10) ? 'mrs' : 'msr';
    return DP[op];
  }
  if ((i & 0x0c000000) === 0x04000000) return ((i & 0x100000) ? 'ldr' : 'str') + ((i & 0x400000) ? 'b' : '');
  if ((i & 0x0e000000) === 0x08000000) return (i & 0x100000) ? 'ldm' : 'stm';
  return '???';
}

export function thumbMnemonic(i: number): string {
  i &= 0xffff;
  const top = i >>> 13;
  if (top === 0b000) {
    const op = (i >>> 11) & 3;
    if (op === 3) return (i & 0x200) ? 'sub' : 'add';
    return SH[op];
  }
  if (top === 0b001) return ['mov', 'cmp', 'add', 'sub'][(i >>> 11) & 3];
  if (top === 0b010) {
    if ((i & 0xfc00) === 0x4000) return T_ALU[(i >>> 6) & 15];
    if ((i & 0xfc00) === 0x4400) { const op = (i >>> 8) & 3; return op === 3 ? 'bx' : ['add', 'cmp', 'mov'][op]; }
    if ((i & 0xf800) === 0x4800) return 'ldr';
    if ((i & 0x0200) === 0) return ((i & 0x800) ? 'ldr' : 'str') + ((i & 0x400) ? 'b' : '');
    return [(i & 0x800) ? 'ldrh' : 'strh', (i & 0x800) ? 'ldrsh' : 'ldrsb'][(i >>> 10) & 1];
  }
  if (top === 0b011) return ((i & 0x800) ? 'ldr' : 'str') + ((i & 0x1000) ? 'b' : '');
  if (top === 0b100) return (i & 0x800) ? ((i & 0x4000) ? 'ldr' : 'ldrh') : ((i & 0x4000) ? 'str' : 'strh');
  if (top === 0b101) {
    if ((i & 0xf000) === 0xa000) return 'add';
    if ((i & 0xff00) === 0xb000) return (i & 0x80) ? 'sub' : 'add';
    if ((i & 0xf600) === 0xb400) return (i & 0x800) ? 'pop' : 'push';
    return '???';
  }
  if (top === 0b110) {
    if ((i & 0xf000) === 0xc000) return (i & 0x800) ? 'ldm' : 'stm';
    return ((i >>> 8) & 15) === 15 ? 'swi' : 'b<c>';
  }
  return ((i >>> 11) & 0x1f) === 0b11100 ? 'b' : 'bl';
}
