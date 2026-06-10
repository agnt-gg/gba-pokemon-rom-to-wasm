/**
 * Live in-emulator debugger drawer.
 *
 * Tabs:
 *   CPU      — all 16 registers, CPSR + decoded flags/mode, halted/IRQ state, and a live
 *              disassembly window around the current PC (ARM or THUMB picked from the T bit).
 *   JIT      — recompiler telemetry: cumulative + per-frame native(WASM)-vs-interpreted
 *              instruction counts, coverage sparkline, blocks compiled/rejected, cache sizes,
 *              SMC invalidations, bail-reason histogram, hottest native blocks by dispatch count,
 *              and an execution-weighted opcode/mnemonic histogram.
 *   Sprites  — OAM atlas: all 128 sprites decoded from VRAM/OAM with palette, plus an attribute
 *              table for the enabled ones.
 *   IO       — decoded MMIO (DISPCNT/DISPSTAT/VCOUNT/IE/IF/IME/keys/timers/DMA/BLDCNT) and the
 *              full BG+OBJ palette as a 512-swatch strip.
 *
 * Purely observational: reads machine state, never mutates it. Refresh is throttled (~8 Hz) and
 * skipped entirely while the drawer is closed, so gameplay cost is ~zero.
 */

import { disasmArm, disasmThumb, armMnemonic, thumbMnemonic } from './disasm.ts';

const MODES: Record<number, string> = {
  0x10: 'usr', 0x11: 'fiq', 0x12: 'irq', 0x13: 'svc', 0x17: 'abt', 0x1b: 'und', 0x1f: 'sys',
};
const IRQ_NAMES = ['VBlank', 'HBlank', 'VCount', 'Tm0', 'Tm1', 'Tm2', 'Tm3', 'Serial', 'DMA0', 'DMA1', 'DMA2', 'DMA3', 'Key', 'Cart'];

function hx(n: number, pad = 8): string { return (n >>> 0).toString(16).padStart(pad, '0'); }
function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

const CSS = `
#dbg-drawer{position:fixed;top:0;right:0;height:100vh;width:480px;max-width:96vw;z-index:60;
  background:linear-gradient(180deg,#13131d,#0e0e16);border-left:1px solid #2a2a40;
  box-shadow:-24px 0 60px rgba(0,0,0,.55);transform:translateX(102%);transition:transform .22s ease;
  display:flex;flex-direction:column;font-family:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  font-size:11.5px;color:#d6d6e4}
#dbg-drawer.open{transform:translateX(0)}
#dbg-drawer .dbg-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #23233a}
#dbg-drawer .dbg-head b{color:#12e0ff;font-size:13px;letter-spacing:.04em}
#dbg-drawer .dbg-head .x{margin-left:auto;cursor:pointer;color:#8b8ba3;border:1px solid #2a2a40;border-radius:6px;padding:2px 9px}
#dbg-drawer .dbg-head .x:hover{color:#fff;border-color:#12e0ff}
#dbg-tabs{display:flex;gap:4px;padding:8px 12px;border-bottom:1px solid #23233a}
#dbg-tabs button{background:#191926;border:1px solid #2a2a40;color:#9a9ab5;border-radius:8px;padding:5px 12px;cursor:pointer;font:inherit}
#dbg-tabs button.on{color:#04222a;background:#12e0ff;border-color:#12e0ff;font-weight:700}
#dbg-body{flex:1;overflow-y:auto;padding:12px 14px 24px}
#dbg-body h4{margin:14px 0 6px;color:#7d8aff;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
#dbg-body h4:first-child{margin-top:0}
.dbg-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:3px 10px}
.dbg-grid .r{display:flex;justify-content:space-between;background:#171724;border:1px solid #23233a;border-radius:6px;padding:3px 7px}
.dbg-grid .r b{color:#8b8ba3;font-weight:600}.dbg-grid .r span{color:#e7e7f0}
.dbg-grid .r.pc span{color:#ffd700}.dbg-grid .r.sp span{color:#12e0ff}.dbg-grid .r.lr span{color:#e53d8f}
.dbg-flags{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.dbg-flags .f{border:1px solid #2a2a40;border-radius:6px;padding:2px 9px;color:#5a5a72;background:#15151f}
.dbg-flags .f.on{color:#19ef83;border-color:#19ef8366;background:#19ef8311}
.dbg-dis{margin-top:6px;background:#0d0d15;border:1px solid #23233a;border-radius:8px;padding:6px 0;overflow-x:auto}
.dbg-dis .ln{display:flex;gap:12px;padding:1px 10px;white-space:pre}
.dbg-dis .ln.cur{background:#12e0ff1c;border-left:3px solid #12e0ff;padding-left:7px}
.dbg-dis .a{color:#5f6b8f}.dbg-dis .w{color:#46506e}.dbg-dis .m{color:#e7e7f0}
.dbg-dis .ln.cur .m{color:#12e0ff;font-weight:700}
.dbg-stat{display:grid;grid-template-columns:1fr 1fr;gap:3px 10px}
.dbg-stat .r{display:flex;justify-content:space-between;background:#171724;border:1px solid #23233a;border-radius:6px;padding:3px 8px}
.dbg-stat .r b{color:#8b8ba3;font-weight:600}
.dbg-bar{height:14px;border-radius:7px;background:#2b1230;overflow:hidden;border:1px solid #23233a;margin-top:6px;position:relative}
.dbg-bar i{display:block;height:100%;background:linear-gradient(90deg,#19ef83,#12e0ff)}
.dbg-bar span{position:absolute;inset:0;display:grid;place-items:center;font-size:10px;color:#04222a;font-weight:700;mix-blend-mode:plus-lighter;color:#fff}
canvas.dbg-spark{width:100%;height:42px;background:#0d0d15;border:1px solid #23233a;border-radius:8px;margin-top:6px}
table.dbg-t{width:100%;border-collapse:collapse;margin-top:4px}
table.dbg-t th{color:#7d8aff;text-align:left;font-weight:600;padding:2px 6px;border-bottom:1px solid #23233a;font-size:10.5px}
table.dbg-t td{padding:2px 6px;border-bottom:1px solid #1b1b2b;color:#cdd0e0}
table.dbg-t td.num{text-align:right;font-variant-numeric:tabular-nums}
.dbg-hist .row{display:flex;align-items:center;gap:8px;margin:2px 0}
.dbg-hist .lbl{width:54px;color:#cdd0e0}
.dbg-hist .bar{flex:1;height:10px;background:#171724;border-radius:5px;overflow:hidden}
.dbg-hist .bar i{display:block;height:100%;background:linear-gradient(90deg,#7d3de5,#e53d8f)}
.dbg-hist .pct{width:46px;text-align:right;color:#8b8ba3}
canvas#dbg-oam{width:100%;image-rendering:pixelated;background:
  repeating-conic-gradient(#15151f 0 25%,#1b1b2b 0 50%) 0 0/16px 16px;border:1px solid #23233a;border-radius:8px}
canvas#dbg-pal{width:100%;image-rendering:pixelated;border:1px solid #23233a;border-radius:8px}
.dbg-note{color:#5a5a72;margin-top:4px;font-size:10.5px}
#dbg-fab{position:fixed;right:16px;bottom:16px;z-index:59;background:#14141f;color:#12e0ff;border:1px solid #2a2a40;
  border-radius:999px;padding:10px 16px;cursor:pointer;font:700 13px ui-monospace,Menlo,monospace;box-shadow:0 8px 30px rgba(0,0,0,.5)}
#dbg-fab:hover{border-color:#12e0ff}
`;

export class DebugPanel {
  private fe: any;
  private m: any = null;
  private drawer!: HTMLElement;
  private body!: HTMLElement;
  private tab = 'cpu';
  private tick = 0;

  // per-frame instruction deltas (ring buffer of native-coverage fractions for the sparkline)
  private ring = new Float32Array(160);
  private ringN = 0;
  private lastTotal = 0;
  private lastNative = 0;
  private frameTotal = 0;
  private frameNative = 0;
  private histCache: { rows: [string, number][]; total: number } | null = null;

  constructor(fe: any) {
    this.fe = fe;
    fe.onFrame = (m: any) => this.frameTick(m);
    this.build();
    setInterval(() => this.refresh(), 125);
  }

  /** Called by the frontend after every emulated frame. O(1) — just delta bookkeeping. */
  frameTick(m: any) {
    this.m = m;
    const rec = m.recompiler;
    const t = m.instrCount || 0;
    const n = rec ? rec.nativeInstrs : 0;
    let dt = t - this.lastTotal, dn = n - this.lastNative;
    if (dt < 0 || dn < 0) { dt = 0; dn = 0; } // machine was reset/reloaded
    this.lastTotal = t; this.lastNative = n;
    this.frameTotal = dt; this.frameNative = dn;
    this.ring[this.ringN % this.ring.length] = dt > 0 ? dn / dt : 1;
    this.ringN++;
  }

  // ---------------------------------------------------------------- DOM ----
  private build() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.drawer = document.createElement('div');
    this.drawer.id = 'dbg-drawer';
    this.drawer.innerHTML = `
      <div class="dbg-head"><b>⛏ DEBUGGER</b>
        <span style="color:#5a5a72">live · read-only</span>
        <span class="x" id="dbg-close">✕</span></div>
      <div id="dbg-tabs">
        <button data-t="cpu" class="on">CPU</button>
        <button data-t="jit">JIT</button>
        <button data-t="spr">Sprites</button>
        <button data-t="io">IO</button>
      </div>
      <div id="dbg-body"></div>`;
    document.body.appendChild(this.drawer);
    this.body = this.drawer.querySelector('#dbg-body')!;

    this.drawer.querySelector('#dbg-close')!.addEventListener('click', () => this.toggle(false));
    this.drawer.querySelectorAll<HTMLButtonElement>('#dbg-tabs button').forEach((b) => {
      b.addEventListener('click', () => {
        this.tab = b.dataset.t!;
        this.drawer.querySelectorAll('#dbg-tabs button').forEach((x) => x.classList.toggle('on', x === b));
        this.histCache = null;
        this.body.innerHTML = '';
        this.refresh(true);
      });
    });

    const hook = document.getElementById('btn-debug');
    if (hook) hook.addEventListener('click', () => this.toggle());
    else {
      const fab = document.createElement('button');
      fab.id = 'dbg-fab';
      fab.textContent = '⛏ debug';
      fab.addEventListener('click', () => this.toggle());
      document.body.appendChild(fab);
    }
    window.addEventListener('keydown', (e) => { if (e.code === 'F9') { e.preventDefault(); this.toggle(); } });
  }

  toggle(force?: boolean) {
    const open = force !== undefined ? force : !this.drawer.classList.contains('open');
    this.drawer.classList.toggle('open', open);
    if (open) this.refresh(true);
  }

  // ------------------------------------------------------------- refresh ----
  private refresh(force = false) {
    if (!this.drawer.classList.contains('open')) return;
    if (!this.m) { this.body.innerHTML = '<div class="dbg-note">Load a ROM to inspect it.</div>'; return; }
    this.tick++;
    if (this.tab === 'cpu') this.renderCpu();
    else if (this.tab === 'jit') this.renderJit(force);
    else if (this.tab === 'spr') this.renderSprites();
    else this.renderIo();
  }

  /** Safe instruction read for disassembly — only from regions that have no read side effects. */
  private safeRead(addr: number, thumb: boolean): number | null {
    const region = (addr >>> 24) & 0xff;
    if (!(region <= 0x03 || (region >= 0x05 && region <= 0x0d))) return null;
    try { return thumb ? this.m.mem.read16(addr >>> 0) & 0xffff : this.m.mem.read32(addr >>> 0) >>> 0; }
    catch { return null; }
  }

  // ----------------------------------------------------------------- CPU ----
  private renderCpu() {
    const st = this.m.cpu.st;
    const cpsr = st.cpsr >>> 0;
    const thumb = !!(cpsr & 0x20);
    const pc = st.r[15] >>> 0;

    let regs = '';
    for (let i = 0; i < 16; i++) {
      const cls = i === 15 ? ' pc' : i === 13 ? ' sp' : i === 14 ? ' lr' : '';
      regs += `<div class="r${cls}"><b>${i === 13 ? 'sp' : i === 14 ? 'lr' : i === 15 ? 'pc' : 'r' + i}</b><span>${hx(st.r[i])}</span></div>`;
    }

    const flags = [
      ['N', cpsr & 0x80000000], ['Z', cpsr & 0x40000000], ['C', cpsr & 0x20000000], ['V', cpsr & 0x10000000],
      ['I·off', cpsr & 0x80], ['F·off', cpsr & 0x40], ['THUMB', cpsr & 0x20],
    ].map(([n, v]) => `<span class="f${v ? ' on' : ''}">${n}</span>`).join('');

    const step = thumb ? 2 : 4;
    const start = (pc - 9 * step) >>> 0;
    let dis = '';
    for (let k = 0; k < 22; k++) {
      const a = (start + k * step) >>> 0;
      const w = this.safeRead(a, thumb);
      const cur = a === pc ? ' cur' : '';
      if (w === null) { dis += `<div class="ln${cur}"><span class="a">${hx(a)}</span><span class="w">·</span><span class="m">??</span></div>`; continue; }
      const txt = thumb ? disasmThumb(w, a) : disasmArm(w, a);
      dis += `<div class="ln${cur}"><span class="a">${hx(a)}</span><span class="w">${hx(w, thumb ? 4 : 8)}</span><span class="m">${esc(txt)}</span></div>`;
    }

    this.body.innerHTML = `
      <h4>Registers</h4><div class="dbg-grid">${regs}</div>
      <h4>CPSR ${hx(cpsr)} · mode ${MODES[cpsr & 0x1f] || hx(cpsr & 0x1f, 2)} · ${this.m.cpu.halted ? '<span style="color:#ffd700">HALTED</span>' : 'running'}</h4>
      <div class="dbg-flags">${flags}</div>
      <h4>Disassembly · ${thumb ? 'THUMB' : 'ARM'} @ ${hx(pc)}</h4>
      <div class="dbg-dis">${dis}</div>
      <div class="dbg-note">instr #${(this.m.instrCount || 0).toLocaleString()} · pause (Space) to freeze a frame, F9 toggles this panel</div>`;
  }

  // ----------------------------------------------------------------- JIT ----
  private renderJit(force: boolean) {
    const rec = this.m.recompiler;
    if (!rec) { this.body.innerHTML = '<div class="dbg-note">Recompiler disabled.</div>'; return; }
    const total = this.m.instrCount || 0;
    const native = rec.nativeInstrs || 0;
    const interp = Math.max(0, total - native);
    const pct = total > 0 ? (native / total) * 100 : 0;
    const fPct = this.frameTotal > 0 ? (this.frameNative / this.frameTotal) * 100 : 100;

    let armB = 0, armN = 0, thmB = 0, thmN = 0;
    for (const v of rec.cache.values()) v ? armB++ : armN++;
    for (const v of rec.cacheThumb.values()) v ? thmB++ : thmN++;

    let bails = '';
    if (rec.bailReasons) {
      const rows = [...rec.bailReasons.entries()].sort((a: any, b: any) => b[1] - a[1]).slice(0, 8);
      bails = rows.map(([k, v]: any) => `<div class="r"><b>${esc(k)}</b><span>${v}</span></div>`).join('');
    }

    // Hot blocks + execution-weighted mnemonic histogram (throttled — every ~1s).
    if (force || !this.histCache || this.tick % 8 === 0) this.computeHist(rec);
    const hot = this.hotBlocks(rec, 10).map((h) =>
      `<tr><td>${hx(h.pc)}</td><td>${h.thumb ? 'T' : 'A'}</td><td class="num">${h.count}</td>` +
      `<td class="num">${h.execs.toLocaleString()}</td><td class="num">${(h.execs * h.count).toLocaleString()}</td></tr>`).join('');

    let hist = '';
    if (this.histCache && this.histCache.total > 0) {
      const max = this.histCache.rows[0]?.[1] || 1;
      hist = this.histCache.rows.map(([mn, w]) =>
        `<div class="row"><span class="lbl">${esc(mn)}</span><span class="bar"><i style="width:${(w / max) * 100}%"></i></span>` +
        `<span class="pct">${((w / this.histCache!.total) * 100).toFixed(1)}%</span></div>`).join('');
    }

    this.body.innerHTML = `
      <h4>Native WASM vs interpreter · cumulative</h4>
      <div class="dbg-stat">
        <div class="r"><b>total instrs</b><span>${total.toLocaleString()}</span></div>
        <div class="r"><b>native (WASM)</b><span style="color:#19ef83">${native.toLocaleString()}</span></div>
        <div class="r"><b>interpreted</b><span style="color:#e53d8f">${interp.toLocaleString()}</span></div>
        <div class="r"><b>coverage</b><span>${pct.toFixed(2)}%</span></div>
      </div>
      <div class="dbg-bar"><i style="width:${pct}%"></i><span>${pct.toFixed(2)}% native</span></div>
      <h4>This frame</h4>
      <div class="dbg-stat">
        <div class="r"><b>instrs/frame</b><span>${this.frameTotal.toLocaleString()}</span></div>
        <div class="r"><b>native/frame</b><span style="color:#19ef83">${this.frameNative.toLocaleString()}</span></div>
        <div class="r"><b>interp/frame</b><span style="color:#e53d8f">${(this.frameTotal - this.frameNative).toLocaleString()}</span></div>
        <div class="r"><b>frame coverage</b><span>${fPct.toFixed(2)}%</span></div>
      </div>
      <canvas class="dbg-spark" id="dbg-spark" width="320" height="42"></canvas>
      <div class="dbg-note">native coverage per frame · last ${this.ring.length} frames</div>
      <h4>Block engine</h4>
      <div class="dbg-stat">
        <div class="r"><b>blocks compiled</b><span>${rec.blocksCompiled}</span></div>
        <div class="r"><b>verify rejections</b><span>${rec.blocksRejected}</span></div>
        <div class="r"><b>ARM cache (blk/nil)</b><span>${armB}/${armN}</span></div>
        <div class="r"><b>THUMB cache (blk/nil)</b><span>${thmB}/${thmN}</span></div>
        <div class="r"><b>SMC invalidations</b><span>${rec.smcInvalidations || 0}</span></div>
        <div class="r"><b>verify gate</b><span>${rec.verifyFirstRun ? 'on' : 'off'}</span></div>
      </div>
      ${bails ? `<h4>Bail reasons (block discovery)</h4><div class="dbg-stat">${bails}</div>` : ''}
      <h4>Hottest native blocks</h4>
      <table class="dbg-t"><tr><th>PC</th><th>set</th><th>instrs</th><th>dispatches</th><th>~instrs run</th></tr>${hot}</table>
      <h4>Opcode mix · execution-weighted</h4>
      <div class="dbg-hist">${hist || '<div class="dbg-note">warming up…</div>'}</div>`;

    // sparkline
    const cv = this.body.querySelector<HTMLCanvasElement>('#dbg-spark')!;
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, cv.width, cv.height);
    const n = Math.min(this.ringN, this.ring.length);
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const v = this.ring[(this.ringN - n + i) % this.ring.length];
      const x = (i / (this.ring.length - 1)) * cv.width;
      const y = cv.height - 2 - v * (cv.height - 6);
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.strokeStyle = '#19ef83'; g.lineWidth = 1.5; g.stroke();
    g.strokeStyle = '#2a2a40'; g.beginPath(); g.moveTo(0, cv.height - 2); g.lineTo(cv.width, cv.height - 2); g.stroke();
  }

  private hotBlocks(rec: any, n: number) {
    const out: { pc: number; thumb: boolean; count: number; execs: number }[] = [];
    for (const [pc, v] of rec.cache) if (v && v.execs) out.push({ pc, thumb: false, count: v.count, execs: v.execs });
    for (const [pc, v] of rec.cacheThumb) if (v && v.execs) out.push({ pc, thumb: true, count: v.count, execs: v.execs });
    out.sort((a, b) => b.execs * b.count - a.execs * a.count);
    return out.slice(0, n);
  }

  private computeHist(rec: any) {
    const hot = this.hotBlocks(rec, 48);
    const map = new Map<string, number>();
    let total = 0;
    for (const h of hot) {
      for (let i = 0; i < h.count; i++) {
        const a = (h.pc + i * (h.thumb ? 2 : 4)) >>> 0;
        const w = this.safeRead(a, h.thumb);
        if (w === null) continue;
        const mn = h.thumb ? thumbMnemonic(w) : armMnemonic(w);
        map.set(mn, (map.get(mn) || 0) + h.execs);
        total += h.execs;
      }
    }
    const rows = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
    this.histCache = { rows, total };
  }

  // ------------------------------------------------------------- Sprites ----
  private renderSprites() {
    const mem = this.m.mem;
    const io = this.m.io;
    const dispcnt = io.get16(0x4000000) & 0xffff;
    const map1D = !!(dispcnt & 0x40);
    const bitmapMode = (dispcnt & 7) >= 3;

    if (!this.body.querySelector('#dbg-oam')) {
      this.body.innerHTML = `
        <h4>OAM atlas · 128 sprites <span style="color:#5a5a72">(mapping: ${map1D ? '1D' : '2D'}, OBJ ${dispcnt & 0x1000 ? 'on' : 'OFF'})</span></h4>
        <canvas id="dbg-oam" width="320" height="640"></canvas>
        <div class="dbg-note">each cell = one OAM entry (fit to 32px) · dimmed = disabled · ring = affine (drawn untransformed)</div>
        <h4>Enabled sprites</h4><div id="dbg-oam-table"></div>`;
    }
    const cv = this.body.querySelector<HTMLCanvasElement>('#dbg-oam')!;
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, cv.width, cv.height);

    const SIZES: number[][][] = [
      [[8, 8], [16, 16], [32, 32], [64, 64]],
      [[16, 8], [32, 8], [32, 16], [64, 32]],
      [[8, 16], [8, 32], [16, 32], [32, 64]],
    ];
    const oam: Uint8Array = mem.oam, vram: Uint8Array = mem.vram, pal: Uint8Array = mem.palette;
    const pal16 = (off: number) => (pal[0x200 + off * 2] | (pal[0x200 + off * 2 + 1] << 8)) & 0x7fff;
    const rgb = (c: number) => [(c & 31) << 3, ((c >> 5) & 31) << 3, ((c >> 10) & 31) << 3];

    let rows = '';
    let shown = 0;
    for (let s = 0; s < 128; s++) {
      const a0 = oam[s * 8] | (oam[s * 8 + 1] << 8);
      const a1 = oam[s * 8 + 2] | (oam[s * 8 + 3] << 8);
      const a2 = oam[s * 8 + 4] | (oam[s * 8 + 5] << 8);
      const affine = !!(a0 & 0x100);
      const disabled = !affine && !!(a0 & 0x200);
      const shape = (a0 >> 14) & 3;
      const size = (a1 >> 14) & 3;
      const [w, h] = (SIZES[shape] || SIZES[0])[size];
      const color256 = !!(a0 & 0x2000);
      const tile = a2 & 0x3ff;
      const palBank = (a2 >> 12) & 15;

      const cellX = (s % 8) * 40 + 4, cellY = (s >> 3) * 40 + 4;
      const scale = Math.max(w, h) / 32;
      const img = g.createImageData(Math.min(32, Math.ceil(w / scale)), Math.min(32, Math.ceil(h / scale)));
      const stride = img.width;
      for (let py = 0; py < img.height; py++) {
        for (let px = 0; px < stride; px++) {
          const sx = Math.min(w - 1, Math.floor(px * scale));
          const sy = Math.min(h - 1, Math.floor(py * scale));
          const tx = sx >> 3, ty = sy >> 3, fx = sx & 7, fy = sy & 7;
          let ci = 0;
          if (color256) {
            const tn = (tile + (map1D ? ty * (w >> 3) * 2 : ty * 32) + tx * 2) & 0x3ff;
            if (!bitmapMode || tn >= 512) ci = vram[(0x10000 + tn * 32 + fy * 8 + fx) % vram.length];
          } else {
            const tn = (tile + (map1D ? ty * (w >> 3) : ty * 32) + tx) & 0x3ff;
            if (!bitmapMode || tn >= 512) {
              const b = vram[(0x10000 + tn * 32 + fy * 4 + (fx >> 1)) % vram.length];
              ci = (fx & 1) ? (b >> 4) : (b & 15);
              if (ci) ci += palBank * 16;
            }
          }
          const o = (py * stride + px) * 4;
          if (ci === 0) { img.data[o + 3] = 0; continue; }
          const [r, gg, b] = rgb(pal16(ci));
          img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = disabled ? 70 : 255;
        }
      }
      g.putImageData(img, cellX + ((32 - stride) >> 1), cellY + ((32 - img.height) >> 1));
      if (affine) { g.strokeStyle = '#ffd700'; g.strokeRect(cellX - 1.5, cellY - 1.5, 35, 35); }

      if (!disabled && shown < 28) {
        shown++;
        let x = a1 & 0x1ff; if (x >= 240 && x >= 256) x -= 512;
        let y = a0 & 0xff; if (y >= 160) y -= 256;
        rows += `<tr><td>${s}</td><td class="num">${x},${y}</td><td class="num">${w}×${h}</td>` +
          `<td class="num">${tile}</td><td class="num">${color256 ? '256' : 'p' + palBank}</td>` +
          `<td class="num">${(a2 >> 10) & 3}</td><td>${affine ? 'aff' : ''}${(a1 & 0x1000) && !affine ? ' fH' : ''}${(a1 & 0x2000) && !affine ? ' fV' : ''}${(a0 >> 10) & 3 ? ' m' + ((a0 >> 10) & 3) : ''}</td></tr>`;
      }
    }
    this.body.querySelector('#dbg-oam-table')!.innerHTML =
      `<table class="dbg-t"><tr><th>#</th><th>x,y</th><th>size</th><th>tile</th><th>pal</th><th>pri</th><th>flags</th></tr>${rows}</table>`;
  }

  // ------------------------------------------------------------------ IO ----
  private renderIo() {
    const io = this.m.io;
    const mem = this.m.mem;
    const g16 = (a: number) => io.get16(a) & 0xffff;
    const dispcnt = g16(0x4000000), dispstat = g16(0x4000004);
    const ie = g16(0x4000200), ifr = g16(0x4000202), ime = g16(0x4000208);
    const keys = g16(0x4000130);

    const irqList = (mask: number) => IRQ_NAMES.filter((_, i) => mask & (1 << i)).join(' ') || '—';
    const bgs = [0, 1, 2, 3].map((n) => (dispcnt & (0x100 << n)) ? `BG${n}` : null).filter(Boolean).join(' ');
    const keyNames = ['A', 'B', 'Sel', 'St', '→', '←', '↑', '↓', 'R', 'L'];
    const pressed = keyNames.filter((_, i) => !(keys & (1 << i))).join(' ') || '—';

    let timers = '';
    for (let t = 0; t < 4; t++) {
      const cnt = g16(0x4000100 + t * 4), ctl = g16(0x4000102 + t * 4);
      timers += `<div class="r"><b>TM${t}</b><span>${hx(cnt, 4)} ${ctl & 0x80 ? 'on' : 'off'}${ctl & 4 ? ' casc' : ''}${ctl & 0x40 ? ' irq' : ''}</span></div>`;
    }

    this.body.innerHTML = `
      <h4>Display</h4>
      <div class="dbg-stat">
        <div class="r"><b>DISPCNT</b><span>${hx(dispcnt, 4)} · mode ${dispcnt & 7}</span></div>
        <div class="r"><b>layers</b><span>${bgs}${dispcnt & 0x1000 ? ' OBJ' : ''}</span></div>
        <div class="r"><b>DISPSTAT</b><span>${hx(dispstat, 4)}${dispstat & 1 ? ' VBL' : ''}${dispstat & 2 ? ' HBL' : ''}</span></div>
        <div class="r"><b>VCOUNT</b><span>${g16(0x4000006) & 0xff}</span></div>
        <div class="r"><b>BLDCNT</b><span>${hx(g16(0x4000050), 4)}</span></div>
        <div class="r"><b>OBJ map</b><span>${dispcnt & 0x40 ? '1D' : '2D'}</span></div>
      </div>
      <h4>Interrupts</h4>
      <div class="dbg-stat">
        <div class="r"><b>IME</b><span>${ime & 1 ? 'on' : 'OFF'}</span></div>
        <div class="r"><b>BIOS IF</b><span>${hx(mem.read16(0x03007ff8) & 0xffff, 4)}</span></div>
        <div class="r" style="grid-column:1/-1"><b>IE</b><span>${irqList(ie)}</span></div>
        <div class="r" style="grid-column:1/-1"><b>IF</b><span>${irqList(ifr)}</span></div>
        <div class="r" style="grid-column:1/-1"><b>handler</b><span>${hx(mem.read32(0x03007ffc))}</span></div>
      </div>
      <h4>Timers · DMA</h4>
      <div class="dbg-stat">${timers}
        <div class="r"><b>DMA3</b><span>${hx(g16(0x40000de), 4)}</span></div>
        <div class="r"><b>DMA0</b><span>${hx(g16(0x40000ba), 4)}</span></div>
      </div>
      <h4>Input</h4>
      <div class="dbg-stat"><div class="r" style="grid-column:1/-1"><b>pressed</b><span>${pressed}</span></div></div>
      <h4>Palette · BG 0-255 then OBJ 256-511</h4>
      <canvas id="dbg-pal" width="256" height="128"></canvas>`;

    const cv = this.body.querySelector<HTMLCanvasElement>('#dbg-pal')!;
    const g = cv.getContext('2d')!;
    const img = g.createImageData(256, 128);
    const pal: Uint8Array = mem.palette;
    for (let i = 0; i < 512; i++) {
      const c = (pal[i * 2] | (pal[i * 2 + 1] << 8)) & 0x7fff;
      const r = (c & 31) << 3, gg = ((c >> 5) & 31) << 3, b = ((c >> 10) & 31) << 3;
      const cx = (i % 32) * 8, cy = (i >> 5) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const o = ((cy + y) * 256 + cx + x) * 4;
        img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }
}
