import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const hex=(v:number)=>'0x'+(v>>>0).toString(16);
// This won't fully navigate a save, but it logs mode/black-frame signatures during menu interactions.
function maskFor(f:number){
  // boot to menu, then press start/A/down-ish patterns to try entering menus
  if(f>900&&f<1300){const k=(f%30<15)?1:8; return 0x3ff&~k;}
  if(f>=1600&&f<1700) return 0x3ff & ~(1<<3); // start
  if(f>=1720&&f<1760) return 0x3ff & ~(1<<0); // A
  return 0x3ff;
}
function stats(){const fb=m.ppu.framebuffer; let non=0; const colors=new Set<number>(); for(let i=0;i<fb.length;i+=4){const c=(fb[i]<<16)|(fb[i+1]<<8)|fb[i+2]; if(c)non++; colors.add(c);} return {non,colors:colors.size};}
for(let f=1;f<=2600;f++){m.setKeys(maskFor(f)); m.runFrame(); if(f%30===0){const s=stats(); console.log(`f=${f} pc=${hex(m.pc())} cb1=${hex(m.mem.read32(0x3001774))} cb2=${hex(m.mem.read32(0x3001778))} task0=${hex(m.mem.read32(0x3004b20))} dispcnt=${hex(m.io.get16(0))} bg0=${hex(m.io.get16(8))} bg1=${hex(m.io.get16(10))} bg2=${hex(m.io.get16(12))} bg3=${hex(m.io.get16(14))} non=${s.non} colors=${s.colors}`);}}
