/**
 * Brute-force differential for two-register THUMB instructions and memory ops over a value matrix.
 * Runs a SINGLE instruction interp-vs-wasm and reports the first mismatch in regs/flags/memory.
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
const SCRATCH = 0x03000100;

function run(instr: number, r: number[], cIn: boolean, useRec: boolean, seedMem?: (b: RamBus) => void) {
  const bus = new RamBus();
  bus.write16(BASE, instr & 0xffff);
  bus.write16(BASE + 2, SWI);
  if (seedMem) seedMem(bus);
  const cpu = new ArmCore(bus);
  cpu.st.switchMode(Mode.SYS);
  cpu.st.cpsr = Mode.SYS | FLAG_T | (cIn ? FLAG_C : 0);
  cpu.st.r[15] = BASE;
  for (let i = 0; i < 8; i++) cpu.st.r[i] = r[i] >>> 0;
  if (useRec) { const rec = new Recompiler(bus); rec.verifyFirstRun = false; const n = rec.tryRunNative(cpu); if (n === 0) cpu.step(); }
  else cpu.step();
  const f = cpu.st.cpsr >>> 0;
  // capture a window of scratch memory for store checks
  const memWin: number[] = [];
  for (let i = 0; i < 16; i++) memWin.push(bus.read8(SCRATCH + i));
  return { regs: Array.from({ length: 8 }, (_, i) => cpu.st.r[i] >>> 0), n: !!(f & FLAG_N), z: !!(f & FLAG_Z), c: !!(f & FLAG_C), v: !!(f & FLAG_V), memWin };
}
function cmp(a: any, b: any): string | null {
  for (let i = 0; i < 8; i++) if (a.regs[i] !== b.regs[i]) return `r${i} int=${a.regs[i]>>>0} wasm=${b.regs[i]>>>0}`;
  if (a.n !== b.n) return `N int=${a.n} wasm=${b.n}`;
  if (a.z !== b.z) return `Z int=${a.z} wasm=${b.z}`;
  if (a.c !== b.c) return `C int=${a.c} wasm=${b.c}`;
  if (a.v !== b.v) return `V int=${a.v} wasm=${b.v}`;
  for (let i = 0; i < 16; i++) if (a.memWin[i] !== b.memWin[i]) return `mem[+${i}] int=${a.memWin[i]} wasm=${b.memWin[i]}`;
  return null;
}
const vals = [0, 1, 2, 3, 4, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff, 0xfffffffe, 0x12345678, 0xabcdef01];

let mism = 0, checks = 0;
function sweepRR(name: string, mk: (rd: number, rs: number) => number, opt: { rd?: number; rs?: number; seedMem?: (b: RamBus, rb: number) => void; baseReg?: number } = {}) {
  let fail: string | null = null;
  const rd = opt.rd ?? 0, rs = opt.rs ?? 1;
  for (const a of vals) for (const b2 of vals) for (const cIn of [false, true]) {
    const regs = [0,0,0,0,0,0,0,0];
    regs[rd] = a; regs[rs] = b2;
    if (opt.baseReg !== undefined) regs[opt.baseReg] = SCRATCH; // base points at scratch
    checks++;
    const seed = opt.seedMem ? (bus: RamBus) => opt.seedMem!(bus, opt.baseReg ?? 1) : undefined;
    const ri = run(mk(rd, rs), regs, cIn, false, seed);
    const rw = run(mk(rd, rs), regs, cIn, true, seed);
    const d = cmp(ri, rw);
    if (d && !fail) { fail = `${name}: rd(r${rd})=0x${a.toString(16)} rs(r${rs})=0x${b2.toString(16)} cIn=${cIn} -> ${d}`; mism++; }
  }
  console.log(fail ? `FAIL ${fail}` : `ok   ${name}`);
}

// Fmt 2 add/sub reg & imm3
sweepRR('Fmt2 ADD reg', (rd, rs) => (0x1800 | (2 << 6) | (rs << 3) | rd)); // r_d = r_s + r2; use rn=2
sweepRR('Fmt2 SUB reg', (rd, rs) => (0x1a00 | (2 << 6) | (rs << 3) | rd));
sweepRR('Fmt2 ADD imm3=5', (rd, rs) => (0x1c00 | (5 << 6) | (rs << 3) | rd));
sweepRR('Fmt2 SUB imm3=5', (rd, rs) => (0x1e00 | (5 << 6) | (rs << 3) | rd));
// Fmt 1 shifts (use rs as source, various amounts)
for (const sh of [0, 1, 7, 15, 31]) {
  sweepRR(`Fmt1 LSL #${sh}`, (rd, rs) => (0x0000 | (sh << 6) | (rs << 3) | rd));
  sweepRR(`Fmt1 LSR #${sh}`, (rd, rs) => (0x0800 | (sh << 6) | (rs << 3) | rd));
  sweepRR(`Fmt1 ASR #${sh}`, (rd, rs) => (0x1000 | (sh << 6) | (rs << 3) | rd));
}
// Fmt 4 ALU (Rd both src & dest, Rs other)
const aluOps: [string, number][] = [['AND',0x0],['EOR',0x1],['TST',0x8],['NEG',0x9],['CMP',0xa],['CMN',0xb],['ORR',0xc],['MUL',0xd],['BIC',0xe],['MVN',0xf]];
for (const [nm, op] of aluOps) sweepRR(`Fmt4 ${nm}`, (rd, rs) => (0x4000 | (op << 6) | (rs << 3) | rd));

// Fmt 9 STR/STRB/LDRB with base in r1 -> scratch
const seedScratch = (bus: RamBus) => { for (let i = 0; i < 16; i++) bus.write8(SCRATCH + i, (0x40 + i) & 0xff); };
sweepRR('Fmt9 STR word off0', (rd) => (0x6000 | (0 << 6) | (1 << 3) | rd), { rd: 0, baseReg: 1, seedMem: seedScratch });
sweepRR('Fmt9 STRB off0', (rd) => (0x7000 | (0 << 6) | (1 << 3) | rd), { rd: 0, baseReg: 1, seedMem: seedScratch });
sweepRR('Fmt9 LDRB off0', (rd) => (0x7800 | (0 << 6) | (1 << 3) | rd), { rd: 0, baseReg: 1, seedMem: seedScratch });
// Fmt 10 STRH/LDRH
sweepRR('Fmt10 STRH off0', (rd) => (0x8000 | (0 << 6) | (1 << 3) | rd), { rd: 0, baseReg: 1, seedMem: seedScratch });
sweepRR('Fmt10 LDRH off0', (rd) => (0x8800 | (0 << 6) | (1 << 3) | rd), { rd: 0, baseReg: 1, seedMem: seedScratch });

console.log(`\n${checks} checks, ${mism} mismatches`);
