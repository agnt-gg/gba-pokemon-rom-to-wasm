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

// We're hung. The CPU is in a THUMB main loop. Let's capture a window of UNIQUE PCs in execution
// order to reconstruct the actual loop body (not just the hottest 3 addresses).
const seq:number[]=[];
const seen=new Set<number>();
const orig=m.cpu.step.bind(m.cpu);
let cap=true;
m.cpu.step=function(){
  const pc=m.cpu.st.r[15]>>>0;
  if(cap && seq.length<4000) seq.push(pc);
  return orig();
};
run(1,0x3ff);
cap=false;
// Find the repeating cycle: the main loop is the set of PCs between two occurrences of the lowest PC.
const counts:Record<number,number>={};
for(const p of seq) counts[p]=(counts[p]||0)+1;
const hot=Object.entries(counts).filter(([,c])=>c>50).map(([p])=>+p).sort((a,b)=>a-b);
console.log('Hot loop PCs (executed >50× in 1 frame), sorted:');
for(const p of hot){
  const region=((p>>>24)&0xff)>=8?'ROM':'RAM';
  console.log('  0x'+p.toString(16)+' ('+region+') ×'+counts[p]);
}
// Show the ROM ones disassembled (the loop logic lives in ROM).
console.log('\nROM hot PCs raw THUMB:');
for(const p of hot.filter(p=>((p>>>24)&0xff)>=8)){
  console.log('  0x'+p.toString(16)+': 0x'+m.mem.read16(p).toString(16).padStart(4,'0'));
}
// The deepest-nested RAM loop is the busy-wait. Disasm RAM hot region.
const ramHot=hot.filter(p=>((p>>>24)&0xff)<8);
if(ramHot.length){
  const lo=Math.min(...ramHot), hi=Math.max(...ramHot);
  console.log('\nRAM busy-loop region 0x'+lo.toString(16)+'..0x'+hi.toString(16)+':');
  for(let a=lo-4;a<=hi+4;a+=4){ console.log('  0x'+a.toString(16)+': 0x'+(m.mem.read32(a)>>>0).toString(16).padStart(8,'0')); }
}
