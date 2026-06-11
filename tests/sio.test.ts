/**
 * SIO (link port) semantics tests.
 *
 * Covers the behaviors Pokemon link features depend on:
 *  - normal-32 master transfer with NO partner completes with 0xFFFFFFFF (wireless-adapter
 *    probe sees "no adapter"), busy clears, serial IRQ fires when enabled
 *  - normal mode slave with no master NEVER completes (games time out)
 *  - multiplayer with no link: SD=0, transfer completes with own word in slot 0, 0xFFFF others
 *  - LocalLinkHub: two linked instances exchange real data, IDs assigned, SD=1 on both
 */
import { strict as assert } from 'node:assert';
import { GbaIo } from '../src/runtime/io.ts';
import { GbaSio, SIO_REG, LocalLinkHub } from '../src/runtime/sio.ts';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e: any) { failed++; console.log('FAIL - ' + name + '\n       ' + (e?.message || e)); }
}

function mk(): { io: GbaIo; sio: GbaSio; irqs: number[] } {
  const io = new GbaIo();
  const sio = new GbaSio(io);
  const irqs: number[] = [];
  sio.requestIrq = (b) => irqs.push(b);
  return { io, sio, irqs };
}

// Convenience: write SIOCNT through the same side-effect path the machine uses.
function writeSiocnt(io: GbaIo, sio: GbaSio, v: number) {
  io.set16(SIO_REG.SIOCNT, v);
  sio.onSiocntWrite();
}

test('post-boot RCNT defaults to general-purpose (0x8000)', () => {
  const { io } = mk();
  assert.equal(io.get16(SIO_REG.RCNT), 0x8000);
});

test('normal-32 master, no partner: completes with 0xFFFFFFFF + IRQ (wireless adapter probe)', () => {
  const { io, sio, irqs } = mk();
  io.set16(SIO_REG.RCNT, 0); sio.onRcntWrite();
  io.set16(SIO_REG.SIODATA32_L, 0x1234);
  io.set16(SIO_REG.SIODATA32_H, 0xabcd);
  // internal clock (bit0) + 2MHz (bit1) + 32-bit mode (bit12) + IRQ enable (bit14) + start (bit7)
  writeSiocnt(io, sio, 0x0001 | 0x0002 | 0x1000 | 0x4000 | 0x0080);
  assert.equal(io.get16(SIO_REG.SIOCNT) & 0x0080, 0x0080, 'busy while in flight');
  sio.step(32 * 8 + 8); // 32 bits @ 8 cycles/bit
  assert.equal(io.get16(SIO_REG.SIOCNT) & 0x0080, 0, 'busy cleared at completion');
  const recv = (io.get16(SIO_REG.SIODATA32_L) | (io.get16(SIO_REG.SIODATA32_H) << 16)) >>> 0;
  assert.equal(recv, 0xffffffff, 'SI pulled high -> all 1s received');
  assert.deepEqual(irqs, [0x80], 'serial IRQ (bit 7) requested once');
});

test('normal-8 master, no partner: receives 0xFF, no IRQ when bit14 clear', () => {
  const { io, sio, irqs } = mk();
  io.set16(SIO_REG.RCNT, 0); sio.onRcntWrite();
  io.set16(SIO_REG.SIODATA8, 0x42);
  writeSiocnt(io, sio, 0x0001 | 0x0080); // internal clock 256KHz, 8-bit, no IRQ
  sio.step(8 * 64 + 64);
  assert.equal(io.get16(SIO_REG.SIOCNT) & 0x0080, 0, 'busy cleared');
  assert.equal(io.get16(SIO_REG.SIODATA8) & 0xff, 0xff);
  assert.equal(irqs.length, 0, 'no IRQ requested');
});

test('normal mode slave (external clock), no master: transfer never completes', () => {
  const { io, sio } = mk();
  io.set16(SIO_REG.RCNT, 0); sio.onRcntWrite();
  writeSiocnt(io, sio, 0x0080); // external clock, start
  sio.step(1_000_000);
  assert.equal(io.get16(SIO_REG.SIOCNT) & 0x0080, 0x0080, 'busy stays set forever');
});

test('multiplayer, no link: SD=0, completes with own word in slot0 and 0xFFFF in slots 1-3', () => {
  const { io, sio, irqs } = mk();
  io.set16(SIO_REG.RCNT, 0); sio.onRcntWrite();
  io.set16(SIO_REG.SIODATA8, 0xbeef & 0xffff); // SIOMLT_SEND
  writeSiocnt(io, sio, 0x2000 | 0x4000 | 0x0080); // multi mode, IRQ enable, start
  assert.equal(io.get16(SIO_REG.SIOCNT) & 0x0008, 0, 'SD=0: not all GBAs ready');
  sio.step(40_000_000); // way past any baud
  assert.equal(io.get16(SIO_REG.SIOCNT) & 0x0080, 0, 'busy cleared');
  assert.equal(io.get16(SIO_REG.SIOMULTI0), 0xbeef);
  assert.equal(io.get16(SIO_REG.SIOMULTI1), 0xffff);
  assert.equal(io.get16(SIO_REG.SIOMULTI2), 0xffff);
  assert.equal(io.get16(SIO_REG.SIOMULTI3), 0xffff);
  assert.deepEqual(irqs, [0x80]);
});

test('UART mode: start bit clears immediately, nothing arrives', () => {
  const { io, sio } = mk();
  io.set16(SIO_REG.RCNT, 0); sio.onRcntWrite();
  writeSiocnt(io, sio, 0x3000 | 0x0080); // UART + start
  assert.equal(io.get16(SIO_REG.SIOCNT) & 0x0080, 0, 'start does not wedge in UART');
});

test('LocalLinkHub: two machines exchange real multiplayer data, IDs + SD correct', () => {
  const a = mk(), b = mk();
  const hub = new LocalLinkHub();
  hub.attach(a.sio); // ID 0 = parent
  hub.attach(b.sio); // ID 1 = child
  a.io.set16(SIO_REG.RCNT, 0); a.sio.onRcntWrite();
  b.io.set16(SIO_REG.RCNT, 0); b.sio.onRcntWrite();
  // Both sides queue their send words.
  a.io.set16(SIO_REG.SIODATA8, 0x1111);
  b.io.set16(SIO_REG.SIODATA8, 0x2222);
  // Child arms multi mode + IRQ; parent starts the round.
  writeSiocnt(b.io, b.sio, 0x2000 | 0x4000);
  writeSiocnt(a.io, a.sio, 0x2000 | 0x4000 | 0x0080);
  assert.equal(a.io.get16(SIO_REG.SIOCNT) & 0x0008, 0x0008, 'parent sees SD=1 (all ready)');
  a.sio.step(40_000_000);
  // Parent's view
  assert.equal(a.io.get16(SIO_REG.SIOMULTI0), 0x1111, 'slot0 = parent word');
  assert.equal(a.io.get16(SIO_REG.SIOMULTI1), 0x2222, 'slot1 = child word');
  assert.equal((a.io.get16(SIO_REG.SIOCNT) >> 4) & 3, 0, 'parent ID 0');
  // Child's view (delivered by the hub)
  assert.equal(b.io.get16(SIO_REG.SIOMULTI0), 0x1111);
  assert.equal(b.io.get16(SIO_REG.SIOMULTI1), 0x2222);
  assert.equal((b.io.get16(SIO_REG.SIOCNT) >> 4) & 3, 1, 'child ID 1');
  assert.equal(b.io.get16(SIO_REG.SIOCNT) & 0x0004, 0x0004, 'child SI flag set');
  assert.deepEqual(a.irqs, [0x80], 'parent serial IRQ');
  assert.deepEqual(b.irqs, [0x80], 'child serial IRQ');
});

test('LocalLinkHub: child cannot initiate a round (start bit ignored)', () => {
  const a = mk(), b = mk();
  const hub = new LocalLinkHub();
  hub.attach(a.sio);
  hub.attach(b.sio);
  b.io.set16(SIO_REG.RCNT, 0); b.sio.onRcntWrite();
  writeSiocnt(b.io, b.sio, 0x2000 | 0x0080);
  assert.equal(b.io.get16(SIO_REG.SIOCNT) & 0x0080, 0, 'child start bit cleared, no transfer');
  assert.equal(b.sio.transfersCompleted, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
