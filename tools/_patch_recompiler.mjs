import { readFileSync, writeFileSync } from 'node:fs';

function patch(file, edits) {
  let src = readFileSync(file, 'utf8');
  for (const [find, replace, optional] of edits) {
    if (!src.includes(find)) {
      if (optional) { console.log(`SKIP (not found) in ${file}: ${find.slice(0, 60)}...`); continue; }
      throw new Error(`NOT FOUND in ${file}: ${find.slice(0, 120)}`);
    }
    src = src.replace(find, replace);
  }
  writeFileSync(file, src);
  console.log(`patched ${file}`);
}

// ---- 1. wasm_encoder.ts: add missing i64 opcodes ----
patch('src/recompiler/wasm_encoder.ts', [
  [
    `  i64_and: 0x83,`,
    `  i64_and: 0x83,
  i64_or: 0x84,
  i64_xor: 0x85,
  i64_sub: 0x7d,
  i64_eqz: 0x50,`,
  ],
]);

// ---- 2. recompiler.ts ----
const recompEdits = [
  // 2a. liftCtx + bail telemetry fields after smcInvalidations decl
  [
    `  /** Count of stale RAM-code blocks invalidated by the self-modifying-code guard. */
  smcInvalidations = 0;`,
    `  /** Count of stale RAM-code blocks invalidated by the self-modifying-code guard. */
  smcInvalidations = 0;

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
  };`,
  ],
  // 2b. ARM block loop: rollback + ctx + lifter-driven flags
  [
    `      const res = liftArm(cb, instr, cur);
      if (res.status === 'bail') {
        break;
      }
      count++;`,
    `      const mark = cb.bytes.length;
      const res = liftArm(cb, instr, cur, this.liftCtx);
      if (res.status === 'bail') {
        // Roll back any partially-emitted bytes so a late bail can never leave dead code.
        cb.bytes.length = mark;
        this.recordBail('A', res.reason);
        break;
      }
      if (res.mayStore) hasStore = true;
      if (res.mayLoad) hasLoad = true;
      count++;`,
  ],
  // 2c. THUMB block loop: rollback + ctx + lifter-driven flags
  [
    `      const res = liftThumb(cb, instr, cur);
      if (res.status === 'bail') break;
      count++;`,
    `      const mark = cb.bytes.length;
      const res = liftThumb(cb, instr, cur, this.liftCtx);
      if (res.status === 'bail') {
        cb.bytes.length = mark;
        this.recordBail('T', res.reason);
        break;
      }
      if (res.mayStore) hasStore = true;
      if (res.mayLoad) hasLoad = true;
      count++;`,
  ],
];
patch('src/recompiler/recompiler.ts', recompEdits);

console.log('all patches applied');
