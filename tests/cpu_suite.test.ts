/**
 * Run jsmolka's gba-suite ARM and THUMB CPU test ROMs (MIT) through the full machine.
 *
 * m_test_eval (lib/macros.inc) does:  stmfd sp!,{r0-r12} ; movs r12, r12 ; beq .passed
 * i.e. the test ROM accumulates its result in r12 directly, and the `movs r12, r12` at a fixed
 * address simply sets the Z flag. The value of r12 the first time PC reaches that `movs` is the
 * authoritative verdict: 0 = all tests passed, otherwise the failing test number.
 *
 * We locate that `movs r12, r12` address per-ROM by scanning for the
 * `stmfd sp!,{r0-r12}` (0xe92d1fff) immediately followed by `movs r12, r12` (0xe1b0c00c).
 */
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

function findEvalAddr(rom: Uint8Array): { addr: number; thumb: boolean } {
  const r32 = (o: number) => (rom[o] | (rom[o + 1] << 8) | (rom[o + 2] << 16) | (rom[o + 3] << 24)) >>> 0;
  const r16 = (o: number) => (rom[o] | (rom[o + 1] << 8)) & 0xffff;
  // ARM eval: stmfd sp!,{r0-r12} (0xe92d1fff) then movs r12,r12 (0xe1b0c00c).
  for (let off = 0; off + 8 <= rom.length; off += 4) {
    if (r32(off) === 0xe92d1fff && r32(off + 4) === 0xe1b0c00c) return { addr: (0x08000000 + off + 4) >>> 0, thumb: false };
  }
  // THUMB eval: push {r0-r7} family then the test register is checked. The THUMB m_test_eval uses
  // `push {r0-r7,lr}` etc.; simplest reliable marker is the `idle: b idle` infinite self-branch in
  // THUMB (0xe7fe). We instead fall back to idle-loop r-register read for the THUMB ROM.
  return { addr: -1, thumb: true };
}

function runRom(path: string, label: string): number {
  const rom = new Uint8Array(readFileSync(path));
  const ev = findEvalAddr(rom);
  const m = new GbaMachine(rom);
  let prevPc = -1, sameCount = 0;
  for (let frame = 0; frame < 8000; frame++) {
    for (let i = 0; i < 100000; i++) {
      const pc = m.pc();
      // ARM ROM: snapshot r12 at the known movs r12,r12 in m_test_eval.
      if (!ev.thumb && pc === (ev.addr >>> 0)) {
        const v = m.cpu.st.r[12] >>> 0;
        console.log(`${label}: reached eval@0x${ev.addr.toString(16)}  r12=${v}  -> ${v === 0 ? 'ALL PASS' : 'FAIL at test #' + v}`);
        return v;
      }
      // THUMB ROM: detect the idle self-branch, then read the verdict from r12.
      if (pc === prevPc) {
        sameCount++;
        if (sameCount > 8000) {
          const v = m.cpu.st.r[12] >>> 0;
          console.log(`${label}: idle@0x${pc.toString(16)}  r12=${v}  -> ${v === 0 ? 'ALL PASS' : 'FAIL at test #' + v}`);
          return v;
        }
      } else { sameCount = 0; prevPc = pc; }
      if (m.cpu.halted) { m.ppu.step(64); m.timers.step(64); m.irq.poll(); (m as any).serviceIrqDispatch?.(); continue; }
      m.step();
    }
  }
  console.log(`${label}: timed out`);
  return -1;
}

const base = 'C:/Users/Studio/AppData/Roaming/AGNT/projects/gba-recomp/build/';
const arm = runRom(base + 'arm.gba', 'ARM  ');
const thumb = runRom(base + 'thumb.gba', 'THUMB');
console.log(`\nResult: ARM=${arm === 0 ? 'PASS' : 'fail@' + arm}  THUMB=${thumb === 0 ? 'PASS' : 'fail@' + thumb}`);
if (arm !== 0 || thumb !== 0) process.exit(1);
