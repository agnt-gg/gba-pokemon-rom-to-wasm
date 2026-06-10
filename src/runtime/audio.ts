/**
 * Minimal GBA Direct Sound path.
 *
 * Pokemon Ruby uses Direct Sound FIFO A/B: DMA1/DMA2 feed 8-bit PCM into FIFO_A (0x040000A0)
 * and FIFO_B (0x040000A4), Timer0 overflows clock samples out, and SOUNDCNT_X enables master
 * sound. This module intentionally starts with the Direct Sound path only (no PSG square/wave/noise
 * yet), which is enough to make Ruby audible.
 */

import { GbaIo, REG } from './io.ts';

const CPU_HZ = 16_777_216;
const OUT_HZ = 44_100;
const FIFO_CAP = 64;

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
    if (this.q.length) this.current = this.q.shift()!;
    // Hardware requests a DMA refill when FIFO contains 16 bytes or fewer, not on every sample.
    if (this.q.length <= 16) this.needsDma = true;
    return this.current;
  }
  consumeDmaRequest(): boolean { const r = this.needsDma; this.needsDma = false; return r; }
  get level(): number { return this.q.length; }
}

export class GbaAudio {
  io: GbaIo;
  fifoA = new PcmFifo();
  fifoB = new PcmFifo();
  left = 0;
  right = 0;

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
  private lastCycles = 0;
  maxBufferedSamples = OUT_HZ * 2;

  constructor(io: GbaIo) { this.io = io; }

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

  /** Advance audio output resampling by CPU cycles. Call once per CPU/hardware step. */
  step(cycles: number): void {
    if ((this.io.get16(0x084) & 0x80) === 0) return; // SOUNDCNT_X master enable
    this.sampleAcc += cycles * this.outHz;
    while (this.sampleAcc >= CPU_HZ) {
      this.sampleAcc -= CPU_HZ;
      let l = this.left, r = this.right;
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
  serializeState() { return { a: this.fifoA.q, b: this.fifoB.q, left: this.left, right: this.right }; }
  loadState(_s: any) { /* not needed yet */ }
}
