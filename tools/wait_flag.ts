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

// Disassemble THUMB at the wait loop 0x81e0820..0x81e0840.
function rd16(a:number){return m.mem.read16(a);}
console.log('THUMB words at 0x81e0810..0x81e0840:');
for(let a=0x81e0810;a<0x81e0840;a+=2){ console.log('  0x'+a.toString(16)+': 0x'+rd16(a).toString(16).padStart(4,'0')); }

// Find the memory address the loop polls: instrument reads while PC is in 0x81e0810..0x81e0840.
const reads:Record<string,number>={};
const oR8=m.mem.read8.bind(m.mem), oR16=m.mem.read16.bind(m.mem), oR32=m.mem.read32.bind(m.mem);
let watch=false;
const inLoop=()=>{const pc=m.cpu.st.r[15]>>>0; return pc>=0x81e0810&&pc<=0x81e0860;};
const tag=(a:number,sz:string)=>{ if(watch&&inLoop()){ const r=(a>>>24)&0xff; if(r===0x02||r===0x03||r===0x04){ reads[sz+':0x'+(a>>>0).toString(16)]=(reads[sz+':0x'+(a>>>0).toString(16)]||0)+1; } } };
m.mem.read8=(a:number)=>{tag(a,'b');return oR8(a);};
m.mem.read16=(a:number)=>{tag(a,'h');return oR16(a);};
m.mem.read32=(a:number)=>{tag(a,'w');return oR32(a);};
watch=true; run(4,0x3ff); watch=false;
console.log('\nMemory the wait loop polls:');
for(const [k,v] of Object.entries(reads).sort((a,b)=>b[1]-a[1]).slice(0,12)) console.log('  '+k+' ×'+v);

// Dump the candidate flag values.
console.log('\nKey IWRAM/EWRAM values:');
for(const a of [0x3001764,0x3001770,0x300402d,0x30033a9]){ console.log('  0x'+a.toString(16)+' = 0x'+(m.mem.read32(a)>>>0).toString(16)); }
console.log('regs:', Array.from({length:8},(_,i)=>'r'+i+'=0x'+(m.cpu.st.r[i]>>>0).toString(16)).join(' '));
