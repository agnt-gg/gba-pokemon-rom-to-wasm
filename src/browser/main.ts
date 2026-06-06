/**
 * Browser entry point for gba-recomp.
 *
 * Wraps GbaMachine with a canvas renderer, a requestAnimationFrame run loop, keyboard +
 * on-screen-button input, and ROM loading from a file picker. Exposes a tiny API on window.GBA
 * so the HTML shell can drive it (load, pause, reset, speed, screenshot).
 *
 * Bundled to web/js/gba.js with esbuild. No copyrighted assets are shipped — the user supplies
 * their own legally-owned ROM via the file picker (kept entirely in-browser, never uploaded).
 */

import { GbaMachine } from '../runtime/machine.ts';

const SCREEN_W = 240, SCREEN_H = 160;

// GBA KEYINPUT bit layout (1 = released). We build a "pressed" set then invert.
const KEY = {
  A: 0, B: 1, SELECT: 2, START: 3, RIGHT: 4, LEFT: 5, UP: 6, DOWN: 7, R: 8, L: 9,
} as const;

const DEFAULT_BINDINGS: Record<string, number> = {
  // Match the common VBA/No$GBA-style bindings: Z = A, X = B.
  KeyZ: KEY.A, KeyX: KEY.B, KeyA: KEY.L, KeyS: KEY.R,
  Enter: KEY.START, ShiftRight: KEY.SELECT, Backspace: KEY.SELECT,
  ArrowRight: KEY.RIGHT, ArrowLeft: KEY.LEFT, ArrowUp: KEY.UP, ArrowDown: KEY.DOWN,
};

class BrowserAudioSink {
  ctx: AudioContext | null = null;
  node: ScriptProcessorNode | null = null;
  private ring = new Float32Array(44100 * 2 * 2); // 2 seconds stereo
  private readIdx = 0;
  private writeIdx = 0;
  private queued = 0; // float samples, not frames
  enabled = false;
  volume = 0.75;

  private popSample(): number {
    if (this.queued <= 0) return 0;
    const v = this.ring[this.readIdx];
    this.readIdx = (this.readIdx + 1) % this.ring.length;
    this.queued--;
    return v;
  }

  private pushSample(v: number): void {
    if (this.queued >= this.ring.length) {
      // Drop oldest sample to keep latency bounded without O(n) array shifting.
      this.readIdx = (this.readIdx + 1) % this.ring.length;
      this.queued--;
    }
    this.ring[this.writeIdx] = v;
    this.writeIdx = (this.writeIdx + 1) % this.ring.length;
    this.queued++;
  }

  async start() {
    const AudioCtor = (window.AudioContext || (window as any).webkitAudioContext);
    if (!AudioCtor) throw new Error('Web Audio is not supported in this browser');
    if (!this.ctx) {
      this.ctx = new AudioCtor({ sampleRate: 44100 });
      this.node = this.ctx.createScriptProcessor(2048, 0, 2);
      this.node.onaudioprocess = (e) => {
        const l = e.outputBuffer.getChannelData(0), r = e.outputBuffer.getChannelData(1);
        for (let i = 0; i < l.length; i++) {
          l[i] = this.popSample() * this.volume;
          r[i] = this.popSample() * this.volume;
        }
      };
      this.node.connect(this.ctx.destination);
    }
    await this.ctx.resume();
    this.enabled = true;
  }
  stop() { this.enabled = false; this.readIdx = this.writeIdx = this.queued = 0; }
  push(samples: Float32Array) {
    if (!this.enabled || !samples.length) return;
    for (let i = 0; i < samples.length; i++) this.pushSample(samples[i]);
  }
}

class Frontend {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  machine: GbaMachine | null = null;
  private saveKey = '';
  private legacySaveKeys: string[] = [];
  private lastSaveFlush = 0;
  private lastDirtyState = false;
  pressed = new Set<number>();
  running = false;
  speed = 1;
  rafId = 0;
  fps = 0;
  private acc = 0;
  private lastT = 0;
  private frameCounter = 0;
  private fpsT = 0;
  // --- Stuck/crash watchdog state ---
  private wdLastDispcnt = -1;
  private wdLastFbSig = -1;
  private wdStuckFrames = 0;
  private wdReported = false;
  private wdVblankSeen = 0;
  audio = new BrowserAudioSink();
  onStatus: (s: string) => void = () => {};
  onFps: (n: number) => void = () => {};
  onSaveStatus: (s: string) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.canvas.width = SCREEN_W; this.canvas.height = SCREEN_H;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.ctx.imageSmoothingEnabled = false;
    this.image = this.ctx.createImageData(SCREEN_W, SCREEN_H);
  }

  loadRom(bytes: Uint8Array) {
    this.machine = new GbaMachine(bytes);
    const title = (this.machine as any).header?.title ?? 'UNKNOWN';
    const code = (this.machine as any).header?.gameCode ?? 'GAME';
    // v3 intentionally avoids persisted saves created by earlier broken RTC/Flash builds, which
    // can keep Ruby showing the stale "internal battery has run dry" warning even after RTC fixes.
    this.saveKey = `gba-save-v3:${code}:${title}`;
    this.legacySaveKeys = [`gba-save:${code}:${title}`, `gba-save-v2:${code}:${title}`];
    this.loadBatterySave();
    this.onStatus(`Loaded: ${title}`);
    this.frameCounter = 0;
    this.start();
  }

  reset() {
    if (!this.machine) return;
    // Re-create from the same ROM bytes (machine holds its rom internally).
    const rom = (this.machine as any).rom ?? (this.machine as any).mem?.rom;
    this.flushBatterySave(true);
    if (rom) { this.machine = new GbaMachine(rom); this.loadBatterySave(); }
    this.onStatus('Reset');
  }

  clearBatterySave() {
    const keys = [this.saveKey, ...this.legacySaveKeys].filter(Boolean);
    for (const k of keys) localStorage.removeItem(k);
    // Also remove any older AGNT/GBA save namespace for this game title/code if present.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i) || '';
      if (k.startsWith('gba-save')) localStorage.removeItem(k);
    }
    if (this.machine) { this.machine.flash.data.fill(0xff); this.machine.flash.dirty = false; }
    this.onStatus('All browser battery saves cleared; reload ROM');
  }

  exportBatterySave() {
    if (!this.machine) return;
    const blob = new Blob([this.machine.flash.data], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pokemon-ruby-flash-128k.sav';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.updateSaveStatus();
    this.onStatus(`Exported 128K Flash save (${this.countNonFF()} bytes written)`);
  }

  setKey(bit: number, down: boolean) {
    if (down) this.pressed.add(bit); else this.pressed.delete(bit);
  }

  private applyKeys() {
    if (!this.machine) return;
    let mask = 0x3ff;
    for (const bit of this.pressed) mask &= ~(1 << bit);
    this.machine.setKeys(mask);
  }

  start() { if (this.running) return; this.running = true; this.lastT = performance.now(); this.loop(this.lastT); }
  pause() { this.flushBatterySave(true); this.running = false; if (this.rafId) cancelAnimationFrame(this.rafId); }
  toggle() { this.running ? this.pause() : this.start(); }

  private loop = (t: number) => {
    if (!this.running || !this.machine) return;
    this.rafId = requestAnimationFrame(this.loop);
    const dt = t - this.lastT; this.lastT = t;
    // Target 60 fps emulated; speed multiplies frames per real second.
    this.acc += dt;
    const frameMs = 1000 / 60;
    let budget = Math.min(8, Math.floor((this.acc / frameMs) * this.speed));
    if (budget < 1 && this.acc >= frameMs) budget = 1;
    for (let i = 0; i < budget; i++) {
      this.applyKeys();
      this.machine.runFrame();
      this.audio.push(this.machine.audio.drainSamples(4096));
      this.flushBatterySave(false);
      if ((this.frameCounter & 31) === 0) this.updateSaveStatus();
      this.frameCounter++;
      this.acc -= frameMs;
      if (this.acc < 0) this.acc = 0;
    }
    if (budget > 0) { this.blit(); this.watchdog(); }
    // FPS meter
    this.frameCounter; this.fpsT += dt;
    if (this.fpsT >= 500) { this.onFps(Math.round((budget > 0 ? 1000 / (frameMs / this.speed) : 0))); this.fpsT = 0; }
  };

  /**
   * Stuck/crash detector. The player-profile screen and wild-encounter transitions were reported
   * to "crash" (freeze). We can't always reproduce that headlessly, so this records the exact CPU +
   * IO fingerprint the moment the screen stops progressing, and exposes it on window.__GBA_DIAG__
   * plus a one-line console summary. It is purely diagnostic: it never alters emulation.
   */
  private watchdog() {
    if (!this.machine) return;
    const m = this.machine as any;
    const dispcnt = m.io.get16(0x4000000) & 0xffff;
    // Cheap framebuffer signature: sample a sparse set of pixels.
    const fb = m.ppu.framebuffer;
    let sig = 0;
    for (let i = 0; i < fb.length; i += 997) sig = (sig * 31 + fb[i]) >>> 0;
    // A STATIC screen (trainer card, options, a paused textbox) is NOT a crash — the game is still
    // running, it just isn't animating. The earlier watchdog wrongly flagged those as freezes
    // because it only checked the framebuffer. The true test of "alive" is CPU liveness: how many
    // distinct code regions the emulated CPU visited last frame. A live game (even on a static
    // screen) runs its full task loop + VBlank handler = many distinct PCs; a genuine hang spins
    // over a tiny handful. We treat the game as ALIVE if it visited a healthy number of distinct PC
    // buckets, regardless of whether the picture changed.
    const liveness = (m.lastFrameLiveness | 0);
    const cpuAlive = liveness > 12; // empirically, real screens visit dozens+; a spin visits <5
    const progressed = dispcnt !== this.wdLastDispcnt || sig !== this.wdLastFbSig || cpuAlive;
    this.wdLastDispcnt = dispcnt; this.wdLastFbSig = sig;
    if (progressed) {
      // Screen is alive — reset the counter and clear any prior report so a NEW stall re-reports.
      this.wdStuckFrames = 0;
      if (this.wdReported) { this.wdReported = false; this.onStatus('Recovered — screen progressing again'); }
      return;
    }
    this.wdStuckFrames++;
    // ~3 seconds of zero visual progress at 60fps. Real idle screens (a paused textbox) also look
    // static, so we additionally require the CPU to be busy-spinning (not legitimately halted at a
    // menu waiting for input we aren't pressing). We approximate "the game thinks it should be
    // animating" by checking that a VBlank-wait is active but nothing on screen changes.
    if (this.wdStuckFrames === 180 && !this.wdReported) {
      this.wdReported = true;
      const st = m.cpu.st;
      const diag = {
        when: new Date().toISOString(),
        frame: this.frameCounter,
        pc: '0x' + (st.r[15] >>> 0).toString(16),
        lr: '0x' + (st.r[14] >>> 0).toString(16),
        sp: '0x' + (st.r[13] >>> 0).toString(16),
        cpsr: '0x' + (st.cpsr >>> 0).toString(16),
        thumb: !!(st.cpsr & 0x20),
        mode: (st.cpsr & 0x1f).toString(16),
        halted: !!m.cpu.halted,
        intrWaitActive: !!m.cpu.intrWaitActive,
        regs: Array.from({ length: 16 }, (_, i) => '0x' + (st.r[i] >>> 0).toString(16)),
        IE: '0x' + m.io.get16(0x4000200).toString(16),
        IF: '0x' + m.io.get16(0x4000202).toString(16),
        IME: '0x' + m.io.get16(0x4000208).toString(16),
        biosIF: '0x' + (m.mem.read16(0x03007ff8) & 0xffff).toString(16),
        userHandler: '0x' + (m.mem.read32(0x03007ffc) >>> 0).toString(16),
        DISPCNT: '0x' + dispcnt.toString(16),
        DISPSTAT: '0x' + m.io.get16(0x4000004).toString(16),
        VCOUNT: m.io.get16(0x4000006) & 0xff,
        BLDCNT: '0x' + m.io.get16(0x4000050).toString(16),
        BLDY: '0x' + m.io.get16(0x4000054).toString(16),
        MOSAIC: '0x' + m.io.get16(0x400004c).toString(16),
        DMA0CNT: '0x' + m.io.get16(0x40000ba).toString(16),
        DMA3CNT: '0x' + m.io.get16(0x40000de).toString(16),
      };
      (window as any).__GBA_DIAG__ = diag;
      // eslint-disable-next-line no-console
      console.warn('[gba] WATCHDOG: screen frozen ~3s. Fingerprint captured on window.__GBA_DIAG__:\n', diag);
      this.onStatus('\u26a0 Screen frozen — diagnostic captured (see console: __GBA_DIAG__)');
    }
  }

  private blit() {
    const fb = this.machine!.ppu.framebuffer;
    this.image.data.set(fb);
    this.ctx.putImageData(this.image, 0, 0);
  }

  private loadBatterySave() {
    if (!this.machine || !this.saveKey) return;
    try {
      const s = localStorage.getItem(this.saveKey);
      if (!s) { this.onStatus('Fresh battery save'); return; }
      const bin = atob(s);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      this.machine.flash.data.set(data.subarray(0, this.machine.flash.data.length));
      this.machine.flash.dirty = false;
      this.lastDirtyState = false;
      this.onStatus('Loaded battery save');
    } catch (e) { console.warn('Failed to load battery save', e); }
  }

  private countNonFF(): number {
    if (!this.machine) return 0;
    let n = 0;
    for (const b of this.machine.flash.data) if (b !== 0xff) n++;
    return n;
  }

  private updateSaveStatus() {
    if (!this.machine) return;
    this.onSaveStatus(`Flash: ${this.countNonFF()} bytes written | dirty=${this.machine.flash.dirty ? 'yes' : 'no'}`);
  }

  flushBatterySave(force: boolean) {
    if (!this.machine || !this.saveKey) return;
    const now = performance.now();
    this.lastDirtyState = this.machine.flash.dirty;
    // Do not synchronously localStorage-flush in the middle of the game's multi-sector save.
    // Ruby/Sapphire write many Flash bytes over multiple frames; flushing every dirty transition can
    // stall the browser main thread exactly while the save task is polling/verifying, making music
    // jitter and the game appear frozen. Only periodic background flushes are allowed; pause/reset/
    // unload/export still force-flush.
    if (!force && (!this.machine.flash.dirty || now - this.lastSaveFlush < 3000)) return;
    try {
      let s = '';
      const d = this.machine.flash.data;
      for (let i = 0; i < d.length; i += 0x8000) {
        s += String.fromCharCode(...d.subarray(i, Math.min(i + 0x8000, d.length)));
      }
      localStorage.setItem(this.saveKey, btoa(s));
      this.machine.flash.dirty = false;
      this.lastDirtyState = false;
      this.lastSaveFlush = now;
      this.updateSaveStatus();
      if (force) this.onStatus(`Battery save flushed (${this.countNonFF()} bytes written)`);
    } catch (e) { console.warn('Failed to persist battery save', e); }
  }

  async enableAudio() { await this.audio.start(); this.onStatus('Live game audio enabled'); }
  disableAudio() { this.audio.stop(); this.onStatus('Audio muted'); }
  screenshot(): string { return this.canvas.toDataURL('image/png'); }
}

// ---- Wire up DOM ----
function boot() {
  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const fe = new Frontend(canvas);
  const status = document.getElementById('status')!;
  const fpsEl = document.getElementById('fps')!;
  const saveStatusEl = document.getElementById('save-status')!;
  fe.onStatus = (s) => { status.textContent = s; };
  fe.onFps = (n) => { fpsEl.textContent = n > 0 ? `${n} fps` : ''; };
  fe.onSaveStatus = (s) => { saveStatusEl.textContent = s; };

  // ROM file picker.
  const picker = document.getElementById('rom') as HTMLInputElement;
  picker.addEventListener('change', async () => {
    const f = picker.files?.[0]; if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    fe.loadRom(buf);
  });

  // Drag & drop.
  document.body.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0]; if (!f) return;
    fe.loadRom(new Uint8Array(await f.arrayBuffer()));
  });

  // Keyboard.
  window.addEventListener('keydown', (e) => {
    const bit = DEFAULT_BINDINGS[e.code];
    if (bit !== undefined) { e.preventDefault(); fe.setKey(bit, true); }
    if (e.code === 'Space') { e.preventDefault(); fe.toggle(); }
  });
  window.addEventListener('keyup', (e) => {
    const bit = DEFAULT_BINDINGS[e.code];
    if (bit !== undefined) { e.preventDefault(); fe.setKey(bit, false); }
  });

  // On-screen buttons (data-key = bit index).
  document.querySelectorAll<HTMLElement>('[data-key]').forEach((el) => {
    const bit = parseInt(el.dataset.key!, 10);
    const down = (e: Event) => { e.preventDefault(); fe.setKey(bit, true); el.classList.add('active'); };
    const up = (e: Event) => { e.preventDefault(); fe.setKey(bit, false); el.classList.remove('active'); };
    el.addEventListener('mousedown', down); el.addEventListener('mouseup', up); el.addEventListener('mouseleave', up);
    el.addEventListener('touchstart', down, { passive: false }); el.addEventListener('touchend', up);
  });

  // Controls.
  document.getElementById('btn-pause')?.addEventListener('click', () => fe.toggle());
  document.getElementById('btn-reset')?.addEventListener('click', () => fe.reset());
  document.getElementById('btn-clear-save')?.addEventListener('click', () => fe.clearBatterySave());
  document.getElementById('btn-export-save')?.addEventListener('click', () => fe.exportBatterySave());
  document.getElementById('btn-audio')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-audio')!;
    try {
      if (!fe.audio.enabled) { await fe.enableAudio(); btn.textContent = '🔊 Audio On'; btn.classList.add('active'); }
      else { fe.disableAudio(); btn.textContent = '🔇 Audio Off'; btn.classList.remove('active'); }
    } catch (err: any) { status.textContent = 'Audio error: ' + (err?.message || err); }
  });
  window.addEventListener('beforeunload', () => fe.flushBatterySave(true));

  document.getElementById('btn-shot')?.addEventListener('click', () => {
    const a = document.createElement('a'); a.href = fe.screenshot(); a.download = 'gba-screenshot.png'; a.click();
  });
  const speedSel = document.getElementById('speed') as HTMLSelectElement | null;
  speedSel?.addEventListener('change', () => { fe.speed = parseFloat(speedSel.value); });

  (window as any).GBA = fe;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
