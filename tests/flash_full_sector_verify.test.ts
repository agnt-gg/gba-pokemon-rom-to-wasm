import { strict as assert } from 'node:assert';
import { GbaMemory } from '../src/runtime/memory.ts';
import { GbaFlash } from '../src/runtime/flash.ts';
let p=0,f=0; function test(n:string,fn:()=>void){try{fn();p++;console.log('ok   - '+n)}catch(e:any){f++;console.log('FAIL - '+n+'\n       '+(e?.message||e))}}
function w8(m:GbaMemory,a:number,v:number){m.write8(0x0e000000+a,v)}
function w16(m:GbaMemory,a:number,v:number){m.write16(0x0e000000+a,v)}
function unlock(m:GbaMemory){w16(m,0x5555,0xaa);w16(m,0x2aaa,0x55)}
function bank(m:GbaMemory,b:number){unlock(m);w16(m,0x5555,0xb0);w8(m,0,b)}
function erase(m:GbaMemory,a:number){unlock(m);w16(m,0x5555,0x80);unlock(m);w8(m,a,0x30)}
function prog(m:GbaMemory,a:number,v:number){unlock(m);w16(m,0x5555,0xa0);w8(m,a,v)}

test('full 4KB sectors including trailer verify across all 32 sectors',()=>{
 const mem=new GbaMemory(); mem.flash=new GbaFlash();
 for(let sector=0;sector<32;sector++){
  bank(mem,sector>=16?1:0); const base=(sector&15)*0x1000; erase(mem,base);
  for(let i=0;i<0x1000;i++) prog(mem,base+i,(i*13+sector*17)&0x7f);
 }
 for(let sector=0;sector<32;sector++){
  bank(mem,sector>=16?1:0); const base=(sector&15)*0x1000;
  for(let i=0;i<0x1000;i++) assert.equal(mem.read8(0x0e000000+base+i),(i*13+sector*17)&0x7f,`s${sector} b${i}`);
 }
});
console.log(`\n${p} passed, ${f} failed`); if(f)process.exit(1);
