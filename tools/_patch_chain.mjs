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

// ---- recompiler.ts: verified-block chaining inside a 256-instruction budget ----
patch('src/recompiler/recompiler.ts', [
  [
    `  /** Telemetry: histogram of bail reasons hit during block discovery, keyed "mode:reason". */`,
    `  /** PCs where the machine must regain control (HLE entry points, quirk fixes, IRQ-return
   *  sentinels). Block chaining stops when the next PC is one of these so machine.step() can
   *  intercept exactly as it does on the single-step path. Populated by the machine. */
  chainStops = new Set<number>();

  /** Telemetry: histogram of bail reasons hit during block discovery, keyed "mode:reason". */`,
  ],
  [
    `    this.syncIn(cpu.st);
    // The block writes the architectural next-instruction address into r15 and returns it.
    const nextPc = block.fn() >>> 0;
    this.syncOut(cpu.st);
    cpu.st.r[15] = nextPc >>> 0;

    this.nativeInstrs += block.count;
    return block.count;
  }
}`,
    `    // ---- verified fast path with BLOCK CHAINING ----
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
}`,
  ],
]);

// ---- machine.ts: register the chain-stop PCs ----
patch('src/runtime/machine.ts', [
  [
    `    this.recompiler = new Recompiler(this.mem);`,
    `    this.recompiler = new Recompiler(this.mem);
    // PCs the dispatcher must regain control at; the recompiler's block chaining breaks at these
    // so machine.step() sees them exactly like on the single-dispatch path:
    //   - depth-unique BIOS IRQ-return sentinels (BIOS_IRQ_RETURN + d*4)
    //   - Pokemon Gen3 flash-helper HLE entry (ProgramFlashSectorAndVerify)
    //   - Ruby/Sapphire RTC battery-check quirk return PCs
    for (let d = 0; d < 4; d++) this.recompiler.chainStops.add((0x0000013c + d * 4) >>> 0);
    this.recompiler.chainStops.add(0x081dfa98);
    for (const p of [0x08009aa6, 0x08009aa8, 0x08009aaa, 0x08009aac]) this.recompiler.chainStops.add(p);`,
  ],
]);

console.log('chaining applied');
