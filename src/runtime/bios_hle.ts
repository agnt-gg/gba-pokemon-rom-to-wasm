/**
 * High-Level Emulation (HLE) of the GBA BIOS SWI calls.
 *
 * GBA games call BIOS routines via SWI (software interrupt). Rather than ship Nintendo's
 * copyrighted BIOS, we reimplement the documented behavior of each SWI from public docs
 * (GBATEK conventions). Pokemon Gen 3 leans heavily on:
 *   - SWI 0x06 Div / 0x07 DivArm
 *   - SWI 0x08 Sqrt
 *   - SWI 0x0B CpuSet / 0x0C CpuFastSet (block fills/copies)
 *   - SWI 0x11 LZ77UnCompWram / 0x12 LZ77UnCompVram
 *   - SWI 0x13 HuffUnComp, 0x14 RLUnCompWram, 0x15 RLUnCompVram
 *   - SWI 0x01 RegisterRamReset, 0x04 IntrWait, 0x05 VBlankIntrWait
 *   - SWI 0x00 SoftReset, 0x02 Halt, 0x03 Stop
 *
 * If a SWI isn't HLE'd we return false so the core can vector to the BIOS stub (rare for games).
 */

import type { ArmCore } from '../cpu/arm_core.ts';
import { Mode, FLAG_I, FLAG_T } from '../cpu/arm_state.ts';

function s16(v: number): number { v &= 0xffff; return v & 0x8000 ? v - 0x10000 : v; }

export function makeBiosHle(opts: { onIntrWait?: () => void; onSoftReset?: (info: { pc: number; lr: number; flag: number; entry: number }) => void } = {}) {
  return function handleSwi(comment: number, cpu: ArmCore): boolean {
    const st = cpu.st;
    const r = st.r;
    const bus = cpu.bus;
    switch (comment) {
      case 0x00: { // SoftReset
        // The real BIOS reads the return-mode flag from 0x03007FFA: 0 => return to ROM
        // (0x08000000), non-zero => return to EWRAM (0x02000000). It restores the BIOS-default
        // banked stack pointers and clears the top of IWRAM. Pokemon uses SoftReset for its
        // soft-reset feature; always hard-jumping to ROM turns an intended EWRAM re-entry into a
        // full title restart, which is exactly the trainer-card restart symptom.
        const flag = bus.read8(0x03007ffa) & 0xff;
        const entry = (flag === 0 ? 0x08000000 : 0x02000000) >>> 0;
        if (opts.onSoftReset) opts.onSoftReset({ pc: r[15] >>> 0, lr: r[14] >>> 0, flag, entry });
        // Clear the BIOS-managed scratch at the top of IWRAM (0x03007E00..0x03007FFF).
        for (let a = 0x03007e00; a < 0x03008000; a += 4) bus.write32(a, 0);
        // Restore banked SPs via mode switches, finishing in System mode (BIOS post-reset state).
        st.switchMode(Mode.SVC); st.r[13] = 0x03007fe0;
        st.switchMode(Mode.IRQ); st.r[13] = 0x03007fa0;
        st.switchMode(Mode.SYS); st.r[13] = 0x03007f00;
        st.cpsr = Mode.SYS | FLAG_I; // SYS mode, IRQs disabled, ARM state (FLAG_T cleared)
        st.cpsr &= ~FLAG_T;
        st.r[14] = entry;
        r[15] = entry;
        return true;
      }
      case 0x01: // RegisterRamReset (we no-op the flags; RAM already initialized)
        return true;
      case 0x02: // Halt
      case 0x03: // Stop
        cpu.halted = true;
        return true;
      case 0x04: // IntrWait(discardOld=r0, waitFlags=r1)
      case 0x05: { // VBlankIntrWait == IntrWait(1, 1)
        // The BIOS IntrWait halts until one of the requested interrupts has been flagged in the
        // BIOS-managed "interrupt check" halfword at 0x03007FF8 (mirror 0x03FFFFF8). It then clears
        // those bits and returns. We emulate that handshake so the game's VBlank wait actually ends.
        const BIOS_IF = 0x03007ff8;
        const discardOld = comment === 0x05 ? 1 : (r[0] & 1);
        const waitFlags = comment === 0x05 ? 0x0001 : (r[1] & 0xffff);
        // CRITICAL: discardOld must only run on the FIRST entry of an IntrWait, NOT on the
        // post-wake re-execution. Because we model the BIOS wait by halting + rewinding PC so the
        // SWI re-runs after an IRQ, re-running discardOld would clear the very flag the IRQ just
        // delivered (BIOS_IF bit), causing the wait to halt forever. We gate it with a per-CPU
        // "in an active IntrWait" flag: clear-old happens once, then we only poll for completion.
        const reentry = cpu.intrWaitActive;
        if (discardOld && !reentry) bus.write16(BIOS_IF, bus.read16(BIOS_IF) & ~waitFlags);
        // If the desired flag is now set, consume it, end the wait, and return (PC already points
        // just past the SWI, so execution continues at the following instruction / bx lr).
        if (bus.read16(BIOS_IF) & waitFlags) {
          bus.write16(BIOS_IF, bus.read16(BIOS_IF) & ~waitFlags);
          cpu.intrWaitActive = false;
          return true;
        }
        // Otherwise halt; the runtime resumes us when an IRQ fires, and re-runs this SWI. Mark the
        // wait active so the re-execution skips discardOld and just re-polls.
        cpu.intrWaitActive = true;
        cpu.halted = true;
        // Rewind PC so the SWI re-executes on wake and re-checks the flag.
        if (cpu.st.thumb) cpu.st.r[15] = (cpu.st.r[15] - 2) >>> 0;
        else cpu.st.r[15] = (cpu.st.r[15] - 4) >>> 0;
        if (opts.onIntrWait) opts.onIntrWait();
        return true;
      }
      case 0x06: { // Div: r0/r1 -> r0=quot, r1=rem, r3=abs(quot)
        const num = r[0] | 0, den = r[1] | 0;
        if (den === 0) { return true; }
        const q = (num / den) | 0; const rem = (num % den) | 0;
        r[0] = q; r[1] = rem; r[3] = Math.abs(q) | 0;
        return true;
      }
      case 0x07: { // DivArm: r1/r0
        const num = r[1] | 0, den = r[0] | 0;
        if (den === 0) return true;
        const q = (num / den) | 0; const rem = (num % den) | 0;
        r[0] = q; r[1] = rem; r[3] = Math.abs(q) | 0;
        return true;
      }
      case 0x08: { // Sqrt
        const v = r[0] >>> 0; r[0] = Math.floor(Math.sqrt(v)) >>> 0; return true;
      }
      case 0x09: { // ArcTan (approx)
        r[0] = Math.atan((r[0] << 16 >> 16) / 16384) * (0x4000 / (Math.PI / 2)) | 0; return true;
      }
      case 0x0b: { // CpuSet: r0=src, r1=dst, r2=control
        let src = r[0] >>> 0, dst = r[1] >>> 0; const ctrl = r[2] >>> 0;
        const count = ctrl & 0x1fffff;
        const fixed = (ctrl & (1 << 24)) !== 0; // fill mode
        const word = (ctrl & (1 << 26)) !== 0;  // 32-bit transfers
        if (word) {
          const fill = fixed ? bus.read32(src) >>> 0 : 0;
          for (let i = 0; i < count; i++) { const v = fixed ? fill : (bus.read32(src) >>> 0); bus.write32(dst, v); if (!fixed) src = (src + 4) >>> 0; dst = (dst + 4) >>> 0; }
        } else {
          const fill = fixed ? bus.read16(src) & 0xffff : 0;
          for (let i = 0; i < count; i++) { const v = fixed ? fill : (bus.read16(src) & 0xffff); bus.write16(dst, v); if (!fixed) src = (src + 2) >>> 0; dst = (dst + 2) >>> 0; }
        }
        return true;
      }
      case 0x0c: { // CpuFastSet: 32-bit, count rounded to 8 words
        let src = r[0] >>> 0, dst = r[1] >>> 0; const ctrl = r[2] >>> 0;
        let count = ctrl & 0x1fffff; count = (count + 7) & ~7;
        const fixed = (ctrl & (1 << 24)) !== 0;
        const fill = fixed ? bus.read32(src) >>> 0 : 0;
        for (let i = 0; i < count; i++) { const v = fixed ? fill : (bus.read32(src) >>> 0); bus.write32(dst, v); if (!fixed) src = (src + 4) >>> 0; dst = (dst + 4) >>> 0; }
        return true;
      }
      case 0x11: case 0x12: { // LZ77UnComp (Wram/Vram). VRAM variant writes 16-bit.
        lz77(cpu, r[0] >>> 0, r[1] >>> 0, comment === 0x12);
        return true;
      }
      case 0x13: { // HuffUnComp
        huff(cpu, r[0] >>> 0, r[1] >>> 0);
        return true;
      }
      case 0x14: case 0x15: { // RLUnComp (Wram/Vram)
        rlUnComp(cpu, r[0] >>> 0, r[1] >>> 0, comment === 0x15);
        return true;
      }
      case 0x0e: { // BgAffineSet: r0=src array, r1=dst array, r2=count
        // Each src entry: bgX(s32 8.8 *256? actually 1<<8), bgY, dispX(s16), dispY(s16),
        // scaleX(s16 8.8), scaleY(s16 8.8), angle(u16, high 8 bits = 0..255 => 0..2pi).
        // Each dst entry: pa,pb,pc,pd (s16 8.8) then dx,dy (s32).
        let src = r[0] >>> 0, dst = r[1] >>> 0; const count = r[2] >>> 0;
        for (let i = 0; i < count; i++) {
          const cx = bus.read32(src) | 0;        // 0..3: bg center x (signed 19.8)
          const cy = bus.read32(src + 4) | 0;    // 4..7: bg center y
          const dispX = s16(bus.read16(src + 8));
          const dispY = s16(bus.read16(src + 10));
          const sx = s16(bus.read16(src + 12)) / 256; // 8.8 scale x
          const sy = s16(bus.read16(src + 14)) / 256; // 8.8 scale y
          const angle = ((bus.read16(src + 16) >> 8) & 0xff) / 256 * 2 * Math.PI;
          const ca = Math.cos(angle), sa = Math.sin(angle);
          const pa = (ca * sx) * 256 | 0;
          const pb = (-sa * sx) * 256 | 0;
          const pc = (sa * sy) * 256 | 0;
          const pd = (ca * sy) * 256 | 0;
          bus.write16(dst, pa & 0xffff);
          bus.write16(dst + 2, pb & 0xffff);
          bus.write16(dst + 4, pc & 0xffff);
          bus.write16(dst + 6, pd & 0xffff);
          // Start coordinate: dx = cx - (pa*dispX + pb*dispY), dy = cy - (pc*dispX + pd*dispY)
          const dx = (cx - (pa * dispX + pb * dispY)) | 0;
          const dy = (cy - (pc * dispX + pd * dispY)) | 0;
          bus.write32(dst + 8, dx >>> 0);
          bus.write32(dst + 12, dy >>> 0);
          src = (src + 20) >>> 0;
          dst = (dst + 16) >>> 0;
        }
        return true;
      }
      case 0x0f: { // ObjAffineSet: r0=src, r1=dst, r2=count, r3=stride(2 or 8 bytes between dst entries)
        // Each src entry (8 bytes): scaleX(s16 8.8), scaleY(s16 8.8), angle(u16), pad(u16).
        // Writes pa,pb,pc,pd (s16 8.8) at dst, dst+stride, dst+2*stride, dst+3*stride.
        let src = r[0] >>> 0, dst = r[1] >>> 0; const count = r[2] >>> 0; const stride = r[3] >>> 0;
        for (let i = 0; i < count; i++) {
          const sx = s16(bus.read16(src)) / 256;
          const sy = s16(bus.read16(src + 2)) / 256;
          const angle = ((bus.read16(src + 4) >> 8) & 0xff) / 256 * 2 * Math.PI;
          const ca = Math.cos(angle), sa = Math.sin(angle);
          // GBATEK ObjAffineSet matrix: pa= sx*cos, pb=-sx*sin, pc= sy*sin, pd= sy*cos.
          const pa = (ca * sx) * 256 | 0;
          const pb = (-sa * sx) * 256 | 0;
          const pc = (sa * sy) * 256 | 0;
          const pd = (ca * sy) * 256 | 0;
          bus.write16(dst, pa & 0xffff);
          bus.write16((dst + stride) >>> 0, pb & 0xffff);
          bus.write16((dst + 2 * stride) >>> 0, pc & 0xffff);
          bus.write16((dst + 3 * stride) >>> 0, pd & 0xffff);
          src = (src + 8) >>> 0;
          dst = (dst + 4 * stride) >>> 0;
        }
        return true;
      }
      case 0x10: { // BitUnPack
        bitUnpack(cpu, r[0] >>> 0, r[1] >>> 0, r[2] >>> 0);
        return true;
      }
      case 0x25: // MultiBoot — not used single-cart
        r[0] = 1; return true;
      default:
        // Unhandled SWI: no-op (return true to avoid faulting to BIOS stub).
        return true;
    }
  };
}

// ---- Decompressor output sink ----
//
// All GBA BIOS decompressors share one tricky requirement: back-references (LZ77) read bytes
// that were *just* written, and VRAM destinations can only be written 16/32 bits at a time.
// The robust, provably-correct approach is to decompress into a local byte buffer, satisfy all
// back-references from that buffer, and flush to memory at the end (halfword-wide for VRAM).
// Reading back-references from the destination memory directly (the old bug) breaks for VRAM
// because the trailing byte sits unflushed in a temporary and the read returns stale memory.
function makeSink(cpu: ArmCore, dst: number, size: number, vram: boolean) {
  const bus = cpu.bus;
  const buf = new Uint8Array(size + 4); // small pad so a final partial halfword/word is safe
  let written = 0;
  const push = (byte: number) => { if (written < buf.length) buf[written] = byte & 0xff; written++; };
  const at = (i: number) => (i >= 0 && i < buf.length ? buf[i] : 0);
  const flush = () => {
    if (vram) {
      // Write halfwords; if size is odd the last byte pairs with a zero high byte.
      for (let i = 0; i < size; i += 2) {
        const lo = buf[i] & 0xff;
        const hi = (i + 1 < size ? buf[i + 1] : 0) & 0xff;
        bus.write16((dst + i) >>> 0, (lo | (hi << 8)) & 0xffff);
      }
    } else {
      for (let i = 0; i < size; i++) bus.write8((dst + i) >>> 0, buf[i] & 0xff);
    }
  };
  return { push, at, flush, count: () => written };
}

// ---- LZ77 decompressor (GBA format) ----
function lz77(cpu: ArmCore, src: number, dst: number, vram: boolean): void {
  const bus = cpu.bus;
  const header = bus.read32(src) >>> 0; src += 4;
  const size = header >>> 8; // decompressed byte count
  const sink = makeSink(cpu, dst, size, vram);
  const peek = (a: number) => bus.read8(a);
  while (sink.count() < size) {
    const flags = peek(src++);
    for (let b = 0; b < 8 && sink.count() < size; b++) {
      if (flags & (0x80 >> b)) {
        const b1 = peek(src++); const b2 = peek(src++);
        const len = (b1 >> 4) + 3;
        const disp = (((b1 & 0xf) << 8) | b2) + 1;
        // Back-reference into the decompressed output buffer (correct for VRAM and WRAM).
        let pos = sink.count() - disp;
        for (let i = 0; i < len && sink.count() < size; i++) { sink.push(sink.at(pos)); pos++; }
      } else {
        sink.push(peek(src++));
      }
    }
  }
  sink.flush();
}

// ---- RL (run-length) decompressor ----
function rlUnComp(cpu: ArmCore, src: number, dst: number, vram: boolean): void {
  const bus = cpu.bus;
  const header = bus.read32(src) >>> 0; src += 4;
  const size = header >>> 8;
  const sink = makeSink(cpu, dst, size, vram);
  while (sink.count() < size) {
    const flag = bus.read8(src++);
    if (flag & 0x80) {
      const len = (flag & 0x7f) + 3; const byte = bus.read8(src++);
      for (let i = 0; i < len && sink.count() < size; i++) sink.push(byte);
    } else {
      const len = (flag & 0x7f) + 1;
      for (let i = 0; i < len && sink.count() < size; i++) sink.push(bus.read8(src++));
    }
  }
  sink.flush();
}

// ---- Huffman decompressor (GBA format) ----
//
// Header word: bits0-3 = symbol bit width (usually 4 or 8), bits8-31 = decompressed size.
// Byte at src+4 = (treeSize/2 - 1); the tree table starts at src+5. The bitstream is a sequence
// of 32-bit little-endian words read MSB-first. Traversal starts at the root (first tree byte):
// each node byte holds a 6-bit offset to its child pair plus two "child is leaf" flags (bit7 for
// the bit=0 child, bit6 for the bit=1 child). Child address = (node & ~1) + offset*2 + 2, then
// +0 for bit0 / +1 for bit1. Decoded symbols are packed LSB-first into the output, `dataSize`
// bits at a time. We decode into a byte buffer (always WRAM-style packing) and flush at the end.
function huff(cpu: ArmCore, src: number, dst: number): void {
  const bus = cpu.bus;
  const header = bus.read32(src) >>> 0;
  const dataSize = header & 0xf;          // bits per symbol
  const size = header >>> 8;              // decompressed size in BYTES
  const treeSize = (bus.read8(src + 4) + 1) * 2;
  const treeStart = src + 5;
  let bitstream = src + 4 + treeSize;     // first 32-bit word of the encoded bitstream
  // Output accumulator: pack dataSize-bit symbols LSB-first into bytes.
  const buf = new Uint8Array(size + 4);
  let outBytes = 0, outAcc = 0, outAccBits = 0;
  const emit = (sym: number) => {
    outAcc |= (sym & ((1 << dataSize) - 1)) << outAccBits;
    outAccBits += dataSize;
    while (outAccBits >= 8 && outBytes < buf.length) {
      buf[outBytes++] = outAcc & 0xff; outAcc >>>= 8; outAccBits -= 8;
    }
  };
  let curWord = 0, bitsLeft = 0;
  const nextBit = (): number => {
    if (bitsLeft === 0) { curWord = bus.read32(bitstream) >>> 0; bitstream += 4; bitsLeft = 32; }
    const bit = (curWord >>> 31) & 1; curWord = (curWord << 1) >>> 0; bitsLeft--; return bit;
  };
  let cur = treeStart;
  while (outBytes < size) {
    const bit = nextBit();
    const nodeVal = bus.read8(cur);
    const offset = nodeVal & 0x3f;
    const next = ((cur & ~1) + offset * 2 + 2 + bit) >>> 0;
    const isLeaf = bit ? (nodeVal & 0x40) : (nodeVal & 0x80);
    if (isLeaf) { emit(bus.read8(next)); cur = treeStart; }
    else cur = next;
  }
  // Flush (Huffman destinations in Gen 3 are WRAM/VRAM; write halfwords to be VRAM-safe).
  for (let i = 0; i < size; i += 2) {
    const lo = buf[i] & 0xff, hi = (i + 1 < size ? buf[i + 1] : 0) & 0xff;
    bus.write16((dst + i) >>> 0, (lo | (hi << 8)) & 0xffff);
  }
}

// ---- BitUnPack ----
function bitUnpack(cpu: ArmCore, src: number, dst: number, info: number): void {
  const bus = cpu.bus;
  const srcLen = bus.read16(info) & 0xffff;
  const srcWidth = bus.read8(info + 2);
  const dstWidth = bus.read8(info + 3);
  const dataOffset = bus.read32(info + 4) >>> 0;
  const zeroFlag = (dataOffset & 0x80000000) !== 0;
  const offset = dataOffset & 0x7fffffff;
  let outBuf = 0, outBits = 0; let srcByteIdx = 0;
  const mask = (1 << srcWidth) - 1;
  for (let i = 0; i < srcLen; i++) {
    const byte = bus.read8(src + i);
    for (let b = 0; b < 8; b += srcWidth) {
      let unit = (byte >> b) & mask;
      if (unit !== 0 || zeroFlag) unit = (unit + offset) >>> 0;
      outBuf |= unit << outBits; outBits += dstWidth;
      if (outBits >= 32) { bus.write32(dst, outBuf >>> 0); dst += 4; outBuf = 0; outBits = 0; }
    }
  }
  if (outBits > 0) bus.write32(dst, outBuf >>> 0);
}
