/**
 * gba-recomp self-driving agent — control + observation core.
 *
 * Mirrors the gb-recomp automation-agent pattern (controller.ts/observation.ts) but for the GBA
 * machine. The whole point: stop driving the game BLIND. We read real CPU + RAM state every frame
 * so we know exactly which screen the game is on, navigate deterministically, and capture the exact
 * fingerprint of a freeze the moment it happens.
 *
 * Legal line (per skill): we reference pokeemerald/pokeruby SYMBOL CONVENTIONS (address names from
 * the public decompilation), never the user's copyrighted ROM bytes. Addresses are verified
 * empirically by RAM-diffing confirmed single-tile steps, exactly like gb-recomp did for Red.
 */
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

export type Button = 'a' | 'b' | 'select' | 'start' | 'right' | 'left' | 'up' | 'down' | 'r' | 'l';
// KEYINPUT bit positions (active-low: 0 = pressed).
const BIT: Record<Button, number> = {
  a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7, r: 8, l: 9,
};

export interface Frame {
  frame: number;
  pc: number; lr: number; sp: number; cpsr: number;
  thumb: boolean; mode: number; halted: boolean; intrWait: boolean;
  IE: number; IF: number; IME: number; biosIF: number; userHandler: number;
  DISPCNT: number; DISPSTAT: number; VCOUNT: number; BLDCNT: number; BLDY: number;
  MOSAIC: number; DMA0CNT: number; DMA3CNT: number;
  fbSig: number; nonBlank: number;
}

export class Agent {
  m: any;
  held = new Set<Button>();
  frame = 0;

  static fromRom(romPath: string, savPath?: string): Agent {
    const a = new Agent();
    a.m = new GbaMachine(new Uint8Array(readFileSync(romPath)));
    if (savPath) {
      try {
        const sav = new Uint8Array(readFileSync(savPath));
        a.m.flash.data.set(sav.subarray(0, a.m.flash.data.length));
      } catch { /* no save */ }
    }
    return a;
  }

  private keymask(): number {
    let v = 0x3ff;
    for (const b of this.held) v &= ~(1 << BIT[b]);
    return v;
  }

  /** Advance N frames holding the current button set. */
  wait(n: number): void {
    for (let i = 0; i < n; i++) { this.m.setKeys(this.keymask()); this.m.runFrame(); this.frame++; }
  }

  hold(b: Button | Button[]): void { (Array.isArray(b) ? b : [b]).forEach(x => this.held.add(x)); }
  release(b: Button | Button[]): void { (Array.isArray(b) ? b : [b]).forEach(x => this.held.delete(x)); }
  releaseAll(): void { this.held.clear(); }

  /** Press a button for `downF` frames then release for `upF` frames. */
  tap(b: Button, downF = 4, upF = 6): void {
    this.hold(b); this.wait(downF); this.release(b); this.wait(upF);
  }

  r8(a: number): number { return this.m.mem.read8(a >>> 0) & 0xff; }
  r16(a: number): number { return this.m.mem.read16(a >>> 0) & 0xffff; }
  r32(a: number): number { return this.m.mem.read32(a >>> 0) >>> 0; }

  /** Sparse framebuffer signature (cheap change-detector). */
  fbSig(): number { const fb = this.m.ppu.framebuffer; let h = 0; for (let i = 0; i < fb.length; i += 311) h = (h * 31 + fb[i]) >>> 0; return h; }
  nonBlank(): number { const fb = this.m.ppu.framebuffer; let n = 0; for (let i = 0; i < fb.length; i += 41) { if (fb[i] > 8 && fb[i] < 248) n++; } return n; }

  snap(): Frame {
    const st = this.m.cpu.st, io = this.m.io, mem = this.m.mem;
    return {
      frame: this.frame,
      pc: st.r[15] >>> 0, lr: st.r[14] >>> 0, sp: st.r[13] >>> 0, cpsr: st.cpsr >>> 0,
      thumb: !!(st.cpsr & 0x20), mode: st.cpsr & 0x1f, halted: !!this.m.cpu.halted, intrWait: !!this.m.cpu.intrWaitActive,
      IE: io.get16(0x4000200), IF: io.get16(0x4000202), IME: io.get16(0x4000208),
      biosIF: mem.read16(0x03007ff8) & 0xffff, userHandler: mem.read32(0x03007ffc) >>> 0,
      DISPCNT: io.get16(0x4000000), DISPSTAT: io.get16(0x4000004), VCOUNT: io.get16(0x4000006) & 0xff,
      BLDCNT: io.get16(0x4000050), BLDY: io.get16(0x4000054), MOSAIC: io.get16(0x400004c),
      DMA0CNT: io.get16(0x40000ba), DMA3CNT: io.get16(0x40000de),
      fbSig: this.fbSig(), nonBlank: this.nonBlank(),
    };
  }

  /** Hash a region of EWRAM/IWRAM for RAM-diffing. */
  snapshotRange(base: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.r8(base + i);
    return out;
  }
}

/** Boot far enough to be at the title/intro (logos done). */
export function bootToTitle(a: Agent, frames = 320): void { a.wait(frames); }
