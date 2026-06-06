/**
 * GBA memory map (the real one).
 *
 *   00000000-00003FFF  BIOS (16 KB, read-only) — we HLE most of it, but provide a small stub.
 *   02000000-0203FFFF  EWRAM (256 KB, on-board work RAM, slower)
 *   03000000-03007FFF  IWRAM (32 KB, fast internal work RAM)
 *   04000000-040003FF  I/O registers (PPU/DMA/timers/sound/keys/IRQ)
 *   05000000-050003FF  Palette RAM (1 KB: BG + OBJ, 256+256 entries of 15-bit color)
 *   06000000-06017FFF  VRAM (96 KB)
 *   07000000-070003FF  OAM (1 KB sprite attributes)
 *   08000000-09FFFFFF  Cartridge ROM (waitstate 0), mirrored at 0A/0B and 0C/0D
 *   0E000000-0E00FFFF  Cartridge save (SRAM/Flash)
 *
 * Regions mirror within their address windows (e.g. IWRAM mirrors every 0x8000). This module
 * exposes a Bus the CPU uses, and direct typed-array handles the PPU/DMA read for rendering.
 *
 * IO register reads/writes are delegated to a hook (the runtime wires PPU/DMA/timers/IRQ here),
 * so this file stays focused on routing + RAM.
 */

import type { Bus } from '../cpu/bus.ts';
import type { GbaFlash } from './flash.ts';

export interface IoBus {
  readIo8(addr: number): number;
  writeIo8(addr: number, value: number): void;
}

export class GbaMemory implements Bus {
  bios = new Uint8Array(0x4000);
  ewram = new Uint8Array(0x40000);
  iwram = new Uint8Array(0x8000);
  palette = new Uint8Array(0x400);
  vram = new Uint8Array(0x18000);
  oam = new Uint8Array(0x400);
  rom = new Uint8Array(0);
  sram = new Uint8Array(0x10000);
  flash: GbaFlash | null = null; // when set, region 0x0E is backed by Flash instead of SRAM
  rtc: { read(addr: number): number; write(addr: number, value: number): void } | null = null; // GPIO RTC (Ruby/Sapphire/Emerald)

  io: IoBus | null = null;

  // Raw IO register backing store for simple registers the IoBus doesn't intercept.
  ioRegs = new Uint8Array(0x400);

  loadRom(bytes: Uint8Array): void { this.rom = bytes; }

  /** Provide a tiny BIOS stub so reads from the BIOS region don't fault. Real SWIs are HLE'd. */
  installBiosStub(): void {
    // A minimal "infinite loop" so an accidental jump to BIOS doesn't execute garbage.
    // 0x00: b 0x00 (e afffffe)
    this.bios.fill(0);
    this.bios[0] = 0xfe; this.bios[1] = 0xff; this.bios[2] = 0xff; this.bios[3] = 0xea;
  }

  private romByte(off: number): number {
    return off < this.rom.length ? this.rom[off] : 0;
  }

  // ---------- 8-bit ----------
  read8(addr: number): number {
    addr >>>= 0;
    const region = (addr >>> 24) & 0xff;
    switch (region) {
      case 0x00: case 0x01: return this.bios[addr & 0x3fff];
      case 0x02: return this.ewram[addr & 0x3ffff];
      case 0x03: return this.iwram[addr & 0x7fff];
      case 0x04: {
        const r = addr & 0x3ff;
        if (this.io) return this.io.readIo8(addr & 0xffffff) & 0xff;
        return this.ioRegs[r];
      }
      case 0x05: return this.palette[addr & 0x3ff];
      case 0x06: { let o = addr & 0x1ffff; if (o >= 0x18000) o -= 0x8000; return this.vram[o]; }
      case 0x07: return this.oam[addr & 0x3ff];
      case 0x08: case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d: {
        // GPIO RTC window 0x080000C4-0x080000C9 (Ruby/Sapphire/Emerald). Route to the RTC chip
        // when present; otherwise fall through to the ROM bytes (the chip is mapped over them).
        const off = addr & 0x01ffffff;
        if (this.rtc && off >= 0xc4 && off <= 0xc9) {
          const v = this.rtc.read(off & ~1);
          return (off & 1) ? (v >>> 8) & 0xff : v & 0xff;
        }
        return this.romByte(off);
      }
      case 0x0e: case 0x0f:
        return this.flash ? this.flash.read(addr & 0xffff) : this.sram[addr & 0xffff];
      default: return 0;
    }
  }
  read16(addr: number): number {
    addr &= ~1;
    return this.read8(addr) | (this.read8(addr + 1) << 8);
  }
  read32(addr: number): number {
    addr &= ~3;
    return (this.read8(addr) | (this.read8(addr + 1) << 8) | (this.read8(addr + 2) << 16) | (this.read8(addr + 3) << 24)) >>> 0;
  }

  // ---------- writes ----------
  write8(addr: number, value: number): void {
    addr >>>= 0; value &= 0xff;
    const region = (addr >>> 24) & 0xff;
    switch (region) {
      case 0x02: this.ewram[addr & 0x3ffff] = value; break;
      case 0x03: this.iwram[addr & 0x7fff] = value; break;
      case 0x04:
        if (this.io) this.io.writeIo8(addr & 0xffffff, value);
        else this.ioRegs[addr & 0x3ff] = value;
        break;
      case 0x05: this.palette[addr & 0x3ff] = value; break; // note: byte writes to palette/VRAM/OAM have quirks; handled at 16-bit
      case 0x06: { let o = addr & 0x1ffff; if (o >= 0x18000) o -= 0x8000; this.vram[o] = value; break; }
      case 0x07: this.oam[addr & 0x3ff] = value; break;
      case 0x08: case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d: {
        // GPIO RTC writes (data/direction/control) land in the 0x080000C4-C9 window.
        const off = addr & 0x01ffffff;
        if (this.rtc && off >= 0xc4 && off <= 0xc9) {
          const base = off & ~1;
          const prev = this.rtc.read(base);
          const v = (off & 1) ? ((prev & 0x00ff) | (value << 8)) : ((prev & 0xff00) | value);
          this.rtc.write(base, v & 0xffff);
        }
        break;
      }
      case 0x0e: case 0x0f:
        if (this.flash) this.flash.write(addr & 0xffff, value); else this.sram[addr & 0xffff] = value;
        break;
      default: break; // BIOS/ROM read-only
    }
  }
  write16(addr: number, value: number): void {
    addr &= ~1; value &= 0xffff;
    // Cartridge Flash/SRAM is on a 16-bit bus but Flash commands are low-byte command writes.
    // Do NOT route the high byte as a second write: 0xAA00 high bytes to 0x5556/0x2AAB break
    // Ruby's command unlock and save polling.
    const region = (addr >>> 24) & 0xff;
    if (region === 0x0e || region === 0x0f) {
      if (this.flash) this.flash.write(addr & 0xffff, value & 0xff);
      else this.sram[addr & 0xffff] = value & 0xff;
      return;
    }
    if (region === 0x04 && this.io) { this.io.writeIo16(addr & 0xffffff, value); return; }
    // Palette/VRAM/OAM are 16-bit-natural; write both bytes.
    this.write8(addr, value & 0xff);
    this.write8(addr + 1, (value >>> 8) & 0xff);
  }
  write32(addr: number, value: number): void {
    addr &= ~3; value >>>= 0;
    const region = (addr >>> 24) & 0xff;
    if (region === 0x04 && this.io) { this.io.writeIo32(addr & 0xffffff, value); return; }
    this.write16(addr, value & 0xffff);
    this.write16(addr + 2, (value >>> 16) & 0xffff);
  }

  // Helpers for PPU/DMA fast paths
  vram16(off: number): number { return this.vram[off] | (this.vram[off + 1] << 8); }
  pal16(off: number): number { return this.palette[off] | (this.palette[off + 1] << 8); }
  oam16(off: number): number { return this.oam[off] | (this.oam[off + 1] << 8); }
}
