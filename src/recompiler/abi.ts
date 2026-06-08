/**
 * Shared ABI between the recompiled WASM blocks and the JS runtime.
 *
 * The CPU register file lives in WebAssembly linear memory so that compiled blocks can
 * read/write it with plain i32 loads/stores. The JS runtime mirrors the same layout via a
 * DataView/Int32Array over the same ArrayBuffer.
 *
 * Linear memory map (byte offsets), page 0:
 *   0x0000 .. 0x003F : r0..r15           (16 * 4 bytes)  -- the CURRENT visible bank
 *   0x0040           : CPSR
 *   0x0044           : cycles (block-local cycle accumulator, added by runtime)
 *   0x0048           : flag N (0/1)   -- exploded flags for cheap WASM access
 *   0x004C           : flag Z
 *   0x0050           : flag C
 *   0x0054           : flag V
 *   0x0058           : scratch0
 *   0x005C           : scratch1
 *
 * Exploded flags: the recompiler keeps N/Z/C/V as separate i32 words during a block so it can
 * set/test them without packing/unpacking CPSR on every instruction. The runtime syncs these
 * to/from the real CPSR at block entry/exit (see Recompiler.syncIn / syncOut).
 *
 * Host imports (module "env"): the compiled block calls back into JS for anything that touches
 * the guest memory bus or needs interpreter semantics:
 *   read8/read16/read32(addr) -> value
 *   write8/write16/write32(addr, value)
 *   These go through the real GbaMemory bus so MMIO/VRAM/Flash side effects are preserved.
 */

export const REG_BASE = 0x0000;          // r0..r15 start here
export const OFF_CPSR = 0x0040;
export const OFF_CYCLES = 0x0044;
export const OFF_NF = 0x0048;
export const OFF_ZF = 0x004c;
export const OFF_CF = 0x0050;
export const OFF_VF = 0x0054;
export const OFF_SCRATCH0 = 0x0058;
export const OFF_SCRATCH1 = 0x005c;

export const STATE_BYTES = 0x0060;

/** byte offset of register n (0..15) in linear memory. */
export function regOff(n: number): number { return REG_BASE + n * 4; }

/** Host import function indices (order MUST match the imports array in the module builder). */
export const HOST = {
  read8: 0,
  read16: 1,
  read32: 2,
  write8: 3,
  write16: 4,
  write32: 5,
} as const;

export const HOST_IMPORT_ORDER = ['read8', 'read16', 'read32', 'write8', 'write16', 'write32'] as const;
