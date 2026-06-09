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

patch('src/recompiler/recompiler.ts', [
  // helper to refresh stamps after a confirmed-unchanged checksum
  [
    `  /** True if every page a block spans still has its compile-time generation (no writes since). */`,
    `  /** Re-stamp a block's page generations (after a checksum proved its bytes are unchanged). */
  private refreshPageGuard(block: CompiledBlock, pc: number): void {
    const pg = this.buildPageGuard(pc, block.guardLen);
    if (pg) { block.pages = pg.pages; block.stamps = pg.stamps; }
  }

  /** True if every page a block spans still has its compile-time generation (no writes since). */`,
  ],
  // ARM hit path: page-gen fast path -> checksum confirm (refresh stamps) -> recompile
  [
    `      if (cached.guard === 0) return cached;
      if (cached.pages ? this.pageGuardFresh(cached) : this.checksumBytes(pc, cached.guardLen, false) === cached.guard) return cached;
      this.cache.delete(pc);
      this.smcInvalidations++;`,
    `      if (cached.guard === 0) return cached;
      if (cached.pages && this.pageGuardFresh(cached)) return cached;
      if (this.checksumBytes(pc, cached.guardLen, false) === cached.guard) {
        // A write touched the block's page(s) but the code bytes are unchanged (data sharing the
        // page). Re-stamp the generations so the fast path is hot again, keep the block.
        if (cached.pages) this.refreshPageGuard(cached, pc);
        return cached;
      }
      this.cache.delete(pc);
      this.smcInvalidations++;`,
  ],
  // THUMB hit path: same
  [
    `      if (cached.guard === 0) return cached;
      if (cached.pages ? this.pageGuardFresh(cached) : this.checksumBytes(pc, cached.guardLen, true) === cached.guard) return cached;
      this.cacheThumb.delete(pc);
      this.smcInvalidations++;`,
    `      if (cached.guard === 0) return cached;
      if (cached.pages && this.pageGuardFresh(cached)) return cached;
      if (this.checksumBytes(pc, cached.guardLen, true) === cached.guard) {
        if (cached.pages) this.refreshPageGuard(cached, pc);
        return cached;
      }
      this.cacheThumb.delete(pc);
      this.smcInvalidations++;`,
  ],
]);
console.log('done');
