# gba-recomp — GBA Pokémon Ruby/Sapphire ROM machine-code to browser

`gba-recomp` is an experimental Game Boy Advance ROM-to-browser runtime and recompiler-oriented hardware host for main-line Gen 3 Pokémon games.

It reads a user-provided Pokémonémon Ruby/Sapphire/Emerald `.gba` ROM locally, executes the ROM's already-assembled ARM7TDMI machine code, and hosts it inside a JavaScript/WebAssembly-ready GBA hardware runtime.

The project began with **Pokémon Ruby / Sapphire** as the bring-up target and is designed around the same binary-lifting discipline as `gb-pokemon-rom-to-wasm`: decode the real cartridge code, preserve hardware-visible semantics, and run the unmodified ROM against a host runtime.

> Important: this repository does **not** include any commercial ROM, BIOS image, `.sav`, browser localStorage dump, or generated user-state artifact. You must provide your own legally obtained ROM locally.

## What this is

```txt
GBA ROM bytes
→ ARM7TDMI ARM/THUMB decoder + interpreter/recompiler-ready core
→ BIOS HLE for documented GBA SWIs
→ GBA hardware runtime: memory map, MMIO, PPU, DMA, timers, IRQ, audio, Flash, RTC
→ browser host: canvas, keyboard/touch, audio, local save persistence
→ playable Pokémon Ruby/Sapphire target
```

This is not source assembly compilation and it is not a ROM distribution project. It is an emulator/recompiler research runtime for user-supplied ROM bytes.

## ARM → WebAssembly recompiler (this really runs WASM)

The runtime is a **hybrid**: an interpreter for correctness and a real ARM→WebAssembly
recompiler for the hot path. The recompiler is genuine — it emits raw `.wasm` bytecode
in-process (no `wabt` / `binaryen` / external toolchain), hands it to
`new WebAssembly.Module()`, and the browser/Node WASM engine executes the translated guest
code against the CPU register file held in `WebAssembly.Memory`.

```txt
ARM machine code (from the ROM)
 → per-instruction lifter (src/recompiler/arm_lifter.ts)
 → basic-block discovery + hand-encoded WASM module (src/recompiler/wasm_encoder.ts)
 → new WebAssembly.Module() / Instance()  ← executed by the engine, not interpreted
 → host imports bridge guest memory/MMIO back to the GBA bus
```

What is lifted natively today (ARM, condition AL):

- data-processing: `MOV/MVN/ADD/SUB/RSB/AND/EOR/ORR/BIC`, immediate or immediate-shifted reg
- compares/tests that set flags: `CMP/CMN/TST/TEQ` (N/Z/C/V computed inline, incl. signed
  overflow and unsigned carry)
- `B` / `BL` with static targets
- `STR/STRB`, `LDRB`, pre/post-indexed with writeback (immediate offset)

Everything else (THUMB, word `LDR` with unaligned rotation, `LDM/STM`, `MUL`, `MSR/MRS`,
`BX`, `SWI`, conditional execution) safely **falls back to the interpreter**. A correct
hybrid beats an incorrect “100% native.”

### Why you can trust it

Two independent guarantees keep the recompiler from ever diverging from real hardware
semantics:

1. **Differential unit tests** (`tests/recompiler_diff.test.ts`): every lifted instruction
   class is run through both the interpreter and a freshly emitted WASM module from identical
   state, and `r0..r14` + `N/Z/C/V` are asserted **bit-identical**.
2. **First-run self-verification gate** (runtime): the first time a block executes natively,
   the same instructions are replayed on a reference interpreter and compared; any mismatch
   permanently rejects that block (it interprets instead). The recompiler can only be a
   correct speedup or a safe fallback — never a correctness regression.

The full **jsmolka GBA CPU conformance suite passes (ARM=PASS, THUMB=PASS) with the
recompiler active**, and Pokémon Ruby boots and renders identically with native blocks on.

### Measured native coverage (Pokémon Ruby, 300-frame boot)

```txt
total guest instrs    : ~8.84M
native (WASM) instrs  : ~1.14M   (~13%)
blocks compiled       : 48
blocks rejected (gate): 11        ← the safety net working as designed
```

Coverage is ARM-only for now; Ruby is heavily THUMB, so **THUMB lifting is the next and
largest lever**. Run it yourself:

```bash
node --experimental-strip-types tools/recomp_coverage.ts <your.gba> 300
```

## Current target matrix

| Game | Header title | Game code | Save hardware | Runtime status |
|---|---|---:|---|---|
| Pokémon Ruby | `POKEMON RUBY` | `AXVE` | 128K Flash + RTC | Primary playable bring-up target |
| Pokémon Sapphire | `POKEMON SAPP` | `AXPE` | 128K Flash + RTC | Supported sibling target |
| Pokémon Emerald | `POKEMON EMER` | `BPEE` | 128K Flash + RTC | Architecture target; additional game-specific work expected |

## What works now

- ARM7TDMI core with ARM + THUMB execution
- Banked CPU modes, CPSR/SPSR, IRQ/SVC behavior
- GBA memory map: BIOS/EWRAM/IWRAM/MMIO/palette/VRAM/OAM/ROM/Flash
- BIOS HLE for Pokémon-critical SWIs: IntrWait/VBlankIntrWait, CpuSet/CpuFastSet, affine helpers, decompression, math, SoftReset diagnostics
- PPU scanline runtime with backgrounds, sprites, windows/blending coverage for Ruby/Sapphire bring-up
- DMA, timers, interrupt controller, HBlank/VBlank paths
- 128K Flash save model and browser localStorage persistence
- GPIO RTC HLE sufficient for Ruby/Sapphire boot/menu stability
- Browser frontend at `web/index.html`
- Headless agent harness for deterministic input, RAM/CPU observation, SoftReset postmortems, and HBlank stress tests
- Regression suite covering CPU, BIOS affine, boot, frames, Flash, IRQ wake, THUMB IRQ LR, PPU window/blend, RTC, and Ruby Flash sectors

## Key bug fixed: HBlank-heavy trainer-card / encounter reset

The repeated player-card and wild-encounter reset was traced to IRQ return semantics under THUMB code.

Live fingerprints showed:

```txt
IE=0x3, IF=0x2, DISPCNT=0x7f60
SoftReset from EWRAM 0x020200xx
recent SWIs: VBlankIntrWait, CpuSet, ObjAffineSet, garbage SWI, SoftReset
```

The CPU was eventually executing EWRAM data as code. The final root cause was that IRQ delivery used `LR_irq = next + 2` for THUMB code, but the HLE BIOS return path restores via `LR_irq - 4`. That returned to `next - 2`, re-executing the interrupted halfword. Under HBlank storms this corrupts THUMB control flow.

Fix: `GbaInterrupts.deliver()` now uses `LR_irq = next + 4` for both ARM and THUMB. The regression `tests/irq_thumb_lr.test.ts` locks this behavior.

## Technical writeup

See:

- [`docs/rom-to-wasm-process.html`](docs/rom-to-wasm-process.html)

This document covers the full ROM-to-browser process, hardware runtime, BIOS HLE, autonomous instrumentation, and failure archaeology.

## Running locally

```bash
npm install
npm run build:web
npm run serve
```

Then open:

```txt
http://localhost:8077/
```

Upload your legally obtained `.gba` ROM using the page's ROM picker.

## Tests

Run individual tests with Node's TypeScript stripping support:

```bash
node --experimental-strip-types tests/irq_thumb_lr.test.ts
node --experimental-strip-types tests/frames_ruby.test.ts
```

Run the main suite manually:

```bash
for t in tests/*.test.ts; do node --experimental-strip-types "$t"; done
```

Some tests reference local Pokémon ROM paths and therefore require your own ROM files. Commercial ROMs are intentionally not committed.

## Repository hygiene

Do not commit:

- `.gba`, `.gb`, `.gbc` commercial ROMs
- `.sav`, save-state, or browser localStorage dumps
- generated user-state artifacts
- browser profile LevelDB copies
- `node_modules`

The only committed `.gba` files are MIT-licensed CPU conformance ROMs under `build/arm.gba` and `build/thumb.gba`.

## License / legal note

This repository implements public GBA hardware behavior and uses public documentation such as GBATEK conventions. It does not include Nintendo BIOS code or any commercial game ROM.
