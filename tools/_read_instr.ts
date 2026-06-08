import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
const addr = parseInt(process.argv[3] || '0x3001c00', 16);
const frames = parseInt(process.argv[4] || '166', 10);
const rom = new Uint8Array(readFileSync(romPath));
const M: any = new GbaMachine(rom);
M.useRecompiler = false;
for (let i = 0; i < frames; i++) M.runFrame();

for (let a = addr - 8; a <= addr + 12; a += 4) {
  const w = M.mem.read32(a) >>> 0;
  const cond = (w >>> 28) & 0xf;
  const op = (w >>> 21) & 0xf; // data-proc opcode
  const I = (w >>> 25) & 1;
  const rn = (w >>> 16) & 0xf, rd = (w >>> 12) & 0xf;
  const imm8 = w & 0xff, rot = ((w >>> 8) & 0xf) * 2;
  const immVal = ((imm8 >>> rot) | (imm8 << (32 - rot))) >>> 0;
  const tag = a === addr ? '  <<< DIVERGING' : '';
  console.log(`0x${a.toString(16)}: 0x${w.toString(16).padStart(8,'0')}  cond=${cond.toString(16)} I=${I} op=${op.toString(16)} rn=${rn} rd=${rd} rot=${rot} imm8=0x${imm8.toString(16)} immVal=0x${immVal.toString(16)}${tag}`);
}
