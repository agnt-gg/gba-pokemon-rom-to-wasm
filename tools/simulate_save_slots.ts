import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const src=0x02010000;
function w32(a:number,v:number){m.mem.write32(a,v>>>0)}
function w16(a:number,v:number){m.mem.write16(a,v&0xffff)}
function checksum(addr:number){let sum=0; for(let i=0;i<0xff4;i+=4) sum=(sum+m.mem.read32(addr+i))>>>0; return ((sum>>>16)+(sum&0xffff))&0xffff;}
for(let slot=0;slot<2;slot++){
 const counter=slot+1;
 for(let id=0;id<14;id++){
  for(let i=0;i<0xff4;i++) m.mem.write8(src+i,(id*17+i+slot)&0xff);
  w16(src+0xff4,id); w16(src+0xff6,checksum(src)); w32(src+0xff8,0x08012025); w32(src+0xffc,counter);
  m.cpu.st.r[0]=slot*14+id; m.cpu.st.r[1]=src; m.cpu.st.r[14]=0x0812544d; m.cpu.st.r[15]=0x081dfa98; m.step();
 }
}
let bad=0;
for(let s=0;s<28;s++){
 const b=s*0x1000; const id=m.flash.data[b+0xff4]|(m.flash.data[b+0xff5]<<8); const chk=m.flash.data[b+0xff6]|(m.flash.data[b+0xff7]<<8); const sig=(m.flash.data[b+0xff8]|(m.flash.data[b+0xff9]<<8)|(m.flash.data[b+0xffa]<<16)|(m.flash.data[b+0xffb]<<24))>>>0; const cnt=(m.flash.data[b+0xffc]|(m.flash.data[b+0xffd]<<8)|(m.flash.data[b+0xffe]<<16)|(m.flash.data[b+0xfff]<<24))>>>0; if(id!==s%14||sig!==0x08012025||cnt!==Math.floor(s/14)+1) bad++; console.log(s,{id,chk,sig:sig.toString(16),cnt});
}
console.log('bad',bad,'dirty',m.flash.dirty);
