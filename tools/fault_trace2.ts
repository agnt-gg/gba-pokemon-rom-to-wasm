import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const K={A:1<<0,B:1<<1,SEL:1<<2,START:1<<3,RIGHT:1<<4,LEFT:1<<5,UP:1<<6,DOWN:1<<7,R:1<<8,L:1<<9};
function keys(...p:number[]){let v=0x3ff;for(const x of p)v&=~x;return v;}

// Track SWIs + a per-window PC histogram to find hot loops (a hang shows up as one PC dominating).
let swiLog:Record<number,number>={};
const origSwi=m.cpu.swiHandler;
m.cpu.swiHandler=(c:number,cpu:any)=>{swiLog[c]=(swiLog[c]||0)+1;return origSwi(c,cpu);};

let pcCount:Record<number,number>={};
let sampling=false;
const origStep=m.cpu.step.bind(m.cpu);
m.cpu.step=function(){ if(sampling){const pc=m.cpu.st.r[15]>>>0; pcCount[pc]=(pcCount[pc]||0)+1;} return origStep(); };

let frame=0;
function run(n:number,k:number){for(let i=0;i<n;i++){frame++;m.setKeys(k);m.runFrame();}}
function fbHash(){const fb=m.ppu.framebuffer;let h=0;for(let i=0;i<fb.length;i+=37)h=(h*31+fb[i])>>>0;return h;}
function topPCs(){return Object.entries(pcCount).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([p,c])=>'0x'+(+p).toString(16)+'×'+c);}

run(420,0x3ff);
for(let i=0;i<40;i++){run(4,keys(K.START));run(4,0x3ff);run(4,keys(K.A));run(4,0x3ff);}
const overworldHash=fbHash();
console.log('overworld fbHash',overworldHash.toString(16),'pc',(m.cpu.st.r[15]>>>0).toString(16));

// Open START menu.
run(6,keys(K.START));run(24,0x3ff);
console.log('menu fbHash',fbHash().toString(16));

// Try selecting EACH menu position: press DOWN i times from top, then A, watch for hang/reset.
for(let item=0; item<6; item++){
  // Re-open a fresh menu each time (B to close, Start to open).
  run(4,keys(K.B));run(8,0x3ff);
  run(6,keys(K.START));run(20,0x3ff);
  for(let d=0; d<item; d++){ run(4,keys(K.DOWN)); run(6,0x3ff); }
  const pre=fbHash();
  swiLog={}; pcCount={}; sampling=true;
  run(8,keys(K.A)); run(90,0x3ff);
  sampling=false;
  const post=fbHash();
  const total=Object.values(pcCount).reduce((a,b)=>a+b,0);
  const top=Object.entries(pcCount).sort((a,b)=>b[1]-a[1])[0];
  const hotPct=top?((top[1]/total)*100).toFixed(0):'0';
  const wentToTitle = post===overworldHash;
  console.log(`item ${item}: changed=${post!==pre} hotPC=0x${top?(+top[0]).toString(16):'?'}(${hotPct}%) swi0x0=${swiLog[0]||0} swi0xf=${swiLog[0xf]||0} swi0xe=${swiLog[0xe]||0} -> ${topPCs().slice(0,3).join(' ')}`);
}
