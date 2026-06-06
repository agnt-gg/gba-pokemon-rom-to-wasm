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
run(8,keys(K.A));run(50,0x3ff);

// The loop is ARM (4-byte stride). Read the words and decode the load targets.
console.log('ARM words at 0x3001274..0x30012a0:');
for(let a=0x3001274;a<0x30012a0;a+=4){
  const w=m.mem.read32(a)>>>0;
  console.log('0x'+a.toString(16)+': 0x'+w.toString(16).padStart(8,'0'));
}

// Capture all read addresses the loop performs over a short window (any region).
const reads:Record<string,number>={};
const oR8=m.mem.read8.bind(m.mem), oR16=m.mem.read16.bind(m.mem), oR32=m.mem.read32.bind(m.mem);
let watch=true;
const tag=(a:number,sz:string)=>{ if(!watch) return; const pc=m.cpu.st.r[15]>>>0; if(pc>=0x3001270&&pc<=0x30012b0){ const key=sz+':0x'+(a>>>0).toString(16); reads[key]=(reads[key]||0)+1; } };
m.mem.read8=(a:number)=>{tag(a,'b8');return oR8(a);};
m.mem.read16=(a:number)=>{tag(a,'h16');return oR16(a);};
m.mem.read32=(a:number)=>{tag(a,'w32');return oR32(a);};
run(10,0x3ff);
watch=false;
console.log('\nMemory the loop body reads (pc in 0x3001270..0x30012b0):');
for(const [k,v] of Object.entries(reads).sort((a,b)=>b[1]-a[1]).slice(0,16)) console.log('  '+k+' ×'+v);

// Show CPU regs + what r-registers point at.
console.log('\nregs: ', Array.from({length:16},(_,i)=>'r'+i+'=0x'+(m.cpu.st.r[i]>>>0).toString(16)).join(' '));
console.log('cpsr=0x'+(m.cpu.st.cpsr>>>0).toString(16),'thumb=',!!(m.cpu.st.cpsr&0x20));
console.log('IE=0x'+m.mem.read16(0x4000200).toString(16),'IF=0x'+m.mem.read16(0x4000202).toString(16),'IME=0x'+m.mem.read16(0x4000208).toString(16),'DISPSTAT=0x'+m.mem.read16(0x4000004).toString(16));
