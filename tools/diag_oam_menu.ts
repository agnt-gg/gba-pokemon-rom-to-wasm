import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const hex=(v:number)=>'0x'+(v>>>0).toString(16);
function keys(f:number){ if(f>900&&f<1300){const k=(f%30<15)?1:8; return 0x3ff&~k;} return 0x3ff; }
function dumpOam(){
 let arr=[] as string[];
 for(let i=0;i<128;i++){const o=i*8; const a0=m.mem.oam16(o), a1=m.mem.oam16(o+2), a2=m.mem.oam16(o+4); const y=a0&0xff, x=a1&0x1ff, objMode=(a0>>10)&3, shape=(a0>>14)&3, size=(a1>>14)&3, tile=a2&0x3ff, pr=(a2>>10)&3, pal=(a2>>12)&15; if(y<160 || y>224) arr.push(`#${i} x=${x} y=${y} mode=${objMode} sh=${shape} sz=${size} tile=${tile} pr=${pr} pal=${pal} a0=${hex(a0)} a1=${hex(a1)} a2=${hex(a2)}`); }
 return arr.slice(0,30).join('\n');
}
for(let f=1;f<=1500;f++){m.setKeys(keys(f));m.runFrame(); if([1000,1050,1100,1200,1300,1400,1500].includes(f)){console.log(`--- f=${f} cb1=${hex(m.mem.read32(0x3001774))} task=${hex(m.mem.read32(0x3004b20))} dispcnt=${hex(m.io.get16(0))}`); console.log(dumpOam());}}
