/**
 * GBA PPU (Picture Processing Unit).
 *
 * Responsibilities, in bring-up priority:
 *   1. Scanline TIMING: drive VCOUNT (0..227), set HBlank/VBlank bits in DISPSTAT, and raise
 *      the VBlank/HBlank/VCount-match interrupts. This is what unblocks games that poll VCOUNT
 *      or VBlankIntrWait — exactly where Pokemon Ruby currently waits.
 *   2. Mode 0 RENDERING: 4 tiled text backgrounds + 128 sprites with priority. This covers the
 *      overworld, menus, and most of Pokemon. Affine modes (1/2) and bitmap modes (3/4/5) come
 *      later; Pokemon uses them rarely.
 *
 * Display: 240x160. A frame is 228 scanlines (160 visible + 68 vblank); each scanline is
 * 1232 CPU cycles (960 visible + 272 hblank). The runtime calls step(cycles) and we emit a
 * full RGBA framebuffer at end of frame.
 */

import type { GbaMemory } from './memory.ts';
import { GbaIo, REG } from './io.ts';

const SCREEN_W = 240, SCREEN_H = 160;
const CYCLES_PER_SCANLINE = 1232;
const HDRAW_CYCLES = 960;
const TOTAL_SCANLINES = 228;

// DISPSTAT bits
const DS_VBLANK = 1 << 0;
const DS_HBLANK = 1 << 1;
const DS_VCOUNT = 1 << 2;
const DS_VBLANK_IRQ = 1 << 3;
const DS_HBLANK_IRQ = 1 << 4;
const DS_VCOUNT_IRQ = 1 << 5;

// IRQ bits (IE/IF)
export const IRQ_VBLANK = 1 << 0;
export const IRQ_HBLANK = 1 << 1;
export const IRQ_VCOUNT = 1 << 2;

export class GbaPpu {
  mem: GbaMemory;
  io: GbaIo;
  framebuffer = new Uint8Array(SCREEN_W * SCREEN_H * 4);
  frameReady = false;

  private scanlineCycles = 0;
  private inHblank = false;
  private colorLine = new Uint16Array(SCREEN_W);
  private priLine = new Uint8Array(SCREEN_W);
  private drawnLine = new Uint8Array(SCREEN_W);
  // Layer id of the top-most pixel: 0-3 = BG0-3, 4 = OBJ, 5 = backdrop.
  private topLayer = new Uint8Array(SCREEN_W);
  // Second-from-top color/layer for alpha blending (target B).
  private subColor = new Uint16Array(SCREEN_W);
  private subLayer = new Uint8Array(SCREEN_W);
  // OBJ window mask + per-OBJ semi-transparent flag for the current scanline.
  private objWinMask = new Uint8Array(SCREEN_W);
  private objSemiTrans = new Uint8Array(SCREEN_W);

  // Interrupt request callback (set by runtime). Bits per IRQ_* above.
  requestIrq: (bits: number) => void = () => {};
  // Called at the start of each HBlank (visible lines) so the runtime can run HBlank DMA.
  onHblank: (line: number) => void = () => {};
  onVblank: () => void = () => {};

  constructor(mem: GbaMemory, io: GbaIo) { this.mem = mem; this.io = io; }

  get vcount(): number { return this.io.get16(REG.VCOUNT) & 0xff; }

  /** Advance the PPU by `cycles` CPU cycles. */
  step(cycles: number): void {
    this.scanlineCycles += cycles;

    // Enter HBlank.
    if (!this.inHblank && this.scanlineCycles >= HDRAW_CYCLES) {
      this.inHblank = true;
      const line = this.vcount;
      if (line < SCREEN_H) {
        this.renderScanline(line);
        this.onHblank(line);
      }
      let ds = this.io.get16(REG.DISPSTAT);
      ds |= DS_HBLANK;
      this.io.set16(REG.DISPSTAT, ds);
      if (ds & DS_HBLANK_IRQ) this.requestIrq(IRQ_HBLANK);
    }

    // End of scanline.
    if (this.scanlineCycles >= CYCLES_PER_SCANLINE) {
      this.scanlineCycles -= CYCLES_PER_SCANLINE;
      this.inHblank = false;
      let line = this.vcount + 1;
      if (line >= TOTAL_SCANLINES) line = 0;
      this.io.set16(REG.VCOUNT, line);

      let ds = this.io.get16(REG.DISPSTAT) & ~DS_HBLANK;

      // VCount match.
      const lyc = (ds >> 8) & 0xff;
      if (line === lyc) { ds |= DS_VCOUNT; if (ds & DS_VCOUNT_IRQ) this.requestIrq(IRQ_VCOUNT); }
      else ds &= ~DS_VCOUNT;

      // VBlank start at line 160.
      if (line === SCREEN_H) {
        ds |= DS_VBLANK;
        if (ds & DS_VBLANK_IRQ) this.requestIrq(IRQ_VBLANK);
        this.onVblank();
        this.frameReady = true;
      } else if (line === 0) {
        ds &= ~DS_VBLANK;
      }
      this.io.set16(REG.DISPSTAT, ds);
    }
  }

  // ---- rendering ----
  private putPixel(x: number, y: number, rgb15: number): void {
    const o = (y * SCREEN_W + x) * 4;
    const r = (rgb15 & 0x1f) << 3, g = ((rgb15 >> 5) & 0x1f) << 3, b = ((rgb15 >> 10) & 0x1f) << 3;
    this.framebuffer[o] = r | (r >> 5);
    this.framebuffer[o + 1] = g | (g >> 5);
    this.framebuffer[o + 2] = b | (b >> 5);
    this.framebuffer[o + 3] = 255;
  }

  private renderScanline(line: number): void {
    const dispcnt = this.io.get16(REG.DISPCNT);
    const mode = dispcnt & 0x7;
    const backdrop = this.mem.pal16(0);

    // Per-pixel: track best (lowest) priority and whether a pixel was drawn. Reuse these buffers;
    // allocating three typed arrays for every visible scanline creates long-run GC/audio stutter.
    const colorLine = this.colorLine;
    const priLine = this.priLine;
    const drawn = this.drawnLine;
    drawn.fill(0);
    this.topLayer.fill(5); // backdrop
    this.subLayer.fill(5);
    this.objWinMask.fill(0);
    this.objSemiTrans.fill(0);
    for (let x = 0; x < SCREEN_W; x++) { colorLine[x] = backdrop; priLine[x] = 5; this.subColor[x] = backdrop; }

    if (mode === 0 || mode === 1 || mode === 2) {
      // Draw tiled BGs from lowest priority value drawn last so higher-priority overwrites.
      // Mode 1: BG0/BG1 text, BG2 affine. Mode 2: BG2/BG3 affine. Rendering affine BGs as text
      // produces obvious garbage on Ruby's intro/loading screens, so route them correctly.
      for (let pr = 3; pr >= 0; pr--) {
        for (let bg = 3; bg >= 0; bg--) {
          if (!(dispcnt & (0x100 << bg))) continue;
          const bgcnt = this.io.get16(REG.BG0CNT + bg * 2);
          if ((bgcnt & 3) !== pr) continue;
          const affine = (mode === 1 && bg === 2) || (mode === 2 && (bg === 2 || bg === 3));
          if (affine) this.renderAffineBg(line, bg, bgcnt, colorLine, priLine, drawn);
          else if (mode === 0 || bg < 2) this.renderTextBg(line, bg, bgcnt, colorLine, priLine, drawn);
        }
      }
    } else if (mode === 3) {
      // 16-bit bitmap.
      const base = 0x0000;
      for (let x = 0; x < SCREEN_W; x++) { const off = base + (line * SCREEN_W + x) * 2; colorLine[x] = this.mem.vram16(off); drawn[x] = 1; }
    } else if (mode === 4) {
      const frame = (dispcnt & 0x10) ? 0xa000 : 0x0000;
      for (let x = 0; x < SCREEN_W; x++) { const idx = this.mem.vram[frame + line * SCREEN_W + x]; if (idx) { colorLine[x] = this.mem.pal16(idx * 2); drawn[x] = 1; } }
    } else if (mode === 5) {
      // 160x128 16-bit bitmap. Used by some card/profile-style screens.
      const frame = (dispcnt & 0x10) ? 0xa000 : 0x0000;
      if (line < 128) {
        for (let x = 0; x < 160; x++) {
          const off = frame + (line * 160 + x) * 2;
          colorLine[x] = this.mem.vram16(off);
          drawn[x] = 1;
        }
      }
    }

    // Sprites (OBJ) — drawn if enabled. Lower priority value wins over BG of equal/greater value.
    // Semi-transparent OBJ (OBJ mode 1) needs the current BG pixel as its blend target, so pass
    // the current composed line instead of treating it as an opaque sprite.
    if (dispcnt & 0x1000) this.renderSprites(line, dispcnt, colorLine, priLine, drawn);

    // Window-aware color special effects (BLDCNT). Pokemon menus draw the selection highlight by
    // enabling Window 0 over the selected row and applying a BLDCNT brightness effect everywhere
    // outside the window, so the chosen row stays bright while the rest dims. Without window +
    // color-effect support the highlight is invisible.
    this.applyColorEffects(line, dispcnt, colorLine);

    for (let x = 0; x < SCREEN_W; x++) this.putPixel(x, line, colorLine[x]);
  }

  private applyColorEffects(line: number, dispcnt: number, colorLine: Uint16Array): void {
    const win0On = (dispcnt & 0x2000) !== 0;
    const win1On = (dispcnt & 0x4000) !== 0;
    const winObjOn = (dispcnt & 0x8000) !== 0;
    const bldcnt = this.io.get16(REG.BLDCNT);
    const effect = (bldcnt >> 6) & 3; // 0=none 1=alpha 2=brighten 3=darken
    const anyWindow = win0On || win1On || winObjOn;
    if (effect === 0) return;

    const win0h = this.io.get16(REG.WIN0H), win0v = this.io.get16(REG.WIN0V);
    const win1h = this.io.get16(REG.WIN1H), win1v = this.io.get16(REG.WIN1V);
    const w0x1 = win0h >> 8; let w0x2 = win0h & 0xff; if (w0x2 > SCREEN_W || w0x2 < w0x1) w0x2 = SCREEN_W;
    const w0y1 = win0v >> 8; let w0y2 = win0v & 0xff; if (w0y2 > SCREEN_H || w0y2 < w0y1) w0y2 = SCREEN_H;
    const w1x1 = win1h >> 8; let w1x2 = win1h & 0xff; if (w1x2 > SCREEN_W || w1x2 < w1x1) w1x2 = SCREEN_W;
    const w1y1 = win1v >> 8; let w1y2 = win1v & 0xff; if (w1y2 > SCREEN_H || w1y2 < w1y1) w1y2 = SCREEN_H;
    const inWin0Row = win0On && line >= w0y1 && line < w0y2;
    const inWin1Row = win1On && line >= w1y1 && line < w1y2;

    const winin = this.io.get16(REG.WININ);
    const winout = this.io.get16(REG.WINOUT);
    const win0Eff = (winin & 0x20) !== 0;
    const win1Eff = (winin & 0x2000) !== 0;
    const winObjEff = (winout & 0x2000) !== 0;
    const winOutEff = (winout & 0x20) !== 0;

    const bldy = Math.min(16, this.io.get16(REG.BLDY) & 0x1f);
    const bldAlpha = this.io.get16(REG.BLDALPHA);
    const targA = bldcnt & 0x3f;

    for (let x = 0; x < SCREEN_W; x++) {
      let effectEnabled = true;
      if (anyWindow) {
        if (inWin0Row && x >= w0x1 && x < w0x2) effectEnabled = win0Eff;
        else if (inWin1Row && x >= w1x1 && x < w1x2) effectEnabled = win1Eff;
        else if (winObjOn && this.objWinMask[x]) effectEnabled = winObjEff;
        else effectEnabled = winOutEff;
      }
      if (!effectEnabled) continue;

      const layer = this.topLayer[x];
      const layerBit = layer === 5 ? 0x20 : (1 << layer);
      if ((targA & layerBit) === 0) continue;

      const c = colorLine[x];
      if (effect === 2) colorLine[x] = brighten555(c, bldy);
      else if (effect === 3) colorLine[x] = darken555(c, bldy);
      else if (effect === 1) colorLine[x] = blend555(c, this.subColor[x], bldAlpha);
    }
  }

  private renderTextBg(line: number, bg: number, bgcnt: number, colorLine: Uint16Array, priLine: Uint8Array, drawn: Uint8Array): void {
    const charBase = ((bgcnt >> 2) & 3) * 0x4000;
    const screenBase = ((bgcnt >> 8) & 0x1f) * 0x800;
    const colors256 = (bgcnt & 0x80) !== 0;
    const size = (bgcnt >> 14) & 3;
    const widthTiles = (size & 1) ? 64 : 32;
    const heightTiles = (size & 2) ? 64 : 32;
    const hofs = this.io.get16(REG.BG0HOFS + bg * 4) & 0x1ff;
    const vofs = this.io.get16(REG.BG0VOFS + bg * 4) & 0x1ff;
    const pr = bgcnt & 3;

    const y = (line + vofs) & (heightTiles * 8 - 1);
    const tileY = (y >> 3);
    const inTileY = y & 7;

    for (let sx = 0; sx < SCREEN_W; sx++) {
      const x = (sx + hofs) & (widthTiles * 8 - 1);
      const tileX = (x >> 3);
      // Screen-block selection for 64-wide/tall maps (each 32x32 block is 0x800).
      let blockX = tileX & 31, blockY = tileY & 31;
      let blockIndex = 0;
      if (widthTiles === 64 && (tileX & 32)) blockIndex += 1;
      if (heightTiles === 64 && (tileY & 32)) blockIndex += (widthTiles === 64 ? 2 : 1);
      const mapOff = screenBase + blockIndex * 0x800 + (blockY * 32 + blockX) * 2;
      const entry = this.mem.vram16(mapOff);
      const tileNum = entry & 0x3ff;
      const flipX = (entry & 0x400) !== 0;
      const flipY = (entry & 0x800) !== 0;
      const palBank = (entry >> 12) & 0xf;
      const py = flipY ? (7 - inTileY) : inTileY;
      const px = flipX ? (7 - (x & 7)) : (x & 7);

      let colorIndex: number;
      if (colors256) {
        const off = charBase + tileNum * 64 + py * 8 + px;
        colorIndex = this.mem.vram[off];
        if (colorIndex === 0) continue;
        const c = this.mem.pal16(colorIndex * 2);
        if (pr < priLine[sx] || !drawn[sx]) { this.subColor[sx] = colorLine[sx]; this.subLayer[sx] = this.topLayer[sx]; colorLine[sx] = c; priLine[sx] = pr; drawn[sx] = 1; this.topLayer[sx] = bg; }
      } else {
        const off = charBase + tileNum * 32 + py * 4 + (px >> 1);
        const byte = this.mem.vram[off];
        colorIndex = (px & 1) ? (byte >> 4) : (byte & 0xf);
        if (colorIndex === 0) continue;
        const c = this.mem.pal16((palBank * 16 + colorIndex) * 2);
        if (pr < priLine[sx] || !drawn[sx]) { this.subColor[sx] = colorLine[sx]; this.subLayer[sx] = this.topLayer[sx]; colorLine[sx] = c; priLine[sx] = pr; drawn[sx] = 1; this.topLayer[sx] = bg; }
      }
    }
  }

  private renderAffineBg(line: number, bg: number, bgcnt: number, colorLine: Uint16Array, priLine: Uint8Array, drawn: Uint8Array): void {
    const charBase = ((bgcnt >> 2) & 3) * 0x4000;
    const screenBase = ((bgcnt >> 8) & 0x1f) * 0x800;
    const size = (bgcnt >> 14) & 3;
    const dim = 128 << size;
    const mask = dim - 1;
    const pr = bgcnt & 3;
    const wrap = (bgcnt & 0x2000) !== 0;

    const base = bg === 2 ? REG.BG2PA : REG.BG3PA;
    const pa = sign16(this.io.get16(base));
    const pb = sign16(this.io.get16(base + 2));
    const pc = sign16(this.io.get16(base + 4));
    const pd = sign16(this.io.get16(base + 6));
    const xReg = bg === 2 ? REG.BG2X : REG.BG3X;
    const yReg = bg === 2 ? REG.BG2Y : REG.BG3Y;
    const refX = sign28(this.io.get16(xReg) | (this.io.get16(xReg + 2) << 16));
    const refY = sign28(this.io.get16(yReg) | (this.io.get16(yReg + 2) << 16));

    let texX = (refX + pb * line) | 0;
    let texY = (refY + pd * line) | 0;
    for (let sx = 0; sx < SCREEN_W; sx++) {
      let x = texX >> 8, y = texY >> 8;
      texX = (texX + pa) | 0;
      texY = (texY + pc) | 0;
      if (wrap) { x &= mask; y &= mask; }
      else if (x < 0 || y < 0 || x >= dim || y >= dim) continue;

      const tileX = x >> 3, tileY = y >> 3;
      const tileIndex = this.mem.vram[screenBase + tileY * (dim >> 3) + tileX];
      const px = x & 7, py = y & 7;
      const colorIndex = this.mem.vram[charBase + tileIndex * 64 + py * 8 + px];
      if (colorIndex === 0) continue;
      const c = this.mem.pal16(colorIndex * 2);
      if (pr < priLine[sx] || !drawn[sx]) { this.subColor[sx] = colorLine[sx]; this.subLayer[sx] = this.topLayer[sx]; colorLine[sx] = c; priLine[sx] = pr; drawn[sx] = 1; this.topLayer[sx] = bg; }
    }
  }

  private renderSprites(line: number, dispcnt: number, colorLine: Uint16Array, priLine: Uint8Array, drawn: Uint8Array): void {
    const oneDim = (dispcnt & 0x40) !== 0;
    // OBJ tile data base is 0x10000 in VRAM. In bitmap modes (3-5) sprite tiles start at 0x14000.
    const objBase = (dispcnt & 0x7) >= 3 ? 0x14000 : 0x10000;
    const bldcnt = this.io.get16(REG.BLDCNT);
    const bldAlpha = this.io.get16(REG.BLDALPHA);
    const alphaEffect = ((bldcnt >> 6) & 3) === 1;
    const objFirstTarget = (bldcnt & 0x10) !== 0;
    // Iterate sprites 127..0 so sprite 0 wins on ties.
    for (let i = 127; i >= 0; i--) {
      const a0 = this.mem.oam16(i * 8);
      const a1 = this.mem.oam16(i * 8 + 2);
      const a2 = this.mem.oam16(i * 8 + 4);
      const affine = (a0 & 0x100) !== 0;
      const disabled = !affine && (a0 & 0x200) !== 0; // attr0 bit9 = OBJ disable when not affine
      if (disabled) continue;
      const doubleSize = affine && (a0 & 0x200) !== 0; // bit9 = double-size when affine
      const objMode = (a0 >> 10) & 3; // 0=normal 1=semi-transparent 2=OBJ window
      const isObjWindow = objMode === 2;
      let y = a0 & 0xff;
      const shape = (a0 >> 14) & 3;
      const sizeBits = (a1 >> 14) & 3;
      const [w, h] = spriteSize(shape, sizeBits);
      const bw = doubleSize ? w * 2 : w;  // on-screen bounding box
      const bh = doubleSize ? h * 2 : h;
      let x = a1 & 0x1ff; if (x & 0x100) x -= 0x200;
      if (y >= 160) y -= 256;
      if (line < y || line >= y + bh) continue;

      const colors256 = (a0 & 0x2000) !== 0;
      const tileNum = a2 & 0x3ff;
      const pr = (a2 >> 10) & 3;
      const palBank = (a2 >> 12) & 0xf;
      const tilesPerRow = oneDim ? (w >> 3) : (colors256 ? 16 : 32);

      // Affine parameters: the OAM affine group index lives in attr1 bits 9-13. Each group is
      // four 16-bit fixed-point (8.8) entries (PA,PB,PC,PD) interleaved every 8th halfword in OAM.
      let pa = 256, pb = 0, pc = 0, pd = 256;
      if (affine) {
        const grp = (a1 >> 9) & 0x1f;
        pa = sign16(this.mem.oam16(grp * 32 + 6));
        pb = sign16(this.mem.oam16(grp * 32 + 14));
        pc = sign16(this.mem.oam16(grp * 32 + 22));
        pd = sign16(this.mem.oam16(grp * 32 + 30));
      }
      const flipX = !affine && (a1 & 0x1000) !== 0;
      const flipY = !affine && (a1 & 0x2000) !== 0;

      const halfW = bw / 2, halfH = bh / 2;
      const iy = (line - y) - halfH; // pixel offset from bbox center on this scanline

      for (let col = 0; col < bw; col++) {
        const sx = x + col; if (sx < 0 || sx >= SCREEN_W) continue;
        const ix = col - halfW;
        // Map screen offset back into texture space via the affine matrix (8.8 fixed point).
        // texX = pa*ix + pb*iy + w/2 ; texY = pc*ix + pd*iy + h/2
        let tx: number, ty: number;
        if (affine) {
          tx = ((pa * ix + pb * iy) >> 8) + (w >> 1);
          ty = ((pc * ix + pd * iy) >> 8) + (h >> 1);
        } else {
          tx = col; ty = line - y;
          if (flipX) tx = w - 1 - tx;
          if (flipY) ty = h - 1 - ty;
        }
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        const tileCol = tx >> 3, inTileX = tx & 7;
        const tileRow = ty >> 3, inTileY = ty & 7;
        let ci: number;
        if (colors256) {
          const tIndex = tileNum + tileRow * tilesPerRow * 2 + tileCol * 2;
          ci = this.mem.vram[objBase + tIndex * 32 + inTileY * 8 + inTileX];
        } else {
          const tIndex = tileNum + tileRow * tilesPerRow + tileCol;
          const byte = this.mem.vram[objBase + tIndex * 32 + inTileY * 4 + (inTileX >> 1)];
          ci = (inTileX & 1) ? (byte >> 4) : (byte & 0xf);
        }
        if (ci === 0) continue;
        if (isObjWindow) { this.objWinMask[sx] = 1; continue; }
        if (pr <= priLine[sx]) {
          const c = colors256 ? this.mem.pal16(0x200 + ci * 2) : this.mem.pal16(0x200 + (palBank * 16 + ci) * 2);
          const doBlend = objMode === 1 || (alphaEffect && objFirstTarget);
          this.subColor[sx] = colorLine[sx]; this.subLayer[sx] = this.topLayer[sx];
          colorLine[sx] = doBlend ? blend555(c, colorLine[sx], bldAlpha) : c;
          priLine[sx] = pr; drawn[sx] = 1; this.topLayer[sx] = 4; this.objSemiTrans[sx] = objMode === 1 ? 1 : 0;
        }
      }
    }
  }

  serializeState() { return { scanlineCycles: this.scanlineCycles, inHblank: this.inHblank }; }
  loadState(s: { scanlineCycles: number; inHblank: boolean }) { this.scanlineCycles = s.scanlineCycles; this.inHblank = s.inHblank; }
}

function blend555(a: number, b: number, alpha: number): number {
  let eva = alpha & 0x1f, evb = (alpha >> 8) & 0x1f;
  if (eva > 16) eva = 16; if (evb > 16) evb = 16;
  const ar = a & 0x1f, ag = (a >> 5) & 0x1f, ab = (a >> 10) & 0x1f;
  const br = b & 0x1f, bg = (b >> 5) & 0x1f, bb = (b >> 10) & 0x1f;
  const r = Math.min(31, ((ar * eva + br * evb) >> 4));
  const g = Math.min(31, ((ag * eva + bg * evb) >> 4));
  const bl = Math.min(31, ((ab * eva + bb * evb) >> 4));
  return r | (g << 5) | (bl << 10);
}

function brighten555(c: number, evy: number): number {
  const r = c & 0x1f, g = (c >> 5) & 0x1f, b = (c >> 10) & 0x1f;
  const nr = r + (((31 - r) * evy) >> 4);
  const ng = g + (((31 - g) * evy) >> 4);
  const nb = b + (((31 - b) * evy) >> 4);
  return (nr & 0x1f) | ((ng & 0x1f) << 5) | ((nb & 0x1f) << 10);
}

function darken555(c: number, evy: number): number {
  const r = c & 0x1f, g = (c >> 5) & 0x1f, b = (c >> 10) & 0x1f;
  const nr = r - ((r * evy) >> 4);
  const ng = g - ((g * evy) >> 4);
  const nb = b - ((b * evy) >> 4);
  return (nr & 0x1f) | ((ng & 0x1f) << 5) | ((nb & 0x1f) << 10);
}

function sign16(v: number): number { v &= 0xffff; return v & 0x8000 ? v - 0x10000 : v; }
function sign28(v: number): number { v &= 0x0fffffff; return v & 0x08000000 ? v - 0x10000000 : v; }

function spriteSize(shape: number, size: number): [number, number] {
  const table: Record<number, [number, number][]> = {
    0: [[8, 8], [16, 16], [32, 32], [64, 64]],   // square
    1: [[16, 8], [32, 8], [32, 16], [64, 32]],    // wide
    2: [[8, 16], [8, 32], [16, 32], [32, 64]],    // tall
  };
  return (table[shape] || table[0])[size];
}
