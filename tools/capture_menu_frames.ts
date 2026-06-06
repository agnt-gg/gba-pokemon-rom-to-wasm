import { readFileSync, writeFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
function keys(f:number){ if(f>900&&f<1300){const k=(f%30<15)?1:8; return 0x3ff&~k;} return 0x3ff; }
function ppm(path:string){const fb=m.ppu.framebuffer; let s=`P6\n240 160\n255\n`; const head=Buffer.from(s,'ascii'); const pix=Buffer.alloc(240*160*3); for(let i=0,j=0;i<fb.length;i+=4){pix[j++]=fb[i];pix[j++]=fb[i+1];pix[j++]=fb[i+2];} writeFileSync(path, Buffer.concat([head,pix]));}
for(let f=1;f<=1500;f++){m.setKeys(keys(f));m.runFrame(); if([1000,1100,1200,1300,1400,1500].includes(f)) ppm(`build/menu_${f}.ppm`);}
console.log('wrote menu ppms');
