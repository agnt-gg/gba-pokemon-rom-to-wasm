/**
 * GBA timers — 4 channels (TM0..TM3).
 *
 * Each timer has a reload value (CNT_L on write) and a control (CNT_H): prescaler (1/64/256/1024),
 * count-up (cascade from previous timer), IRQ on overflow, enable. When a timer overflows it
 * reloads and may raise an IRQ and/or tick the next timer (cascade). Timers also drive the audio
 * sample rate (Direct Sound) later.
 *
 * We advance timers by CPU cycles. Reads of CNT_L return the live counter.
 */

import { GbaIo, REG } from './io.ts';

const PRESCALER = [1, 64, 256, 1024];
const IRQ_TIMER = [1 << 3, 1 << 4, 1 << 5, 1 << 6];

export class GbaTimers {
  io: GbaIo;
  requestIrq: (bits: number) => void = () => {};
  onOverflow: (ch: number) => void = () => {};

  private counter = [0, 0, 0, 0];
  private reload = [0, 0, 0, 0];
  private subcycle = [0, 0, 0, 0];
  private enabled = [false, false, false, false];

  private CNT_L = [REG.TM0CNT_L, REG.TM1CNT_L, REG.TM2CNT_L, REG.TM3CNT_L];
  private CNT_H = [REG.TM0CNT_H, REG.TM1CNT_H, REG.TM2CNT_H, REG.TM3CNT_H];

  constructor(io: GbaIo) { this.io = io; }

  onReloadWrite(ch: number): void { this.reload[ch] = this.io.get16(this.CNT_L[ch]); }

  onControlWrite(ch: number): void {
    const ctrl = this.io.get16(this.CNT_H[ch]);
    const en = (ctrl & 0x80) !== 0;
    if (en && !this.enabled[ch]) { this.counter[ch] = this.reload[ch]; this.subcycle[ch] = 0; }
    this.enabled[ch] = en;
  }

  /**
   * Compute the EXACT counter value for channel `ch` as if it had been advanced by `pendingCycles`
   * additional CPU cycles beyond the last sync, WITHOUT mutating timer state. Used by the lazy
   * timer-read hook so that a timer CNT_L read mid-way through a native (recompiled) block returns
   * the same value the per-instruction interpreter would, even though the runtime only calls
   * step() at block boundaries. Handles prescaler division and overflow wrap (reload on overflow).
   * Count-up (cascade) timers are not cycle-driven, so we return their last synced value.
   */
  liveCounter(ch: number, pendingCycles: number): number {
    if (!this.enabled[ch]) return this.counter[ch] & 0xffff;
    const ctrl = this.io.get16(this.CNT_H[ch]);
    if (ch > 0 && (ctrl & 0x4) !== 0) return this.counter[ch] & 0xffff; // count-up: not cycle-driven
    const ps = PRESCALER[ctrl & 3];
    const totalSub = this.subcycle[ch] + (pendingCycles | 0);
    const ticks = Math.floor(totalSub / ps);
    if (ticks <= 0) return this.counter[ch] & 0xffff;
    const span = 0x10000 - this.reload[ch]; // ticks per full overflow cycle from reload..0xffff
    let c = this.counter[ch] + ticks;
    if (c > 0xffff) {
      // wrap through reload one or more times
      c = this.reload[ch] + ((c - 0x10000) % span);
    }
    return c & 0xffff;
  }

  /** True if any non-cascade timer is currently enabled (its CNT_L is a live, cycle-driven value). */
  anyEnabled(): boolean {
    for (let ch = 0; ch < 4; ch++) {
      if (!this.enabled[ch]) continue;
      const ctrl = this.io.get16(this.CNT_H[ch]);
      if (ch > 0 && (ctrl & 0x4) !== 0) continue; // count-up timers don't advance on cycles
      return true;
    }
    return false;
  }

  step(cycles: number): void {
    for (let ch = 0; ch < 4; ch++) {
      if (!this.enabled[ch]) continue;
      const ctrl = this.io.get16(this.CNT_H[ch]);
      const countUp = ch > 0 && (ctrl & 0x4) !== 0;
      if (countUp) continue; // ticked by previous timer's overflow only
      const ps = PRESCALER[ctrl & 3];
      this.subcycle[ch] += cycles;
      while (this.subcycle[ch] >= ps) {
        this.subcycle[ch] -= ps;
        this.tick(ch, ctrl);
      }
      this.io.set16(this.CNT_L[ch], this.counter[ch] & 0xffff);
    }
  }

  private tick(ch: number, ctrl: number): void {
    this.counter[ch]++;
    if (this.counter[ch] > 0xffff) {
      this.counter[ch] = this.reload[ch];
      this.onOverflow(ch);
      if (ctrl & 0x40) this.requestIrq(IRQ_TIMER[ch]);
      // Cascade into next timer if it's in count-up mode.
      if (ch < 3) {
        const nextCtrl = this.io.get16(this.CNT_H[ch + 1]);
        if (this.enabled[ch + 1] && (nextCtrl & 0x4)) this.cascadeTick(ch + 1, nextCtrl);
      }
    }
  }

  private cascadeTick(ch: number, ctrl: number): void {
    this.counter[ch]++;
    if (this.counter[ch] > 0xffff) {
      this.counter[ch] = this.reload[ch];
      this.onOverflow(ch);
      if (ctrl & 0x40) this.requestIrq(IRQ_TIMER[ch]);
      if (ch < 3) { const nc = this.io.get16(this.CNT_H[ch + 1]); if (this.enabled[ch + 1] && (nc & 0x4)) this.cascadeTick(ch + 1, nc); }
    }
    this.io.set16(this.CNT_L[ch], this.counter[ch] & 0xffff);
  }

  serializeState() { return { counter: [...this.counter], reload: [...this.reload], subcycle: [...this.subcycle], enabled: [...this.enabled] }; }
  loadState(s: any) { this.counter = [...s.counter]; this.reload = [...s.reload]; this.subcycle = [...s.subcycle]; this.enabled = [...s.enabled]; }
}
