/**
 * Memory bus interface the CPU talks to.
 *
 * The GBA has a flat 32-bit address space (unlike the GB's 16-bit map + MBC banking).
 * The CPU core depends only on this small interface so it can be unit-tested against a
 * plain RAM model, then wired to the real GBA memory map (BIOS/EWRAM/IWRAM/IO/VRAM/...).
 *
 * ARM is little-endian on the GBA. read32 must honor the ARM "rotated read" behavior for
 * unaligned addresses at the LDR level, but the bus itself returns aligned data; the CPU
 * core applies the rotation. Here read32/read16 expect the caller to pass the raw address.
 */
export interface Bus {
  read8(addr: number): number;
  read16(addr: number): number;
  read32(addr: number): number;
  write8(addr: number, value: number): void;
  write16(addr: number, value: number): void;
  write32(addr: number, value: number): void;
}

/** Simple flat-RAM bus used for CPU unit tests (no hardware, just bytes). */
export class FlatBus implements Bus {
  mem: Uint8Array;
  constructor(size = 0x200000) { this.mem = new Uint8Array(size); }
  private m(a: number): number { return a & (this.mem.length - 1); }
  read8(a: number): number { return this.mem[this.m(a)]; }
  read16(a: number): number { const i = this.m(a & ~1); return this.mem[i] | (this.mem[i + 1] << 8); }
  read32(a: number): number {
    const i = this.m(a & ~3);
    return (this.mem[i] | (this.mem[i + 1] << 8) | (this.mem[i + 2] << 16) | (this.mem[i + 3] << 24)) >>> 0;
  }
  write8(a: number, v: number): void { this.mem[this.m(a)] = v & 0xff; }
  write16(a: number, v: number): void { const i = this.m(a & ~1); this.mem[i] = v & 0xff; this.mem[i + 1] = (v >>> 8) & 0xff; }
  write32(a: number, v: number): void {
    const i = this.m(a & ~3);
    this.mem[i] = v & 0xff; this.mem[i + 1] = (v >>> 8) & 0xff;
    this.mem[i + 2] = (v >>> 16) & 0xff; this.mem[i + 3] = (v >>> 24) & 0xff;
  }
}
