import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
function keys(f:number){ if(f>900&&f<1300){const k=(f%30<15)?1:8; return 0x3ff&~k;} return 0x3ff; }
for(let f=1;f<=1400;f++){m.setKeys(keys(f));m.runFrame();}
let non=0; const vals=new Map<number,number>(); for(let i=0x10000;i<0x10000+64*32;i++){const v=m.mem.vram[i]; if(v)non++; vals.set(v,(vals.get(v)||0)+1);}
console.log('tile0-63 nonzero',non,'vals', [...vals.entries()].filter(([v])=>v).slice(0,20));
console.log('obj pal', Array.from({length:32},(_,i)=>m.mem.pal16(0x200+i*2).toString(16)).join(' '));
console.log('bldcnt',m.io.get16(0x50).toString(16),'alpha',m.io.get16(0x52).toString(16));
