/**
 * Phase 0/1 milestone: load the REAL Pokemon Ruby ROM and execute thousands of real
 * ARM/THUMB instructions from the cartridge entrypoint without faulting.
 *
 * This is the GBA equivalent of "does Red boot far enough to prove the CPU works." We don't
 * have a PPU yet, so we don't expect pixels — we expect the boot code to run, switch into
 * THUMB, call SWIs (HLE BIOS), set up RAM, and progress its PC across a wide address range
 * instead of getting stuck or crashing.
 *
 * Legal note: we read the user's own ROM file from disk at test time; we never embed ROM bytes.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const RUBY = 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e: any) { failed++; console.log('FAIL - ' + name + '\n       ' + (e?.message || e)); }
}

const rom = new Uint8Array(readFileSync(RUBY));
const m = new GbaMachine(rom);

test('ROM header parses as Pokemon Ruby (AXVE)', () => {
  assert.equal(m.header.title, 'POKEMON RUBY');
  assert.equal(m.header.gameCode, 'AXVE');
  assert.equal(m.header.fixedByte, 0x96);
});

test('entrypoint is an ARM branch and PC starts at 0x08000000', () => {
  assert.equal(m.pc(), 0x08000000);
  assert.equal((m.header.entryOpcode >>> 24) & 0xff, 0xea, 'B opcode');
});

test('executes 200k instructions from boot without throwing', () => {
  let thumbSwitches = 0; let lastThumb = m.thumb();
  let minPc = 0xffffffff, maxPc = 0;
  const pcHistogram = new Map<number, number>();
  for (let i = 0; i < 200000; i++) {
    if (m.cpu.halted) m.wake(); // no IRQ controller yet; keep going past IntrWait
    const pc = m.pc();
    minPc = Math.min(minPc, pc); maxPc = Math.max(maxPc, pc);
    const region = (pc >>> 24) & 0xff;
    pcHistogram.set(region, (pcHistogram.get(region) || 0) + 1);
    m.step();
    if (m.thumb() !== lastThumb) { thumbSwitches++; lastThumb = m.thumb(); }
  }
  console.log('       PC range: 0x' + minPc.toString(16) + ' .. 0x' + maxPc.toString(16));
  console.log('       ARM<->THUMB switches: ' + thumbSwitches);
  const regs = [...pcHistogram.entries()].map(([r, c]) => '0x0' + r.toString(16) + ':' + c).join('  ');
  console.log('       exec by region: ' + regs);
  assert.ok(thumbSwitches > 0, 'boot code should switch into THUMB at least once');
});

test('PC is in a sane code region after boot (BIOS/ROM/IWRAM/EWRAM)', () => {
  const region = (m.pc() >>> 24) & 0xff;
  assert.ok([0x00, 0x02, 0x03, 0x08, 0x09].includes(region), 'PC region = 0x0' + region.toString(16));
});

test('intro state machine clears the RTC/IRQ gates and installs the next callback', () => {
  // The pre-title intro state lives at gMain+0x43c (0x03001bac). With the IntrWait
  // re-entry fix it climbs instead of freezing at 0x01; with BIOS-style IRQ register preservation
  // and the GPIO RTC path it then clears the 0x8d RTC gate and installs the next boot callback.
  const fresh = new GbaMachine(new Uint8Array(readFileSync(RUBY)));
  for (let f = 0; f < 220; f++) fresh.runFrame();
  const introState = fresh.mem.read8(0x03001bac);
  const cb1 = fresh.mem.read32(0x03001770 + 4) >>> 0;
  const rtcBusy = fresh.mem.read32(0x0202f398) >>> 0;
  console.log('       intro state @0x03001bac after 220 frames = 0x' + introState.toString(16));
  console.log('       gMain.callback1 after 220 frames = 0x' + cb1.toString(16));
  assert.notEqual(introState, 0x01, 'intro state must not freeze at 0x01');
  assert.equal(rtcBusy, 0, 'RTC async gate should be complete');
  assert.notEqual(cb1, 0x0813ba45, 'boot should advance beyond the initial pre-title callback');
});

test('VBlank counter increments steadily (IRQ heartbeat alive)', () => {
  const fresh = new GbaMachine(new Uint8Array(readFileSync(RUBY)));
  for (let f = 0; f < 60; f++) fresh.runFrame();
  const vblankCounter = fresh.mem.read32(0x03001770 + 32) >>> 0;
  console.log('       gMain.vblankCounter after 60 frames = ' + vblankCounter);
  assert.ok(vblankCounter >= 50, 'vblank counter should be ~58 after 60 frames (got ' + vblankCounter + ')');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
