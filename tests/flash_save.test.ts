import { strict as assert } from 'node:assert';
import { GbaMemory } from '../src/runtime/memory.ts';
import { GbaFlash } from '../src/runtime/flash.ts';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) { try { fn(); passed++; console.log('ok   - '+name); } catch(e:any){ failed++; console.log('FAIL - '+name+'\n       '+(e?.message||e)); } }

function seq(mem:GbaMemory, a:number, v:number){ mem.write16(0x0e000000 + a, v); }
function unlockProgram(mem:GbaMemory){ seq(mem,0x5555,0xaa); seq(mem,0x2aaa,0x55); seq(mem,0x5555,0xa0); }
function unlockErase(mem:GbaMemory){ seq(mem,0x5555,0xaa); seq(mem,0x2aaa,0x55); seq(mem,0x5555,0x80); seq(mem,0x5555,0xaa); seq(mem,0x2aaa,0x55); }

test('16-bit Flash command writes use the low byte only and do not get reset by high byte', () => {
  const mem = new GbaMemory(); const flash = new GbaFlash(); mem.flash = flash;
  unlockProgram(mem);
  seq(mem,0x1234,0x34);
  assert.equal(mem.read8(0x0e001234), 0x34);
});

test('Flash ID mode works through 16-bit writes', () => {
  const mem = new GbaMemory(); const flash = new GbaFlash(); mem.flash = flash;
  seq(mem,0x5555,0xaa); seq(mem,0x2aaa,0x55); seq(mem,0x5555,0x90);
  assert.equal(mem.read8(0x0e000000), 0xc2);
  assert.equal(mem.read8(0x0e000001), 0x09);
  seq(mem,0x5555,0xaa); seq(mem,0x2aaa,0x55); seq(mem,0x5555,0xf0);
  assert.equal(mem.read8(0x0e000000), 0xff);
});

test('Flash sector erase and program respect one-way 1->0 programming', () => {
  const mem = new GbaMemory(); const flash = new GbaFlash(); mem.flash = flash;
  unlockProgram(mem); seq(mem,0x2222,0x00);
  assert.equal(mem.read8(0x0e002222), 0x00);
  unlockProgram(mem); seq(mem,0x2222,0xff);
  assert.equal(mem.read8(0x0e002222), 0x00, 'programming cannot turn 0 bits back to 1');
  unlockErase(mem); seq(mem,0x2222,0x30);
  assert.equal(mem.read8(0x0e002222), 0xff);
});

console.log(`\n${passed} passed, ${failed} failed`); if(failed) process.exit(1);
