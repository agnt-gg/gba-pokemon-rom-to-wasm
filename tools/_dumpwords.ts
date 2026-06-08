import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const rom = new Uint8Array(readFileSync(process.argv[2]));
const start = parseInt(process.argv[3], 16);
const n = parseInt(process.argv[4] || '10', 10);
const frame = parseInt(process.argv[5] || '168', 10);
const m: any = new GbaMachine(rom); m.useRecompiler = false;
for (let f = 1; f < frame; f++) m.runFrame();
for (let i = 0; i < n; i++) {
  const a = start + i*2;
  const w = m.mem.read16(a) & 0xffff;
  console.log(`0x${a.toString(16)}: 0x${w.toString(16).padStart(4,'0')}  ${decode(w)}`);
}
function decode(w: number): string {
  const top = w >>> 13;
  if (top === 0) { const op=(w>>>11)&3; const amt=(w>>>6)&0x1f; const rs=(w>>>3)&7; const rd=w&7;
    if(op===0)return `LSL r${rd},r${rs},#${amt}`; if(op===1)return `LSR r${rd},r${rs},#${amt}`; if(op===2)return `ASR r${rd},r${rs},#${amt}`;
    const i=(w>>>10)&1,sub=(w>>>9)&1,rn=(w>>>6)&7; return `${sub?'SUB':'ADD'} r${rd},r${rs},${i?'#'+rn:'r'+rn}`; }
  if (top===1){ const op=(w>>>11)&3; const rd=(w>>>8)&7; const imm=w&0xff; return ['MOV','CMP','ADD','SUB'][op]+` r${rd},#0x${imm.toString(16)}`; }
  if (top===2){ if((w&0xfc00)===0x4000){const op=(w>>>6)&0xf;const rs=(w>>>3)&7;const rd=w&7;return `ALU#${op.toString(16)} r${rd},r${rs}`;}
    if((w&0xfc00)===0x4400){const op=(w>>>8)&3;return `HIREG op${op}`;}
    if((w&0xf800)===0x4800){const rd=(w>>>8)&7;return `LDR r${rd},[PC,#..]`;}
    const l=(w>>>11)&1;return `Fmt7/8 ${l?'LDR':'STR'}`; }
  if (top===3){ const b=(w>>>12)&1;const l=(w>>>11)&1;const off=(w>>>6)&0x1f;const rb=(w>>>3)&7;const rd=w&7;return `${l?'LDR':'STR'}${b?'B':''} r${rd},[r${rb},#${b?off:off<<2}]`; }
  if (top===4){ if((w&0xf000)===0x8000){const l=(w>>>11)&1;const off=((w>>>6)&0x1f)<<1;const rb=(w>>>3)&7;const rd=w&7;return `${l?'LDRH':'STRH'} r${rd},[r${rb},#${off}]`;}
    const l=(w>>>11)&1;const rd=(w>>>8)&7;const off=(w&0xff)<<2;return `${l?'LDR':'STR'} r${rd},[SP,#${off}]`; }
  if (top===5){ if((w&0xf000)===0xa000){const sp=(w>>>11)&1;const rd=(w>>>8)&7;return `ADD r${rd},${sp?'SP':'PC'},#..`;}
    if((w&0xff00)===0xb000)return `ADD SP,#..`; return `PUSH/POP 0x${w.toString(16)}`; }
  if (top===6){ if((w&0xf000)===0xc000)return `LDM/STM`; const c=(w>>>8)&0xf; if(c===0xf)return `SWI`; return `B${['EQ','NE','CS','CC','MI','PL','VS','VC','HI','LS','GE','LT','GT','LE'][c]||'?'} #..`; }
  if (top===7){ if((w&0xf800)===0xe000)return `B #..`; return `BL #..`; }
  return '?';
}
