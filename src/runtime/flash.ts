/**
 * GBA Flash save emulation (128 KB, used by Pokemon Ruby/Sapphire/Emerald).
 *
 * Ruby/Sapphire use Flash 1M (two 64KB banks). The game writes command bytes to the save region
 * through the GBA's 16-bit external bus, so memory.ts routes halfword writes here as a *single*
 * low-byte command write. Treating a 16-bit save write as two independent byte writes can corrupt
 * the unlock sequence (the high byte write hits 0x5556/0x2AAB), which is exactly how save flows get
 * stuck polling forever.
 */

const FLASH_SIZE = 0x20000;
const BANK_SIZE = 0x10000;
const SECTOR_SIZE = 0x1000;
const ID_MANUFACTURER = 0xc2; // Macronix
const ID_DEVICE = 0x09;       // 128K / 1Mbit

const St = { READY: 0, UNLOCK1: 1, UNLOCK2: 2, ERASE1: 3, ERASE2: 4, ERASE3: 5, PROGRAM: 6, BANK: 7 } as const;
type St = (typeof St)[keyof typeof St];

export class GbaFlash {
  data = new Uint8Array(FLASH_SIZE);
  private state: St = St.READY;
  private idMode = false;
  private bank = 0;
  dirty = false;

  // Operations complete immediately. Ruby verifies Flash writes by reading the target byte back;
  // returning toggle/status bytes here can make the save routine think the write failed/hung.

  constructor(initial?: Uint8Array) {
    this.data.fill(0xff);
    if (initial?.length) this.data.set(initial.subarray(0, FLASH_SIZE));
  }

  private abs(off: number): number { return (this.bank * BANK_SIZE + (off & 0xffff)) & (FLASH_SIZE - 1); }
  private setReady(_addr = 0): void { /* immediate-ready Flash model */ }
  // Flash command addresses are byte addresses in docs, but GBA halfword writes are aligned by the
  // CPU/bus before reaching memory. Accept both 0x5555 and its aligned 0x5554 form.
  private is5555(off: number): boolean { return off === 0x5555 || off === 0x5554; }
  private is2aaa(off: number): boolean { return off === 0x2aaa; }

  read(addr: number): number {
    const off = addr & 0xffff;
    // If games poll the status register after an operation, report ready immediately. DQ7 mirrors
    // the final data bit and DQ6 stops toggling; for erased sectors the ready value is 0xFF. Normal
    // verify reads still return the actual cell below.
    if (off === 0x5555 && !this.idMode) return this.data[this.abs(off)];
    if (this.idMode) {
      if (off === 0x0000) return ID_MANUFACTURER;
      if (off === 0x0001) return ID_DEVICE;
    }
    return this.data[this.abs(off)];
  }

  /** Save-region writes are command-byte writes. For 16-bit bus writes, pass the low byte only. */
  write(addr: number, value: number): void {
    const off = addr & 0xffff;
    value &= 0xff;

    // Reset/read-array is accepted from almost anywhere.
    if (value === 0xf0) { this.idMode = false; this.state = St.READY; return; }

    if (this.state === St.PROGRAM) {
      // Flash programming can only clear bits (1 -> 0); erase restores 1s.
      const a = this.abs(off);
      this.data[a] &= value;
      this.dirty = true;
      this.state = St.READY;
      this.setReady(off);
      return;
    }

    if (this.state === St.BANK) {
      // Flash 1M bank register is selected by AA/55/B0 then write bank to address 0.
      if (off === 0x0000) this.bank = value & 1;
      this.state = St.READY;
      return;
    }

    switch (this.state) {
      case St.READY:
        if (this.is5555(off) && value === 0xaa) this.state = St.UNLOCK1;
        break;
      case St.UNLOCK1:
        this.state = (this.is2aaa(off) && value === 0x55) ? St.UNLOCK2 : St.READY;
        break;
      case St.UNLOCK2:
        if (!this.is5555(off)) { this.state = St.READY; break; }
        switch (value) {
          case 0x90: this.idMode = true; this.state = St.READY; break;
          case 0x80: this.state = St.ERASE1; break;
          case 0xa0: this.state = St.PROGRAM; break;
          case 0xb0: this.state = St.BANK; break;
          default: this.state = St.READY; break;
        }
        break;
      case St.ERASE1:
        this.state = (this.is5555(off) && value === 0xaa) ? St.ERASE2 : St.READY;
        break;
      case St.ERASE2:
        this.state = (this.is2aaa(off) && value === 0x55) ? St.ERASE3 : St.READY;
        break;
      case St.ERASE3:
        if (value === 0x10 && this.is5555(off)) {
          this.data.fill(0xff);
          this.dirty = true;
          this.setReady(0);
        } else if (value === 0x30) {
          const base = this.abs(off) & ~(SECTOR_SIZE - 1);
          this.data.fill(0xff, base, base + SECTOR_SIZE);
          this.dirty = true;
          this.setReady(off);
        }
        this.state = St.READY;
        break;
    }
  }

  getBank(): number { return this.bank; }
  serializeState() { return { data: Array.from(this.data), bank: this.bank }; }
  loadState(s: any) { if (s?.data) this.data.set(s.data); this.bank = s?.bank & 1 || 0; }
}
