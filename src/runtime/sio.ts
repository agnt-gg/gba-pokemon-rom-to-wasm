/**
 * GBA Serial I/O (SIO) — link cable / link port model.
 *
 * Registers (offsets relative to 0x04000000):
 *   0x120 SIODATA32_L / SIOMULTI0     0x122 SIODATA32_H / SIOMULTI1
 *   0x124 SIOMULTI2                   0x126 SIOMULTI3
 *   0x128 SIOCNT                      0x12A SIODATA8 / SIOMLT_SEND
 *   0x134 RCNT                        0x140 JOYCNT
 *   0x150 JOY_RECV                    0x154 JOY_TRANS
 *   0x158 JOYSTAT
 *
 * Mode select (GBATEK):
 *   RCNT bit15=0:
 *     SIOCNT bit13=0           -> Normal mode (bit12: 0=8-bit, 1=32-bit)
 *     SIOCNT bit13=1, bit12=0  -> Multiplayer (16-bit, up to 4 GBAs)
 *     SIOCNT bit13=1, bit12=1  -> UART
 *   RCNT bit15=1, bit14=0      -> General purpose
 *   RCNT bit15=1, bit14=1      -> JOY bus
 *
 * Disconnected-cable semantics (what Pokemon link menus / wireless-adapter probes need):
 *   - Normal mode, internal clock (master): the transfer ALWAYS completes — SI is pulled high
 *     with nothing attached, so the received data is all 1s (0xFF / 0xFFFFFFFF). Busy clears,
 *     serial IRQ fires if enabled. (FRLG/Emerald probe the wireless adapter this way at boot and
 *     read 0xFFFFFFFF -> "no adapter", exactly like a real GBA without the AGB-015.)
 *   - Normal mode, external clock (slave): no master ever drives the clock, so the transfer
 *     NEVER completes; the start/busy bit stays set until the game times out.
 *   - Multiplayer: with no children attached SD stays low (not all ready); a started transfer
 *     completes with our own word in SIOMULTI0 and 0xFFFF (absent) in slots 1-3, ID=0.
 *   - UART / JOY bus: registers are readable/writable; nothing ever arrives.
 *
 * Linked operation: a LinkTransport (LocalLinkHub here; a WebRTC DataChannel adapter later)
 * exchanges 16-bit multiplayer words or 8/32-bit normal-mode words between machines. The hub
 * assigns multiplayer IDs, drives SD/SI bits, fills SIOMULTI0-3 on every attached machine, and
 * raises each machine's serial IRQ per its own SIOCNT bit14.
 */

import { GbaIo } from './io.ts';

// SIO register offsets.
export const SIO_REG = {
  SIODATA32_L: 0x120, SIODATA32_H: 0x122,
  SIOMULTI0: 0x120, SIOMULTI1: 0x122, SIOMULTI2: 0x124, SIOMULTI3: 0x126,
  SIOCNT: 0x128, SIODATA8: 0x12a,
  RCNT: 0x134,
  JOYCNT: 0x140, JOY_RECV_L: 0x150, JOY_RECV_H: 0x152,
  JOY_TRANS_L: 0x154, JOY_TRANS_H: 0x156, JOYSTAT: 0x158,
} as const;

const IRQ_SERIAL = 0x80; // IF/IE bit 7

const CPU_HZ = 16_777_216;
// Multiplayer baud table (bits/sec).
const MULTI_BAUD = [9600, 38400, 57600, 115200];

export type SioMode = 'normal8' | 'normal32' | 'multi' | 'uart' | 'general' | 'joybus';

/**
 * Transport seam for real linking. Implementations: LocalLinkHub (in-process, below),
 * and in the browser a WebRTC/BroadcastChannel adapter implementing the same interface.
 */
export interface LinkTransport {
  /** True when at least one partner is attached and responsive. */
  readonly connected: boolean;
  /** Our multiplayer ID (0 = parent). */
  readonly id: number;
  /**
   * Master/parent starts a multiplayer exchange carrying our SIOMLT_SEND word.
   * Returns the 4 slot words (absent slots = 0xFFFF), or null -> behave disconnected.
   */
  exchangeMulti(sent: number): [number, number, number, number] | null;
  /** Normal-mode 8/32-bit master exchange. Returns partner's word, or null -> disconnected. */
  exchangeNormal(sent: number, bits: 8 | 32): number | null;
}

export class GbaSio {
  io: GbaIo;
  requestIrq: (bits: number) => void = () => {};
  transport: LinkTransport | null = null;

  /** Cycles remaining on an in-flight transfer; 0 = idle. */
  private busyCycles = 0;
  private pendingKind: 'normal8' | 'normal32' | 'multi' | null = null;
  /** Telemetry. */
  transfersStarted = 0;
  transfersCompleted = 0;

  constructor(io: GbaIo) {
    this.io = io;
    // Post-BIOS default: general-purpose mode.
    io.set16(SIO_REG.RCNT, 0x8000);
  }

  mode(): SioMode {
    const rcnt = this.io.get16(SIO_REG.RCNT);
    if (rcnt & 0x8000) return (rcnt & 0x4000) ? 'joybus' : 'general';
    const cnt = this.io.get16(SIO_REG.SIOCNT);
    if (cnt & 0x2000) return (cnt & 0x1000) ? 'uart' : 'multi';
    return (cnt & 0x1000) ? 'normal32' : 'normal8';
  }

  /** IO write side effect for SIOCNT (0x128). Called from the machine's writeHook. */
  onSiocntWrite(): void {
    this.reflectNormalSi();
    const cnt = this.io.get16(SIO_REG.SIOCNT);
    const m = this.mode();

    if (m === 'multi') {
      // Reflect link presence in read-only bits even before any transfer:
      // SD (bit3) = all GBAs ready; SI (bit2) = 0 parent / 1 child; ID in bits 4-5.
      this.reflectMultiStatus();
      if (cnt & 0x0080) this.startMulti();
      return;
    }
    if (m === 'normal8' || m === 'normal32') {
      if (cnt & 0x0080) this.startNormal(m === 'normal32' ? 32 : 8);
      return;
    }
    // UART: we model "nothing attached": send-buffer always empty (SC high), nothing received.
    // Clear start bit immediately so polled sends don't wedge.
    if (m === 'uart' && (cnt & 0x0080)) {
      this.io.set16(SIO_REG.SIOCNT, cnt & ~0x0080);
    }
  }

  /** IO write side effect for RCNT (0x134). Mode switches cancel in-flight transfers. */
  onRcntWrite(): void {
    this.reflectNormalSi();
    const m = this.mode();
    if (m === 'general' || m === 'joybus') {
      this.busyCycles = 0;
      this.pendingKind = null;
    }
    if (m === 'multi') this.reflectMultiStatus();
  }

  /**
   * Normal mode: SIOCNT bit2 is the read-only SI input line. With NOTHING attached the line
   * is pulled HIGH — this is exactly how the FRLG/Emerald RFU (STWI) driver detects "no
   * wireless adapter" and errors out of rfu_waitREQComplete() instead of retrying forever.
   * With a live transport the partner drives SI low (ready).
   */
  private reflectNormalSi(): void {
    const m = this.mode();
    if (m !== 'normal8' && m !== 'normal32') return;
    let cnt = this.io.get16(SIO_REG.SIOCNT);
    if (this.transport?.connected) cnt &= ~0x0004; else cnt |= 0x0004;
    this.io.set16(SIO_REG.SIOCNT, cnt);
  }

  private reflectMultiStatus(): void {
    let cnt = this.io.get16(SIO_REG.SIOCNT);
    const t = this.transport;
    if (t?.connected) {
      cnt = (cnt & ~0x000c) | 0x0008 | (t.id > 0 ? 0x0004 : 0); // SD=1, SI=child flag
      cnt = (cnt & ~0x0030) | ((t.id & 3) << 4);
    } else {
      cnt &= ~0x003c; // SD=0, SI=0(parent), ID=0
    }
    this.io.set16(SIO_REG.SIOCNT, cnt);
  }

  private startNormal(bits: 8 | 32): void {
    const cnt = this.io.get16(SIO_REG.SIOCNT);
    const internalClock = (cnt & 0x0001) !== 0;
    this.transfersStarted++;
    if (!internalClock && !this.transport?.connected) {
      // Slave with no master: clock never arrives; busy stays set until the game gives up.
      return;
    }
    // 256 KHz or 2 MHz internal clock -> 64 or 8 cycles per bit.
    const cyclesPerBit = (cnt & 0x0002) ? 8 : 64;
    this.busyCycles = bits * cyclesPerBit;
    this.pendingKind = bits === 32 ? 'normal32' : 'normal8';
  }

  private startMulti(): void {
    const cnt = this.io.get16(SIO_REG.SIOCNT);
    const isParent = !this.transport?.connected || this.transport.id === 0;
    this.transfersStarted++;
    if (!isParent) {
      // Children cannot initiate; hardware ignores the start bit (it mirrors the parent's busy).
      this.io.set16(SIO_REG.SIOCNT, cnt & ~0x0080);
      return;
    }
    const baud = MULTI_BAUD[cnt & 3];
    // One multiplayer round: each of up to 4 GBAs shifts 16 bits + start/stop overhead.
    const gbas = this.transport?.connected ? 4 : 1;
    this.busyCycles = Math.max(1, Math.round((CPU_HZ / baud) * (16 + 2) * gbas));
    this.pendingKind = 'multi';
  }

  /** Advance the in-flight transfer; deliver results at completion. */
  step(cycles: number): void {
    if (this.busyCycles <= 0) return;
    this.busyCycles -= cycles;
    if (this.busyCycles > 0) return;
    this.busyCycles = 0;
    const kind = this.pendingKind;
    this.pendingKind = null;
    if (kind === 'normal8' || kind === 'normal32') this.completeNormal(kind === 'normal32' ? 32 : 8);
    else if (kind === 'multi') this.completeMulti();
  }

  private completeNormal(bits: 8 | 32): void {
    let cnt = this.io.get16(SIO_REG.SIOCNT);
    let received: number | null = null;
    if (this.transport?.connected) {
      const sent = bits === 32
        ? (this.io.get16(SIO_REG.SIODATA32_L) | (this.io.get16(SIO_REG.SIODATA32_H) << 16)) >>> 0
        : this.io.get16(SIO_REG.SIODATA8) & 0xff;
      received = this.transport.exchangeNormal(sent, bits);
    }
    if (received === null || received === undefined) received = bits === 32 ? 0xffffffff : 0xff;
    if (bits === 32) {
      this.io.set16(SIO_REG.SIODATA32_L, received & 0xffff);
      this.io.set16(SIO_REG.SIODATA32_H, (received >>> 16) & 0xffff);
    } else {
      this.io.set16(SIO_REG.SIODATA8, received & 0xff);
    }
    cnt &= ~0x0080; // busy/start clears
    this.io.set16(SIO_REG.SIOCNT, cnt);
    this.reflectNormalSi();
    this.transfersCompleted++;
    if (cnt & 0x4000) this.requestIrq(IRQ_SERIAL);
  }

  private completeMulti(): void {
    let cnt = this.io.get16(SIO_REG.SIOCNT);
    const sent = this.io.get16(SIO_REG.SIODATA8); // SIOMLT_SEND shares 0x12A
    let slots: [number, number, number, number] | null = null;
    if (this.transport?.connected) slots = this.transport.exchangeMulti(sent);
    if (!slots) slots = [sent & 0xffff, 0xffff, 0xffff, 0xffff];
    this.io.set16(SIO_REG.SIOMULTI0, slots[0]);
    this.io.set16(SIO_REG.SIOMULTI1, slots[1]);
    this.io.set16(SIO_REG.SIOMULTI2, slots[2]);
    this.io.set16(SIO_REG.SIOMULTI3, slots[3]);
    cnt &= ~0x0080;
    this.io.set16(SIO_REG.SIOCNT, cnt);
    this.reflectMultiStatus();
    this.transfersCompleted++;
    if (cnt & 0x4000) this.requestIrq(IRQ_SERIAL);
  }

  /** Used by LocalLinkHub to deliver a parent-initiated multiplayer round to a child. */
  deliverMultiSlots(slots: [number, number, number, number]): void {
    this.io.set16(SIO_REG.SIOMULTI0, slots[0]);
    this.io.set16(SIO_REG.SIOMULTI1, slots[1]);
    this.io.set16(SIO_REG.SIOMULTI2, slots[2]);
    this.io.set16(SIO_REG.SIOMULTI3, slots[3]);
    this.reflectMultiStatus();
    const cnt = this.io.get16(SIO_REG.SIOCNT);
    this.transfersCompleted++;
    if (cnt & 0x4000) this.requestIrq(IRQ_SERIAL);
  }

  /** Child's current SIOMLT_SEND word (what it would put on the wire this round). */
  currentSendWord(): number { return this.io.get16(SIO_REG.SIODATA8) & 0xffff; }

  serializeState() {
    return { busyCycles: this.busyCycles, pendingKind: this.pendingKind };
  }
  loadState(s: any) {
    if (!s) return;
    this.busyCycles = s.busyCycles | 0;
    this.pendingKind = s.pendingKind ?? null;
  }
}

/**
 * In-process link hub: wires 2-4 GbaSio instances together like a real link cable.
 * Attachment order assigns multiplayer IDs (first = parent/ID 0).
 * This is also the reference implementation of LinkTransport for the future
 * WebRTC adapter: the browser side only has to speak exchangeMulti/exchangeNormal.
 */
export class LocalLinkHub {
  private members: GbaSio[] = [];

  attach(sio: GbaSio): void {
    if (this.members.length >= 4) throw new Error('link hub full (4 GBAs max)');
    this.members.push(sio);
    const self = this;
    const id = this.members.length - 1;
    sio.transport = {
      get connected() { return self.members.length >= 2; },
      id,
      exchangeMulti(sent: number) { return self.runMultiRound(id, sent); },
      exchangeNormal(sent: number, bits: 8 | 32) { return self.runNormalRound(id, sent, bits); },
    };
  }

  /** Parent collects every member's send word, distributes slots to all, returns parent's view. */
  private runMultiRound(initiatorId: number, sent: number): [number, number, number, number] | null {
    if (this.members.length < 2 || initiatorId !== 0) return null;
    const slots: [number, number, number, number] = [0xffff, 0xffff, 0xffff, 0xffff];
    for (let i = 0; i < this.members.length; i++) {
      slots[i] = i === 0 ? (sent & 0xffff) : this.members[i].currentSendWord();
    }
    // Children receive the round (parent's own regs are set by completeMulti()).
    for (let i = 1; i < this.members.length; i++) this.members[i].deliverMultiSlots(slots);
    return slots;
  }

  /** Two-player normal-mode exchange: master's word goes to slave, slave's word comes back. */
  private runNormalRound(initiatorId: number, sent: number, bits: 8 | 32): number | null {
    if (this.members.length < 2) return null;
    const other = this.members[initiatorId === 0 ? 1 : 0];
    const mask = bits === 32 ? 0xffffffff : 0xff;
    const theirWord = bits === 32
      ? ((other.io.get16(SIO_REG.SIODATA32_L) | (other.io.get16(SIO_REG.SIODATA32_H) << 16)) >>> 0)
      : (other.io.get16(SIO_REG.SIODATA8) & 0xff);
    // Deliver our word into their data register and raise their IRQ if enabled.
    if (bits === 32) {
      other.io.set16(SIO_REG.SIODATA32_L, sent & 0xffff);
      other.io.set16(SIO_REG.SIODATA32_H, (sent >>> 16) & 0xffff);
    } else {
      other.io.set16(SIO_REG.SIODATA8, sent & 0xff);
    }
    const otherCnt = other.io.get16(SIO_REG.SIOCNT);
    other.io.set16(SIO_REG.SIOCNT, otherCnt & ~0x0080);
    other.transfersCompleted++;
    if (otherCnt & 0x4000) other.requestIrq(IRQ_SERIAL);
    return (theirWord & mask) >>> 0;
  }
}
