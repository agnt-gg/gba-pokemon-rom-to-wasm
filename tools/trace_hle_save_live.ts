import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const hex=(v:number)=>'0x'+(v>>>0).toString(16);
let hits=0;
for(let f=1; f<=12000 && hits<80; f++){
 // Can't navigate full save, but trace any HLE sector calls reached by intro/title flows.
 if(f>900 && f<3000){const press=(f%20<10)?1:8; m.setKeys(0x3ff&~press);} else m.setKeys(0x3ff);
 let cycles=0,guard=0; while(cycles<280896&&guard<2000000){ const pc=m.pc(); if(pc===0x081dfa98){ const src=m.cpu.st.r[1]>>>0; console.log(`HLE incoming f=${f} sector=${m.cpu.st.r[0]&255} src=${hex(src)} id=${m.mem.read16(src+0xff4)} chk=${hex(m.mem.read16(src+0xff6))} sig=${hex(m.mem.read32(src+0xff8))} cnt=${m.mem.read32(src+0xffc)}`); hits++; } cycles+=m.step(); guard++; }
 m.frameCount++;
}
console.log('done hits',hits);
