/**
 * Brute-force differential for individual THUMB instructions: for a given encoder and a sweep of
 * operand/immediate values, run one instruction on the interpreter and on the WASM recompiler and
 * report the first mismatch (regs or flags). Catches edge cases the curated tests miss.
 */
import { ArmCore } from '../src/cpu/arm_core.ts';
import { Mode, FLAG_N, FLAG_Z, FLAG_C, FLAG_V, FLAG_T } from '../src/cpu/arm_state.ts';
import type { Bus } from '../src/cpu/bus.ts';
import { Recompiler } from '../src/recompiler/recompiler.ts';

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
const SWI = 0xdf00;

function run(instr: number, setup: (c: ArmCore) => void, useRec: boolean) {
  const bus = new RamBus();
  bus.write16(BASE, instr & 0xffff);
  bus.write16(BASE + 2, SWI);
  const cpu = new ArmCore(bus);
  cpu.st.switchMode(Mode.SYS);
  cpu.st.cpsr = Mode.SYS | FLAG_T;
  cpu.st.r[15] = BASE;
  setup(cpu);
  if (useRec) { const rec = new Recompiler(bus); rec.verifyFirstRun = false; const n = rec.tryRunNative(cpu); if (n === 0) cpu.step(); }
  else cpu.step();
  const f = cpu.st.cpsr >>> 0;
  return { regs: Array.from({ length: 15 }, (_, i) => cpu.st.r[i] >>> 0), n: !!(f & FLAG_N), z: !!(f & FLAG_Z), c: !!(f & FLAG_C), v: !!(f & FLAG_V) };
}

function cmp(a: any, b: any): string | null {
  for (let i = 0; i < 15; i++) if (a.regs[i] !== b.regs[i]) return `r${i} int=${a.regs[i]>>>0} wasm=${b.regs[i]>>>0}`;
  if (a.n !== b.n) return `N int=${a.n} wasm=${b.n}`;
  if (a.z !== b.z) return `Z int=${a.z} wasm=${b.z}`;
  if (a.c !== b.c) return `C int=${a.c} wasm=${b.c}`;
  if (a.v !== b.v) return `V int=${a.v} wasm=${b.v}`;
  return null;
}

let mismatches = 0, checks = 0;
function sweep(name: string, mk: (rd: number, imm: number) => number, rdInits: number[]) {
  let firstFail: string | null = null;
  for (let imm = 0; imm <= 255; imm++) {
    for (const init of rdInits) {
      const instr = mk(0, imm);
      checks++;
      const a = run(instr, (c) => { c.st.r[0] = init >>> 0; c.st.cpsr |= (init & 1) ? FLAG_C : 0; }, false);
      const b = run(instr, (c) => { c.st.r[0] = init >>> 0; c.st.cpsr |= (init & 1) ? FLAG_C : 0; }, true);
      const d = cmp(a, b);
      if (d && !firstFail) { firstFail = `${name}: imm=${imm} r0init=0x${(init>>>0).toString(16)} -> ${d}`; mismatches++; }
    }
  }
  console.log(firstFail ? `FAIL ${firstFail}` : `ok   ${name} (all imm/operand combos match)`);
}

const inits = [0, 1, 0xff, 0x100, 0x7fffffff, 0x80000000, 0xffffffff, 0xfffffffe, 0x12345678, 5, 250];
const movImm8 = (rd: number, imm: number) => (0x2000 | (rd << 8) | (imm & 0xff));
const cmpImm8 = (rd: number, imm: number) => (0x2800 | (rd << 8) | (imm & 0xff));
const addImm8 = (rd: number, imm: number) => (0x3000 | (rd << 8) | (imm & 0xff));
const subImm8 = (rd: number, imm: number) => (0x3800 | (rd << 8) | (imm & 0xff));

sweep('Fmt3 MOV imm8', movImm8, inits);
sweep('Fmt3 CMP imm8', cmpImm8, inits);
sweep('Fmt3 ADD imm8', addImm8, inits);
sweep('Fmt3 SUB imm8', subImm8, inits);

console.log(`\n${checks} checks, ${mismatches} mismatches`);
