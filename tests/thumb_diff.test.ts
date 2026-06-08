/**
 * Differential proof for the THUMB -> WASM lifter: recompiled WASM block == interpreter, bit for
 * bit, across every THUMB format the lifter claims to handle natively.
 *
 * For each program we:
 *   - run it on the pure interpreter (ArmCore.step in THUMB mode) to a known instruction count,
 *   - run the SAME program from identical initial state on the WASM recompiler (compileBlockThumb),
 *   - assert r0..r14 and N/Z/C/V flags match exactly, and that the native block consumed the
 *     expected number of instructions.
 *
 * THUMB dominates Pokemon code, so this is the lifter that turns the project from ~13% native into
 * a majority-WASM runtime. Correctness is non-negotiable: anything that fails here would otherwise
 * be caught by the runtime self-verification gate and demoted to the interpreter.
 */
import { ArmCore } from '../src/cpu/arm_core.ts';
import { Mode, FLAG_N, FLAG_Z, FLAG_C, FLAG_V, FLAG_T } from '../src/cpu/arm_state.ts';
import type { Bus } from '../src/cpu/bus.ts';
import { Recompiler } from '../src/recompiler/recompiler.ts';

let passed = 0, failed = 0;
function test(n: string, f: () => void) { try { f(); passed++; console.log('ok   - ' + n); } catch (e: any) { failed++; console.log('FAIL - ' + n + '\n       ' + (e?.message || e)); } }

class RamBus implements Bus {
  mem = new Uint8Array(0x10000000);
  read8(a: number) { return this.mem[a >>> 0] ?? 0; }
  read16(a: number) { return (this.read8(a) | (this.read8(a + 1) << 8)) >>> 0; }
  read32(a: number) { return (this.read16(a) | (this.read16(a + 2) << 16)) >>> 0; }
  write8(a: number, v: number) { this.mem[a >>> 0] = v & 0xff; }
  write16(a: number, v: number) { this.write8(a, v); this.write8(a + 1, v >> 8); }
  write32(a: number, v: number) { this.write16(a, v); this.write16(a + 2, v >>> 16); }
}

const BASE = 0x08000000;
const SP = 0x03007f00; // a sane stack pointer in IWRAM range

function loadThumb(bus: RamBus, halfwords: number[]) {
  for (let i = 0; i < halfwords.length; i++) bus.write16(BASE + i * 2, halfwords[i] & 0xffff);
}

function freshCpu(halfwords: number[], init: (c: ArmCore) => void): { cpu: ArmCore; bus: RamBus } {
  const bus = new RamBus();
  loadThumb(bus, halfwords);
  const cpu = new ArmCore(bus);
  cpu.st.switchMode(Mode.SYS);
  cpu.st.cpsr = Mode.SYS | FLAG_T; // THUMB state
  cpu.st.r[13] = SP;
  cpu.st.r[15] = BASE;
  init(cpu);
  return { cpu, bus };
}

function snapshot(cpu: ArmCore) {
  const regs = [];
  for (let i = 0; i < 15; i++) regs.push(cpu.st.r[i] >>> 0);
  const f = cpu.st.cpsr >>> 0;
  return { regs, n: !!(f & FLAG_N), z: !!(f & FLAG_Z), c: !!(f & FLAG_C), v: !!(f & FLAG_V), pc: cpu.st.r[15] >>> 0 };
}

function assertSame(a: any, b: any, label: string, comparePc = false) {
  for (let i = 0; i < 15; i++) {
    if (a.regs[i] !== b.regs[i]) throw new Error(`${label}: r${i} mismatch interp=${a.regs[i] >>> 0} wasm=${b.regs[i] >>> 0}`);
  }
  if (a.n !== b.n) throw new Error(`${label}: N flag mismatch interp=${a.n} wasm=${b.n}`);
  if (a.z !== b.z) throw new Error(`${label}: Z flag mismatch interp=${a.z} wasm=${b.z}`);
  if (a.c !== b.c) throw new Error(`${label}: C flag mismatch interp=${a.c} wasm=${b.c}`);
  if (a.v !== b.v) throw new Error(`${label}: V flag mismatch interp=${a.v} wasm=${b.v}`);
  if (comparePc && a.pc !== b.pc) throw new Error(`${label}: PC mismatch interp=0x${a.pc.toString(16)} wasm=0x${b.pc.toString(16)}`);
}

function runInterp(hw: number[], n: number, init: (c: ArmCore) => void) {
  const { cpu } = freshCpu(hw, init);
  for (let i = 0; i < n; i++) cpu.step();
  return snapshot(cpu);
}

function runWasm(hw: number[], init: (c: ArmCore) => void) {
  const { cpu, bus } = freshCpu(hw, init);
  const rec = new Recompiler(bus);
  const did = rec.tryRunNative(cpu);
  return { snap: snapshot(cpu), nativeCount: did, rec };
}

// A SWI terminates a native block (the lifter bails on it), so the WASM block stops exactly at the
// end of the program under test. THUMB 0x0000 decodes as `LSL r0,r0,#0` which the lifter happily
// lifts, so without a terminator a straight-line block would run into the zero-filled RAM forever.
const SWI_TERM = 0xdf00;

/** Compare interp vs wasm for a straight-line THUMB program of `n` instructions. */
function diff(name: string, hw: number[], n: number, init: (c: ArmCore) => void = () => {}, comparePc = false) {
  test(name, () => {
    const prog = [...hw, SWI_TERM];
    const interp = runInterp(prog, n, init);
    const { snap, nativeCount } = runWasm(prog, init);
    if (nativeCount !== n) throw new Error(`expected ${n} native instrs, got ${nativeCount}`);
    assertSame(interp, snap, name, comparePc);
  });
}

// ---- THUMB encoders ----
const movImm8 = (rd: number, imm: number) => (0x2000 | (rd << 8) | (imm & 0xff));
const cmpImm8 = (rd: number, imm: number) => (0x2800 | (rd << 8) | (imm & 0xff));
const addImm8 = (rd: number, imm: number) => (0x3000 | (rd << 8) | (imm & 0xff));
const subImm8 = (rd: number, imm: number) => (0x3800 | (rd << 8) | (imm & 0xff));
const lslImm = (rd: number, rs: number, sh: number) => (0x0000 | (sh << 6) | (rs << 3) | rd);
const lsrImm = (rd: number, rs: number, sh: number) => (0x0800 | (sh << 6) | (rs << 3) | rd);
const asrImm = (rd: number, rs: number, sh: number) => (0x1000 | (sh << 6) | (rs << 3) | rd);
const addReg = (rd: number, rs: number, rn: number) => (0x1800 | (rn << 6) | (rs << 3) | rd);
const subReg = (rd: number, rs: number, rn: number) => (0x1a00 | (rn << 6) | (rs << 3) | rd);
const addImm3 = (rd: number, rs: number, imm: number) => (0x1c00 | (imm << 6) | (rs << 3) | rd);
const subImm3 = (rd: number, rs: number, imm: number) => (0x1e00 | (imm << 6) | (rs << 3) | rd);
// ALU reg (Fmt 4): 0x4000 | op<<6 | rs<<3 | rd
const alu = (op: number, rd: number, rs: number) => (0x4000 | (op << 6) | (rs << 3) | rd);
const AND = 0x0, EOR = 0x1, TST = 0x8, NEG = 0x9, CMP = 0xa, CMN = 0xb, ORR = 0xc, MUL = 0xd, BIC = 0xe, MVN = 0xf;
// Fmt 5 hi-reg: 0x4400 | op<<8 | h1<<7 | h2<<6 | rs(lo3)<<3 | rd(lo3)
const hiReg = (op: number, rd: number, rs: number) => {
  const h1 = rd >= 8 ? 0x80 : 0, h2 = rs >= 8 ? 0x40 : 0;
  return (0x4400 | (op << 8) | h1 | h2 | ((rs & 7) << 3) | (rd & 7));
};
// Fmt 9 load/store imm offset: STR=0x6000, LDR=0x6800, STRB=0x7000, LDRB=0x7800
const strImm = (rd: number, rb: number, off5: number) => (0x6000 | (off5 << 6) | (rb << 3) | rd); // word off in words
const ldrbImm = (rd: number, rb: number, off5: number) => (0x7800 | (off5 << 6) | (rb << 3) | rd);
const strbImm = (rd: number, rb: number, off5: number) => (0x7000 | (off5 << 6) | (rb << 3) | rd);
// Fmt 10 halfword: STRH=0x8000, LDRH=0x8800
const strhImm = (rd: number, rb: number, off5: number) => (0x8000 | (off5 << 6) | (rb << 3) | rd);
const ldrhImm = (rd: number, rb: number, off5: number) => (0x8800 | (off5 << 6) | (rb << 3) | rd);
// Fmt 11 SP-rel: STR=0x9000
const strSp = (rd: number, off8: number) => (0x9000 | (rd << 8) | (off8 & 0xff));
// Fmt 12 load address: ADD rd, PC, #imm = 0xa000; ADD rd, SP, #imm = 0xa800
const addPc = (rd: number, off8: number) => (0xa000 | (rd << 8) | (off8 & 0xff));
const addSp = (rd: number, off8: number) => (0xa800 | (rd << 8) | (off8 & 0xff));
// Fmt 13 add to SP: 0xb000 | (sub<<7) | off7
const addToSp = (off7: number, sub = false) => (0xb000 | (sub ? 0x80 : 0) | (off7 & 0x7f));
// Fmt 16 cond branch: 0xd000 | cond<<8 | soffset8
const bcond = (cond: number, soff8: number) => (0xd000 | (cond << 8) | (soff8 & 0xff));
// Fmt 18 uncond branch: 0xe000 | offset11
const b = (off11: number) => (0xe000 | (off11 & 0x7ff));
// Fmt 19 BL halves
const blHi = (off11: number) => (0xf000 | (off11 & 0x7ff));
const blLo = (off11: number) => (0xf800 | (off11 & 0x7ff));

// ============ Fmt 3: MOV/CMP/ADD/SUB imm8 ============
diff('Fmt3 MOV/ADD/SUB imm8 chain', [
  movImm8(0, 10), addImm8(0, 5), subImm8(0, 3), movImm8(1, 0xff),
], 4);

diff('Fmt3 CMP imm8 sets flags (equal)', [
  movImm8(0, 7), cmpImm8(0, 7),
], 2);

diff('Fmt3 SUB imm8 borrow + carry flag', [
  movImm8(0, 3), subImm8(0, 5),
], 2);

diff('Fmt3 ADD imm8 unsigned carry/overflow', [
  movImm8(0, 0xff), addImm8(0, 0xff),
], 2);

// ============ Fmt 1: shift by immediate ============
diff('Fmt1 LSL imm sets carry', [
  movImm8(0, 0x81), lslImm(1, 0, 1),
], 2);

diff('Fmt1 LSR imm #1', [
  movImm8(0, 0x03), lsrImm(1, 0, 1),
], 2);

diff('Fmt1 LSR imm #0 (=#32)', [
  movImm8(0, 0xff), lslImm(0, 0, 24), lsrImm(1, 0, 0),
], 3);

diff('Fmt1 ASR imm #0 (=#32) sign', [
  movImm8(0, 0x80), lslImm(0, 0, 24), asrImm(1, 0, 0),
], 3);

diff('Fmt1 ASR imm #2 negative', [
  movImm8(0, 0xf0), lslImm(0, 0, 24), asrImm(1, 0, 2),
], 3);

// ============ Fmt 2: add/sub register and imm3 ============
diff('Fmt2 ADD reg sets NZCV', [
  movImm8(0, 100), movImm8(1, 50), addReg(2, 0, 1),
], 3);

diff('Fmt2 SUB reg borrow', [
  movImm8(0, 5), movImm8(1, 9), subReg(2, 0, 1),
], 3);

diff('Fmt2 ADD imm3', [
  movImm8(0, 20), addImm3(1, 0, 7),
], 2);

diff('Fmt2 SUB imm3', [
  movImm8(0, 20), subImm3(1, 0, 7),
], 2);

// ============ Fmt 4: ALU reg (Rd is both source and destination) ============
diff('Fmt4 AND', [ movImm8(0, 0xff), movImm8(1, 0x0f), alu(AND, 0, 1) ], 3);
diff('Fmt4 EOR', [ movImm8(0, 0xff), movImm8(1, 0x0f), alu(EOR, 0, 1) ], 3);
diff('Fmt4 ORR', [ movImm8(0, 0xf0), movImm8(1, 0x0f), alu(ORR, 0, 1) ], 3);
diff('Fmt4 BIC', [ movImm8(0, 0xff), movImm8(1, 0x0f), alu(BIC, 0, 1) ], 3);
diff('Fmt4 MVN', [ movImm8(1, 0x0f), alu(MVN, 0, 1) ], 2);
diff('Fmt4 TST (no writeback)', [ movImm8(0, 0xf0), movImm8(1, 0x0f), alu(TST, 0, 1) ], 3);
diff('Fmt4 CMP reg equal', [ movImm8(0, 42), movImm8(1, 42), alu(CMP, 0, 1) ], 3);
diff('Fmt4 CMP reg less', [ movImm8(0, 5), movImm8(1, 9), alu(CMP, 0, 1) ], 3);
diff('Fmt4 CMN reg', [ movImm8(0, 1), movImm8(1, 2), alu(CMN, 0, 1) ], 3);
diff('Fmt4 MUL', [ movImm8(0, 12), movImm8(1, 11), alu(MUL, 0, 1) ], 3);
diff('Fmt4 NEG', [ movImm8(1, 7), alu(NEG, 0, 1) ], 2);
diff('Fmt4 NEG of zero', [ movImm8(1, 0), alu(NEG, 0, 1) ], 2);

// ============ Fmt 5: hi-reg ADD/CMP/MOV ============
diff('Fmt5 ADD hi-reg', [ movImm8(0, 100), hiReg(0, 8, 0) /* r8 += r0 */, hiReg(2, 1, 8) /* MOV r1, r8 */ ], 3, (c) => { c.st.r[8] = 5; });
diff('Fmt5 MOV hi-reg', [ movImm8(0, 0x55), hiReg(2, 9, 0) /* MOV r9, r0 */ ], 2);
diff('Fmt5 CMP hi-reg', [ hiReg(1, 0, 8) /* CMP r0, r8 */ ], 1, (c) => { c.st.r[0] = 10; c.st.r[8] = 10; });

// ============ Fmt 9: load/store imm offset ============
diff('Fmt9 STRB then LDRB', [
  movImm8(0, 0xab), movImm8(1, 0x10) /* rb base low */, strbImm(0, 1, 0), ldrbImm(2, 1, 0),
], 4, (c) => { c.st.r[1] = 0x03000000; });
diff('Fmt9 STR word', [
  movImm8(0, 0x7f), strImm(0, 1, 0),
], 2, (c) => { c.st.r[1] = 0x03000010; });

// ============ Fmt 10: halfword ============
diff('Fmt10 STRH then LDRH', [
  movImm8(0, 0xfe), strhImm(0, 1, 0), ldrhImm(2, 1, 0),
], 3, (c) => { c.st.r[1] = 0x03000020; });

// ============ Fmt 11: SP-relative store ============
diff('Fmt11 STR SP-relative', [ movImm8(0, 0x33), strSp(0, 1) ], 2);

// ============ Fmt 12: load address ============
diff('Fmt12 ADD rd, SP, #imm', [ addSp(0, 4) ], 1);
diff('Fmt12 ADD rd, PC, #imm', [ addPc(0, 4) ], 1);

// ============ Fmt 13: add offset to SP ============
diff('Fmt13 ADD SP, #imm', [ addToSp(8, false) ], 1);
diff('Fmt13 SUB SP, #imm', [ addToSp(8, true) ], 1);

// ============ Fmt 16: conditional branch (ends block) ============
diff('Fmt16 BEQ taken', [ movImm8(0, 1), cmpImm8(0, 1), bcond(0x0, 2) ], 3, () => {}, true);
diff('Fmt16 BNE not taken', [ movImm8(0, 1), cmpImm8(0, 1), bcond(0x1, 2) ], 3, () => {}, true);
diff('Fmt16 BCS taken', [ movImm8(0, 5), cmpImm8(0, 3), bcond(0x2, 4) ], 3, () => {}, true);
diff('Fmt16 BGE taken', [ movImm8(0, 5), cmpImm8(0, 3), bcond(0xa, 4) ], 3, () => {}, true);
diff('Fmt16 BLT taken', [ movImm8(0, 3), cmpImm8(0, 5), bcond(0xb, 4) ], 3, () => {}, true);

// ============ Fmt 18: unconditional branch (ends block) ============
diff('Fmt18 B forward', [ movImm8(0, 7), b(2) ], 2, () => {}, true);

// ============ Fmt 19: BL (ends block, sets LR) ============
test('Fmt19 BL sets LR and PC', () => {
  const hw = [blHi(0), blLo(4)]; // BL +offset
  const interp = runInterp(hw, 2, () => {});
  const { snap, nativeCount } = runWasm(hw, () => {});
  if (nativeCount !== 2) throw new Error(`expected 2 native instrs, got ${nativeCount}`);
  assertSame(interp, snap, 'Fmt19 BL', true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
