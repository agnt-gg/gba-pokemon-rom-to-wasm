import { strict as assert } from 'node:assert';
import { GbaMemory } from '../src/runtime/memory.ts';
import { GbaFlash } from '../src/runtime/flash.ts';
let passed=0, failed=0; function test(n:string,fn:()=>void){try{fn();passed++;console.log('ok   - '+n)}catch(e:any){failed++;console.log('FAIL - '+n+'\n       '+(e?.message||e))}}
function w8(m:GbaMemory,a:number,v:number){m.write8(0x0e000000+a,v)}
function cmd(m:GbaMemory,a:number,v:number){m.write16(0x0e000000+a,v)}
function unlock(m:GbaMemory){cmd(m,0x5555,0xaa);cmd(m,0x2aaa,0x55)}
function program(m:GbaMemory,a:number,v:number){unlock(m);cmd(m,0x5555,0xa0);w8(m,a,v)}
function sectorErase(m:GbaMemory,a:number){unlock(m);cmd(m,0x5555,0x80);unlock(m);w8(m,a,0x30)}
function bank(m:GbaMemory,b:number){unlock(m);cmd(m,0x5555,0xb0);w8(m,0,b)}

test('Ruby-style sector writes across bank 0 and bank 1 verify byte-for-byte',()=>{
 const mem=new GbaMemory(); mem.flash=new GbaFlash();
 for(let sector=0; sector<32; sector++){
   const b=sector>=16?1:0; const off=(sector&15)*0x1000; bank(mem,b); sectorErase(mem,off);
   for(let i=0;i<32;i++) program(mem,off+i,((sector*7+i)&0x7f));
 }
 for(let sector=0; sector<32; sector++){
   bank(mem,sector>=16?1:0); const off=(sector&15)*0x1000;
   for(let i=0;i<32;i++) assert.equal(mem.read8(0x0e000000+off+i),((sector*7+i)&0x7f),`sector ${sector} byte ${i}`);
 }
});

test('chip erase clears both banks',()=>{
 const mem=new GbaMemory(); mem.flash=new GbaFlash();
 bank(mem,1); program(mem,0x2222,0x12); bank(mem,0); program(mem,0x1111,0x34);
 unlock(mem); cmd(mem,0x5555,0x80); unlock(mem); cmd(mem,0x5555,0x10);
 bank(mem,0); assert.equal(mem.read8(0x0e001111),0xff); bank(mem,1); assert.equal(mem.read8(0x0e002222),0xff);
});
console.log(`\n${passed} passed, ${failed} failed`); if(failed) process.exit(1);
