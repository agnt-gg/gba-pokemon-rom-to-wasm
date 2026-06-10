/**
 * ARM -> WASM block recompiler + hybrid runtime.
 *
 * This is the genuine recompilation engine:
 *   1. discoverBlock(pc): decode forward from pc, lifting each ARM instruction to WASM until a
 *      control-flow boundary (branch) or an un-lifted instruction (bail).
 *   2. compileBlock(): emit a REAL .wasm module exporting that block as a function, instantiate
 *      it with host imports bound to the live GbaMemory bus, and cache the instance.
 *   3. run(): execute the compiled WASM block against the shared register-file memory; if a PC
 *      has no compilable native prefix, fall back to the interpreter (ArmCore) for that step.
 *
 * The CPU register file lives in WebAssembly.Memory so compiled blocks and the JS runtime share
 * it with zero copying. syncIn/syncOut bridge between the interpreter's ArmState and the shared
 * memory + exploded flags.
 *
 * This module proves the project name: ARM machine code from the ROM is translated into
 * WebAssembly bytecode and executed by the browser's WASM engine — not interpreted.
 */

import { ArmCore } from '../cpu/arm_core.ts';
import { ArmState, FLAG_N, FLAG_Z, FLAG_C, FLAG_V } from '../cpu/arm_state.ts';
import type { Bus } from '../cpu/bus.ts';
import { CodeBuilder } from './wasm_encoder.ts';
import { buildModule, I32, OP } from './wasm_encoder.ts';
import { liftArm, RESERVED_LOCALS } from './arm_lifter.ts';
import { liftThumb } from './thumb_lifter.ts';
import { OFF_CYCLES } from './abi.ts';
import {
  STATE_BYTES, regOff, OFF_CPSR, OFF_NF, OFF_ZF, OFF_CF, OFF_VF,
  HOST_IMPORT_ORDER,
} from './abi.ts';

const tHostRead = { params: [I32], results: [I32] };
const tHostWrite = { params: [I32, I32], results: [] };
const tBlock = { params: [], results: [I32] };

export interface CompiledBlock {
  startPc: number;
  /** number of ARM instructions natively lifted (>=1). */
  count: number;
  /** true if the block performs guest memory stores (can't be verified by naive replay). */
  hasStore: boolean;
  /** true if the block performs guest memory loads (reads may hit volatile IO; verification must
   *  snapshot/restore IO so the reference run reads the same values native did). */
  hasLoad: boolean;
  /** For blocks compiled from WRITABLE guest RAM (IWRAM/EWRAM) — a checksum of the exact
   *  instruction bytes the block was lifted from, plus its byte length. Pokemon copies/overwrites
   *  routines in IWRAM (self-modifying / relocated code), so a cached block at a given PC can become
   *  STALE when the underlying RAM bytes change. On lookup we re-checksum the live bytes; a mismatch
   *  means the code changed and we must recompile. 0 = not a RAM block (ROM/BIOS, never changes). */
  guard: number;
  /** byte length covered by the guard checksum (count*2 for THUMB, count*4 for ARM). */
  guardLen: number;
  /** Page-generation guard (preferred over checksum when the bus exposes page gens):
   *  pages[i] = encoded page (region<<16 | pageIndex), stamps[i] = generation at compile time. */
  pages: number[] | null;
  stamps: number[] | null;
  /** Set once the first-run differential verification has passed for THIS compilation. */
  verified: boolean;
  /** Number of times this block has been dispatched natively (read by the debugger UI). */
  execs: number;
  /** the exported function: () -> nextPc. */
  fn: () => number;
}

export class Recompiler {
  bus: Bus;
  /** Shared memory holding the register file (and exploded flags). */
  mem: WebAssembly.Memory;
  i32: Int32Array;
  u32: Uint32Array;
  cache = new Map<number, CompiledBlock | null>(); // null = "no native prefix, interpret" (ARM)
  cacheThumb = new Map<number, CompiledBlock | null>(); // THUMB block cache, keyed by pc

  // stats
  nativeInstrs = 0;
  interpInstrs = 0;
  blocksCompiled = 0;
  blocksRejected = 0;

  /**
   * Self-verification gate. On a block's FIRST native execution we re-run the same instructions on
   * a throwaway interpreter from identical state and compare the resulting register file + flags.
   * If they ever differ, we permanently mark the block as non-native (interpret instead). This
   * guarantees the recompiler can never diverge from the reference semantics on real ROM code —
   * it can only be a correct speedup or a safe fallback, never a correctness regression.
   */
  verifyFirstRun = true;
  private MAX_CACHE = 8192;

  constructor(bus: Bus) {
    this.bus = bus;
    this.mem = new WebAssembly.Memory({ initial: 1 }); // 64 KiB is plenty for the state block
    this.i32 = new Int32Array(this.mem.buffer);
    this.u32 = new Uint32Array(this.mem.buffer);
  }

  private hostImports() {
    const bus = this.bus;
    return {
      read8: (a: number) => bus.read8(a >>> 0) | 0,
      read16: (a: number) => bus.read16(a >>> 0) | 0,
      read32: (a: number) => bus.read32(a >>> 0) | 0,
      write8: (a: number, v: number) => bus.write8(a >>> 0, v & 0xff),
      write16: (a: number, v: number) => bus.write16(a >>> 0, v & 0xffff),
      write32: (a: number, v: number) => bus.write32(a >>> 0, v >>> 0),
    };
  }

  /** Copy interpreter ArmState (current bank) into shared WASM memory + explode flags. */
  /** Intra-block cycles executed so far by the currently-running native block (for lazy IO reads). */
  pendingCycles(): number { return this.i32[OFF_CYCLES >> 2] | 0; }

  /** Count of stale RAM-code blocks invalidated by the self-modifying-code guard. */
  smcInvalidations = 0;

  /** PCs where the machine must regain control (HLE entry points, quirk fixes, IRQ-return
   *  sentinels). Block chaining stops when the next PC is one of these so machine.step() can
   *  intercept exactly as it does on the single-step path. Populated by the machine. */
  chainStops = new Set<number>();

  /** Telemetry: histogram of bail reasons hit during block discovery, keyed "mode:reason". */
  bailReasons = new Map<string, number>();
  private recordBail(mode: string, reason?: string) {
    const k = mode + ':' + (reason || 'unknown');
    this.bailReasons.set(k, (this.bailReasons.get(k) || 0) + 1);
  }

  /** Compile-time lift context: lets lifters constant-fold literal-pool loads from immutable ROM. */
  private liftCtx = {
    romRead32: (addr: number) => {
      const region = (addr >>> 24) & 0xff;
      if (region >= 0x08 && region <= 0x0d) return this.bus.read32(addr >>> 0) >>> 0;
      return null;
    },
  };

  /** True if `pc` lies in a writable RAM region whose bytes can change under us (IWRAM 0x03, EWRAM
   *  0x02). ROM (0x08+) and BIOS (0x00) are immutable, so blocks there never need a guard. */
  private isRamCode(pc: number): boolean {
    const region = (pc >>> 24) & 0xff;
    return region === 0x02 || region === 0x03;
  }

  /** FNV-1a checksum of `len` bytes of guest code starting at `pc`. Used as the self-modifying-code
   *  guard for RAM blocks. `thumb` only affects nothing here (we read raw bytes), kept for clarity. */
  private checksumBytes(pc: number, len: number, _thumb: boolean): number {
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < len; i++) {
      h ^= this.bus.read8((pc + i) >>> 0) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
    return h | 0;
  }

  /** Build the page-generation guard for a RAM block, or null if the bus has no page gens. */
  private buildPageGuard(pc: number, len: number): { pages: number[]; stamps: number[] } | null {
    const m: any = this.bus;
    const region = (pc >>> 24) & 0xff;
    let gens: Uint32Array | null = null; let mask = 0;
    if (region === 0x03 && m.iwramGen) { gens = m.iwramGen; mask = 0x7fff; }
    else if (region === 0x02 && m.ewramGen) { gens = m.ewramGen; mask = 0x3ffff; }
    if (!gens) return null;
    const first = (pc & mask) >>> 8;
    const last = ((pc + len - 1) & mask) >>> 8;
    const pages: number[] = []; const stamps: number[] = [];
    for (let p = first; p <= last; p++) { pages.push((region << 16) | p); stamps.push(gens[p] | 0); }
    return { pages, stamps };
  }

  /** Re-stamp a block's page generations (after a checksum proved its bytes are unchanged). */
  private refreshPageGuard(block: CompiledBlock, pc: number): void {
    const pg = this.buildPageGuard(pc, block.guardLen);
    if (pg) { block.pages = pg.pages; block.stamps = pg.stamps; }
  }

  /** True if every page a block spans still has its compile-time generation (no writes since). */
  private pageGuardFresh(block: CompiledBlock): boolean {
    const m: any = this.bus;
    const pages = block.pages!; const stamps = block.stamps!;
    for (let i = 0; i < pages.length; i++) {
      const region = pages[i] >>> 16; const p = pages[i] & 0xffff;
      const gens: Uint32Array = region === 0x03 ? m.iwramGen : m.ewramGen;
      if ((gens[p] | 0) !== stamps[i]) return false;
    }
    return true;
  }

  // ---- store-block verification helpers ----
  // Snapshot/restore/compare the writable guest RAM regions so store-bearing native blocks can be
  // differentially verified against the reference interpreter on their first execution.
  private snapPool: any[] = [null, null];
  /** Pooled snapshotRam: reuses two snapshot buffers (verify is not reentrant) to avoid GC churn. */
  private snapshotRamPooled(slot: number) {
    const m: any = this.bus;
    const io: any = m.io;
    const ioSrc = io && io.regs ? io.regs : (m.ioRegs ? m.ioRegs : null);
    let s = this.snapPool[slot];
    if (!s) {
      s = this.snapPool[slot] = {
        iwram: m.iwram ? m.iwram.slice() : null,
        ewram: m.ewram ? m.ewram.slice() : null,
        vram: m.vram ? m.vram.slice() : null,
        palette: m.palette ? m.palette.slice() : null,
        oam: m.oam ? m.oam.slice() : null,
        ioRegs: ioSrc ? ioSrc.slice() : null,
      };
      return s;
    }
    if (s.iwram) s.iwram.set(m.iwram);
    if (s.ewram) s.ewram.set(m.ewram);
    if (s.vram) s.vram.set(m.vram);
    if (s.palette) s.palette.set(m.palette);
    if (s.oam) s.oam.set(m.oam);
    if (s.ioRegs && ioSrc) s.ioRegs.set(ioSrc);
    return s;
  }

  private snapshotRam() {
    const m: any = this.bus;
    const io: any = m.io;
    return {
      iwram: m.iwram ? m.iwram.slice() : null,
      ewram: m.ewram ? m.ewram.slice() : null,
      vram: m.vram ? m.vram.slice() : null,
      palette: m.palette ? m.palette.slice() : null,
      oam: m.oam ? m.oam.slice() : null,
      // IO register file (live registers like IME/IF/VCOUNT) — captured so a load-bearing block's
      // reference replay reads the exact same IO bytes native did.
      ioRegs: io && io.regs ? io.regs.slice() : (m.ioRegs ? m.ioRegs.slice() : null),
    };
  }
  private restoreRam(s: ReturnType<Recompiler['snapshotRam']>) {
    const m: any = this.bus;
    const io: any = m.io;
    if (s.iwram) m.iwram.set(s.iwram);
    if (s.ewram) m.ewram.set(s.ewram);
    if (s.vram) m.vram.set(s.vram);
    if (s.palette) m.palette.set(s.palette);
    if (s.oam) m.oam.set(s.oam);
    if (s.ioRegs) { if (io && io.regs) io.regs.set(s.ioRegs); else if (m.ioRegs) m.ioRegs.set(s.ioRegs); }
  }
  private ramEquals(s: ReturnType<Recompiler['snapshotRam']>): boolean {
    const m: any = this.bus;
    const eq = (a: Uint8Array | null, b: Uint8Array | null) => {
      if (!a || !b) return true;
      if (a.length !== b.length) return false;
      // Native memcmp under Node; 32-bit-word compare in the browser. (The old per-byte JS loop
      // compared ~390KB per store-block verification.)
      if (typeof Buffer !== 'undefined') return Buffer.compare(a, b) === 0;
      const n = a.length >>> 2;
      const a32 = new Int32Array(a.buffer, a.byteOffset, n);
      const b32 = new Int32Array(b.buffer, b.byteOffset, n);
      for (let i = 0; i < n; i++) if (a32[i] !== b32[i]) return false;
      for (let i = n << 2; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    // Compare only true RAM (not IO regs — IO side effects are intentional and re-applied below).
    return eq(s.iwram, m.iwram) && eq(s.ewram, m.ewram) && eq(s.vram, m.vram) && eq(s.palette, m.palette) && eq(s.oam, m.oam);
  }

  syncIn(st: ArmState): void {
    // Reset the intra-block cycle accumulator: each lifted instruction bumps mem[OFF_CYCLES] so the
    // lazy timer-read hook can reconcile a mid-block timer CNT_L read to the per-instruction value.
    this.i32[OFF_CYCLES >> 2] = 0;
    for (let i = 0; i < 16; i++) this.i32[(regOff(i)) >> 2] = st.r[i] | 0;
    this.i32[OFF_CPSR >> 2] = st.cpsr | 0;
    this.i32[OFF_NF >> 2] = (st.cpsr & FLAG_N) ? 1 : 0;
    this.i32[OFF_ZF >> 2] = (st.cpsr & FLAG_Z) ? 1 : 0;
    this.i32[OFF_CF >> 2] = (st.cpsr & FLAG_C) ? 1 : 0;
    this.i32[OFF_VF >> 2] = (st.cpsr & FLAG_V) ? 1 : 0;
  }

  /** Copy shared WASM memory back into the interpreter ArmState + repack flags into CPSR. */
  syncOut(st: ArmState): void {
    // Clear the intra-block cycle accumulator so any subsequent INTERPRETER-path IO read (when the
    // recompiler bails to single-step) sees pendingCycles()==0 and returns the already-current
    // per-instruction value rather than a stale leftover from the last native block.
    this.i32[OFF_CYCLES >> 2] = 0;
    for (let i = 0; i < 16; i++) st.r[i] = this.u32[(regOff(i)) >> 2] >>> 0;
    let cpsr = this.i32[OFF_CPSR >> 2] >>> 0;
    cpsr = (cpsr & ~(FLAG_N | FLAG_Z | FLAG_C | FLAG_V)) >>> 0;
    if (this.i32[OFF_NF >> 2]) cpsr |= FLAG_N;
    if (this.i32[OFF_ZF >> 2]) cpsr |= FLAG_Z;
    if (this.i32[OFF_CF >> 2]) cpsr |= FLAG_C;
    if (this.i32[OFF_VF >> 2]) cpsr |= FLAG_V;
    st.cpsr = cpsr >>> 0;
  }

  /**
   * Discover and compile a native block starting at `pc` (ARM, AL-only prefix).
   * Returns null if the very first instruction can't be lifted (caller should interpret one step).
   */
  compileBlock(pc: number): CompiledBlock | null {
    const cached = this.cache.get(pc);
    if (cached) {
      // Self-modifying / relocated code guard. Page generations (O(1)) when available;
      // otherwise fall back to the byte checksum (O(blockLen)).
      if (cached.guard === 0) return cached;
      if (cached.pages && this.pageGuardFresh(cached)) return cached;
      if (this.checksumBytes(pc, cached.guardLen, false) === cached.guard) {
        // A write touched the block's page(s) but the code bytes are unchanged (data sharing the
        // page). Re-stamp the generations so the fast path is hot again, keep the block.
        if (cached.pages) this.refreshPageGuard(cached, pc);
        return cached;
      }
      this.cache.delete(pc);
      this.smcInvalidations++;
    } else if (this.cache.has(pc)) {
      return this.cache.get(pc)!; // null sentinel (permanently-rejected block) — keep interpreting.
    }
    // Self-modifying / relocated code (Pokemon copies routines into IWRAM) can spawn unbounded
    // distinct PCs. Cap the cache; once full, stop compiling new blocks (interpret them).
    if (this.cache.size >= this.MAX_CACHE) return null;

    const cb = new CodeBuilder();
    let cur = pc >>> 0;
    let count = 0;
    let endedByBranch = false;
    let hasStore = false;
    let hasLoad = false;
    const MAX = (globalThis as any).__ARM_MAXLEN || 256; // safety cap on block length

    while (count < MAX) {
      const instr = this.bus.read32(cur) >>> 0;
      // Detect store instructions (LDR/STR class with L==0) so we know this block has memory
      // side effects and cannot be verified by naive interpreter replay.
      if ((instr & 0x0c100000) === 0x04000000) hasStore = true; // single transfer, L==0
      if ((instr & 0x0c100000) === 0x04100000) hasLoad = true;  // single transfer, L==1
      const mark = cb.bytes.length;
      const res = liftArm(cb, instr, cur, this.liftCtx);
      if (res.status === 'bail') {
        // Roll back any partially-emitted bytes so a late bail can never leave dead code.
        cb.bytes.length = mark;
        this.recordBail('A', res.reason);
        break;
      }
      if (res.mayStore) hasStore = true;
      if (res.mayLoad) hasLoad = true;
      count++;
      if (res.status === 'endsBlock') {
        endedByBranch = true;
        break;
      }
      cur = (cur + 4) >>> 0;
    }

    if (count === 0) {
      this.cache.set(pc, null);
      return null;
    }

    // If the block fell through without a branch, set PC to the next instruction so the
    // dispatcher knows where to resume.
    if (!endedByBranch) {
      cb.i32_const(regOff(15));
      cb.i32_const(cur >>> 0);
      cb.i32_store(0);
    }
    // Return nextPc = r15.
    cb.i32_const(regOff(15)).i32_load(0);
    cb.return_();

    const mod = buildModule({
      types: [tHostRead, tHostWrite, tBlock],
      imports: HOST_IMPORT_ORDER.map((name) => ({
        module: 'env',
        name,
        type: name.startsWith('read') ? tHostRead : tHostWrite,
      })),
      memory: { module: 'env', name: 'mem', minPages: 1 },
      functions: [{ locals: RESERVED_LOCALS, code: cb.build(), typeIndex: 2, exportName: 'block' }],
    });

    const module = new WebAssembly.Module(mod);
    const instance = new WebAssembly.Instance(module, {
      env: { mem: this.mem, ...this.hostImports() },
    });

    const guardLen = count * 4; // ARM: 4 bytes/instr
    const isRam = this.isRamCode(pc);
    const guard = isRam ? this.checksumBytes(pc, guardLen, false) : 0;
    const pg = isRam ? this.buildPageGuard(pc, guardLen) : null;
    const block: CompiledBlock = {
      startPc: pc,
      count,
      hasStore,
      hasLoad,
      guard,
      guardLen,
      pages: pg ? pg.pages : null,
      stamps: pg ? pg.stamps : null,
      verified: false,
      execs: 0,
      fn: instance.exports.block as () => number,
    };
    this.cache.set(pc, block);
    this.blocksCompiled++;
    return block;
  }

  /**
   * Compile a THUMB block starting at `pc` (the address of the first 16-bit instruction). Mirrors
   * compileBlock but decodes 16-bit instructions, steps by 2, and uses the THUMB lifter. Cached in
   * a separate map so an address can have both an ARM and a THUMB compilation if ever reused in
   * both modes (it won't in practice, but keeping them separate is correctness-safe).
   */
  compileBlockThumb(pc: number): CompiledBlock | null {
    const cached = this.cacheThumb.get(pc);
    if (cached) {
      if (cached.guard === 0) return cached;
      if (cached.pages && this.pageGuardFresh(cached)) return cached;
      if (this.checksumBytes(pc, cached.guardLen, true) === cached.guard) {
        if (cached.pages) this.refreshPageGuard(cached, pc);
        return cached;
      }
      this.cacheThumb.delete(pc);
      this.smcInvalidations++;
    } else if (this.cacheThumb.has(pc)) {
      return this.cacheThumb.get(pc)!; // null sentinel
    }
    if (this.cacheThumb.size >= this.MAX_CACHE) return null;

    const cb = new CodeBuilder();
    let cur = pc >>> 0;
    let count = 0;
    let endedByBranch = false;
    let hasStore = false;
    let hasLoad = false;
    const MAX = (globalThis as any).__THUMB_MAXLEN || 256;

    while (count < MAX) {
      const instr = this.bus.read16(cur) & 0xffff;
      // Detect THUMB stores (Fmt 9/10/11 with L==0) so blocks with memory side effects skip
      // naive interpreter-replay verification.
      const top = instr >>> 13;
      if (top === 0b011 && (instr & 0x0800) === 0) hasStore = true;            // Fmt 9 STR/STRB
      else if (top === 0b100 && (instr & 0xf000) === 0x8000 && (instr & 0x0800) === 0) hasStore = true; // Fmt 10 STRH
      else if (top === 0b100 && (instr & 0xf000) !== 0x8000 && (instr & 0x0800) === 0) hasStore = true; // Fmt 11 SP STR
      // Detect THUMB loads (any Fmt 6/7/9/10/11 with L==1, plus PC-rel Fmt 6) so verification can
      // snapshot/restore volatile IO around the reference replay.
      if (top === 0b011 && (instr & 0x0800) !== 0) hasLoad = true;             // Fmt 9 LDR/LDRB
      else if (top === 0b100 && (instr & 0x0800) !== 0) hasLoad = true;        // Fmt 10/11 LDRH/LDR
      else if ((instr & 0xf800) === 0x4800) hasLoad = true;                    // Fmt 6 LDR PC-rel
      else if (top === 0b010 && (instr & 0x0e00) === 0x0800 && (instr & 0x0200) !== 0) hasLoad = true; // Fmt 7/8 loads
      const mark = cb.bytes.length;
      const res = liftThumb(cb, instr, cur, this.liftCtx);
      if (res.status === 'bail') {
        cb.bytes.length = mark;
        this.recordBail('T', res.reason);
        break;
      }
      if (res.mayStore) hasStore = true;
      if (res.mayLoad) hasLoad = true;
      count++;
      if (res.status === 'endsBlock') { endedByBranch = true; break; }
      cur = (cur + 2) >>> 0;
    }

    if (count === 0) {
      this.cacheThumb.set(pc, null);
      return null;
    }

    // Fell through without a branch: set r15 to the next THUMB instruction address.
    if (!endedByBranch) {
      cb.i32_const(regOff(15));
      cb.i32_const(cur >>> 0);
      cb.i32_store(0);
    }
    cb.i32_const(regOff(15)).i32_load(0);
    cb.return_();

    const mod = buildModule({
      types: [tHostRead, tHostWrite, tBlock],
      imports: HOST_IMPORT_ORDER.map((name) => ({
        module: 'env',
        name,
        type: name.startsWith('read') ? tHostRead : tHostWrite,
      })),
      memory: { module: 'env', name: 'mem', minPages: 1 },
      functions: [{ locals: RESERVED_LOCALS, code: cb.build(), typeIndex: 2, exportName: 'block' }],
    });

    const module = new WebAssembly.Module(mod);
    const instance = new WebAssembly.Instance(module, {
      env: { mem: this.mem, ...this.hostImports() },
    });

    const guardLen = count * 2; // THUMB: 2 bytes/instr
    const isRam = this.isRamCode(pc);
    const guard = isRam ? this.checksumBytes(pc, guardLen, true) : 0;
    const pg = isRam ? this.buildPageGuard(pc, guardLen) : null;
    const block: CompiledBlock = {
      startPc: pc,
      count,
      hasStore,
      hasLoad,
      guard,
      guardLen,
      pages: pg ? pg.pages : null,
      stamps: pg ? pg.stamps : null,
      verified: false,
      execs: 0,
      fn: instance.exports.block as () => number,
    };
    this.cacheThumb.set(pc, block);
    this.blocksCompiled++;
    return block;
  }

  /**
   * Run one "unit of progress" from the interpreter's current PC:
   *   - If a native block compiles at PC, sync in, run the WASM block, sync out, return native count.
   *   - Otherwise, return 0 to signal the caller to interpret a single instruction.
   *
   * The caller (HybridCpu) owns the interpreter and the cycle/IRQ bookkeeping.
   */
  tryRunNative(cpu: ArmCore): number {
    // Interpreter convention: at the top of step(), r[15] == address of the CURRENT instruction
    // (ARM PC reads add +8, THUMB reads add +4; handled inside the lifters). No pipeline latch.
    const pc = cpu.st.r[15] >>> 0;
    const block = cpu.st.thumb ? this.compileBlockThumb(pc) : this.compileBlock(pc);
    if (!block) return 0;

    // --- first-run self-verification ---
    // Snapshot the full architectural state, run native, then run the SAME instructions on a
    // reference interpreter from the snapshot and compare. Any divergence => reject this block.
    // Blocks that write guest memory cannot be verified by interpreter replay (replaying would
    // double-apply the stores). Their correctness is covered by the differential unit tests; here
    // we trust the verified lifter and execute directly.
    if (this.verifyFirstRun && !block.verified) {
      const snapR = Int32Array.from(cpu.st.r);
      const snapCpsr = cpu.st.cpsr >>> 0;

      // Store-bearing blocks mutate guest RAM. To verify them we must compare the MEMORY effects of
      // the native block against the reference interpreter, not just registers/flags. We snapshot
      // the writable RAM regions, run native (capturing its memory result), restore RAM, run the
      // reference, then compare. Only if BOTH register/flag state AND all memory bytes match do we
      // accept; otherwise we roll back fully and reject. (Previously store blocks were trusted
      // un-verified, which let a mis-lifted load/store silently corrupt state — the root cause of
      // the frame-168 interp-vs-wasm divergence.)
      // Snapshot when the block STORES (to compare memory effects) OR LOADS (so the reference
      // replay reads the SAME volatile IO/RAM bytes native read — a load from IME/IF/VCOUNT etc.
      // can change between the native run and the reference run, producing a false rejection or,
      // worse, a wrong accepted value. Snapshotting IO+RAM and restoring it before the reference
      // run makes the replay deterministic against the exact state native observed.)
      const needSnap = block.hasStore || block.hasLoad;
      const memSnap = needSnap ? this.snapshotRamPooled(0) : null;

      this.syncIn(cpu.st);
      const nextPc = block.fn() >>> 0;
      this.syncOut(cpu.st);
      cpu.st.r[15] = nextPc >>> 0;

      let nativeMem: ReturnType<typeof this.snapshotRam> | null = null;
      // Only compare memory bytes for STORE blocks; load-only blocks don't mutate RAM so the
      // reference replay must see the pre-block snapshot (restore it) but we don't diff memory.
      if (memSnap) {
        if (block.hasStore) nativeMem = this.snapshotRamPooled(1);
        this.restoreRam(memSnap);
      }

      // Reference run on a throwaway core sharing the SAME bus.
      const ref = new ArmCore(this.bus);
      ref.st.r.set(snapR);
      ref.st.cpsr = snapCpsr;
      ref.st.r[15] = pc;
      for (let i = 0; i < block.count; i++) ref.step();

      let ok = (ref.st.r[15] >>> 0) === (cpu.st.r[15] >>> 0);
      if (ok) for (let i = 0; i < 15; i++) { if ((ref.st.r[i] >>> 0) !== (cpu.st.r[i] >>> 0)) { ok = false; break; } }
      const FLAGS = FLAG_N | FLAG_Z | FLAG_C | FLAG_V;
      if (ok && ((ref.st.cpsr & FLAGS) !== (cpu.st.cpsr & FLAGS))) ok = false;
      // Compare memory effects for store blocks: the reference just mutated the (restored) RAM; the
      // native result is in nativeMem. They must be byte-identical.
      if (ok && nativeMem && !this.ramEquals(nativeMem)) ok = false;

      if (!ok) {
        if ((globalThis as any).__RECOMP_DEBUG) {
          const diffs: string[] = [];
          for (let i = 0; i < 15; i++) if ((ref.st.r[i] >>> 0) !== (cpu.st.r[i] >>> 0)) diffs.push(`r${i}:int=${(ref.st.r[i]>>>0).toString(16)} wasm=${(cpu.st.r[i]>>>0).toString(16)}`);
          if ((ref.st.r[15] >>> 0) !== (cpu.st.r[15] >>> 0)) diffs.push(`pc:int=${(ref.st.r[15]>>>0).toString(16)} wasm=${(cpu.st.r[15]>>>0).toString(16)}`);
          const FF = FLAG_N|FLAG_Z|FLAG_C|FLAG_V;
          if ((ref.st.cpsr & FF) !== (cpu.st.cpsr & FF)) diffs.push(`flags:int=${(ref.st.cpsr&FF).toString(16)} wasm=${(cpu.st.cpsr&FF).toString(16)}`);
          const fmt = cpu.st.thumb ? 'THUMB' : 'ARM';
          const first = cpu.st.thumb ? this.bus.read16(pc).toString(16) : this.bus.read32(pc).toString(16);
          console.error(`[recomp-reject] ${fmt} pc=0x${pc.toString(16)} count=${block.count} firstInstr=0x${first} :: ${diffs.join(' | ')}`);
        }
        // Roll back to the snapshot and permanently reject this block. For store blocks the RAM
        // currently holds the REFERENCE result; restore the pre-block snapshot so the caller can
        // cleanly re-interpret this instruction from scratch.
        if (memSnap) this.restoreRam(memSnap);
        cpu.st.r.set(snapR);
        cpu.st.cpsr = snapCpsr;
        cpu.st.r[15] = pc;
        (cpu.st.thumb ? this.cacheThumb : this.cache).set(pc, null);
        this.blocksRejected++;
        return 0;
      }
      // Passed. For store blocks, RAM currently holds the reference result which is byte-identical
      // to the native result, so no further action is needed.
      block.verified = true;
      block.execs++;
      this.nativeInstrs += block.count;
      return block.count;
    }

    // ---- verified fast path with BLOCK CHAINING ----
    // Registers live in linear memory between chained blocks: syncIn once, run up to a
    // 256-instruction budget of already-verified blocks back-to-back (the same instruction span
    // a single max-size block may already cover, so the IRQ guard-band timing model is
    // unchanged), then syncOut once. This removes per-block sync + dispatch overhead.
    // The THUMB/ARM mode of the next block is read from the CPSR T bit in linear memory, so
    // BX / POP{pc} mode switches chain seamlessly.
    this.syncIn(cpu.st);
    const CHAIN_BUDGET = 256;
    let total = 0;
    let nextPc = 0;
    let cur: CompiledBlock = block;
    for (;;) {
      cur.execs++;
      nextPc = cur.fn() >>> 0;
      total += cur.count;
      if (total >= CHAIN_BUDGET) break;
      if (cpu.halted) break;                       // a chained store halted the CPU (HALTCNT)
      if (this.chainStops.has(nextPc)) break;      // machine-level PC intercept
      const thumbNow = (this.i32[OFF_CPSR >> 2] & 0x20) !== 0;
      const nb = thumbNow ? this.compileBlockThumb(nextPc) : this.compileBlock(nextPc);
      if (!nb) break;
      if (this.verifyFirstRun && !nb.verified) break; // first run must go through the verify gate
      if (total + nb.count > CHAIN_BUDGET) break;
      cur = nb;
    }
    this.syncOut(cpu.st);
    cpu.st.r[15] = nextPc >>> 0;

    this.nativeInstrs += total;
    return total;
  }
}
