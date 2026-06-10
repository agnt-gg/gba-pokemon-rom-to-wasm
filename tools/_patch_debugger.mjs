import { readFileSync, writeFileSync } from 'node:fs';

function patch(file, edits, { global = false } = {}) {
  let src = readFileSync(file, 'utf8');
  for (const [find, replace] of edits) {
    if (!src.includes(find)) throw new Error(`NOT FOUND in ${file}: ${find.slice(0, 100)}`);
    src = global ? src.split(find).join(replace) : src.replace(find, replace);
  }
  writeFileSync(file, src);
  console.log('patched ' + file);
}

// ---- 1. recompiler.ts: per-block dispatch counter (debug/profiling) ----
patch('src/recompiler/recompiler.ts', [
  [
    `  /** Set once the first-run differential verification has passed for THIS compilation. */
  verified: boolean;`,
    `  /** Set once the first-run differential verification has passed for THIS compilation. */
  verified: boolean;
  /** Number of times this block has been dispatched natively (read by the debugger UI). */
  execs: number;`,
  ],
]);
patch('src/recompiler/recompiler.ts', [[`      verified: false,\n`, `      verified: false,\n      execs: 0,\n`]], { global: true });
patch('src/recompiler/recompiler.ts', [
  [
    `    let cur: CompiledBlock = block;
    for (;;) {
      nextPc = cur.fn() >>> 0;`,
    `    let cur: CompiledBlock = block;
    for (;;) {
      cur.execs++;
      nextPc = cur.fn() >>> 0;`,
  ],
  [
    `      block.verified = true;
      this.nativeInstrs += block.count;`,
    `      block.verified = true;
      block.execs++;
      this.nativeInstrs += block.count;`,
  ],
]);

// ---- 2. main.ts: onFrame hook + debug panel boot ----
patch('src/browser/main.ts', [
  [
    `import { GbaMachine } from '../runtime/machine.ts';`,
    `import { GbaMachine } from '../runtime/machine.ts';
import { DebugPanel } from './debug.ts';`,
  ],
  [
    `  onSaveStatus: (s: string) => void = () => {};`,
    `  onSaveStatus: (s: string) => void = () => {};
  /** Called after every emulated frame with the live machine (used by the debugger panel). */
  onFrame: (m: GbaMachine) => void = () => {};`,
  ],
  [
    `      this.machine.runFrame();
      this.audio.push(this.machine.audio.drainSamples(4096));`,
    `      this.machine.runFrame();
      this.onFrame(this.machine);
      this.audio.push(this.machine.audio.drainSamples(4096));`,
  ],
  [
    `  (window as any).GBA = fe;`,
    `  (window as any).GBA = fe;
  (window as any).GBA_DEBUG = new DebugPanel(fe);`,
  ],
]);

// ---- 3. index.html: toolbar button + cache-bust ----
patch('web/index.html', [
  [
    `<button class="ctl" id="btn-shot">⧉ Screenshot</button>`,
    `<button class="ctl" id="btn-shot">⧉ Screenshot</button>
      <button class="ctl" id="btn-debug" title="Live CPU/JIT/sprite/IO inspector (F9)">⛏ Debug</button>`,
  ],
  [
    `<script type="module" src="./js/gba.js?v=20260606-irqlrthumbfix"></script>`,
    `<script type="module" src="./js/gba.js?v=20260610-debugger"></script>`,
  ],
  [
    `<span><b>Arrows</b> D-Pad</span><span><b>Space</b> Pause</span>`,
    `<span><b>Arrows</b> D-Pad</span><span><b>Space</b> Pause</span><span><b>F9</b> Debugger</span>`,
  ],
]);

console.log('debugger patches applied');
