import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const K={A:1<<0,START:1<<3,DOWN:1<<7,B:1<<1};
function keys(...p:number[]){let v=0x3ff;for(const x of p)v&=~x;return v;}
let frame=0; function run(n:number,k:number){for(let i=0;i<n;i++){frame++;m.setKeys(k);m.runFrame();}}

run(420,0x3ff);
for(let i=0;i<40;i++){run(4,keys(K.START));run(4,0x3ff);run(4,keys(K.A));run(4,0x3ff);}
run(6,keys(K.START));run(24,0x3ff);
run(8,keys(K.A));run(40,0x3ff); // enter the hanging screen

// Dump the IWRAM loop region + CPU state.
const base=0x3001270;
console.log('CPU thumb=',!!(m.cpu.st.cpsr&0x20),'pc=0x'+(m.cpu.st.r[15]>>>0).toString(16));
console.log('registers:');
for(let i=0;i<16;i++) process.stdout.write('r'+i+'=0x'+(m.cpu.st.r[i]>>>0).toString(16)+'  '+(i%4===3?'\n':''));
console.log('\nIWRAM bytes around the loop (0x3001270..0x3001290):');
for(let a=base;a<base+0x20;a+=2){
  const hw=m.mem.read16(a);
  console.log('0x'+a.toString(16)+': 0x'+hw.toString(16).padStart(4,'0'));
}
// Disassemble the 3 hot thumb instructions textually (rough).
function thumbDis(op:number):string{
  if((op&0xf800)===0x6800){const imm=((op>>6)&0x1f)*4;const rn=(op>>3)&7;const rd=op&7;return `LDR r${rd},[r${rn},#${imm}]`;}
  if((op&0xf800)===0x4800){const rd=(op>>8)&7;const imm=(op&0xff)*4;return `LDR r${rd},[pc,#${imm}]`;}
  if((op&0xfe00)===0x4000){return `ALU(0x${op.toString(16)})`;}
  if((op&0xf000)===0xd000){const cond=(op>>8)&0xf;const off=((op&0xff)<<24>>24)*2;return `B<cond=${cond}> #${off}`;}
  if((op&0xf800)===0xe000){const off=((op&0x7ff)<<21>>21)*2;return `B #${off}`;}
  if((op&0xff00)===0x2800){const rn=(op>>8)&7;return `CMP r${rn},#${op&0xff}`;}
  if((op&0xf800)===0x2000){const rd=(op>>8)&7;return `MOV r${rd},#${op&0xff}`;}
  if((op&0xfc00)===0x4200){return `TST/CMP/etc(0x${op.toString(16)})`;}
  if((op&0xff87)===0x4700){const rm=(op>>3)&0xf;return `BX r${rm}`;}
  return '0x'+op.toString(16);
}
console.log('\nDisasm:');
for(let a=0x3001274;a<=0x300127e;a+=2){ console.log('0x'+a.toString(16)+': '+thumbDis(m.mem.read16(a))); }

// What addresses is the loop reading? Instrument one more window watching read addrs from EWRAM/IWRAM/IO.
const reads:Record<number,number>={};
const origR16=m.mem.read16.bind(m.mem); const origR8=m.mem.read8.bind(m.mem); const origR32=m.mem.read32.bind(m.mem);
let watch=true;
m.mem.read16=(a:number)=>{if(watch){const r=(a>>>24)&0xff; if(r===0x04) reads[a&0xffffff]=(reads[a&0xffffff]||0)+1;} return origR16(a);};
m.mem.read8=(a:number)=>{if(watch){const r=(a>>>24)&0xff; if(r===0x04) reads[(a&0xffffff)|0x1000000]=(reads[(a&0xffffff)|0x1000000]||0)+1;} return origR8(a);};
run(20,0x3ff);
watch=false;
console.log('\nIO registers polled during hang (offset within 0x04000000):');
for(const [k,v] of Object.entries(reads).sort((a,b)=>b[1]-a[1]).slice(0,12)){
  const off=(+k)&0xffffff; const isByte=(+k)&0x1000000;
  console.log('  0x'+off.toString(16)+(isByte?'(b)':'   ')+' ×'+v);
}
