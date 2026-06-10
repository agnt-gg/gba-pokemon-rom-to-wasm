import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function patch(file, edits) {
  if (!existsSync(file)) { console.log('MISSING ' + file); return 0; }
  let src = readFileSync(file, 'utf8');
  let n = 0;
  for (const [find, replace] of edits) {
    if (src.includes(find)) { src = src.replace(find, replace); n++; }
    else console.log(`  (skip) not found in ${file}: ${find.slice(0, 60).replace(/\n/g, ' ')}...`);
  }
  writeFileSync(file, src);
  console.log(`patched ${file}: ${n}/${edits.length}`);
  return n;
}

// ---- README ----
patch('README.md', [
  [
    `- Browser frontend at \`web/index.html\``,
    `- Browser frontend at \`web/index.html\`
- **Live in-emulator debugger** (F9 or the ⛏ Debug button): all 16 registers + CPSR flags/mode with a live ARM/THUMB disassembly window around PC; JIT telemetry — cumulative and per-frame **native-WASM vs interpreted** instruction counts, coverage sparkline, blocks compiled/rejected, cache fill, SMC invalidations, bail-reason histogram, hottest native blocks by dispatch count, and an execution-weighted opcode mix; a full 128-sprite OAM atlas decoded live from VRAM/OAM/palette; and decoded MMIO (DISPCNT/DISPSTAT/IE/IF/IME/timers/DMA/keys) with the 512-entry palette. Strictly read-only, ~8 Hz refresh, zero cost while closed
- **Drift-free audio**: emulation paced at the exact GBA frame rate (16.777216 MHz / 280,896 cycles = 59.7275 fps, not a rounded 60), plus dynamic rate control that trims the APU output rate ±2% from audio-queue depth — locking latency at ~93 ms indefinitely instead of drifting out of sync over long play sessions`,
  ],
]);

// ---- Both writeup copies ----
const writeupEdits = [
  // Append observability + audio paragraphs after the verification/chaining paragraph.
  [
    `and chains hard-stop at machine intercept PCs (BIOS IRQ-return sentinels, flash-HLE entry, RTC quirk returns) and HALTCNT halts.</p>`,
    `and chains hard-stop at machine intercept PCs (BIOS IRQ-return sentinels, flash-HLE entry, RTC quirk returns) and HALTCNT halts.</p>

      <h3>Live observability: the in-emulator debugger</h3>
      <p>The browser frontend ships a read-only debugger drawer (F9) that makes the hybrid model <em>visible while playing</em>. A CPU tab shows all 16 registers, decoded CPSR flags/mode, and a live ARM/THUMB disassembly window around PC (a compact ARMv4T disassembler covering every ARM class and all 19 THUMB formats). A JIT tab shows the cumulative and <strong>per-frame split between engine-executed WASM and interpreted instructions</strong> with a coverage sparkline, block-engine counters (compiled / verify-rejected / cache fill / SMC invalidations), the live bail-reason histogram, the hottest native blocks ranked by a per-block dispatch counter, and an execution-weighted opcode mix. A sprite tab decodes the entire 128-entry OAM from live VRAM/OAM/palette (4bpp/8bpp, 1D/2D mapping, affine flagged), and an IO tab decodes DISPCNT/DISPSTAT/IE/IF/IME/timers/DMA/keys plus the full 512-color palette. Refresh is throttled to ~8&nbsp;Hz and costs nothing while closed.</p>

      <h3>Audio clocking: two clocks, one queue</h3>
      <p>A long-session audio desync traced to a clock mismatch, not the APU: the run loop paced emulation at a rounded 60&nbsp;fps while a real GBA frame is 280,896 cycles at 16.777216&nbsp;MHz = <strong>59.7275&nbsp;fps</strong>. The emulator generated +0.456% more emulated time (and samples) per real second than the 44.1&nbsp;kHz device consumed, so the audio queue gained ~0.27&nbsp;s of latency per minute until its cap &mdash; and pausing "fixed" it precisely because the device kept draining while production stopped. The fix is two-layered: pace at the exact frame rate, and apply <strong>dynamic rate control</strong> &mdash; the APU output rate is trimmed &plusmn;2% (inaudible) from the sink-queue depth each frame, locking latency at ~93&nbsp;ms and absorbing every residual skew (non-60&nbsp;Hz displays, audio-crystal vs <code>performance.now()</code> drift, rAF jitter, pause/resume transients). The debugger's IO tab displays the live queue depth and effective APU rate so the lock is verifiable.</p>`,
  ],
  // Results table: add the two new capabilities.
  [
    `<tr><td>full suite</td><td>16 test files</td><td class="ok">all passing, 0 failures</td></tr>`,
    `<tr><td>full suite</td><td>16 test files</td><td class="ok">all passing, 0 failures</td></tr>
        <tr><td>observability</td><td>in-emulator debugger (regs/disasm, JIT split, OAM atlas, MMIO)</td><td class="ok">live at ~8 Hz, read-only, zero cost closed</td></tr>
        <tr><td>audio stability</td><td>exact 59.7275 fps pacing + &plusmn;2% dynamic rate control</td><td class="ok">queue locked at ~93 ms; no long-session drift</td></tr>`,
  ],
];
patch('docs/rom-to-wasm-process.html', writeupEdits);
patch('GBA_Ruby_Sapphire_ROM_to_WASM_Technical_Writeup.html', writeupEdits);
console.log('docs v3 done');
