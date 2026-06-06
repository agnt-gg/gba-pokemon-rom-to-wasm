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

// Sample the actual executing PC over a window and find the dominant loop in ROM.
const pcCount:Record<number,number>={};
const orig=m.cpu.step.bind(m.cpu);
m.cpu.step=function(){const pc=m.cpu.st.r[15]>>>0; pcCount[pc]=(pcCount[pc]||0)+1; return orig();};
run(30,0x3ff);
const top=Object.entries(pcCount).sort((a,b)=>b[1]-a[1]).slice(0,10);
console.log('Hottest PCs during hang:');
for(const [p,c] of top) console.log('  0x'+(+p).toString(16)+' ×'+c+(((+p>>>24)&0xff)>=8?' (ROM)':' (RAM)'));

// Does VCOUNT advance? Sample REG 0x06 across one frame.
const seen=new Set<number>();
const origR8=m.mem.read8.bind(m.mem);
m.mem.read8=(a:number)=>{const v=origR8(a); if(((a>>>24)&0xff)===0x04 && (a&0xffffff)===6) seen.add(v); return v;};
run(2,0x3ff);
console.log('\nDistinct VCOUNT (0x4000006) values game observed in 2 frames:', [...seen].sort((a,b)=>a-b).join(','));
console.log('(healthy = many values 0..227 incl >=160 for VBlank)');

// Check DISPSTAT VBlank/HBlank/VCount-match flags + IME/IE/IF and whether VBlank IRQ is enabled.
console.log('\nDISPSTAT=0x'+m.mem.read16(0x4000004).toString(16));
console.log('IE=0x'+m.mem.read16(0x4000200).toString(16),'IF=0x'+m.mem.read16(0x4000202).toString(16),'IME=0x'+m.mem.read16(0x4000208).toString(16));
console.log('DMA3CNT=0x'+m.mem.read32(0x40000dc).toString(16));
