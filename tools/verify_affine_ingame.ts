import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const s16=(v:number)=>{v&=0xffff;return v&0x8000?v-0x10000:v;};
let swiF=0;const orig=(m as any).cpu.swiHandler;(m as any).cpu.swiHandler=(c:number,cpu:any)=>{if(c===0x0f)swiF++;return orig(c,cpu);};
for(let f=1;f<=2000;f++){let k=0x3ff;if(f>900&&f<1300){k=0x3ff&~((f%30<15)?1:8);}m.setKeys(k);m.runFrame();}
let nonId=0;
for(let g=0;g<32;g++){const pa=s16((m as any).mem.oam16(g*32+6));if(pa!==0&&pa!==256)nonId++;}
console.log('ran 2000 frames OK (no crash/stall)');
console.log('ObjAffineSet calls during run:',swiF);
console.log('OAM affine groups with non-identity PA after run:',nonId);
const a:any=(m as any).audio;
console.log('audio present:', !!a, 'keys:', a?Object.keys(a).join(','):'n/a');
