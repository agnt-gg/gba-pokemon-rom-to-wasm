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

// BEFORE entering the screen, install write-watchers on the wait flags.
// We want to see who writes 0x3001764 / 0x3001770 during the LAST healthy frames before the hang,
// i.e. what task normally toggles them. Capture the PC of every writer.
const WATCH=[0x3001764,0x3001768,0x300176c,0x3001770];
const writers:Record<string,Set<number>>={};
for(const a of WATCH) writers['0x'+a.toString(16)]=new Set();
const oW8=m.mem.write8.bind(m.mem), oW16=m.mem.write16.bind(m.mem), oW32=m.mem.write32.bind(m.mem);
function note(a:number){ const al=a>>>0; for(const w of WATCH){ if(al>=w&&al<w+4){ writers['0x'+w.toString(16)].add(m.cpu.st.r[15]>>>0); } } }
m.mem.write8=(a:number,v:number)=>{note(a);return oW8(a,v);};
m.mem.write16=(a:number,v:number)=>{note(a);return oW16(a,v);};
m.mem.write32=(a:number,v:number)=>{note(a);return oW32(a,v);};

// Press A to enter the screen and run a while.
run(8,keys(K.A));run(120,0x3ff);
console.log('Writers (PC addresses that wrote each flag):');
for(const [addr,set] of Object.entries(writers)){
  console.log('  '+addr+': '+([...set].map(p=>'0x'+p.toString(16)).join(' ')||'(NEVER WRITTEN)'));
}
console.log('flag values now: 0x3001764=0x'+(m.mem.read32(0x3001764)>>>0).toString(16)+' 0x3001770=0x'+(m.mem.read32(0x3001770)>>>0).toString(16));
