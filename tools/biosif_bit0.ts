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
run(8,keys(K.A));run(20,0x3ff);

// Watch IE and what the dispatch's `fired` actually is each VBlank.
console.log('IE=0x'+m.io.get16(0x4000200).toString(16));

// Hook the SWI 5 path: count entries, re-entries, consumes.
let swi5=0, consumed=0, halts=0;
const origSwi=m.cpu.swiHandler;
m.cpu.swiHandler=(c:number,cpu:any)=>{
  if(c===0x05||c===0x04){
    swi5++;
    const before=m.cpu.halted;
    const bif=m.mem.read16(0x03007ff8);
    const r=origSwi(c,cpu);
    if(!m.cpu.halted && before===false) consumed++;
    if(m.cpu.halted) halts++;
    return r;
  }
  return origSwi(c,cpu);
};

// Also: each time dispatch sets BIOS-IF, record the value bits.
let bifSetBits:Record<number,number>={};
const origW16=m.mem.write16.bind(m.mem);
m.mem.write16=(a:number,v:number)=>{ if((a>>>0)===0x03007ff8){ for(let b=0;b<14;b++) if(v&(1<<b)) bifSetBits[b]=(bifSetBits[b]||0)+1; } return origW16(a,v); };

run(30,0x3ff);
console.log('Over 30 frames at the hang:');
console.log('  SWI 4/5 (IntrWait) calls:', swi5, ' halts:', halts, ' consumes:', consumed);
console.log('  BIOS-IF bits that got SET:', Object.entries(bifSetBits).map(([b,c])=>'bit'+b+'×'+c).join(' ')||'(none)');
console.log('  expected: bit0 (VBlank) should be set ~30 times (once/frame)');
console.log('  intrWaitActive=', m.cpu.intrWaitActive, 'halted=', m.cpu.halted);
