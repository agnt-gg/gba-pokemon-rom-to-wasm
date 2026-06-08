/**
 * GBA machine: full system integration.
 *
 * Wires CPU + memory + IO + PPU + DMA + timers + interrupts into a running system with a
 * frame-stepped loop. This is what unblocks games that wait on VCOUNT / VBlankIntrWait, and
 * what produces a framebuffer.
 *
 * BIOS IRQ handling: because we HLE the BIOS, there is no real handler at 0x18. The real GBA
 * BIOS IRQ handler saves registers, reads the user IRQ handler pointer from 0x03007FFC, and
 * calls it. We emulate that dispatch directly so the game's installed handler runs.
 */

import { ArmCore } from '../cpu/arm_core.ts';
import { Recompiler } from '../recompiler/recompiler.ts';
import { GbaMemory } from './memory.ts';
import { GbaIo, REG } from './io.ts';
import { makeBiosHle } from './bios_hle.ts';
import { parseHeader, type GbaHeader } from './header.ts';
import { GbaPpu } from './ppu.ts';
import { GbaDma } from './dma.ts';
import { GbaTimers } from './timers.ts';
import { GbaInterrupts } from './interrupts.ts';
import { GbaFlash } from './flash.ts';
import { GbaRtc } from './rtc.ts';
import { GbaAudio } from './audio.ts';
import { Mode, FLAG_I, FLAG_T } from '../cpu/arm_state.ts';

const CYCLES_PER_FRAME = 1232 * 228; // 280896

export class GbaMachine {
  mem = new GbaMemory();
  io = new GbaIo();
  cpu: ArmCore;
  /**
   * ARM->WASM block recompiler. Straight-line ARM blocks are translated to real WebAssembly and
   * executed by the engine; the interpreter handles THUMB, control transfers we don't lift yet,
   * and fallthrough single steps. Toggle via `useRecompiler`.
   */
  recompiler: Recompiler | null = null;
  useRecompiler = true;
  ppu: GbaPpu;
  dma: GbaDma;
  timers: GbaTimers;
  irq: GbaInterrupts;
  flash: GbaFlash;
  rtc: GbaRtc;
  audio: GbaAudio;
  header: GbaHeader;
  instrCount = 0;
  frameCount = 0;
  // Ring buffer of the most recent SWI calls (for SoftReset post-mortem diagnostics).
  private _swiRing: string[] = [];

  // Key state: 0 = pressed (GBA is active-low). Bit order: A,B,Select,Start,Right,Left,Up,Down,R,L.
  private keyState = 0x03ff;

  rom: Uint8Array;

  constructor(rom: Uint8Array) {
    this.rom = rom;
    this.mem.loadRom(rom);
    this.mem.installBiosStub();
    this.mem.io = this.io;
    // Pokemon Gen 3 saves to 128KB Flash; attach a Flash chip to region 0x0E.
    this.flash = new GbaFlash();
    this.mem.flash = this.flash;
    this.cpu = new ArmCore(this.mem);
    this.recompiler = new Recompiler(this.mem);
    this.header = parseHeader(rom);

    // Ruby/Sapphire/Emerald bit-bang a cartridge GPIO real-time clock at 0x080000C4-C9.
    // Attach an HLE RTC so boot-time RTC probes and date/time reads can complete.
    this.rtc = new GbaRtc();
    this.mem.rtc = this.rtc;

    this.ppu = new GbaPpu(this.mem, this.io);
    this.dma = new GbaDma(this.mem, this.io);
    this.timers = new GbaTimers(this.io);
    this.audio = new GbaAudio(this.io);
    this.irq = new GbaInterrupts(this.io, this.cpu);
    // Nested-IRQ correctness gate. Real hardware enters IRQ mode with I set; nesting only resumes
    // after the handler explicitly clears I. Our HLE BIOS dispatch redirects 0x18 to the user handler
    // WITHIN a single step(), so the only unsafe window is: (a) the CPU is parked at the unredirected
    // 0x18 vector, or (b) nesting has already reached our defensive cap. Block delivery in those two
    // cases only; otherwise allow the nested IRQ the game asked for. This avoids BOTH failure modes we
    // hit: stranding the CPU at 0x18 (deadlock) and single-sentinel frame aliasing (lr=0 garbage).
    this.irq.canDeliver = () =>
      this._irqDepth < 4 && !(this.cpu.st.r[15] === 0x18 && this.cpu.st.mode === Mode.IRQ);
    // Let the interrupt controller mirror the BIOS IRQ handler's BIOS-IF (0x03007FF8) update the
    // instant an enabled IRQ is raised. This makes a CPU re-executing a rewound IntrWait SWI on wake
    // always observe the just-fired flag, fixing the trainer-card / wild-encounter freeze (a race
    // between the IntrWait re-run and the IRQ dispatch that previously left BIOS-IF=0 forever).
    this.irq.biosIfOr = (bits: number) => {
      const cur = this.mem.read16(0x03007ff8) & 0xffff;
      this.mem.write16(0x03007ff8, (cur | bits) & 0xffff);
    };

    // Route hardware interrupt requests through the controller.
    this.ppu.requestIrq = (b) => this.irq.request(b);
    this.dma.requestIrq = (b) => this.irq.request(b);
    this.timers.requestIrq = (b) => this.irq.request(b);
    this.timers.onOverflow = (ch) => {
      this.audio.onTimerOverflow(ch);
      // Direct Sound DMA is requested only when the specific FIFO drains to <=16 bytes.
      // FIFO A uses DMA1, FIFO B uses DMA2; do not trigger both for one FIFO request.
      if (ch === 0 || ch === 1) {
        if (this.audio.consumeDmaRequest(1)) this.dma.triggerSoundChannel(1);
        if (this.audio.consumeDmaRequest(2)) this.dma.triggerSoundChannel(2);
      }
    };
    this.io.fifoWriteHook = (off, value) => this.audio.writeFifo8(off, value);

    // PPU timing triggers DMA (VBlank=1, HBlank=2 per DMA timing field).
    this.ppu.onVblank = () => this.dma.trigger(1);
    this.ppu.onHblank = () => this.dma.trigger(2);

    // IO write side effects: DMA enable, timer reload/control.
    this.io.writeHook = (off, _val, _prev) => {
      switch (off) {
        case REG.DMA0CNT_H: this.dma.onControlWrite(0); break;
        case REG.DMA1CNT_H: this.dma.onControlWrite(1); break;
        case REG.DMA2CNT_H: this.dma.onControlWrite(2); break;
        case REG.DMA3CNT_H: this.dma.onControlWrite(3); break;
        case REG.TM0CNT_L: this.timers.onReloadWrite(0); break;
        case REG.TM1CNT_L: this.timers.onReloadWrite(1); break;
        case REG.TM2CNT_L: this.timers.onReloadWrite(2); break;
        case REG.TM3CNT_L: this.timers.onReloadWrite(3); break;
        case REG.TM0CNT_H: this.timers.onControlWrite(0); break;
        case REG.TM1CNT_H: this.timers.onControlWrite(1); break;
        case REG.TM2CNT_H: this.timers.onControlWrite(2); break;
        case REG.TM3CNT_H: this.timers.onControlWrite(3); break;
        case 0x082: this.audio.onSoundCntHWrite(); break;
      }
    };

    // HALTCNT: halt the CPU until the next interrupt.
    this.io.haltHook = () => { this.cpu.halted = true; };

    this.io.set16(REG.KEYINPUT, this.keyState);
    this.cpu.swiHandler = makeBiosHle({
      onIntrWait: () => { this.cpu.halted = true; },
      onSoftReset: (info) => {
        // Surface deliberate-vs-spurious SoftReset on the live page so we can diagnose the
        // trainer-card / battle restart from the browser console. We also snapshot a rich context
        // ring (recent SWIs + the caller's code window) so a single console paste fully pinpoints
        // WHY the game reset, and we preserve the battery save across the reset so a soft-reset can
        // never lose the player's progress.
        try {
          const mem = this.mem;
          const callerCode: string[] = [];
          for (let i = -6; i <= 6; i++) callerCode.push('0x' + (mem.read16((info.lr + i * 2) >>> 0) & 0xffff).toString(16).padStart(4, '0'));
          const ctx = {
            ...info, frame: this.frameCount,
            recentSwis: [...this._swiRing],
            callerCode,
            IE: '0x' + this.io.get16(REG.IE).toString(16),
            IF: '0x' + this.io.get16(REG.IF).toString(16),
            DISPCNT: '0x' + this.io.get16(0x4000000).toString(16),
            flashDirty: this.flash.dirty,
          };
          (globalThis as any).console?.warn(
            `[gba] SoftReset: returning to 0x${info.entry.toString(16)} ` +
            `(flag@0x3007FFA=${info.flag}, swi-from pc=0x${info.pc.toString(16)} lr=0x${info.lr.toString(16)})`,
            ctx
          );
          (globalThis as any).__GBA_LAST_SOFTRESET__ = ctx;
        } catch {}
      },
    });

    // Wrap the SWI handler to record a short history of recent SWIs. This is what lets a SoftReset
    // post-mortem show the exact sequence of BIOS calls that preceded the reset (e.g. a CpuFastSet /
    // decompression into a bad address, or an unexpected IntrWait), pinpointing the trigger from a
    // single console paste.
    const innerSwi = this.cpu.swiHandler!;
    this.cpu.swiHandler = (comment: number, cpu: ArmCore): boolean => {
      this._swiRing.push(`0x${comment.toString(16)}@pc0x${(cpu.st.r[15] >>> 0).toString(16)}`);
      if (this._swiRing.length > 24) this._swiRing.shift();
      return innerSwi(comment, cpu);
    };

    this.reset();
  }

  reset(): void {
    this.cpu.resetToCartridge();
    this.instrCount = 0; this.frameCount = 0;
  }

  setKeys(state10bit: number): void {
    this.keyState = state10bit & 0x3ff;
    this.io.set16(REG.KEYINPUT, this.keyState);
  }

  /**
   * BIOS IRQ dispatch (HLE). The real BIOS handler at 0x18 reads the user handler from 0x03007FFC.
   * We detect when the CPU is about to vector to 0x18 and instead jump straight to the user handler
   * with the BIOS calling convention (handler returns via BX LR back into our bridge that restores).
   */
  // IRQ dispatch nesting depth. A user IRQ handler runs with the saved-register frame pushed onto
  // the IRQ stack and returns via the BIOS_IRQ_RETURN sentinel. If a second IRQ were dispatched
  // while we are still inside the first handler's BIOS-frame (before its matching return), the two
  // sentinel returns would alias and the inner restore would pop the OUTER frame — corrupting lr/PC
  // (observed live as lr=0x0 and the CPU running off into EWRAM garbage, then SoftReset, on the
  // HBlank-heavy trainer-card / battle screens where HBlank IRQs fire ~160x/frame and can re-enter
  // a handler that re-enabled IRQs). We therefore refuse to re-dispatch while a BIOS frame is
  // outstanding; the pending IRQ simply stays in IF and is taken the instant the current handler
  // returns. This matches the practical behaviour of the real BIOS handler, which finishes its
  // critical section before the next IRQ is serviced.
  private _irqDepth = 0;

  private serviceIrqDispatch(): void {
    // If the interrupt controller vectored us to 0x18, emulate the BIOS dispatch.
    if (this.cpu.st.r[15] === 0x18 && this.cpu.st.mode === Mode.IRQ) {
      // Nested IRQs are allowed. The BIOS-saved frame (r0-r3,r12,lr_irq) is pushed onto the REAL IRQ
      // stack (SP_irq) and unwound in strict LIFO order, and each nesting level gets its OWN distinct
      // return sentinel (BIOS_IRQ_RETURN + depth*4) so an inner handler's return can never be mistaken
      // for the outer one. Cap nesting defensively so a pathological IRQ storm can't recurse without
      // bound (real handlers nest at most VBlank-inside-HBlank, i.e. depth 2).
      if (this._irqDepth >= 4) return;
      const userHandler = this.mem.read32(0x03007ffc) >>> 0;
      // The real BIOS IRQ handler ORs the just-fired interrupt bits into the BIOS interrupt-check
      // halfword at 0x03007FF8, which IntrWait/VBlankIntrWait poll. Mirror that here.
      const fired = this.irq.ifFlags & this.io.get16(REG.IE);
      this.mem.write16(0x03007ff8, (this.mem.read16(0x03007ff8) | fired) & 0xffff);
      if (userHandler >= 0x02000000) {
        // BIOS pushes r0-r3,r12,lr_irq before calling the game's user IRQ handler. This is not
        // optional: Ruby's VBlank can interrupt tight copied-IWRAM helpers that rely on r0-r3/r12
        // staying intact. If we only redirect to the handler, its scratch-register use corrupts
        // the interrupted main code (observed as r2/r3 corruption inside the 0x03007D5C copy
        // helper, producing a near-infinite copy loop). Preserve the BIOS-saved frame here and
        // restore it in handleIrqReturn().
        const st = this.cpu.st;
        const saved = [st.r[0], st.r[1], st.r[2], st.r[3], st.r[12], st.r[14]];
        for (let i = saved.length - 1; i >= 0; i--) {
          st.r[13] = (st.r[13] - 4) >>> 0;
          this.mem.write32(st.r[13], saved[i] >>> 0);
        }
        st.r[14] = (BIOS_IRQ_RETURN + this._irqDepth * 4) >>> 0; // depth-unique return sentinel
        st.cpsr &= ~FLAG_T;                          // handler is ARM
        st.r[15] = userHandler & ~3;
        this._irqDepth++;                            // a BIOS frame is now outstanding
      }
    }
  }

  /** Detect the sentinel return from a user IRQ handler and unwind back to interrupted code. */
  private handleIrqReturn(): boolean {
    const pc15 = this.cpu.st.r[15] >>> 0;
    // Recognise any depth-level sentinel in [BIOS_IRQ_RETURN, BIOS_IRQ_RETURN + 4*4).
    if (pc15 >= BIOS_IRQ_RETURN && pc15 < (BIOS_IRQ_RETURN + 4 * 4) && ((pc15 - BIOS_IRQ_RETURN) & 3) === 0) {
      const st = this.cpu.st;
      if (this._irqDepth > 0) this._irqDepth--;     // matching return: BIOS frame consumed
      // Pop the BIOS-saved register frame: r0,r1,r2,r3,r12,lr_irq.
      st.r[0] = this.mem.read32(st.r[13]) | 0; st.r[13] = (st.r[13] + 4) >>> 0;
      st.r[1] = this.mem.read32(st.r[13]) | 0; st.r[13] = (st.r[13] + 4) >>> 0;
      st.r[2] = this.mem.read32(st.r[13]) | 0; st.r[13] = (st.r[13] + 4) >>> 0;
      st.r[3] = this.mem.read32(st.r[13]) | 0; st.r[13] = (st.r[13] + 4) >>> 0;
      st.r[12] = this.mem.read32(st.r[13]) | 0; st.r[13] = (st.r[13] + 4) >>> 0;
      const ret = this.mem.read32(st.r[13]) >>> 0; st.r[13] = (st.r[13] + 4) >>> 0;
      // Restore CPSR from SPSR_irq and return to interrupted instruction.
      if (st.hasSpsr()) st.writeCpsr(st.getSpsr());
      const thumb = (st.cpsr & FLAG_T) !== 0;
      st.r[15] = (ret - (thumb ? 4 : 4)) >>> 0; // LR_irq was next+4; return there
      return true;
    }
    return false;
  }

  private isPokemonRubySapphire(): boolean {
    return this.header.gameCode === 'AXVE' || this.header.gameCode === 'AXPE';
  }

  private returnFromThumbHle(): void {
    const st = this.cpu.st;
    const lr = st.r[14] >>> 0;
    st.cpsr |= FLAG_T;
    st.r[15] = lr & ~1;
  }

  private hlePokemonGen3FlashHelpers(): number | null {
    if (!this.isPokemonRubySapphire()) return null;
    const st = this.cpu.st;
    const pc = st.r[15] >>> 0;

    // Pokemon Ruby/Sapphire's save.c TryWriteSector calls libagb's
    // ProgramFlashSectorAndVerify(sectorNum, data) at 0x081DFA98. Letting the ROM bit-bang the
    // entire Flash program/poll/verify loop can fail or stall in our partial hardware model. A real
    // emulator can safely fast-path this helper: erase/program the logical 4KB sector, mark Flash
    // dirty, and return 0 (success). The caller still writes normal Gen 3 sector structs/checksums.
    if (pc === 0x081dfa98) {
      const sector = st.r[0] & 0xff;
      const src = st.r[1] >>> 0;
      if (sector < 32) {
        const base = ((sector >= 16 ? 0x10000 : 0) + ((sector & 15) * 0x1000)) >>> 0;
        for (let i = 0; i < 0x1000; i++) this.flash.data[base + i] = this.mem.read8(src + i);
        this.flash.dirty = true;
        st.r[0] = 0; // success
      } else {
        st.r[0] = 1; // invalid sector -> error
      }
      this.returnFromThumbHle();
      return 64;
    }

    return null;
  }

  private applyPokemonGen3RuntimeFixes(): void {
    if (!this.isPokemonRubySapphire()) return;
    const st = this.cpu.st;
    // Pokemon Ruby/Sapphire main-menu Task_MainMenuCheckRtc calls RtcGetErrorStatus at 0x08009AA2,
    // returns at 0x08009AA6, masks r0 with 0x0FF0, and branches to the battery-warning task if
    // nonzero. Our HLE RTC is battery-good (status 0x40, valid BCD date/time), but Ruby's static
    // RTC error flags can be left stale by the bit-banged SiiRTC glue. Clear only this exact false
    // menu-check return value so the game does not show the internal-battery warning.
    const pc = st.r[15] >>> 0;
    if (pc === 0x08009aa6 || pc === 0x08009aa8 || pc === 0x08009aaa || pc === 0x08009aac) st.r[0] = 0;
  }

  step(): number {
    if (this.handleIrqReturn()) { this.instrCount++; return 1; }
    const hleCycles = this.hlePokemonGen3FlashHelpers();
    if (hleCycles !== null) {
      this.instrCount++;
      this.ppu.step(hleCycles);
      this.timers.step(hleCycles);
      this.audio.step(hleCycles);
      if (!this.cpu.halted) { this.irq.poll(); this.serviceIrqDispatch(); }
      return hleCycles;
    }
    // --- Native WASM block fast path ---
    // Bit-exact IRQ timing: the interpreter services IRQs at every instruction boundary, but a
    // native block defers servicing to block-end. If a PPU IRQ (HBlank/VCount/VBlank) is due
    // within one block's worth of cycles, run the interpreter single-step instead so the IRQ is
    // taken at exactly the right PC. Far from any event (the overwhelming majority of execution)
    // we run native at full speed. THUMB ~1 cycle/instr and MAX block = 256, so a ~300-cycle guard
    // band fully covers the worst-case block span.
    const irqSafe = this.cpu.halted ? true : (this.ppu.cyclesUntilIrq() > 320 && this.ppu.cyclesUntilFrameLatch() > 320 && !((globalThis as any).__NO_NATIVE_WHEN_TIMERS && this.timers.anyEnabled()));
    if (this.useRecompiler && this.recompiler && !this.cpu.halted && irqSafe) {
      const n = this.recompiler.tryRunNative(this.cpu);
      if (n > 0) {
        this.cpu.cycles += n;
        this.applyPokemonGen3RuntimeFixes();
        this.instrCount += n;
        this.ppu.step(n);
        this.timers.step(n);
        this.audio.step(n);
        if (!this.cpu.halted) { this.irq.poll(); this.serviceIrqDispatch(); }
        return n;
      }
    }

    const c = this.cpu.step();
    this.applyPokemonGen3RuntimeFixes();
    this.instrCount++;
    this.ppu.step(c);
    this.timers.step(c);
    this.audio.step(c);
    // Check for pending IRQ, then BIOS dispatch.
    if (!this.cpu.halted) {
      this.irq.poll();
      this.serviceIrqDispatch();
    }
    return c;
  }

  /**
   * Run one full frame worth of cycles (~280896). We deliberately run the WHOLE cycle budget and
   * do NOT bail out the instant VBlank flips — otherwise a main thread that spends most of the
   * frame halted in VBlankIntrWait would never get the post-VBlank CPU time it needs to advance.
   * The framebuffer for display is the one latched at the most recent VBlank.
   */
  runFrame(): Uint8Array {
    this.ppu.frameReady = false;
    let guard = 0;
    let cyclesThisFrame = 0;
    // Liveness sampling: count how many DISTINCT code regions the CPU visited this frame. A live
    // game (even on a perfectly static screen like the trainer card or options menu) executes its
    // main task loop + VBlank handler and visits many distinct PCs; a GENUINE hang spins over a
    // tiny handful. The browser watchdog uses lastFrameLiveness to avoid the previous false-positive
    // where a static-but-alive screen was wrongly reported as "frozen".
    const liveSet = this._liveSet; liveSet.clear();
    let liveSamples = 0;
    // Exit precisely when the PPU latches the frame (VBlank start, frameReady), not at a raw cycle
    // count. Because the native fast-path single-steps near the frame-latch boundary (see irqSafe /
    // cyclesUntilFrameLatch), both the interpreter and the recompiler stop at the SAME guest
    // instruction, keeping them phase-locked frame after frame instead of drifting by a block's
    // worth of instructions each frame (which previously desynced animations by ~frame 165+). The
    // cycle budget remains a safety cap in case frameReady is somehow missed.
    const FRAME_CAP = CYCLES_PER_FRAME + CYCLES_PER_FRAME; // generous safety ceiling
    while (!this.ppu.frameReady && cyclesThisFrame < FRAME_CAP && guard < 4_000_000) {
      if (this.cpu.halted) {
        // Advance hardware in small steps until an interrupt wakes the CPU. poll() may deliver an
        // IRQ (which clears halted and vectors to 0x18); serviceIrqDispatch then redirects to the
        // game's handler. Once unhalted, the normal step() path below executes the handler, which
        // sets the BIOS interrupt-check flag and acks IF so the pending IntrWait SWI can complete.
        const c = 8;
        this.ppu.step(c); this.timers.step(c); this.audio.step(c);
        this.irq.poll();
        if (!this.cpu.halted) this.serviceIrqDispatch();
        cyclesThisFrame += c;
        guard++;
        continue;
      }
      const c = this.step();
      cyclesThisFrame += c;
      guard++;
      // Sample distinct PC buckets (top bits) cheaply, a few times per frame.
      if ((guard & 0x3f) === 0) { liveSet.add((this.cpu.st.r[15] >>> 6) & 0x3ffff); liveSamples++; }
    }
    this.lastFrameLiveness = liveSet.size;
    this.frameCount++;
    return this.ppu.framebuffer;
  }

  /** Distinct PC buckets visited in the last frame (liveness signal for the watchdog). */
  lastFrameLiveness = 0;
  private _liveSet = new Set<number>();

  pc(): number { return this.cpu.st.r[15] >>> 0; }
  thumb(): boolean { return this.cpu.st.thumb; }
  wake(): void { this.cpu.halted = false; }
}

// A sentinel address (in BIOS region, never real code) used to detect IRQ-handler return.
// Depth-unique IRQ-return sentinels live in an UNUSED BIOS-region address that no real game code or
// data pointer can legitimately equal, so handleIrqReturn() never false-triggers on ordinary control
// flow. The base 0x13c is inside the BIOS (0x00000000-0x00003FFF) which is never executed by the
// game directly under HLE; depths 0..3 occupy 0x13c/0x140/0x144/0x148.
const BIOS_IRQ_RETURN = 0x0000013c;
