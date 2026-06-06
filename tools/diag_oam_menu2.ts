import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const hex=(v:number)=>'0x'+(v>>>0).toString(16);
function keys(f:number){ if(f>900&&f<1300){const k=(f%30<15)?1:8; return 0x3ff&~k;} return 0x3ff; }
for(let f=1;f<=1500;f++) { m.setKeys(keys(f)); m.runFrame(); }
console.log('dispcnt',hex(m.io.get16(0)),'bldcnt',hex(m.io.get16(0x50)),'alpha',hex(m.io.get16(0x52)));
for(let i=0;i<8;i++){
 const o=i*8, a0=m.mem.oam16(o), a1=m.mem.oam16(o+2), a2=m.mem.oam16(o+4);
 const mode=(a0>>8)&3, mosaic=(a0>>12)&1, bpp=(a0>>13)&1, shape=(a0>>14)&3, size=(a1>>14)&3;
 console.log(`#${i}`,{a0:hex(a0),a1:hex(a1),a2:hex(a2),x:a1&0x1ff,y:a0&0xff,mode,mosaic,bpp,shape,size,tile:a2&0x3ff,pri:(a2>>10)&3,pal:(a2>>12)&15});
}
function nonzero4(tileStart:number, tiles:number){let n=0, hi=0; for(let i=0;i<tiles*32;i++){const v=m.mem.vram[0x10000+tileStart*32+i]; if(v){n++; if(v>0x0f)hi++;}} return {n,hi};}
console.log('tile0 4bpp bytes',nonzero4(0,64));
console.log('first 128 obj bytes',Array.from(m.mem.vram.slice(0x10000,0x10080)).map(x=>x.toString(16).padStart(2,'0')).join(' '));
