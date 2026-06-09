import { readFileSync, writeFileSync } from 'node:fs';

function patch(file, edits) {
  let src = readFileSync(file, 'utf8');
  for (const [find, replace] of edits) {
    if (!src.includes(find)) throw new Error(`NOT FOUND in ${file}: ${find.slice(0, 100)}`);
    src = src.replace(find, replace);
  }
  writeFileSync(file, src);
  console.log('patched ' + file);
}

// ---- 1. memory.ts: page-generation tracking for IWRAM/EWRAM code invalidation ----
patch('src/runtime/memory.ts', [
  [
    `  // Raw IO register backing store for simple registers the IoBus doesn't intercept.
  ioRegs = new Uint8Array(0x400);`,
    `  // Raw IO register backing store for simple registers the IoBus doesn't intercept.
  ioRegs = new Uint8Array(0x400);

  // ---- self-modifying-code page generations ----
  // Every write to IWRAM/EWRAM stamps its 256-byte page with a fresh generation number. The
  // recompiler records the generations of the pages a RAM block spans at compile time and
  // compares them on every dispatch — an O(pages) (≈O(1)) exactness guard that replaces the
  // old O(blockLen) FNV re-checksum on every cache hit.
  iwramGen = new Uint32Array(0x8000 >>> 8);   // 128 pages
  ewramGen = new Uint32Array(0x40000 >>> 8);  // 1024 pages
  genCounter = 1;`,
  ],
  [
    `      case 0x02: this.ewram[addr & 0x3ffff] = value; break;
      case 0x03: this.iwram[addr & 0x7fff] = value; break;
      case 0x04:
        if (this.io) this.io.writeIo8(addr & 0xffffff, value);`,
    `      case 0x02: { const o = addr & 0x3ffff; this.ewram[o] = value; this.ewramGen[o >>> 8] = ++this.genCounter; break; }
      case 0x03: { const o = addr & 0x7fff; this.iwram[o] = value; this.iwramGen[o >>> 8] = ++this.genCounter; break; }
      case 0x04:
        if (this.io) this.io.writeIo8(addr & 0xffffff, value);`,
  ],
]);

// ---- 2. recompiler.ts: page-stamp guard + per-block verified flag ----
patch('src/recompiler/recompiler.ts', [
  // 2a. CompiledBlock fields
  [
    `  /** byte length covered by the guard checksum (count*2 for THUMB, count*4 for ARM). */
  guardLen: number;
  /** the exported function: () -> nextPc. */
  fn: () => number;
}`,
    `  /** byte length covered by the guard checksum (count*2 for THUMB, count*4 for ARM). */
  guardLen: number;
  /** Page-generation guard (preferred over checksum when the bus exposes page gens):
   *  pages[i] = encoded page (region<<16 | pageIndex), stamps[i] = generation at compile time. */
  pages: number[] | null;
  stamps: number[] | null;
  /** Set once the first-run differential verification has passed for THIS compilation. */
  verified: boolean;
  /** the exported function: () -> nextPc. */
  fn: () => number;
}`,
  ],
  // 2b. helper methods after checksumBytes
  [
    `  // ---- store-block verification helpers ----`,
    `  /** Build the page-generation guard for a RAM block, or null if the bus has no page gens. */
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

  // ---- store-block verification helpers ----`,
  ],
  // 2c. ARM cache-hit path: prefer page guard
  [
    `    if (cached) {
      // Self-modifying / relocated code: if this block was lifted from writable RAM, the live bytes
      // may have been overwritten since. Re-checksum; on mismatch, drop the stale block & recompile.
      if (cached.guard === 0 || this.checksumBytes(pc, cached.guardLen, false) === cached.guard) return cached;
      this.cache.delete(pc);
      this.smcInvalidations++;
    } else if (this.cache.has(pc)) {`,
    `    if (cached) {
      // Self-modifying / relocated code guard. Page generations (O(1)) when available;
      // otherwise fall back to the byte checksum (O(blockLen)).
      if (cached.guard === 0) return cached;
      if (cached.pages ? this.pageGuardFresh(cached) : this.checksumBytes(pc, cached.guardLen, false) === cached.guard) return cached;
      this.cache.delete(pc);
      this.smcInvalidations++;
    } else if (this.cache.has(pc)) {`,
  ],
  // 2d. THUMB cache-hit path
  [
    `    if (cached) {
      if (cached.guard === 0 || this.checksumBytes(pc, cached.guardLen, true) === cached.guard) return cached;
      this.cacheThumb.delete(pc);
      this.smcInvalidations++;
    } else if (this.cacheThumb.has(pc)) {`,
    `    if (cached) {
      if (cached.guard === 0) return cached;
      if (cached.pages ? this.pageGuardFresh(cached) : this.checksumBytes(pc, cached.guardLen, true) === cached.guard) return cached;
      this.cacheThumb.delete(pc);
      this.smcInvalidations++;
    } else if (this.cacheThumb.has(pc)) {`,
  ],
  // 2e. ARM block construction
  [
    `    const guardLen = count * 4; // ARM: 4 bytes/instr
    const guard = this.isRamCode(pc) ? this.checksumBytes(pc, guardLen, false) : 0;
    const block: CompiledBlock = {
      startPc: pc,
      count,
      hasStore,
      hasLoad,
      guard,
      guardLen,
      fn: instance.exports.block as () => number,
    };`,
    `    const guardLen = count * 4; // ARM: 4 bytes/instr
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
      fn: instance.exports.block as () => number,
    };`,
  ],
  // 2f. THUMB block construction
  [
    `    const guardLen = count * 2; // THUMB: 2 bytes/instr
    const guard = this.isRamCode(pc) ? this.checksumBytes(pc, guardLen, true) : 0;
    const block: CompiledBlock = {
      startPc: pc,
      count,
      hasStore,
      hasLoad,
      guard,
      guardLen,
      fn: instance.exports.block as () => number,
    };`,
    `    const guardLen = count * 2; // THUMB: 2 bytes/instr
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
      fn: instance.exports.block as () => number,
    };`,
  ],
  // 2g. verified flag instead of the Set (a recompiled SMC block now correctly RE-verifies)
  [
    `  verifyFirstRun = true;
  private verified = new Set<number>();
  private MAX_CACHE = 8192;`,
    `  verifyFirstRun = true;
  private MAX_CACHE = 8192;`,
  ],
  [
    `    const verifyKey = ((cpu.st.thumb ? 0x80000000 : 0) | pc) >>> 0;
    if (this.verifyFirstRun && !this.verified.has(verifyKey)) {`,
    `    if (this.verifyFirstRun && !block.verified) {`,
  ],
  [
    `      // Passed. For store blocks, RAM currently holds the reference result which is byte-identical
      // to the native result, so no further action is needed.
      this.verified.add(verifyKey);
      this.nativeInstrs += block.count;`,
    `      // Passed. For store blocks, RAM currently holds the reference result which is byte-identical
      // to the native result, so no further action is needed.
      block.verified = true;
      this.nativeInstrs += block.count;`,
  ],
]);

console.log('all perf patches applied');
