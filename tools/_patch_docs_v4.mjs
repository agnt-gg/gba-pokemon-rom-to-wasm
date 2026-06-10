import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SECTION = `
      <h2>15 — The optimization campaign, measured</h2>
      <p class="lede">One working session took the recompiler from 64.6% native coverage at 16.2 s per 600-frame boot to 99.96% coverage at 3.4 s — a 4.8&times; end-to-end speedup with <strong>zero</strong> verification regressions across 46 million differentially-checked instructions. Every step below was driven by measurement, not intuition, and every claim is reproducible from <code>tools/recomp_coverage.ts</code> and the committed test suite.</p>

      <h3>Step 0 — measure before touching anything</h3>
      <p>The baseline run exposed the real problem immediately: of 3,495 THUMB block-start PCs, <strong>1,714 (49%) could not lift even their first instruction</strong>. Gen 3 functions open with <code>push {rN…, lr}</code>, load constants via <code>ldr rd, [pc, #imm]</code>, and read structs with word loads — all three were bail classes in the v1 lifter. A bail-reason telemetry histogram was added to block discovery <em>first</em>, so each subsequent lifter was aimed at the heaviest measured bucket rather than guessed at.</p>

      <table>
        <tr><th>Stage</th><th>Native coverage</th><th>600-frame wall time</th><th>What changed</th></tr>
        <tr><td>v1 baseline</td><td>64.6%</td><td>16,166 ms</td><td>conservative lifter: word-LDR, PUSH/POP, LDM/STM, BX, conditionals all bailed</td></tr>
        <tr><td>+ lifter v2</td><td class="ok">99.9%</td><td>7,326 ms</td><td>full THUMB + ARM instruction coverage incl. every rotation/quirk path (details below)</td></tr>
        <tr><td>+ profiler kills</td><td class="ok">99.9%</td><td>4,148 ms</td><td>three O(n)&rarr;O(1)/O(overflows) rewrites found by <code>--cpu-prof</code> (details below)</td></tr>
        <tr><td>+ block chaining</td><td class="ok">99.9%</td><td class="ok">3,415 ms</td><td>verified blocks run back-to-back in linear memory; one register sync per chain</td></tr>
        <tr><td>1200-frame validation</td><td class="ok">99.96%</td><td class="ok">6,956 ms (46.0M instrs)</td><td>residue is exactly 16 MSR/MRS sites + 6 SWI sites — nothing else interprets</td></tr>
      </table>
      <p>Block-population shift: 1,848 short blocks &rarr; 1,391 longer ones; THUMB null entries (un-liftable block starts) collapsed <strong>1,714 &rarr; 5</strong>, ARM nulls 123 &rarr; 8. The verify gate rejected <strong>0</strong> of the new blocks (v1 had 15 rejections — all traced to the late-bail emission bug fixed by the rollback discipline).</p>

      <h3>The profiler-driven kills</h3>
      <p>After the lifters landed, a V8 CPU profile showed the remaining time was <em>not</em> in guest execution at all. Each hotspot was rewritten as a complexity-class change, not a micro-tweak:</p>
      <table>
        <tr><th>Hotspot (profile share)</th><th>Was</th><th>Now</th></tr>
        <tr><td><code>cyclesUntilIrq</code> / frame-latch (13% + part of 21%)</td><td>scanned up to 228 scanlines through an IO-register getter <em>on every dispatch</em></td><td class="ok">closed-form O(1) modular arithmetic — identical results, property-checked against the scan</td></tr>
        <tr><td>timer stepping (8.6%)</td><td>per-CPU-cycle JS loop; Timer0 at prescaler 1 (the audio sample clock) ticked ~280,000 times per frame</td><td class="ok">bulk advance: O(overflows) per step, jumping counter math straight to each overflow</td></tr>
        <tr><td>store-block verification (8.0% + 4.5%)</td><td>byte-by-byte JS compare + 5 fresh typed-array allocations (~390 KB) per verified store block</td><td class="ok"><code>Buffer.compare</code> memcmp + two pooled snapshot buffers — same exactness, near-zero GC</td></tr>
        <tr><td>SMC guard on cache hits</td><td>FNV checksum over the block's code bytes on <em>every</em> RAM-block dispatch — O(blockLen)</td><td class="ok">O(1) page-generation stamps (256-byte pages, bumped by the bus on write), with a checksum <em>confirm</em> that re-stamps instead of recompiling when a data write merely shares the page</td></tr>
        <tr><td>dispatch overhead</td><td>syncIn + Map lookup + syncOut per block</td><td class="ok">verified blocks chain in linear memory under a 256-instruction budget — chosen to equal the existing max block span so the IRQ guard-band timing model is provably unchanged; chains hard-stop at machine intercept PCs and HALTCNT</td></tr>
      </table>
      <p>After all five, the profile shows the CPU side is done: the top entries are now the PPU renderer (~36%) — guest code itself has effectively vanished from the JS profile because it executes inside the WASM engine.</p>

      <h3>The correctness traps that had to be bit-exact</h3>
      <p>Coverage is the easy half. Each of these is a real ARM7TDMI behavior where a plausible-looking lift is <em>wrong</em>, and where the differential gate would have caught — and in several cases did catch — a naive implementation:</p>
      <table>
        <tr><th>Trap</th><th>Exact behavior the WASM must reproduce</th></tr>
        <tr><td>Unaligned word LDR</td><td><code>rotr(read32(addr &amp; ~3), 8*(addr &amp; 3))</code> — emitted branchless; proven for every <code>addr &amp; 3</code> by a dedicated differential test</td></tr>
        <tr><td>Unaligned LDRH</td><td>halfword loads rotate too: <code>rotr(read16(addr &amp; ~1), 8*(addr &amp; 1))</code></td></tr>
        <tr><td>Odd-address LDRSH</td><td>silently degrades to LDRSB (sign-extend the <em>byte</em>) — an ARM7 quirk, not a spec behavior</td></tr>
        <tr><td>LDM/STM empty rlist</td><td>transfers PC and adjusts the base by &plusmn;0x40 — the jsmolka suite tests this explicitly</td></tr>
        <tr><td>STM with base in rlist</td><td>stores the <em>post-writeback</em> base value unless the base is the lowest register listed</td></tr>
        <tr><td>SBC/RSC carry ordering</td><td>carry-out is computed against the <em>incoming</em> C flag; the lift must read OFF_CF for both the sum and the new flag before overwriting it — an ordering bug here is invisible until a borrow chain crosses it</td></tr>
        <tr><td>ADC 33-bit carry</td><td>two-step detection <code>(t &lt;u a) | (res &lt;u t)</code>, exact for a+b+cin without 64-bit math</td></tr>
        <tr><td>Shifter carry edge cases</td><td>LSR/ASR #0 mean #32; ROR #0 is RRX (33-bit rotate through carry); register shifts by 0 leave C untouched, by &ge;32 have their own table</td></tr>
        <tr><td>NEG flag quirk</td><td>the interpreter's C=(b==0), V=(b &amp; res)&gt;&gt;31 — mirrored verbatim, because the contract is the interpreter, not the manual</td></tr>
        <tr><td>PC-relative reads</td><td>ARM reads PC as +8, <em>except</em> register-specified shifts read +12; STR of PC stores +12; THUMB reads +4</td></tr>
        <tr><td>BX / POP {pc} interworking</td><td>the CPSR T bit is rewritten in linear memory so a mode switch propagates through syncOut and the dispatcher picks the other instruction-set cache — this is what lets chains cross THUMB&harr;ARM boundaries</td></tr>
        <tr><td>Late-bail emission</td><td>v1's "decide before emitting" convention was replaced by a mechanical snapshot/truncate of the CodeBuilder around every lift — partial emission became impossible by construction, and the 15 historical gate rejections went to zero</td></tr>
      </table>

      <h3>Why the numbers are trustworthy</h3>
      <p>Three independent mechanisms have to agree before any of this counts: (1) the jsmolka hardware-conformance ROMs report ALL PASS for ARM and THUMB <em>through the hybrid path</em>; (2) every compiled block's first execution is differentially replayed on the interpreter — registers, all four flags, and memory effects — with <strong>0 rejections across 46M instructions</strong>; (3) the 16-file regression suite (boot, 600-frame render, IRQ wake/LR semantics, flash sectors, RTC, PPU window/blend) stays green after every stage. The coverage and timing figures come from a committed, rerunnable tool — not from a one-off measurement.</p>
`;

function patch(file) {
  if (!existsSync(file)) { console.log('MISSING ' + file); return; }
  let src = readFileSync(file, 'utf8');
  let n = 0;
  // Insert the new section right before the roadmap, and renumber roadmap.
  for (const head of ['<h2>15 -- Roadmap</h2>', '<h2>15 — Roadmap</h2>', '<h2>15 &mdash; Roadmap</h2>']) {
    if (src.includes(head)) {
      src = src.replace(head, SECTION + '\n      ' + head.replace('15', '16'));
      n++;
      break;
    }
  }
  if (!n) console.log(`  WARN: roadmap anchor not found in ${file}`);
  writeFileSync(file, src);
  console.log(`patched ${file}: ${n}/1`);
}

patch('docs/rom-to-wasm-process.html');
patch('GBA_Ruby_Sapphire_ROM_to_WASM_Technical_Writeup.html');
console.log('docs v4 done');
