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

// ---- 1. audio.ts: adjustable output rate (dynamic rate control target) ----
patch('src/runtime/audio.ts', [
  [
    `  private output: number[] = [];`,
    `  /**
   * Effective output sample rate. Nominally OUT_HZ, but the frontend nudges it ±2% based on its
   * audio-queue depth (dynamic rate control). The producer (emulated time) and the consumer
   * (the real audio device clock) are different clocks; without feedback the queue drifts —
   * monotonically growing latency (audio lagging gameplay) or underruns. A ±2% rate trim is
   * inaudible and locks the queue to a fixed latency.
   */
  outHz = OUT_HZ;

  private output: number[] = [];`,
  ],
  [
    `    this.sampleAcc += cycles * OUT_HZ;`,
    `    this.sampleAcc += cycles * this.outHz;`,
  ],
]);

// ---- 2. main.ts: queue introspection + correct GBA frame pacing + rate control ----
patch('src/browser/main.ts', [
  [
    `  stop() { this.enabled = false; this.readIdx = this.writeIdx = this.queued = 0; }`,
    `  stop() { this.enabled = false; this.readIdx = this.writeIdx = this.queued = 0; }
  /** Stereo frames currently queued for the audio device (latency = queuedFrames / 44100 s). */
  get queuedFrames(): number { return this.queued >> 1; }`,
  ],
  [
    `    const frameMs = 1000 / 60;`,
    `    // EXACT GBA frame rate: 16,777,216 Hz / 280,896 cycles-per-frame = 59.7275 fps.
    // Pacing at a rounded 60 fps made the emulator produce +0.456% more emulated time (and thus
    // +0.456% more audio samples) than real time — the audio queue grew ~0.27 s of latency per
    // minute until the ring capped, which players observed as music drifting out of sync until a
    // pause/unpause drained the queue.
    const frameMs = 1000 / (16777216 / 280896);`,
  ],
  [
    `    if (budget > 0) { this.blit(); this.watchdog(); }`,
    `    if (budget > 0) { this.blit(); this.watchdog(); }
    // --- audio dynamic rate control ---
    // Lock the sink queue to ~93 ms by trimming the APU output rate ±2% (inaudible). This absorbs
    // every residual clock mismatch: display refresh != 60 Hz, audio-device crystal vs
    // performance.now() skew, rAF jitter, and pause/resume transients.
    if (this.audio.enabled && this.machine && this.speed === 1) {
      const TARGET = 4096; // stereo frames ≈ 93 ms at 44.1 kHz
      const err = Math.max(-1, Math.min(1, (TARGET - this.audio.queuedFrames) / TARGET));
      this.machine.audio.outHz = 44100 * (1 + 0.02 * err);
    } else if (this.machine) {
      this.machine.audio.outHz = 44100;
    }`,
  ],
]);

// ---- 3. debug.ts: live audio-queue telemetry in the IO tab (verify the fix visually) ----
patch('src/browser/debug.ts', [
  [
    `      <h4>Input</h4>`,
    `      <h4>Audio</h4>
      <div class="dbg-stat">
        <div class="r"><b>queue</b><span>\${this.fe.audio ? this.fe.audio.queuedFrames + ' fr · ' + ((this.fe.audio.queuedFrames / 44100) * 1000).toFixed(0) + ' ms' : '—'}</span></div>
        <div class="r"><b>APU rate</b><span>\${this.m.audio ? this.m.audio.outHz.toFixed(0) + ' Hz' : '—'}</span></div>
      </div>
      <h4>Input</h4>`,
  ],
]);

// ---- 4. index.html: cache-bust ----
patch('web/index.html', [
  [`./js/gba.js?v=20260610-debugger`, `./js/gba.js?v=20260610-audiosync`],
]);

console.log('audio-sync patches applied');
