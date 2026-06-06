/**
 * GBA DMA controller — 4 channels.
 *
 * DMA copies blocks of memory far faster than CPU loops, and games (Pokemon included) use it
 * constantly to move tile/palette/OAM data and to feed the sound FIFOs. Each channel has:
 *   SAD (source), DAD (dest), CNT_L (word count), CNT_H (control).
 * Control bits: dest adjust, source adjust, repeat, 32/16-bit, timing (immediate/VBlank/HBlank/special),
 * IRQ, enable.
 *
 * Implements immediate, VBlank, HBlank, and Direct Sound FIFO special timing (DMA1/2).
 */

import type { GbaMemory } from './memory.ts';
import { GbaIo, REG } from './io.ts';

const IRQ_DMA = [1 << 8, 1 << 9, 1 << 10, 1 << 11];

export class GbaDma {
  mem: GbaMemory;
  io: GbaIo;
  requestIrq: (bits: number) => void = () => {};

  // Latched internal address/count per channel (reload on enable / repeat).
  private srcAddr = [0, 0, 0, 0];
  private dstAddr = [0, 0, 0, 0];
  private count = [0, 0, 0, 0];
  private enabled = [false, false, false, false];

  private CNT_H = [REG.DMA0CNT_H, REG.DMA1CNT_H, REG.DMA2CNT_H, REG.DMA3CNT_H];
  private SAD = [REG.DMA0SAD, REG.DMA1SAD, REG.DMA2SAD, REG.DMA3SAD];
  private DAD = [REG.DMA0DAD, REG.DMA1DAD, REG.DMA2DAD, REG.DMA3DAD];
  private CNT_L = [REG.DMA0CNT_L, REG.DMA1CNT_L, REG.DMA2CNT_L, REG.DMA3CNT_L];

  constructor(mem: GbaMemory, io: GbaIo) { this.mem = mem; this.io = io; }

  private read32IO(off: number): number { return (this.io.get16(off) | (this.io.get16(off + 2) << 16)) >>> 0; }

  /** Called when a DMAxCNT_H register is written. Detect enable rising edge. */
  onControlWrite(channel: number): void {
    const ctrl = this.io.get16(this.CNT_H[channel]);
    const wasEnabled = this.enabled[channel];
    const nowEnabled = (ctrl & 0x8000) !== 0;
    if (nowEnabled && !wasEnabled) {
      // Latch source/dest/count.
      this.srcAddr[channel] = this.read32IO(this.SAD[channel]) >>> 0;
      this.dstAddr[channel] = this.read32IO(this.DAD[channel]) >>> 0;
      let cnt = this.io.get16(this.CNT_L[channel]);
      if (cnt === 0) cnt = (channel === 3) ? 0x10000 : 0x4000;
      this.count[channel] = cnt;
      this.enabled[channel] = true;
      const timing = (ctrl >> 12) & 3;
      if (timing === 0) this.runChannel(channel); // immediate
    } else if (!nowEnabled) {
      this.enabled[channel] = false;
    }
  }

  /** Trigger timing-based DMAs (VBlank=1, HBlank=2, Special/FIFO=3). */
  trigger(timing: number): void {
    for (let ch = 0; ch < 4; ch++) {
      if (!this.enabled[ch]) continue;
      const ctrl = this.io.get16(this.CNT_H[ch]);
      if (((ctrl >> 12) & 3) === timing) this.runChannel(ch, timing === 3);
    }
  }

  /** Trigger one Direct Sound FIFO DMA channel. FIFO A conventionally uses DMA1, FIFO B DMA2. */
  triggerSoundChannel(ch: 1 | 2): void {
    if (!this.enabled[ch]) return;
    const ctrl = this.io.get16(this.CNT_H[ch]);
    if (((ctrl >> 12) & 3) === 3) this.runChannel(ch, true);
  }

  private runChannel(ch: number, soundFifo = false): void {
    const ctrl = this.io.get16(this.CNT_H[ch]);
    const word = (ctrl & 0x400) !== 0;
    const dstCtl = (ctrl >> 5) & 3; // 0 inc,1 dec,2 fixed,3 inc+reload
    const srcCtl = (ctrl >> 7) & 3;
    const repeat = (ctrl & 0x200) !== 0;
    const irq = (ctrl & 0x4000) !== 0;
    const unit = word ? 4 : 2;
    let src = this.srcAddr[ch] >>> 0;
    let dst = this.dstAddr[ch] >>> 0;
    const fifoDst = (dst & 0x0ffffffc) === 0x040000a0 || (dst & 0x0ffffffc) === 0x040000a4;
    // Direct Sound DMA timing ignores DMAxCNT_L and transfers exactly 4 words (16 bytes)
    // into FIFO A/B on each timer request.
    const n = soundFifo && (ch === 1 || ch === 2) && fifoDst ? 4 : this.count[ch];

    for (let i = 0; i < n; i++) {
      const value = word ? this.mem.read32(src) : this.mem.read16(src);
      if (soundFifo && fifoDst && word && this.io.fifoWriteHook) {
        // Sound FIFO DMA writes one 32-bit word as four sequential signed PCM bytes into the FIFO.
        // Going through generic byte/halfword IO paths is too easy to get wrong because FIFO A/B
        // are stream ports, not normal registers.
        const base = dst & 0x3ff;
        this.io.fifoWriteHook(base, value & 0xff);
        this.io.fifoWriteHook(base + 1, (value >>> 8) & 0xff);
        this.io.fifoWriteHook(base + 2, (value >>> 16) & 0xff);
        this.io.fifoWriteHook(base + 3, (value >>> 24) & 0xff);
      } else if (word) this.mem.write32(dst, value);
      else this.mem.write16(dst, value);
      src = (src + (srcCtl === 1 ? -unit : srcCtl === 2 ? 0 : unit)) >>> 0;
      // Direct Sound FIFO destination is a fixed stream port for all 4 transferred words.
      if (!(soundFifo && fifoDst)) dst = (dst + (dstCtl === 1 ? -unit : dstCtl === 2 ? 0 : unit)) >>> 0;
    }
    this.srcAddr[ch] = src;
    // Sound FIFO DMA destination is fixed at FIFO_A/B even if the register bits say increment.
    if (soundFifo && fifoDst) this.dstAddr[ch] = this.dstAddr[ch] >>> 0;
    else if (dstCtl !== 3) this.dstAddr[ch] = dst;

    if (irq) this.requestIrq(IRQ_DMA[ch]);

    // Clear enable unless repeating (and not immediate).
    const timing = (ctrl >> 12) & 3;
    if (!repeat || timing === 0) {
      this.enabled[ch] = false;
      this.io.set16(this.CNT_H[ch], ctrl & ~0x8000);
    }
  }

  serializeState() { return { srcAddr: [...this.srcAddr], dstAddr: [...this.dstAddr], count: [...this.count], enabled: [...this.enabled] }; }
  loadState(s: any) { this.srcAddr = [...s.srcAddr]; this.dstAddr = [...s.dstAddr]; this.count = [...s.count]; this.enabled = [...s.enabled]; }
}
