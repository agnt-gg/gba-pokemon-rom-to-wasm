import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const K={A:1<<0,START:1<<3};
function keys(...p:number[]){let v=0x3ff;for(const x of p)v&=~x;return v;}
let frame=0; function run(n:number,k:number){for(let i=0;i<n;i++){frame++;m.setKeys(k);m.runFrame();}}
run(420,0x3ff);
for(let i=0;i<40;i++){run(4,keys(K.START));run(4,0x3ff);run(4,keys(K.A));run(4,0x3ff);}
run(6,keys(K.START));run(24,0x3ff);
run(8,keys(K.A));run(40,0x3ff);

// Distinguish dispatch-write vs handler-write to BIOS-IF by tracking PC at write time.
const userHandler=m.mem.read32(0x03007ffc)>>>0;
let dispatchWrites=0, handlerWrites:string[]=[];
const origW16=m.mem.write16.bind(m.mem);
m.mem.write16=(a:number,v:number)=>{
  if((a>>>0)===0x03007ff8){
    const pc=m.cpu.st.r[15]>>>0;
    const inHandler = pc>=(userHandler&~3)&&pc<((userHandler&~3)+0x400);
    if(inHandler) handlerWrites.push('pc=0x'+pc.toString(16)+' v=0x'+(v&0xffff).toString(16));
    else dispatchWrites++;
  }
  return origW16(a,v);
};

// Track whether the SWI ever consumes (intrWaitActive transitions) and if the screen advances.
function fbHash(){const fb=m.ppu.framebuffer;let h=0;for(let i=0;i<fb.length;i+=37)h=(h*31+fb[i])>>>0;return h;}
const h0=fbHash();
run(60,0x3ff);
const h1=fbHash();
console.log('userHandler=0x'+userHandler.toString(16));
console.log('dispatch (BIOS) writes to BIOS-IF:', dispatchWrites);
console.log('handler writes to BIOS-IF:', handlerWrites.length, handlerWrites.slice(0,6).join(' | '));
console.log('intrWaitActive now:', m.cpu.intrWaitActive);
console.log('screen advanced over 60 frames?', h0!==h1, '(h0=0x'+h0.toString(16)+' h1=0x'+h1.toString(16)+')');
console.log('PC=0x'+(m.cpu.st.r[15]>>>0).toString(16),'halted='+m.cpu.halted);
