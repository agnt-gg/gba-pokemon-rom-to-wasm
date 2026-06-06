import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
let passed=0, failed=0;
function test(name:string, fn:()=>void){try{fn();passed++;console.log('ok   - '+name)}catch(e:any){failed++;console.log('FAIL - '+name+'\n       '+(e?.message||e))}}

test('Pokemon Ruby/Sapphire ProgramFlashSectorAndVerify HLE writes a 4KB logical sector and returns success',()=>{
  const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
  const src=0x02010000;
  for(let i=0;i<0x1000;i++) m.mem.write8(src+i,(i*7+3)&0xff);
  m.cpu.st.r[0]=17; // bank 1, sector 1
  m.cpu.st.r[1]=src;
  m.cpu.st.r[14]=0x0812544d; // THUMB return address
  m.cpu.st.r[15]=0x081dfa98;
  const cycles=m.step();
  assert.ok(cycles>0);
  assert.equal(m.cpu.st.r[0],0);
  assert.equal(m.pc(),0x0812544c);
  const base=0x10000+0x1000;
  for(let i=0;i<0x1000;i++) assert.equal(m.flash.data[base+i],(i*7+3)&0xff,`byte ${i}`);
  assert.equal(m.flash.dirty,true);
});

console.log(`\n${passed} passed, ${failed} failed`); if(failed) process.exit(1);
