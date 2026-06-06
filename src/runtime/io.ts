/**
 * GBA I/O register file (0x04000000-0x040003FF).
 *
 * This owns the raw 16-bit register values and routes reads/writes. The PPU, DMA, timers, and
 * IRQ controller all read/write through here. We keep a flat halfword array plus named accessors
 * for the registers the hardware actually uses. Side-effecting registers (DMA enable, IF ack,
 * etc.) are handled by hooks the runtime installs.
 */

import type { IoBus } from './memory.ts';

// Common register offsets (relative to 0x04000000).
export const REG = {
  DISPCNT: 0x000, DISPSTAT: 0x004, VCOUNT: 0x006,
  BG0CNT: 0x008, BG1CNT: 0x00a, BG2CNT: 0x00c, BG3CNT: 0x00e,
  BG0HOFS: 0x010, BG0VOFS: 0x012, BG1HOFS: 0x014, BG1VOFS: 0x016,
  BG2HOFS: 0x018, BG2VOFS: 0x01a, BG3HOFS: 0x01c, BG3VOFS: 0x01e,
  BG2PA: 0x020, BG2PB: 0x022, BG2PC: 0x024, BG2PD: 0x026, BG2X: 0x028, BG2Y: 0x02c,
  BG3PA: 0x030, BG3PB: 0x032, BG3PC: 0x034, BG3PD: 0x036, BG3X: 0x038, BG3Y: 0x03c,
  WIN0H: 0x040, WIN1H: 0x042, WIN0V: 0x044, WIN1V: 0x046, WININ: 0x048, WINOUT: 0x04a,
  MOSAIC: 0x04c, BLDCNT: 0x050, BLDALPHA: 0x052, BLDY: 0x054,
  DMA0SAD: 0x0b0, DMA0DAD: 0x0b4, DMA0CNT_L: 0x0b8, DMA0CNT_H: 0x0ba,
  DMA1SAD: 0x0bc, DMA1DAD: 0x0c0, DMA1CNT_L: 0x0c4, DMA1CNT_H: 0x0c6,
  DMA2SAD: 0x0c8, DMA2DAD: 0x0cc, DMA2CNT_L: 0x0d0, DMA2CNT_H: 0x0d2,
  DMA3SAD: 0x0d4, DMA3DAD: 0x0d8, DMA3CNT_L: 0x0dc, DMA3CNT_H: 0x0de,
  TM0CNT_L: 0x100, TM0CNT_H: 0x102, TM1CNT_L: 0x104, TM1CNT_H: 0x106,
  TM2CNT_L: 0x108, TM2CNT_H: 0x10a, TM3CNT_L: 0x10c, TM3CNT_H: 0x10e,
  KEYINPUT: 0x130, KEYCNT: 0x132,
  IE: 0x200, IF: 0x202, WAITCNT: 0x204, IME: 0x208,
  HALTCNT: 0x301,
} as const;

export type IoWriteHook = (offset: number, value16: number, prev: number) => void;

export class GbaIo implements IoBus {
  regs = new Uint16Array(0x400 >> 1); // halfword-addressed
  writeHook: IoWriteHook | null = null;
  ifReadHook: (() => number) | null = null;
  ifAckHook: ((bits: number) => void) | null = null;
  haltHook: (() => void) | null = null;
  fifoWriteHook: ((offset: number, value: number) => boolean) | null = null;

  get16(off: number): number { return this.regs[(off & 0x3ff) >> 1]; }
  set16(off: number, v: number): void { this.regs[(off & 0x3ff) >> 1] = v & 0xffff; }

  readIo8(addr: number): number {
    const off = addr & 0x3ff;
    // KEYINPUT returns live key state (1 = released). Runtime updates regs[KEYINPUT].
    if (off === REG.IF || off === REG.IF + 1) {
      const v = this.ifReadHook ? this.ifReadHook() : this.get16(REG.IF);
      return (off & 1) ? (v >>> 8) & 0xff : v & 0xff;
    }
    const hw = this.get16(off & ~1);
    return (off & 1) ? (hw >>> 8) & 0xff : hw & 0xff;
  }

  private writeFifoByte(off: number, value: number): boolean {
    return off >= 0x0a0 && off <= 0x0a7 && !!this.fifoWriteHook?.(off, value & 0xff);
  }

  writeIo16(addr: number, value: number): void {
    const off = addr & 0x3ff;
    if (off >= 0x0a0 && off <= 0x0a7) {
      this.writeFifoByte(off, value & 0xff);
      this.writeFifoByte(off + 1, (value >>> 8) & 0xff);
      return;
    }
    this.writeIo8(addr, value & 0xff);
    this.writeIo8(addr + 1, (value >>> 8) & 0xff);
  }

  writeIo32(addr: number, value: number): void {
    const off = addr & 0x3ff;
    if (off >= 0x0a0 && off <= 0x0a7) {
      this.writeFifoByte(off, value & 0xff);
      this.writeFifoByte(off + 1, (value >>> 8) & 0xff);
      this.writeFifoByte(off + 2, (value >>> 16) & 0xff);
      this.writeFifoByte(off + 3, (value >>> 24) & 0xff);
      return;
    }
    this.writeIo16(addr, value & 0xffff);
    this.writeIo16(addr + 2, (value >>> 16) & 0xffff);
  }

  writeIo8(addr: number, value: number): void {
    const off = addr & 0x3ff;
    const wordOff = off & ~1;
    const prev = this.get16(wordOff);
    let v: number;
    if (off & 1) v = (prev & 0x00ff) | ((value & 0xff) << 8);
    else v = (prev & 0xff00) | (value & 0xff);

    // Direct Sound FIFO registers (0xA0-0xA7) are write-only byte streams.
    if (this.writeFifoByte(off, value & 0xff)) return;

    // IF is write-1-to-clear.
    if (wordOff === REG.IF) {
      const ackBits = (off & 1) ? ((value & 0xff) << 8) : (value & 0xff);
      if (this.ifAckHook) this.ifAckHook(ackBits);
      return;
    }
    if (off === REG.HALTCNT) {
      if (this.haltHook) this.haltHook();
      return;
    }
    this.set16(wordOff, v);
    if (this.writeHook) this.writeHook(wordOff, this.get16(wordOff), prev);
  }
}
