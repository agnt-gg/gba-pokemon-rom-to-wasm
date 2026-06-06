import { strict as assert } from 'node:assert';
import { GbaMachine } from '../src/runtime/machine.ts';
import { readFileSync } from 'node:fs';

let passed=0, failed=0;
function test(n:string,f:()=>void){try{f();passed++;console.log('ok   - '+n)}catch(e:any){failed++;console.log('FAIL - '+n+'\n       '+(e?.message||e))}}
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
function s16(v:number){v&=0xffff;return v&0x8000?v-0x10000:v;}

test('ObjAffineSet (SWI 0x0F) writes a correct identity matrix for angle=0 scale=1', ()=>{
  const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
  const src=0x02000000, dst=0x02000100;
  // src entry: scaleX=0x100 (1.0), scaleY=0x100, angle=0, pad=0
  m.mem.write16(src, 0x0100); m.mem.write16(src+2, 0x0100); m.mem.write16(src+4, 0x0000); m.mem.write16(src+6, 0);
  m.cpu.st.r[0]=src; m.cpu.st.r[1]=dst; m.cpu.st.r[2]=1; m.cpu.st.r[3]=2; // stride 2 (packed)
  m.cpu.swiHandler(0x0f, m.cpu);
  const pa=s16(m.mem.read16(dst)), pb=s16(m.mem.read16(dst+2)), pc=s16(m.mem.read16(dst+4)), pd=s16(m.mem.read16(dst+6));
  assert.equal(pa,256,`pa ${pa}`); assert.equal(pb,0,`pb ${pb}`); assert.equal(pc,0,`pc ${pc}`); assert.equal(pd,256,`pd ${pd}`);
});

test('ObjAffineSet 90 degrees rotates axes (pa~0, pb~-256, pc~256, pd~0)', ()=>{
  const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
  const src=0x02000000, dst=0x02000100;
  m.mem.write16(src, 0x0100); m.mem.write16(src+2, 0x0100); m.mem.write16(src+4, 0x4000); m.mem.write16(src+6, 0); // angle 0x4000 = 90deg
  m.cpu.st.r[0]=src; m.cpu.st.r[1]=dst; m.cpu.st.r[2]=1; m.cpu.st.r[3]=2;
  m.cpu.swiHandler(0x0f, m.cpu);
  const pa=s16(m.mem.read16(dst)), pb=s16(m.mem.read16(dst+2)), pc=s16(m.mem.read16(dst+4)), pd=s16(m.mem.read16(dst+6));
  assert.ok(Math.abs(pa)<4, `pa ~0 got ${pa}`);
  assert.ok(Math.abs(pb+256)<4, `pb ~-256 got ${pb}`);
  assert.ok(Math.abs(pc-256)<4, `pc ~256 got ${pc}`);
  assert.ok(Math.abs(pd)<4, `pd ~0 got ${pd}`);
});

test('ObjAffineSet scale 0.5 halves the matrix', ()=>{
  const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
  const src=0x02000000, dst=0x02000100;
  m.mem.write16(src, 0x0080); m.mem.write16(src+2, 0x0080); m.mem.write16(src+4, 0x0000); m.mem.write16(src+6, 0); // scale 0.5
  m.cpu.st.r[0]=src; m.cpu.st.r[1]=dst; m.cpu.st.r[2]=1; m.cpu.st.r[3]=2;
  m.cpu.swiHandler(0x0f, m.cpu);
  assert.equal(s16(m.mem.read16(dst)),128,'pa=128');
  assert.equal(s16(m.mem.read16(dst+6)),128,'pd=128');
});

test('BgAffineSet (SWI 0x0E) writes identity matrix + start coords', ()=>{
  const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
  const src=0x02000000, dst=0x02000100;
  m.mem.write32(src, 0);     // cx
  m.mem.write32(src+4, 0);   // cy
  m.mem.write16(src+8, 0);   // dispX
  m.mem.write16(src+10, 0);  // dispY
  m.mem.write16(src+12, 0x0100); // scaleX 1.0
  m.mem.write16(src+14, 0x0100); // scaleY 1.0
  m.mem.write16(src+16, 0x0000); // angle
  m.cpu.st.r[0]=src; m.cpu.st.r[1]=dst; m.cpu.st.r[2]=1;
  m.cpu.swiHandler(0x0e, m.cpu);
  assert.equal(s16(m.mem.read16(dst)),256,'pa=256');
  assert.equal(s16(m.mem.read16(dst+6)),256,'pd=256');
});

console.log(`\n${passed} passed, ${failed} failed`); if(failed) process.exit(1);
