import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const edits = [
  // 1. Execution-model framing: interpreter-first -> hybrid recompiler, measured numbers.
  [
    `<p>The current core executes the ROM dynamically through an interpreter. The ROM-to-WASM framing is still accurate because the architectural separation is the same one used by a static or hybrid recompiler: decode guest instructions into a host-level intermediate form, preserve all guest-visible side effects, and route hardware interaction through imports.</p>`,
    `<p>The core executes the ROM through a <strong>hybrid recompiler</strong>: ARM and THUMB basic blocks are lifted into real WebAssembly bytecode in-process (<code>new WebAssembly.Module()</code>) and run by the engine, with a reference interpreter as the verification oracle and fallback. On the measured Ruby boot/gameplay path, <strong>99.9% of executed guest instructions run as engine-executed WASM</strong> &mdash; the only interpreted instructions left are a handful of MSR/MRS mode-plumbing sites and SWI entries into the BIOS HLE. The architectural separation is exactly the one a static or hybrid recompiler uses: decode guest instructions into a host-level form, preserve all guest-visible side effects, and route hardware interaction through imports.</p>`,
  ],
  // 2. "What gets lifted, what bails" paragraph: conservative-v1 list -> v2 full coverage.
  [
    `<p>The lifter is deliberately conservative. It natively handles the instruction classes that dominate hot loops -- moves, the full ALU set, immediate and register shifts, multiplies, byte/halfword/word loads and stores, conditional and unconditional branches, BL, PUSH/POP of the common forms, and SP/PC-relative address math. Anything with subtle pipeline or rotation semantics it does not yet model exactly -- unaligned word-LDR rotation, BX mode switches, LDM/STM register lists, PC as an operand -- returns a <code>bail</code> status. A bail simply ends the block early; the interpreter executes that one instruction, and compilation resumes at the next PC. This is the "hybrid" in hybrid recompilation: <strong>correctness is never traded for coverage</strong>. Today roughly three quarters of executed instructions run as native WASM; the remainder fall back, and every one of them is still correct.</p>`,
    `<p>The lifters now model essentially the whole user-mode instruction set, including the semantics that were originally deferred as "subtle": the ARM7 <strong>unaligned word-LDR rotation</strong> is emitted natively as <code>rotr(read32(addr &amp; ~3), 8*(addr &amp; 3))</code> (branchless &mdash; <code>rotr</code> by 0 is the identity); <strong>BX and POP {pc}</strong> perform the THUMB&harr;ARM mode switch by rewriting the CPSR T bit in linear memory so the dispatcher picks the right instruction set for the next block; <strong>LDM/STM register lists are unrolled at compile time</strong> (the list is a compile-time constant) including the ARM7 empty-rlist and STM base-in-rlist quirks; <strong>full conditional execution</strong> wraps any liftable body in an <code>if(cond)</code> block with an architectural <code>else PC=pc+4</code>; ADC/SBC/RSC take carry-in from the exploded C flag with an exact two-step carry-out; register-specified shifts reproduce the barrel shifter's &ge;32 edge cases; long multiplies use i64 math; and <code>ldr rd, [pc, #imm]</code> literal-pool loads from immutable ROM are <strong>constant-folded into <code>i32.const</code></strong> &mdash; zero host calls. What still bails: MSR/MRS (banked-mode plumbing), SWI (BIOS HLE entry), LDM/STM with the S bit, and DP ops writing PC (exception returns). A bail ends the block; the interpreter executes that instruction and compilation resumes at the next PC. This is still the "hybrid" guarantee &mdash; <strong>correctness is never traded for coverage</strong> &mdash; but the measured outcome is now 99.9% native on the Ruby boot path, with a bail-reason telemetry histogram in the coverage tool proving the residue is exactly 16 MSR/MRS sites and 6 SWI sites.</p>`,
  ],
  // 3. Bail-before-emit callout -> snapshot/rollback discipline.
  [
    `<div class="callout"><b>Design rule that paid off repeatedly:</b> a lifter must decide to bail <em>before</em> it emits any WASM. Two load lifters originally computed an address and stored it to a scratch local and <em>then</em> discovered they had to bail -- leaving dead, half-finished code in the shared block builder. Restructuring them to test the bail condition first (zero prior emission) removed an entire class of latent corruption.</div>`,
    `<div class="callout"><b>Design rule, evolved:</b> v1's rule was "a lifter must decide to bail <em>before</em> it emits any WASM" &mdash; two early load lifters left dead, half-finished code in the shared builder by bailing late. v2 replaces the convention with a <strong>mechanical guarantee</strong>: the block builder snapshots the CodeBuilder length before every lift and truncates back to it on any bail. Lifters are now free to bail at any point (which the full-coverage lifters need &mdash; e.g. a register-shifted logical S-op discovers its dynamic-carry case mid-decode), and partial emission can never corrupt a block by construction.</div>`,
  ],
  // 4. Verification one-time cost -> verified flag + chaining note.
  [
    `<p>A verified block is never re-checked (beyond the SMC guard above), so verification is a one-time cost amortized across thousands of later executions. A rejected block is permanently marked and always interpreted, so a single mis-lift can never corrupt the run -- it just costs a little speed.</p>`,
    `<p>Verification is recorded as a per-block <code>verified</code> flag (so a block recompiled after an SMC invalidation correctly re-verifies), making it a one-time cost amortized across thousands of later executions. A rejected block is permanently marked and always interpreted, so a single mis-lift can never corrupt the run &mdash; it just costs a little speed. Verified blocks also unlock <strong>block chaining</strong>: registers live in WASM linear memory between blocks, so the dispatcher syncs in once, runs up to a 256-instruction budget of verified blocks back-to-back (mode switches included &mdash; the next block's ARM/THUMB cache is chosen from the CPSR T bit in linear memory), and syncs out once. The budget equals the maximum single-block span, so the IRQ guard-band timing model is unchanged, and chains hard-stop at machine intercept PCs (BIOS IRQ-return sentinels, flash-HLE entry, RTC quirk returns) and HALTCNT halts.</p>`,
  ],
  // 5. Results table row: ~74% -> 99.9% + perf row.
  [
    `<tr><td>native coverage</td><td>share of executed instrs run as WASM</td><td class="ok">~74% (rest interpreted, all correct)</td></tr>
        <tr><td>full suite</td><td>16 test files</td><td class="ok">all passing, 0 failures</td></tr>`,
    `<tr><td>native coverage</td><td>share of executed instrs run as WASM (600-frame Ruby boot, 20.4M instrs)</td><td class="ok">99.9% &mdash; residue is 16 MSR/MRS + 6 SWI sites</td></tr>
        <tr><td>verify-gate rejections</td><td>differential first-run verification, 46M instrs (1200 frames)</td><td class="ok">0 rejected blocks</td></tr>
        <tr><td>wall-clock speed</td><td>600-frame Ruby boot, same machine</td><td class="ok">16.2s &rarr; 3.4s (4.8&times;) with chaining + O(1) schedulers + page-generation SMC guard</td></tr>
        <tr><td>full suite</td><td>16 test files</td><td class="ok">all passing, 0 failures</td></tr>`,
  ],
  // recompiler_diff count 11 -> 12 (added the per-misalignment rotation test)
  [
    `<tr><td><code>recompiler_diff.test.ts</code></td><td>ARM block lift vs interpreter</td><td class="ok">11 passed, 0 failed</td></tr>`,
    `<tr><td><code>recompiler_diff.test.ts</code></td><td>ARM block lift vs interpreter (incl. native unaligned-LDR rotation at every addr&amp;3)</td><td class="ok">12 passed, 0 failed</td></tr>`,
  ],
];

const files = [
  'docs/rom-to-wasm-process.html',
  'GBA_Ruby_Sapphire_ROM_to_WASM_Technical_Writeup.html',
  '../docs/rom-to-wasm-process.html',
  '../GBA_Ruby_Sapphire_ROM_to_WASM_Technical_Writeup.html',
];

for (const f of files) {
  if (!existsSync(f)) { console.log(`MISSING: ${f}`); continue; }
  let src = readFileSync(f, 'utf8');
  let applied = 0;
  for (const [find, replace] of edits) {
    if (src.includes(find)) { src = src.replace(find, replace); applied++; }
  }
  writeFileSync(f, src);
  console.log(`${f}: ${applied}/${edits.length} edits applied`);
}
