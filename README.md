# gba-recomp â€” GBA PokÃ©mon Ruby/Sapphire ROM machine-code to browser

`gba-recomp` is an experimental Game Boy Advance ROM-to-browser runtime and recompiler-oriented hardware host for main-line Gen 3 PokÃ©mon games.

It reads a user-provided Pokémon Ruby/Sapphire/Emerald `.gba` ROM locally and runs the ROM's already-assembled ARM7TDMI machine code inside a GBA hardware runtime in the browser. The runtime is a **hybrid recompiler**: ARM **and THUMB** basic blocks are **lifted into real WebAssembly bytecode in-process and executed by the engine** (`new WebAssembly.Module()` - not interpreted). Today **99.9% of executed guest instructions run as engine-run WebAssembly** on the Ruby boot/gameplay path — the only instructions still interpreted are the handful of MSR/MRS mode-plumbing sites and SWI entries into the BIOS HLE. The lifters cover the full data-processing set (incl. ADC/SBC/RSC and register-specified shifts), full conditional execution, unaligned-LDR/LDRH rotation, LDRSB/LDRSH quirks, LDM/STM with the ARM7 empty-rlist and base-in-rlist quirks, PUSH/POP incl. `pc`, BX/POP-pc THUMB↔ARM interworking, MUL/MLA/UMULL/SMULL/UMLAL/SMLAL, SWP, and PC-relative literal loads constant-folded straight out of immutable ROM. Verified blocks **chain back-to-back in linear memory** (one register sync per chain, not per block), and RAM-resident blocks are guarded by O(1) **page-generation SMC tracking** (with a checksum confirm that distinguishes data writes from real code changes). Correctness is guaranteed by three independent mechanisms: lifters *bail* on anything they cannot model exactly, every emitted block is *differentially verified* against the interpreter on first run (registers, flags, AND memory effects), and stale RAM code can never run thanks to the SMC guard. The 600-frame Ruby boot benchmark runs **4.8× faster** than the pre-expansion hybrid.

The project began with **PokÃ©mon Ruby / Sapphire** as the bring-up target and follows the same binary-lifting discipline as `gb-pokemon-rom-to-wasm`: decode the real cartridge machine code, lift it to WebAssembly, preserve hardware-visible semantics exactly, and run the unmodified ROM against a host runtime. See the *ARM/THUMB -> WebAssembly recompiler* section below for what is lifted natively today and how correctness is guaranteed.

> Important: this repository does **not** include any commercial ROM, BIOS image, `.sav`, browser localStorage dump, or generated user-state artifact. You must provide your own legally obtained ROM locally.

## What this is

```txt
GBA ROM bytes
â†’ ARM7TDMI ARM/THUMB decoder + interpreter/recompiler-ready core
â†’ BIOS HLE for documented GBA SWIs
â†’ GBA hardware runtime: memory map, MMIO, PPU, DMA, timers, IRQ, audio, Flash, RTC
â†’ browser host: canvas, keyboard/touch, audio, local save persistence
â†’ playable PokÃ©mon Ruby/Sapphire target
```

This is not source assembly compilation and it is not a ROM distribution project. It is an emulator/recompiler research runtime for user-supplied ROM bytes.

## Current target matrix

| Game | Header title | Game code | Save hardware | Runtime status |
|---|---|---:|---|---|
| PokÃ©mon Ruby | `POKEMON RUBY` | `AXVE` | 128K Flash + RTC | Primary playable bring-up target |
| PokÃ©mon Sapphire | `POKEMON SAPP` | `AXPE` | 128K Flash + RTC | Supported sibling target |
| PokÃ©mon Emerald | `POKEMON EMER` | `BPEE` | 128K Flash + RTC | Architecture target; additional game-specific work expected |

## What works now

- ARM7TDMI core with ARM + THUMB execution
- Banked CPU modes, CPSR/SPSR, IRQ/SVC behavior
- GBA memory map: BIOS/EWRAM/IWRAM/MMIO/palette/VRAM/OAM/ROM/Flash
- BIOS HLE for PokÃ©mon-critical SWIs: IntrWait/VBlankIntrWait, CpuSet/CpuFastSet, affine helpers, decompression, math, SoftReset diagnostics
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

Some tests reference local PokÃ©mon ROM paths and therefore require your own ROM files. Commercial ROMs are intentionally not committed.

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
