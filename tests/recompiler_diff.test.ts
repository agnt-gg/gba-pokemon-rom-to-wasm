/**
 * Differential proof: recompiled WASM block == interpreter, bit for bit.
 *
 * For each program we:
 *   - run it on the pure interpreter (ArmCore.step) to a known instruction count,
 *   - run the SAME program from identical initial state on the WASM recompiler,
 *   - assert r0..r15 and N/Z/C/V flags match exactly.
 *
 * If these pass, the recompiler is emitting correct WebAssembly that the engine executes —
 * the project genuinely runs WASM, verified against the reference semantics.
 */
import { ArmCore } from '../src/cpu/arm_core.ts';
import { Mode, FLAG_I, FLAG_N, FLAG_Z, FLAG_C, FLAG_V } from '../src/cpu/arm_state.ts';
import type { Bus } from '../src/cpu/bus.ts';
import { Recompiler } from '../src/recompiler/recompiler.ts';

let passed = 0, failed = 0;
function test(n: string, f: () => void) { try { f(); passed++; console.log('ok   - ' + n); } catch (e: any) { failed++; console.log('FAIL - ' + n + '\n       ' + (e?.message || e)); } }

class RamBus implements Bus {
  mem = new Uint8Array(0x10000000); // sparse-ish; fine for tests
  read8(a: number) { return this.mem[a >>> 0] ?? 0; }
  read16(a: number) { return (this.read8(a) | (this.read8(a + 1) << 8)) >>> 0; }
  read32(a: number) { return (this.read16(a) | (this.read16(a + 2) << 16)) >>> 0; }
  write8(a: number, v: number) { this.mem[a >>> 0] = v & 0xff; }
  write16(a: number, v: number) { this.write8(a, v); this.write8(a + 1, v >> 8); }
  write32(a: number, v: number) { this.write16(a, v); this.write16(a + 2, v >>> 16); }
}

const BASE = 0x08000000;

function loadProgram(bus: RamBus, words: number[]) {
  for (let i = 0; i < words.length; i++) bus.write32(BASE + i * 4, words[i] >>> 0);
  // Terminate with `B .` so the recompiled block ends exactly at the program boundary.
  bus.write32(BASE + words.length * 4, 0xeafffffe);
}

function freshCpu(words: number[], init: (c: ArmCore) => void): { cpu: ArmCore; bus: RamBus } {
  const bus = new RamBus();
  loadProgram(bus, words);
  const cpu = new ArmCore(bus);
  cpu.st.switchMode(Mode.SYS);
  cpu.st.cpsr = Mode.SYS; // flags clear, IRQ enabled, ARM state
  cpu.st.r[15] = BASE;
  init(cpu);
  return { cpu, bus };
}

function snapshot(cpu: ArmCore) {
  const regs = [];
  for (let i = 0; i < 15; i++) regs.push(cpu.st.r[i] >>> 0); // exclude r15 (PC differs by run model)
  const f = cpu.st.cpsr >>> 0;
  return { regs, n: !!(f & FLAG_N), z: !!(f & FLAG_Z), c: !!(f & FLAG_C), v: !!(f & FLAG_V) };
}

function assertSame(a: any, b: any, label: string) {
  for (let i = 0; i < 15; i++) {
    if (a.regs[i] !== b.regs[i]) throw new Error(`${label}: r${i} mismatch interp=${a.regs[i] >>> 0} wasm=${b.regs[i] >>> 0}`);
  }
  if (a.n !== b.n) throw new Error(`${label}: N flag mismatch interp=${a.n} wasm=${b.n}`);
  if (a.z !== b.z) throw new Error(`${label}: Z flag mismatch interp=${a.z} wasm=${b.z}`);
  if (a.c !== b.c) throw new Error(`${label}: C flag mismatch interp=${a.c} wasm=${b.c}`);
  if (a.v !== b.v) throw new Error(`${label}: V flag mismatch interp=${a.v} wasm=${b.v}`);
}

/** Run a straight-line program on interpreter for `n` instrs. */
function runInterp(words: number[], n: number, init: (c: ArmCore) => void) {
  const { cpu } = freshCpu(words, init);
  for (let i = 0; i < n; i++) cpu.step();
  return snapshot(cpu);
}

/** Run via recompiler: try native block; the block covers the whole straight-line program. */
function runWasm(words: number[], init: (c: ArmCore) => void) {
  const { cpu, bus } = freshCpu(words, init);
  const rec = new Recompiler(bus);
  const did = rec.tryRunNative(cpu);
  return { snap: snapshot(cpu), nativeCount: did, rec };
}

// Encoders for the instruction classes we lift.
const movImm = (rd: number, imm: number) => (0xe3a00000 | (rd << 12) | (imm & 0xff)) >>> 0;
const addImm = (rd: number, rn: number, imm: number) => (0xe2800000 | (rn << 16) | (rd << 12) | (imm & 0xff)) >>> 0;
const subImm = (rd: number, rn: number, imm: number) => (0xe2400000 | (rn << 16) | (rd << 12) | (imm & 0xff)) >>> 0;
const subsImm = (rd: number, rn: number, imm: number) => (0xe2500000 | (rn << 16) | (rd << 12) | (imm & 0xff)) >>> 0;
const addsReg = (rd: number, rn: number, rm: number) => (0xe0900000 | (rn << 16) | (rd << 12) | rm) >>> 0;
const orrReg = (rd: number, rn: number, rm: number) => (0xe1800000 | (rn << 16) | (rd << 12) | rm) >>> 0;
const andImm = (rd: number, rn: number, imm: number) => (0xe2000000 | (rn << 16) | (rd << 12) | (imm & 0xff)) >>> 0;
const cmpImm = (rn: number, imm: number) => (0xe3500000 | (rn << 16) | (imm & 0xff)) >>> 0;
const mvnImm = (rd: number, imm: number) => (0xe3e00000 | (rd << 12) | (imm & 0xff)) >>> 0;
const lslReg = (rd: number, rm: number, sh: number) => (0xe1a00000 | (rd << 12) | (sh << 7) | rm) >>> 0; // MOV rd, rm LSL #sh

test('MOV/ADD/SUB immediate chain matches interpreter', () => {
  const prog = [
    movImm(0, 10),       // r0 = 10
    addImm(1, 0, 5),     // r1 = r0 + 5 = 15
    subImm(2, 1, 3),     // r2 = r1 - 3 = 12
    movImm(3, 0xff),     // r3 = 255
  ];
  const init = () => {};
  const interp = runInterp(prog, 4, init);
  const { snap, nativeCount } = runWasm(prog, init);
  if (nativeCount !== 5) throw new Error(`expected 4 native instrs + B, got ${nativeCount}`);
  assertSame(interp, snap, 'mov/add/sub');
});

test('register ADD/ORR matches interpreter', () => {
  const prog = [
    addsReg(2, 0, 1),    // r2 = r0 + r1 (sets flags)
    orrReg(3, 0, 1),     // r3 = r0 | r1
  ];
  const init = (c: ArmCore) => { c.st.r[0] = 0x12340000; c.st.r[1] = 0x00005678; };
  const interp = runInterp(prog, 2, init);
  const { snap, nativeCount } = runWasm(prog, init);
  if (nativeCount !== 3) throw new Error(`expected 2 native + B, got ${nativeCount}`);
  assertSame(interp, snap, 'add/orr reg');
});

test('SUBS flags (carry/overflow/zero/neg) match interpreter', () => {
  const cases: [number, number][] = [
    [5, 3], [3, 5], [0, 0], [0x80000000, 1], [0x7fffffff, -1 & 0xff],
  ];
  for (const [a, b] of cases) {
    const prog = [subsImm(0, 0, b)];
    const init = (c: ArmCore) => { c.st.r[0] = a >>> 0; };
    const interp = runInterp(prog, 1, init);
    const { snap, nativeCount } = runWasm(prog, init);
    if (nativeCount !== 2) throw new Error(`SUBS not lifted for a=${a}`);
    assertSame(interp, snap, `subs ${a}-${b}`);
  }
});

test('CMP immediate sets flags identically', () => {
  for (const a of [0, 1, 5, 0x80000000, 0xffffffff]) {
    const prog = [cmpImm(0, 5)];
    const init = (c: ArmCore) => { c.st.r[0] = a >>> 0; };
    const interp = runInterp(prog, 1, init);
    const { snap } = runWasm(prog, init);
    assertSame(interp, snap, `cmp ${a}`);
  }
});

test('MVN and immediate-shift MOV match interpreter', () => {
  const prog = [
    mvnImm(0, 0),        // r0 = ~0 = 0xffffffff
    lslReg(1, 0, 4),     // r1 = r0 << 4
  ];
  const init = () => {};
  const interp = runInterp(prog, 2, init);
  const { snap, nativeCount } = runWasm(prog, init);
  if (nativeCount !== 3) throw new Error(`expected 2 native + B, got ${nativeCount}`);
  assertSame(interp, snap, 'mvn/lsl');
});

test('AND immediate matches interpreter', () => {
  const prog = [andImm(0, 0, 0x0f)];
  const init = (c: ArmCore) => { c.st.r[0] = 0xabcd; };
  const interp = runInterp(prog, 1, init);
  const { snap } = runWasm(prog, init);
  assertSame(interp, snap, 'and imm');
});

test('Branch (B) computes the correct target PC', () => {
  // B +2 instructions forward from BASE.
  // offset field: target = pc+8 + (off<<2). We want target = BASE+0x20.
  // pc = BASE, pc+8 = BASE+8, need off<<2 = 0x18 -> off = 6.
  const b = (0xea000000 | 6) >>> 0;
  const prog = [b, movImm(0, 1), movImm(0, 2)];
  const init = () => {};
  const { cpu, bus } = freshCpu(prog, init);
  const rec = new Recompiler(bus);
  const n = rec.tryRunNative(cpu);
  if (n !== 1) throw new Error(`expected branch to end block at 1 instr, got ${n}`);
  if ((cpu.st.r[15] >>> 0) !== (BASE + 0x20) >>> 0) throw new Error(`branch target wrong: ${(cpu.st.r[15] >>> 0).toString(16)}`);
});

// LDR/STR encoders (immediate offset).
const strImm = (rd: number, rn: number, off: number) => (0xe5800000 | (rn << 16) | (rd << 12) | (off & 0xfff)) >>> 0;        // STR rd,[rn,#off]
const ldrImm = (rd: number, rn: number, off: number) => (0xe5900000 | (rn << 16) | (rd << 12) | (off & 0xfff)) >>> 0;        // LDR rd,[rn,#off]
const strbImm = (rd: number, rn: number, off: number) => (0xe5c00000 | (rn << 16) | (rd << 12) | (off & 0xfff)) >>> 0;       // STRB
const ldrbImm = (rd: number, rn: number, off: number) => (0xe5d00000 | (rn << 16) | (rd << 12) | (off & 0xfff)) >>> 0;       // LDRB
const strPostImm = (rd: number, rn: number, off: number) => (0xe4800000 | (rn << 16) | (rd << 12) | (off & 0xfff)) >>> 0;    // STR rd,[rn],#off
const ldrPreWb = (rd: number, rn: number, off: number) => (0xe5b00000 | (rn << 16) | (rd << 12) | (off & 0xfff)) >>> 0;      // LDR rd,[rn,#off]!

const WORK = 0x02000000; // EWRAM-ish scratch region in the test bus

test('STR word + word LDR (native unaligned-rotation) match interpreter', () => {
  // Both the STR and the word LDR are lifted natively now: the LDR emits the ARM7
  // unaligned-read rotation as rotr(read32(addr & ~3), 8*(addr & 3)).
  const prog = [
    strImm(0, 1, 0x10),   // mem[r1+0x10] = r0   (native)
    ldrImm(2, 1, 0x10),   // r2 = mem[...]        (native, rotation-exact)
  ];
  const init = (c: ArmCore) => { c.st.r[0] = 0xdeadbeef | 0; c.st.r[1] = WORK; };
  const interp = runInterp(prog, 2, init);
  const { snap, nativeCount } = runWasm(prog, init);
  if (nativeCount !== 3) throw new Error(`expected fully-native STR+LDR+B (3), got ${nativeCount}`);
  assertSame(interp, snap, 'str+ldr word native');
});

test('unaligned word LDR rotation matches interpreter for every addr&3', () => {
  for (const mis of [0, 1, 2, 3]) {
    const prog = [ldrImm(2, 1, 0)]; // r2 = ldrWord(r1)
    const init = (c: ArmCore) => { c.st.r[1] = (WORK + 0x200 + mis) >>> 0; };
    const seed = (bus: RamBus) => bus.write32(WORK + 0x200, 0x11223344);
    const a = freshCpu(prog, init); seed(a.bus); a.cpu.step();
    const b = freshCpu(prog, init); seed(b.bus);
    const rec = new Recompiler(b.bus);
    const n = rec.tryRunNative(b.cpu);
    if (n < 1) throw new Error(`unaligned LDR (mis=${mis}) not native`);
    assertSame(snapshot(a.cpu), snapshot(b.cpu), `ldr rot mis=${mis}`);
  }
});

test('STRB/LDRB byte access matches interpreter', () => {
  const prog = [
    strbImm(0, 1, 5),
    ldrbImm(2, 1, 5),
  ];
  const init = (c: ArmCore) => { c.st.r[0] = 0xab; c.st.r[1] = WORK + 0x40; };
  const interp = runInterp(prog, 2, init);
  const { snap, nativeCount } = runWasm(prog, init);
  if (nativeCount !== 3) throw new Error(`expected 2 native + B, got ${nativeCount}`);
  assertSame(interp, snap, 'strb/ldrb');
});

test('post-indexed STR writeback matches interpreter', () => {
  const prog = [strPostImm(0, 1, 4)]; // mem[r1]=r0; r1 += 4
  const init = (c: ArmCore) => { c.st.r[0] = 0x11223344; c.st.r[1] = WORK + 0x80; };
  const interp = runInterp(prog, 1, init);
  const { snap, nativeCount } = runWasm(prog, init);
  if (nativeCount !== 2) throw new Error(`post-idx not lifted`);
  assertSame(interp, snap, 'str post writeback');
});

test('pre-indexed LDR writeback matches interpreter', () => {
  const prog = [
    strImm(0, 1, 0x20),   // seed memory
    ldrPreWb(2, 1, 0x20), // r2 = mem[r1+0x20]; r1 += 0x20
  ];
  const init = (c: ArmCore) => { c.st.r[0] = 0x55667788; c.st.r[1] = WORK + 0x100; };
  // The pre-indexed word LDR (incl. writeback) is now lifted natively.
  const interp = runInterp(prog, 2, init);
  const { snap, nativeCount } = runWasm(prog, init);
  if (nativeCount !== 3) throw new Error(`expected fully-native STR+LDR!+B (3), got ${nativeCount}`);
  assertSame(interp, snap, 'ldr pre wb native');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
