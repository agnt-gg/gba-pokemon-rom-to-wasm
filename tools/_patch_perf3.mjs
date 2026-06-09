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

// ---- 1. ppu.ts: O(1) cyclesUntilIrq / cyclesUntilFrameLatch (were O(scanlines) per dispatch) ----
patch('src/runtime/ppu.ts', [
  [
    `    const lyc = (ds >> 8) & 0xff;
    const sc = this.scanlineCycles;
    let best = Infinity;
    // HBlank: fires at HDRAW_CYCLES within the current scanline (if not already past it).
    if (hbEn && !this.inHblank && sc < HDRAW_CYCLES) best = Math.min(best, HDRAW_CYCLES - sc);
    // End-of-scanline events (VCount match at next line, VBlank at line 160). Scan forward up to a
    // full frame to find the nearest enabled end-of-line event.
    const toLineEnd = CYCLES_PER_SCANLINE - sc;
    for (let k = 0; k < TOTAL_SCANLINES; k++) {
      const line = (this.vcount + 1 + k) % TOTAL_SCANLINES;
      const cyc = toLineEnd + k * CYCLES_PER_SCANLINE;
      if (vcEn && line === lyc) { best = Math.min(best, cyc); break; }
      if (vbEn && line === SCREEN_H) { best = Math.min(best, cyc); break; }
    }
    return best;
  }`,
    `    const lyc = (ds >> 8) & 0xff;
    const sc = this.scanlineCycles;
    const cur = this.vcount;
    let best = Infinity;
    // HBlank: fires at HDRAW_CYCLES within the current scanline (if not already past it).
    if (hbEn && !this.inHblank && sc < HDRAW_CYCLES) best = HDRAW_CYCLES - sc;
    // End-of-scanline events in O(1): k = scanline-ends until target line becomes current.
    const toLineEnd = CYCLES_PER_SCANLINE - sc;
    if (vcEn && lyc < TOTAL_SCANLINES) {
      const k = (lyc - cur - 1 + TOTAL_SCANLINES) % TOTAL_SCANLINES;
      const cyc = toLineEnd + k * CYCLES_PER_SCANLINE;
      if (cyc < best) best = cyc;
    }
    if (vbEn) {
      const k = (SCREEN_H - cur - 1 + TOTAL_SCANLINES) % TOTAL_SCANLINES;
      const cyc = toLineEnd + k * CYCLES_PER_SCANLINE;
      if (cyc < best) best = cyc;
    }
    return best;
  }`,
  ],
  [
    `  cyclesUntilFrameLatch(): number {
    const sc = this.scanlineCycles;
    const toLineEnd = CYCLES_PER_SCANLINE - sc;
    let best = Infinity;
    for (let k = 0; k < TOTAL_SCANLINES; k++) {
      const line = (this.vcount + 1 + k) % TOTAL_SCANLINES;
      if (line === SCREEN_H || line === 0) { best = toLineEnd + k * CYCLES_PER_SCANLINE; break; }
    }
    return best;
  }`,
    `  cyclesUntilFrameLatch(): number {
    const sc = this.scanlineCycles;
    const toLineEnd = CYCLES_PER_SCANLINE - sc;
    const cur = this.vcount;
    const kVb = (SCREEN_H - cur - 1 + TOTAL_SCANLINES) % TOTAL_SCANLINES;
    const kZero = (0 - cur - 1 + TOTAL_SCANLINES) % TOTAL_SCANLINES;
    return toLineEnd + (kVb < kZero ? kVb : kZero) * CYCLES_PER_SCANLINE;
  }`,
  ],
]);

// ---- 2. timers.ts: bulk advance — O(overflows) instead of O(cycles) when prescaler is small ----
patch('src/runtime/timers.ts', [
  [
    `      const ps = PRESCALER[ctrl & 3];
      this.subcycle[ch] += cycles;
      while (this.subcycle[ch] >= ps) {
        this.subcycle[ch] -= ps;
        this.tick(ch, ctrl);
      }
      this.io.set16(this.CNT_L[ch], this.counter[ch] & 0xffff);`,
    `      const ps = PRESCALER[ctrl & 3];
      this.subcycle[ch] += cycles;
      let ticks = (this.subcycle[ch] / ps) | 0;
      if (ticks > 0) {
        this.subcycle[ch] -= ticks * ps;
        // Bulk-advance: jump straight to each overflow instead of ticking per cycle.
        // (Timer0 runs at prescaler 1 as the audio sample timer — the old per-cycle loop
        //  executed ~280k JS iterations per frame.)
        while (ticks > 0) {
          const toOverflow = 0x10000 - this.counter[ch];
          if (ticks < toOverflow) { this.counter[ch] += ticks; ticks = 0; break; }
          ticks -= toOverflow;
          this.counter[ch] = this.reload[ch];
          this.onOverflow(ch);
          if (ctrl & 0x40) this.requestIrq(IRQ_TIMER[ch]);
          if (ch < 3) {
            const nextCtrl = this.io.get16(this.CNT_H[ch + 1]);
            if (this.enabled[ch + 1] && (nextCtrl & 0x4)) this.cascadeTick(ch + 1, nextCtrl);
          }
        }
      }
      this.io.set16(this.CNT_L[ch], this.counter[ch] & 0xffff);`,
  ],
]);

// ---- 3. recompiler.ts: native-speed RAM compare + pooled verify snapshots ----
patch('src/recompiler/recompiler.ts', [
  [
    `  private ramEquals(s: ReturnType<Recompiler['snapshotRam']>): boolean {
    const m: any = this.bus;
    const eq = (a: Uint8Array | null, b: Uint8Array | null) => {
      if (!a || !b) return true;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };`,
    `  private ramEquals(s: ReturnType<Recompiler['snapshotRam']>): boolean {
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
    };`,
  ],
  // pooled snapshots: avoid 5 fresh typed-array allocations per verification
  [
    `  private snapshotRam() {`,
    `  private snapPool: any[] = [null, null];
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

  private snapshotRam() {`,
  ],
  [
    `      const needSnap = block.hasStore || block.hasLoad;
      const memSnap = needSnap ? this.snapshotRam() : null;`,
    `      const needSnap = block.hasStore || block.hasLoad;
      const memSnap = needSnap ? this.snapshotRamPooled(0) : null;`,
  ],
  [
    `        if (block.hasStore) nativeMem = this.snapshotRam();`,
    `        if (block.hasStore) nativeMem = this.snapshotRamPooled(1);`,
  ],
]);

console.log('perf3 applied');
