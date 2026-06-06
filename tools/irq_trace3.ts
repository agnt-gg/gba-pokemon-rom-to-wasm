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

// Log every time PC enters 0x18 or the userHandler region, and watch BIOS-IF + IF writes.
const userHandler=m.mem.read32(0x03007ffc)>>>0;
console.log('userHandler=0x'+userHandler.toString(16));
let enter18=0, enterHandler=0, biosIfWrites:string[]=[], ifAcks=0;
const origStep=m.cpu.step.bind(m.cpu);
let handlerPCs=new Set<number>();
m.cpu.step=function(){
  const pc=m.cpu.st.r[15]>>>0;
  if(pc===0x18)enter18++;
  if(pc>=(userHandler&~3)&&pc<((userHandler&~3)+0x40)){enterHandler++;handlerPCs.add(pc);}
  return origStep();
};
const origW16=m.mem.write16.bind(m.mem);
m.mem.write16=(a:number,v:number)=>{ if((a>>>0)===0x03007ff8)biosIfWrites.push('0x'+(v&0xffff).toString(16)); if(((a>>>24)&0xff)===0x04 && (a&0xffffff)===0x202)ifAcks++; return origW16(a,v); };

run(2,0x3ff);
console.log('Over 2 frames:');
console.log('  entered 0x18 (BIOS IRQ vector):', enter18);
console.log('  executed user-handler instrs:', enterHandler, ' distinct handler PCs:', handlerPCs.size);
console.log('  writes to BIOS-IF 0x3007FF8:', biosIfWrites.slice(0,8).join(',') || '(none)');
console.log('  IF acks (writes to 0x4000202):', ifAcks);
console.log('  serviceIrqDispatch redirect works?', enterHandler>0?'YES handler ran':'NO handler never executed');
