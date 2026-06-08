import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
const addr = parseInt(process.argv[3] || '0x3007d68', 16);
const frames = parseInt(process.argv[4] || '168', 10);
const rom = new Uint8Array(readFileSync(romPath));
const M: any = new GbaMachine(rom);
M.useRecompiler = false;
for (let i = 0; i < frames; i++) M.runFrame();

for (let a = addr - 16; a <= addr + 8; a += 2) {
  const w = M.mem.read16(a) & 0xffff;
  const tag = a === addr ? '  <<< PUSH (r2 already wrong here)' : '';
  // crude THUMB decode hints
  let hint = '';
  const t = w >>> 13;
  if ((w & 0xf800) === 0x4800) hint = `LDR r${(w>>8)&7}, [PC, #0x${((w&0xff)*4).toString(16)}]`;
  else if ((w & 0xf800) === 0x0000) hint = `LSL r${w&7}, r${(w>>3)&7}, #${(w>>6)&31}`;
  else if ((w & 0xf800) === 0x0800) hint = `LSR r${w&7}, r${(w>>3)&7}, #${(w>>6)&31}`;
  else if ((w & 0xf800) === 0x1000) hint = `ASR r${w&7}, r${(w>>3)&7}, #${(w>>6)&31}`;
  else if ((w & 0xfe00) === 0x1800) hint = `ADD r${w&7}, r${(w>>3)&7}, r${(w>>6)&7}`;
  else if ((w & 0xfe00) === 0x1a00) hint = `SUB r${w&7}, r${(w>>3)&7}, r${(w>>6)&7}`;
  else if ((w & 0xf800) === 0x2000) hint = `MOV r${(w>>8)&7}, #0x${(w&0xff).toString(16)}`;
  else if ((w & 0xf800) === 0x3000) hint = `ADD r${(w>>8)&7}, #0x${(w&0xff).toString(16)}`;
  else if ((w & 0xf800) === 0x3800) hint = `SUB r${(w>>8)&7}, #0x${(w&0xff).toString(16)}`;
  else if ((w & 0xfc00) === 0x4000) hint = `ALU op=0x${((w>>6)&0xf).toString(16)} rd=r${w&7} rs=r${(w>>3)&7}`;
  else if ((w & 0xff00) === 0xb500 || (w & 0xfe00) === 0xb400) hint = `PUSH`;
  else if ((w & 0xf800) === 0x6800) hint = `LDR r${w&7}, [r${(w>>3)&7}, #0x${(((w>>6)&31)*4).toString(16)}]`;
  else if ((w & 0xf800) === 0x6000) hint = `STR r${w&7}, [r${(w>>3)&7}, #0x${(((w>>6)&31)*4).toString(16)}]`;
  console.log(`0x${a.toString(16)}: 0x${w.toString(16).padStart(4,'0')}  ${hint}${tag}`);
}
