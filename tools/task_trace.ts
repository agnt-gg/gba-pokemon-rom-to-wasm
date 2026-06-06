import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const K={A:1<<0,START:1<<3};
function keys(...p:number[]){let v=0x3ff;for(const x of p)v&=~x;return v;}
let frame=0; function run(n:number,k:number){for(let i=0;i<n;i++){frame++;m.setKeys(k);m.runFrame();}}

// Compare: capture the set of distinct ROM PCs executed per frame BEFORE pressing A (healthy
// overworld) vs AFTER (hung screen). The hang = a whole category of code stops running.
function distinctRomPCs(nframes:number){
  const set=new Set<number>();
  const orig=m.cpu.step.bind(m.cpu);
  m.cpu.step=function(){ const pc=m.cpu.st.r[15]>>>0; if(((pc>>>24)&0xff)>=8) set.add(pc>>>0); return orig(); };
  run(nframes,0x3ff);
  m.cpu.step=orig;
  return set;
}
run(420,0x3ff);
for(let i=0;i<40;i++){run(4,keys(K.START));run(4,0x3ff);run(4,keys(K.A));run(4,0x3ff);}
run(6,keys(K.START));run(24,0x3ff);
const healthy=distinctRomPCs(2);
console.log('healthy frame distinct ROM PCs:', healthy.size);
run(8,keys(K.A));run(40,0x3ff);
const hung=distinctRomPCs(2);
console.log('hung frame distinct ROM PCs:', hung.size);

// Find code that ran healthy but NOT in hang — that's the task machinery that died.
const lost=[...healthy].filter(p=>!hung.has(p)).sort((a,b)=>a-b);
console.log('\nPC ranges that STOPPED running after the hang (first 40):');
let ranges:string[]=[]; let start=-1,prev=-1;
for(const p of lost){ if(start<0){start=p;prev=p;} else if(p-prev<=8){prev=p;} else {ranges.push('0x'+start.toString(16)+'-0x'+prev.toString(16)); start=p;prev=p;} }
if(start>=0)ranges.push('0x'+start.toString(16)+'-0x'+prev.toString(16));
console.log(ranges.slice(0,40).join('\n'));

// What's NEW in the hang (only-hung code) — the transition's wait loop.
const gained=[...hung].filter(p=>!healthy.has(p)).sort((a,b)=>a-b);
console.log('\nNEW code only in hang (first 20):', gained.slice(0,20).map(p=>'0x'+p.toString(16)).join(' '));
