import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const hex=(v:number)=>'0x'+(v>>>0).toString(16);
function pressForFrame(f:number){
  // boot/title mash A+Start-ish until menu; then idle
  if(f>900 && f<1250){ const key=(f%30<15)?1:8; return 0x3ff & ~key; }
  return 0x3ff;
}
function rowStats(){ const fb=m.ppu.framebuffer; let non=0; const colors=new Set<number>(); for(let i=0;i<fb.length;i+=4){const c=(fb[i]<<16)|(fb[i+1]<<8)|fb[i+2]; colors.add(c); if(c)non++;} return {non, colors:colors.size}; }
for(let f=1; f<=1800; f++){
  m.setKeys(pressForFrame(f)); m.runFrame();
  if(f%60===0){
    const st=rowStats();
    console.log(`f=${f} pc=${hex(m.pc())} cb1=${hex(m.mem.read32(0x3001774))} task0=${hex(m.mem.read32(0x3004b20))} dispcnt=${hex(m.io.get16(0))} bg0=${hex(m.io.get16(8))} bg1=${hex(m.io.get16(10))} bg2=${hex(m.io.get16(12))} bg3=${hex(m.io.get16(14))} winin=${hex(m.io.get16(0x48))} winout=${hex(m.io.get16(0x4a))} bld=${hex(m.io.get16(0x50))} alpha=${hex(m.io.get16(0x52))} y=${hex(m.io.get16(0x54))} non=${st.non} colors=${st.colors}`);
  }
}
