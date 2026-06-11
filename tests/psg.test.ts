/**
 * PSG (CGB sound channels 1-4) behavior tests: trigger, tone generation, envelope decay,
 * length counter expiry, sweep overflow kill, wave playback, noise LFSR, and routing/mixing
 * through SOUNDCNT_L/H into the resampled output stream.
 */
import { strict as assert } from 'node:assert';
import { GbaIo } from '../src/runtime/io.ts';
import { GbaAudio } from '../src/runtime/audio.ts';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e: any) { failed++; console.log('FAIL - ' + name + '\n       ' + (e?.message || e)); }
}

function mk(): { io: GbaIo; au: GbaAudio } {
  const io = new GbaIo();
  const au = new GbaAudio(io);
  io.set16(0x084, 0x0080); // SOUNDCNT_X master enable
  io.set16(0x080, 0xff77); // all channels both sides, max PSG volume
  io.set16(0x082, 0x0002); // PSG ratio 100%
  return { io, au };
}
function w(io: GbaIo, au: GbaAudio, off: number, v: number) {
  io.set16(off, v);
  if (off >= 0x060 && off <= 0x07f) au.onPsgWrite(off, v);
  else if (off >= 0x090 && off <= 0x09f) au.onWaveRamWrite(off, v);
}
function drainAll(au: GbaAudio): Float32Array { return au.drainSamples(1 << 20); }
function rms(buf: Float32Array): number {
  if (!buf.length) return 0;
  let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

test('square ch1: trigger produces a tone in the output stream', () => {
  const { io, au } = mk();
  w(io, au, 0x062, 0xf080); // vol 15, duty 50%
  w(io, au, 0x064, 0x8400); // trigger, freq 0x400 -> 128 Hz
  au.step(CYCLES(0.05));
  const out = drainAll(au);
  assert.ok(out.length > 0, 'samples produced');
  assert.ok(rms(out) > 0.01, `tone should be audible, rms=${rms(out)}`);
});

test('square ch1: envelope decays to silence', () => {
  const { io, au } = mk();
  w(io, au, 0x062, 0xf180); // vol 15, env decrease, period 1 (~15/64s to zero)
  w(io, au, 0x064, 0x8400);
  au.step(CYCLES(0.5)); // well past full decay
  drainAll(au);
  au.step(CYCLES(0.05));
  const tail = drainAll(au);
  assert.ok(rms(tail) < 0.001, `fully decayed, rms=${rms(tail)}`);
  assert.equal(au.ch1.envVolume, 0);
});

test('square ch2: length counter silences the channel', () => {
  const { io, au } = mk();
  w(io, au, 0x068, 0xf03f); // vol 15, length = 64-63 = 1 (~3.9ms)
  w(io, au, 0x06c, 0xc400); // trigger + length enable
  assert.ok(au.ch2.enabled);
  au.step(CYCLES(0.05));
  assert.equal(au.ch2.enabled, false, 'length expired');
});

test('sweep overflow kills ch1', () => {
  const { io, au } = mk();
  w(io, au, 0x060, 0x0011); // sweep time 1, increase, shift 1
  w(io, au, 0x062, 0xf080);
  w(io, au, 0x064, 0x87f0); // very high freq -> first sweep overflows
  au.step(CYCLES(0.1));
  assert.equal(au.ch1.enabled, false, 'sweep overflow disables channel');
});

test('wave ch3: banked RAM playback produces output', () => {
  const { io, au } = mk();
  // Write a square-ish wave into the CPU-visible bank (bank 1 while bank 0 selected for play).
  w(io, au, 0x070, 0x0000); // playback off, bank 0 selected
  for (let i = 0; i < 8; i++) w(io, au, 0x090 + i * 2, i < 4 ? 0xffff : 0x0000);
  // Flip: select bank 1 for playback (the one we just wrote)... CPU writes went to bank^1=1.
  w(io, au, 0x070, 0x00c0); // playback on, bank=1
  w(io, au, 0x072, 0x2000); // volume 100%
  w(io, au, 0x074, 0x8400); // trigger
  assert.ok(au.ch3.enabled, 'wave channel triggered');
  au.step(CYCLES(0.05));
  const out = drainAll(au);
  assert.ok(rms(out) > 0.01, `wave audible, rms=${rms(out)}`);
});

test('noise ch4: LFSR advances and output is nonzero', () => {
  const { io, au } = mk();
  w(io, au, 0x078, 0xf000); // vol 15
  w(io, au, 0x07c, 0x8011); // trigger, divisor 1, shift 1
  const lfsr0 = au.ch4.lfsr;
  au.step(CYCLES(0.05));
  assert.notEqual(au.ch4.lfsr, lfsr0, 'LFSR advanced');
  const out = drainAll(au);
  assert.ok(rms(out) > 0.005, `noise audible, rms=${rms(out)}`);
});

test('SOUNDCNT_L routing: muting both sides silences PSG', () => {
  const { io, au } = mk();
  io.set16(0x080, 0x0077); // volumes max but NO channel routing bits
  w(io, au, 0x062, 0xf080);
  w(io, au, 0x064, 0x8400);
  au.step(CYCLES(0.05));
  const out = drainAll(au);
  assert.ok(rms(out) < 1e-6, `routed off -> silent, rms=${rms(out)}`);
});

test('master disable (SOUNDCNT_X) gates everything', () => {
  const { io, au } = mk();
  w(io, au, 0x062, 0xf080);
  w(io, au, 0x064, 0x8400);
  io.set16(0x084, 0x0000);
  au.step(CYCLES(0.05));
  assert.equal(au.bufferedFrames, 0, 'no samples generated while master-disabled');
});

function CYCLES(seconds: number): number { return Math.round(16_777_216 * seconds); }

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
