/**
 * GBA audio: Direct Sound (FIFO A/B) + the full PSG block (CGB channels 1-4).
 *
 * Pokemon's m4a/Sappy engine mixes music/SFX on the CPU into Direct Sound FIFO A/B
 * (DMA1/DMA2 -> 0x040000A0/A4, clocked by Timer0/1 overflow), but it ALSO drives the four
 * legacy PSG channels (square w/ sweep, square, programmable wave, noise) for instrument
 * layers and SFX. Until now only Direct Sound was modeled; the PSG block below completes
 * the audio path:
 *   ch1 0x60/0x62/0x64  square + frequency sweep
 *   ch2 0x68/0x6C       square
 *   ch3 0x70/0x72/0x74  wave, GBA dual-bank / 64-sample mode, 0x90-0x9F wave RAM
 *   ch4 0x78/0x7C       noise (15/7-bit LFSR)
 *   0x80 SOUNDCNT_L     PSG L/R master volume + per-channel routing
 *   0x82 SOUNDCNT_H     PSG mix ratio (25/50/100%) + DS volume/routing/FIFO resets
 *   0x84 SOUNDCNT_X     master enable
 * Frame sequencer: 512 Hz (every 32768 CPU cycles), DMG ordering — length @0,2,4,6;
 * sweep @2,6; envelope @7. GBA clocks are exactly 4x DMG, so periods are DMG x4.
 */

import { GbaIo, REG } from './io.ts';

const CPU_HZ = 16_777_216;
const OUT_HZ = 44_100;
// Hardware Direct Sound FIFO holds 32 bytes (8 words).
const FIFO_CAP = 32;
const FRAME_SEQ_PERIOD = 32768; // 512 Hz

class PcmFifo {
  q: number[] = [];
  current = 0;
  needsDma = false;
  reset(): void { this.q.length = 0; this.current = 0; this.needsDma = true; }
  pushByte(byte: number): void {
    // Direct Sound samples are signed 8-bit PCM.
    const s = ((byte << 24) >> 24) / 128;
    if (this.q.length >= FIFO_CAP) this.q.shift();
    this.q.push(s);
    if (this.q.length > 16) this.needsDma = false;
  }
  pop(): number {
    // On underrun the DAC repeats the last latched sample (hardware behavior).
    if (this.q.length) this.current = this.q.shift()!;
    // Hardware requests a DMA refill when the FIFO is half empty (<=16 bytes).
    if (this.q.length <= 16) this.needsDma = true;
    return this.current;
  }
  consumeDmaRequest(): boolean { const r = this.needsDma; this.needsDma = false; return r; }
  get level(): number { return this.q.length; }
}

const DUTY_TABLE = [
  [0, 0, 0, 0, 0, 0, 0, 1], // 12.5%
  [1, 0, 0, 0, 0, 0, 0, 1], // 25%
  [1, 0, 0, 0, 0, 1, 1, 1], // 50%
  [0, 1, 1, 1, 1, 1, 1, 0], // 75%
];

class SquareChannel {
  enabled = false;
  duty = 0;
  dutyStep = 0;
  freq = 0;          // 11-bit
  timer = 0;         // cycles until next duty step
  lengthCounter = 0;
  lengthEnable = false;
  envVolume = 0;     // current 0-15
  envInitial = 0;
  envDir = 0;        // 1 = increase
  envPeriod = 0;
  envTimer = 0;
  // sweep (ch1 only)
  hasSweep = false;
  sweepShift = 0;
  sweepDir = 0;      // 1 = decrease
  sweepTime = 0;
  sweepTimer = 0;
  sweepShadow = 0;
  sweepEnabled = false;

  period(): number { return (2048 - this.freq) * 16; }

  trigger(): void {
    this.enabled = true;
    if (this.lengthCounter === 0) this.lengthCounter = 64;
    this.timer = this.period();
    this.envVolume = this.envInitial;
    this.envTimer = this.envPeriod;
    if (this.hasSweep) {
      this.sweepShadow = this.freq;
      this.sweepTimer = this.sweepTime || 8;
      this.sweepEnabled = this.sweepTime > 0 || this.sweepShift > 0;
      if (this.sweepShift > 0 && this.sweepCalc() > 2047) this.enabled = false;
    }
    if (this.envInitial === 0 && this.envDir === 0) this.enabled = false; // DAC off
  }

  sweepCalc(): number {
    const d = this.sweepShadow >> this.sweepShift;
    return this.sweepDir ? this.sweepShadow - d : this.sweepShadow + d;
  }

  clockSweep(): void {
    if (!this.hasSweep || !this.sweepEnabled || !this.enabled) return;
    if (--this.sweepTimer > 0) return;
    this.sweepTimer = this.sweepTime || 8;
    if (this.sweepTime === 0) return;
    const next = this.sweepCalc();
    if (next > 2047) { this.enabled = false; return; }
    if (this.sweepShift > 0) {
      this.sweepShadow = next & 0x7ff;
      this.freq = this.sweepShadow;
      if (this.sweepCalc() > 2047) this.enabled = false;
    }
  }

  clockLength(): void {
    if (this.lengthEnable && this.lengthCounter > 0 && --this.lengthCounter === 0) this.enabled = false;
  }

  clockEnvelope(): void {
    if (!this.enabled || this.envPeriod === 0) return;
    if (--this.envTimer > 0) return;
    this.envTimer = this.envPeriod;
    if (this.envDir && this.envVolume < 15) this.envVolume++;
    else if (!this.envDir && this.envVolume > 0) this.envVolume--;
  }

  advance(cycles: number): void {
    if (!this.enabled) return;
    const p = this.period();
    if (p <= 0) return;
    this.timer -= cycles;
    while (this.timer <= 0) { this.timer += p; this.dutyStep = (this.dutyStep + 1) & 7; }
  }

  output(): number {
    if (!this.enabled) return 0;
    const bit = DUTY_TABLE[this.duty][this.dutyStep];
    return bit ? (this.envVolume / 15) : -(this.envVolume / 15);
  }
}

class WaveChannel {
  enabled = false;
  playback = false;   // SOUND3CNT_L bit7
  dimension = false;  // 64-sample mode
  bank = 0;           // playing bank
  freq = 0;
  timer = 0;
  pos = 0;            // sample position 0..31 (or 0..63)
  lengthCounter = 0;
  lengthEnable = false;
  volumeCode = 0;     // 0=0%,1=100%,2=50%,3=25%
  force75 = false;
  ram = [new Uint8Array(16), new Uint8Array(16)];
  sample = 0;

  period(): number { return (2048 - this.freq) * 8; }

  trigger(): void {
    if (!this.playback) { this.enabled = false; return; }
    this.enabled = true;
    if (this.lengthCounter === 0) this.lengthCounter = 256;
    this.timer = this.period();
    this.pos = 0;
  }

  clockLength(): void {
    if (this.lengthEnable && this.lengthCounter > 0 && --this.lengthCounter === 0) this.enabled = false;
  }

  advance(cycles: number): void {
    if (!this.enabled || !this.playback) return;
    const p = this.period();
    if (p <= 0) return;
    this.timer -= cycles;
    while (this.timer <= 0) {
      this.timer += p;
      const len = this.dimension ? 64 : 32;
      this.pos = (this.pos + 1) % len;
      // In 64-sample (dimension) mode playback starts on the selected bank, then continues into the other.
      const bankIdx = this.dimension ? ((this.pos >> 5) + this.bank) & 1 : this.bank;
      const idx = this.pos & 31;
      const byte = this.ram[bankIdx][idx >> 1];
      this.sample = (idx & 1) ? (byte & 0x0f) : (byte >> 4);
    }
  }

  output(): number {
    if (!this.enabled || !this.playback) return 0;
    let v = this.sample / 15;
    let scale: number;
    if (this.force75) scale = 0.75;
    else scale = this.volumeCode === 0 ? 0 : this.volumeCode === 1 ? 1 : this.volumeCode === 2 ? 0.5 : 0.25;
    return (v * 2 - 1) * scale;
  }
}

class NoiseChannel {
  enabled = false;
  lengthCounter = 0;
  lengthEnable = false;
  envVolume = 0;
  envInitial = 0;
  envDir = 0;
  envPeriod = 0;
  envTimer = 0;
  shift = 0;
  width7 = false;
  divisor = 0;
  timer = 0;
  lfsr = 0x7fff;

  period(): number {
    // DMG: (r==0 ? 8 : r*16) << s; GBA clocks are 4x DMG.
    return (this.divisor === 0 ? 32 : this.divisor * 64) << this.shift;
  }

  trigger(): void {
    this.enabled = true;
    if (this.lengthCounter === 0) this.lengthCounter = 64;
    this.timer = this.period();
    this.envVolume = this.envInitial;
    this.envTimer = this.envPeriod;
    this.lfsr = 0x7fff;
    if (this.envInitial === 0 && this.envDir === 0) this.enabled = false;
  }

  clockLength(): void {
    if (this.lengthEnable && this.lengthCounter > 0 && --this.lengthCounter === 0) this.enabled = false;
  }

  clockEnvelope(): void {
    if (!this.enabled || this.envPeriod === 0) return;
    if (--this.envTimer > 0) return;
    this.envTimer = this.envPeriod;
    if (this.envDir && this.envVolume < 15) this.envVolume++;
    else if (!this.envDir && this.envVolume > 0) this.envVolume--;
  }

  advance(cycles: number): void {
    if (!this.enabled) return;
    const p = this.period();
    if (p <= 0) return;
    this.timer -= cycles;
    let steps = 0;
    while (this.timer <= 0 && steps < 64) {
      this.timer += p;
      const xor = (this.lfsr ^ (this.lfsr >> 1)) & 1;
      this.lfsr = (this.lfsr >> 1) | (xor << 14);
      if (this.width7) this.lfsr = (this.lfsr & ~0x40) | (xor << 6);
      steps++;
    }
    if (steps >= 64 && this.timer <= 0) this.timer = p; // clamp pathological tiny periods
  }

  output(): number {
    if (!this.enabled) return 0;
    return (this.lfsr & 1) ? -(this.envVolume / 15) : (this.envVolume / 15);
  }
}

export class GbaAudio {
  io: GbaIo;
  fifoA = new PcmFifo();
  fifoB = new PcmFifo();
  left = 0;   // Direct Sound contribution
  right = 0;

  // PSG block
  ch1 = new SquareChannel();
  ch2 = new SquareChannel();
  ch3 = new WaveChannel();
  ch4 = new NoiseChannel();
  private frameSeqAcc = 0;
  private frameSeqStep = 0;

  /**
   * Effective output sample rate. Nominally OUT_HZ, but the frontend nudges it ±2% based on its
   * audio-queue depth (dynamic rate control). The producer (emulated time) and the consumer
   * (the real audio device clock) are different clocks; without feedback the queue drifts —
   * monotonically growing latency (audio lagging gameplay) or underruns. A ±2% rate trim is
   * inaudible and locks the queue to a fixed latency.
   */
  outHz = OUT_HZ;

  private output: number[] = [];
  private outRead = 0; // index into output; avoids O(n) splice/shift on every drain
  private sampleAcc = 0;
  maxBufferedSamples = OUT_HZ * 2;

  constructor(io: GbaIo) {
    this.io = io;
    this.ch1.hasSweep = true;
  }

  /** Handle byte writes to FIFO_A/B IO addresses. DMA writes 32-bit, which arrives as 4 byte writes. */
  writeFifo8(off: number, value: number): boolean {
    if (off >= 0x0a0 && off <= 0x0a3) { this.fifoA.pushByte(value & 0xff); return true; }
    if (off >= 0x0a4 && off <= 0x0a7) { this.fifoB.pushByte(value & 0xff); return true; }
    return false;
  }

  /** Called by IO write side effects for SOUNDCNT_H FIFO reset bits. */
  onSoundCntHWrite(): void {
    const h = this.io.get16(0x082);
    if (h & 0x0800) this.fifoA.reset();
    if (h & 0x8000) this.fifoB.reset();
  }

  /** IO write side effect for the PSG register block 0x60-0x7F. */
  onPsgWrite(wordOff: number, v: number): void {
    switch (wordOff) {
      case 0x060: { // SOUND1CNT_L: sweep
        this.ch1.sweepShift = v & 7;
        this.ch1.sweepDir = (v >> 3) & 1;
        this.ch1.sweepTime = (v >> 4) & 7;
        break;
      }
      case 0x062: { // SOUND1CNT_H: length/duty/envelope
        this.ch1.lengthCounter = 64 - (v & 63);
        this.ch1.duty = (v >> 6) & 3;
        this.ch1.envPeriod = (v >> 8) & 7;
        this.ch1.envDir = (v >> 11) & 1;
        this.ch1.envInitial = (v >> 12) & 15;
        if (this.ch1.envInitial === 0 && this.ch1.envDir === 0) this.ch1.enabled = false;
        break;
      }
      case 0x064: { // SOUND1CNT_X: freq/length-enable/trigger
        this.ch1.freq = v & 0x7ff;
        this.ch1.lengthEnable = (v & 0x4000) !== 0;
        if (v & 0x8000) this.ch1.trigger();
        break;
      }
      case 0x068: {
        this.ch2.lengthCounter = 64 - (v & 63);
        this.ch2.duty = (v >> 6) & 3;
        this.ch2.envPeriod = (v >> 8) & 7;
        this.ch2.envDir = (v >> 11) & 1;
        this.ch2.envInitial = (v >> 12) & 15;
        if (this.ch2.envInitial === 0 && this.ch2.envDir === 0) this.ch2.enabled = false;
        break;
      }
      case 0x06c: {
        this.ch2.freq = v & 0x7ff;
        this.ch2.lengthEnable = (v & 0x4000) !== 0;
        if (v & 0x8000) this.ch2.trigger();
        break;
      }
      case 0x070: { // SOUND3CNT_L
        this.ch3.dimension = (v & 0x20) !== 0;
        this.ch3.bank = (v >> 6) & 1;
        this.ch3.playback = (v & 0x80) !== 0;
        if (!this.ch3.playback) this.ch3.enabled = false;
        break;
      }
      case 0x072: { // SOUND3CNT_H
        this.ch3.lengthCounter = 256 - (v & 0xff);
        this.ch3.volumeCode = (v >> 13) & 3;
        this.ch3.force75 = (v & 0x8000) !== 0;
        break;
      }
      case 0x074: { // SOUND3CNT_X
        this.ch3.freq = v & 0x7ff;
        this.ch3.lengthEnable = (v & 0x4000) !== 0;
        if (v & 0x8000) this.ch3.trigger();
        break;
      }
      case 0x078: {
        this.ch4.lengthCounter = 64 - (v & 63);
        this.ch4.envPeriod = (v >> 8) & 7;
        this.ch4.envDir = (v >> 11) & 1;
        this.ch4.envInitial = (v >> 12) & 15;
        if (this.ch4.envInitial === 0 && this.ch4.envDir === 0) this.ch4.enabled = false;
        break;
      }
      case 0x07c: {
        this.ch4.divisor = v & 7;
        this.ch4.width7 = (v & 8) !== 0;
        this.ch4.shift = (v >> 4) & 15;
        this.ch4.lengthEnable = (v & 0x4000) !== 0;
        if (v & 0x8000) this.ch4.trigger();
        break;
      }
    }
  }

  /** Wave RAM write (0x90-0x9F): CPU accesses the bank NOT currently selected for playback. */
  onWaveRamWrite(wordOff: number, v: number): void {
    const idx = (wordOff - 0x090) & 0x0f;
    const bank = this.ch3.bank ^ 1;
    this.ch3.ram[bank][idx] = v & 0xff;
    this.ch3.ram[bank][idx + 1] = (v >> 8) & 0xff;
  }

  /** Timer overflow clocks Direct Sound FIFO samples. */
  onTimerOverflow(timer: number): void {
    const h = this.io.get16(0x082);
    const aUsesTimer1 = (h & 0x0400) !== 0;
    const bUsesTimer1 = (h & 0x4000) !== 0;
    let a = this.fifoA.current, b = this.fifoB.current;
    if ((timer === 0 && !aUsesTimer1) || (timer === 1 && aUsesTimer1)) a = this.fifoA.pop();
    if ((timer === 0 && !bUsesTimer1) || (timer === 1 && bUsesTimer1)) b = this.fifoB.pop();

    const aVol = (h & 0x0004) ? 1.0 : 0.5;
    const bVol = (h & 0x0008) ? 1.0 : 0.5;
    // Direct Sound routing bits: A right/left = bits 8/9, B right/left = bits 12/13.
    const ar = (h & 0x0100) !== 0, al = (h & 0x0200) !== 0;
    const br = (h & 0x1000) !== 0, bl = (h & 0x2000) !== 0;
    this.left = ((al ? a * aVol : 0) + (bl ? b * bVol : 0)) * 0.35;
    this.right = ((ar ? a * aVol : 0) + (br ? b * bVol : 0)) * 0.35;
  }

  consumeDmaRequest(channel: 1 | 2): boolean {
    return channel === 1 ? this.fifoA.consumeDmaRequest() : this.fifoB.consumeDmaRequest();
  }

  private clockFrameSequencer(): void {
    const s = this.frameSeqStep;
    if ((s & 1) === 0) {
      this.ch1.clockLength(); this.ch2.clockLength(); this.ch3.clockLength(); this.ch4.clockLength();
    }
    if (s === 2 || s === 6) this.ch1.clockSweep();
    if (s === 7) { this.ch1.clockEnvelope(); this.ch2.clockEnvelope(); this.ch4.clockEnvelope(); }
    this.frameSeqStep = (s + 1) & 7;
  }

  /** Mix the four PSG channels for the current instant. Returns [left, right] in ~[-1,1]. */
  private psgMix(): [number, number] {
    const cntL = this.io.get16(0x080);
    const cntH = this.io.get16(0x082);
    const psgRatio = (cntH & 3) === 0 ? 0.25 : (cntH & 3) === 1 ? 0.5 : 1.0;
    const rVol = ((cntL & 7) + 1) / 8;
    const lVol = (((cntL >> 4) & 7) + 1) / 8;
    const o1 = this.ch1.output(), o2 = this.ch2.output(), o3 = this.ch3.output(), o4 = this.ch4.output();
    let l = 0, r = 0;
    if (cntL & 0x0100) r += o1; if (cntL & 0x1000) l += o1;
    if (cntL & 0x0200) r += o2; if (cntL & 0x2000) l += o2;
    if (cntL & 0x0400) r += o3; if (cntL & 0x4000) l += o3;
    if (cntL & 0x0800) r += o4; if (cntL & 0x8000) l += o4;
    // 4 channels summed; scale to keep PSG comparable to the DS path.
    const k = 0.25 * psgRatio * 0.5;
    return [l * lVol * k, r * rVol * k];
  }

  /** Advance audio output resampling by CPU cycles. Call once per CPU/hardware step. */
  step(cycles: number): void {
    if ((this.io.get16(0x084) & 0x80) === 0) return; // SOUNDCNT_X master enable
    // PSG channel timers + frame sequencer advance in CPU-cycle time.
    this.ch1.advance(cycles); this.ch2.advance(cycles); this.ch3.advance(cycles); this.ch4.advance(cycles);
    this.frameSeqAcc += cycles;
    while (this.frameSeqAcc >= FRAME_SEQ_PERIOD) { this.frameSeqAcc -= FRAME_SEQ_PERIOD; this.clockFrameSequencer(); }

    this.sampleAcc += cycles * this.outHz;
    while (this.sampleAcc >= CPU_HZ) {
      this.sampleAcc -= CPU_HZ;
      const [pl, pr] = this.psgMix();
      let l = this.left + pl, r = this.right + pr;
      // Soft clip.
      l = Math.max(-1, Math.min(1, l)); r = Math.max(-1, Math.min(1, r));
      this.output.push(l, r);
      const maxFloats = this.maxBufferedSamples * 2;
      if (this.output.length - this.outRead > maxFloats) this.outRead = this.output.length - maxFloats;
      // Compact occasionally, never every audio callback.
      if (this.outRead > 16384 && this.outRead > (this.output.length >> 1)) {
        this.output = this.output.slice(this.outRead);
        this.outRead = 0;
      }
    }
  }

  /** Drain interleaved stereo Float32-ish samples for the browser audio queue. */
  drainSamples(maxFrames = 4096): Float32Array {
    const available = this.output.length - this.outRead;
    const frames = Math.min(maxFrames, available >> 1);
    const n = frames * 2;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.output[this.outRead + i] || 0;
    this.outRead += n;
    if (this.outRead > 16384 && this.outRead > (this.output.length >> 1)) {
      this.output = this.output.slice(this.outRead);
      this.outRead = 0;
    }
    return out;
  }

  get bufferedFrames(): number { return (this.output.length - this.outRead) >> 1; }
  serializeState() {
    return {
      a: this.fifoA.q, b: this.fifoB.q, left: this.left, right: this.right,
      wave0: [...this.ch3.ram[0]], wave1: [...this.ch3.ram[1]],
    };
  }
  loadState(s: any) {
    if (!s) return;
    if (Array.isArray(s.wave0)) this.ch3.ram[0].set(s.wave0);
    if (Array.isArray(s.wave1)) this.ch3.ram[1].set(s.wave1);
  }
}
