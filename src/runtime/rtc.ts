/**
 * GPIO Real-Time Clock (Seiko S-3511A / "SiiRTC") emulation.
 *
 * Pokemon Ruby/Sapphire/Emerald (and FireRed/LeafGreen for the wireless adapter) wire an RTC chip
 * to the cartridge's 4-bit General Purpose I/O port, mapped over the ROM at:
 *   0x080000C4  GPIO data   (bits 0-3 = SCK, SIO, CS, -)
 *   0x080000C6  GPIO direction (1 = output from GBA, 0 = input to GBA)
 *   0x080000C8  GPIO control (bit0: 1 = GPIO pins readable, 0 = read as 0)
 *
 * The chip speaks a 3-wire serial protocol:
 *   bit0 = SCK  (clock, driven by GBA)
 *   bit1 = SIO  (bidirectional data)
 *   bit2 = CS   (chip select; transfer active while high)
 *
 * A transfer begins on CS rising edge. The GBA first clocks out an 8-bit command byte
 * (MSB-first in this implementation matching pokeruby's bit order), whose bits select a register
 * and a read/write direction. Then it clocks the parameter bytes in/out, LSB-first per byte.
 *
 * We implement enough of the protocol for the boot-time RTC probe and date/time reads to succeed:
 * STATUS, DATETIME (7 bytes), TIME (3 bytes), and the reset/force-IRQ no-ops. Date/time values are
 * sourced from the host clock and BCD-encoded, which is exactly what the games expect.
 */

const Pin = { SCK: 0x1, SIO: 0x2, CS: 0x4 } as const;

// Command byte format used by S-3511A: 0b0110_RRRW where R=register index, W=read flag.
// pokeruby's RtcGetRawData clocks the command MSB-first; the fixed prefix nibble is 0b0110.
const CMD_RESET = 0;
const CMD_STATUS = 1;
const CMD_DATETIME = 2;
const CMD_TIME = 3;
const CMD_ALARM = 4;

function bcd(n: number): number { return ((Math.floor(n / 10) % 10) << 4) | (n % 10); }
function bitReverse8(v: number): number { let r = 0; for (let i = 0; i < 8; i++) { r = (r << 1) | ((v >> i) & 1); } return r & 0xff; }

export class GbaRtc {
  // Pin state as last written by the GBA.
  private sck = 0;
  private sio = 0;
  private cs = 0;
  private dir = 0;      // direction bits (1 = GBA output)
  private control = 0;  // 0x80000c8 bit0 enables pin readback

  // Serial transfer state machine.
  private active = false;     // CS high, transfer in progress
  private commandDone = false;
  private bitsIn = 0;         // bits accumulated for the current incoming byte
  private curByte = 0;
  private command = 0;        // decoded command byte
  private reg = 0;            // selected register
  private reading = false;    // true once command says "read"
  private byteIndex = 0;      // which parameter byte we're on
  private outByte = 0;        // byte currently being shifted out
  // True until the first falling edge after the command byte: that edge PRESENTS bit 0
  // (S-3511A drives data on falling edges; the GBA samples while SCK is high). Advancing on
  // that first fall shifted every byte right by one bit - the Emerald battery-dry root cause.
  private firstFallPending = false;
  private outBits = 0;        // bits already shifted out of outByte

  // S-3511A status register (24h flag in bit6, power-fail in bit7). 0x40 = 24-hour mode.
  private status = 0x40;

  // Optional debug hook used by bring-up scripts. Kept inert unless a tool assigns it.
  debug: ((msg: string) => void) | null = null;

  // Virtual-clock base. We snapshot the host wall clock ONCE at construction and derive the
  // reported time from a monotonic offset. Pokemon validates its save by reading the RTC at two
  // different points during boot and comparing them; if the live host clock ticks a second between
  // those two reads (which happens roughly half the time, depending on exactly when the player
  // presses A), the comparison disagrees and the game reports "save file corrupted". Latching a
  // virtual base makes consecutive reads stable and monotonic, eliminating the race.
  private baseEpochMs = Date.now();
  private basePerfMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  // While the boot validation window is open, freeze the reported time entirely so the two boot
  // reads are byte-identical. We release the freeze after enough real time has passed that boot is
  // certainly complete; from then on the clock advances normally for in-game day/night.
  private bootFreeze = true;
  private firstReadPerfMs = -1;

  /** Current virtual time as a Date, latched during boot to defeat the read-vs-read race. */
  private virtualNow(): Date {
    const nowPerf = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (this.firstReadPerfMs < 0) this.firstReadPerfMs = nowPerf;
    if (this.bootFreeze) {
      // Hold the clock perfectly still for the first ~3s of reads (the boot validation window),
      // then let it run so in-game time-of-day still progresses.
      if (nowPerf - this.firstReadPerfMs > 3000) this.bootFreeze = false;
      else return new Date(this.baseEpochMs);
    }
    return new Date(this.baseEpochMs + (nowPerf - this.basePerfMs));
  }

  /** Build the parameter bytes for a read of the selected register, from the virtual clock. */
  private buildReadBytes(reg: number): number[] {
    const d = this.virtualNow();
    switch (reg) {
      case CMD_STATUS:
        // Bit 6 = 24-hour mode, bit 7 = power-fail/battery-dry. Always present battery-good
        // status unless the game explicitly changes mode; this prevents Ruby's dry-battery gate.
        this.status = (this.status | 0x40) & ~0x80;
        return [this.status];
      case CMD_DATETIME: {
        const year = d.getFullYear() % 100;
        const month = d.getMonth() + 1;
        const day = d.getDate();
        const weekday = d.getDay(); // 0=Sun
        let hour = d.getHours();
        const min = d.getMinutes();
        const sec = d.getSeconds();
        return [bcd(year), bcd(month), bcd(day), bcd(weekday), bcd(hour), bcd(min), bcd(sec)];
      }
      case CMD_TIME: {
        return [bcd(d.getHours()), bcd(d.getMinutes()), bcd(d.getSeconds())];
      }
      default:
        return [0, 0, 0, 0, 0, 0, 0];
    }
  }

  private outBuf: number[] = [];

  /** Called when CS goes high → start of a new command. */
  private beginTransfer(): void {
    this.active = true;
    this.commandDone = false;
    this.bitsIn = 0;
    this.curByte = 0;
    this.reading = false;
    this.byteIndex = 0;
    this.outBuf = [];
    this.outBits = 0;
    this.outByte = 0;
  }

  private endTransfer(): void {
    this.active = false;
    this.commandDone = false;
  }

  /** Decode the just-received command byte and set up read/write of the target register. */
  private decodeCommand(byte: number): void {
    this.command = byte;
    // S-3511A: command is usually observed as 0b0110_RRRW, but some games/libraries clock the
    // low nibble in the opposite order. Decode both common forms and choose the one with the
    // expected 0b0110 prefix. If neither matches, fall back to the raw low-nibble form so debug
    // output tells us exactly what was seen.
    let reg = (byte >> 1) & 0x7;
    let read = (byte & 0x1) !== 0;
    if ((byte >> 4) !== 0x6) {
      const rev = bitReverse8(byte);
      if ((rev >> 4) === 0x6) { reg = (rev >> 1) & 0x7; read = (rev & 1) !== 0; }
    }
    this.reg = reg;
    this.reading = read;
    if (this.debug) this.debug(`RTC cmd raw=0x${byte.toString(16).padStart(2,'0')} reg=${this.reg} read=${this.reading}`);
    if (this.reading) {
      this.outBuf = this.buildReadBytes(this.reg);
      if (this.debug) this.debug(`RTC out=[${this.outBuf.map(b => '0x'+b.toString(16).padStart(2,'0')).join(',')}]`);
      this.byteIndex = 0;
      this.outByte = this.outBuf.length ? this.outBuf[0] : 0;
      this.outBits = 0;
      this.firstFallPending = true;
    }
  }

  /**
   * Clock edge handler. The GBA toggles SCK; data is sampled on the rising edge (write, GBA→RTC)
   * and presented on the falling edge (read, RTC→GBA). We keep it simple: on each SCK low→high we
   * process one bit in the current direction.
   */
  private onClockRise(): void {
    if (!this.active) return;
    if (!this.commandDone) {
      // Receiving the command byte, MSB-first.
      this.curByte = ((this.curByte << 1) | (this.sio & 1)) & 0xff;
      if (++this.bitsIn === 8) {
        this.commandDone = true;
        this.bitsIn = 0;
        this.decodeCommand(this.curByte);
        this.curByte = 0;
      }
      return;
    }
    if (this.reading) {
      // Presenting data bits LSB-first; nothing to sample here (handled on read of data pin).
      return;
    }
    // Writing register bytes. Preserve battery-good semantics for STATUS writes: games may
    // unprotect/reset/set 24h mode; do not let a transient write leave POWER/12h set.
    this.curByte = ((this.curByte >> 1) | ((this.sio & 1) << 7)) & 0xff;
    if (++this.bitsIn === 8) {
      if (this.reg === CMD_STATUS && this.byteIndex === 0) this.status = (this.curByte | 0x40) & ~0x80;
      this.bitsIn = 0; this.curByte = 0; this.byteIndex++;
    }
  }

  /** Advance the outgoing data bit after the GBA reads it on a clock low (read direction). */
  private onClockFall(): void {
    if (!this.active || !this.commandDone || !this.reading) return;
    if (this.firstFallPending) { this.firstFallPending = false; return; } // first fall presents bit 0
    if (++this.outBits === 8) {
      this.outBits = 0;
      this.byteIndex++;
      this.outByte = this.byteIndex < this.outBuf.length ? this.outBuf[this.byteIndex] : 0;
    }
  }

  /** Handle a GBA write to a GPIO register. addr is the low 24 bits (e.g. 0xc4/0xc6/0xc8). */
  write(addr: number, value: number): void {
    switch (addr & 0xff) {
      case 0xc4: { // data
        const prevSck = this.sck, prevCs = this.cs;
        const v = value & 0xf;
        // Only bits configured as output are driven by the GBA.
        this.cs = (v & Pin.CS);
        this.sck = (v & Pin.SCK);
        if (this.dir & Pin.SIO) this.sio = (v & Pin.SIO) ? 1 : 0;
        // CS rising edge → begin; CS falling edge → end.
        if (!prevCs && this.cs) { if (this.debug) this.debug('RTC CS rise'); this.beginTransfer(); }
        else if (prevCs && !this.cs) { if (this.debug) this.debug('RTC CS fall'); this.endTransfer(); }
        // Clock edges.
        if (!prevSck && this.sck) this.onClockRise();
        else if (prevSck && !this.sck) this.onClockFall();
        break;
      }
      case 0xc6: this.dir = value & 0xf; break;       // direction
      case 0xc8: this.control = value & 0x1; break;   // read-enable
    }
  }

  /** Handle a GBA read from a GPIO register; returns the 16-bit value (only low nibble meaningful). */
  read(addr: number): number {
    switch (addr & 0xff) {
      case 0xc4: {
        if (!this.control) return 0; // pins not readable
        let v = 0;
        v |= this.sck & Pin.SCK;
        v |= this.cs & Pin.CS;
        // Present the current outgoing data bit on SIO when SIO is configured as input (RTC drives).
        if (!(this.dir & Pin.SIO) && this.active && this.commandDone && this.reading) {
          const bit = (this.outByte >> this.outBits) & 1;
          if (bit) v |= Pin.SIO;
        } else {
          if (this.sio) v |= Pin.SIO;
        }
        return v;
      }
      case 0xc6: return this.dir;
      case 0xc8: return this.control;
    }
    return 0;
  }

  /** True if the address falls in the GPIO window (so memory.ts knows to route here). */
  static isGpio(off: number): boolean { const a = off & 0x01ffffff; return a >= 0xc4 && a <= 0xc9; }

  serializeState() { return { status: this.status }; }
  loadState(_s: any) { /* RTC is host-clock-backed; nothing persistent to restore */ }
}
