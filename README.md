# gba-recomp — GBA Pokémon Gen 3 ROM machine-code to browser

`gba-recomp` is an experimental Game Boy Advance ROM-to-browser runtime and recompiler-oriented hardware host for main-line Gen 3 Pokémon games.

It reads a user-provided Pokémon Ruby/Sapphire/Emerald `.gba` ROM locally and runs the ROM's already-assembled ARM7TDMI machine code inside a GBA hardware runtime in the browser. The runtime is a **hybrid recompiler**: ARM **and THUMB** basic blocks are **lifted into real WebAssembly bytecode in-process and executed by the engine** (`new WebAssembly.Module()` - not interpreted). Today **99.9% of executed guest instructions run as engine-run WebAssembly** on the Ruby boot/gameplay path — the only instructions still interpreted are the handful of MSR/MRS mode-plumbing sites and SWI entries into the BIOS HLE. The lifters cover the full data-processing set (incl. ADC/SBC/RSC and register-specified shifts), full conditional execution, unaligned-LDR/LDRH rotation, LDRSB/LDRSH quirks, LDM/STM with the ARM7 empty-rlist and base-in-rlist quirks, PUSH/POP incl. `pc`, BX/POP-pc THUMB↔ARM interworking, MUL/MLA/UMULL/SMULL/UMLAL/SMLAL, SWP, and PC-relative literal loads constant-folded straight out of immutable ROM. Verified blocks **chain back-to-back in linear memory** (one register sync per chain, not per block), and RAM-resident blocks are guarded by O(1) **page-generation SMC tracking** (with a checksum confirm that distinguishes data writes from real code changes). Correctness is guaranteed by three independent mechanisms: lifters *bail* on anything they cannot model exactly, every emitted block is *differentially verified* against the interpreter on first run (registers, flags, AND memory effects), and stale RAM code can never run thanks to the SMC guard. The 600-frame Ruby boot benchmark runs **4.8× faster** than the pre-expansion hybrid.

**Status (June 2026): all five mainline Gen 3 games - Ruby, Sapphire, Emerald, FireRed, LeafGreen - boot, render, and play with framebuffers byte-identical to the reference interpreter at every verified checkpoint, at 99.8-99.9% native WASM coverage and zero verification rejections.** Getting the last three there took four root-caused hardware bugs - a BIOS boot-state contract, a pulled-high serial line, a one-edge RTC timing error, and a PPU blend-gate rule - each found with a purpose-built diagnostic and documented below.

The project began with **Pokémon Ruby / Sapphire** as the bring-up target and follows the same binary-lifting discipline as `gb-pokemon-rom-to-wasm`: decode the real cartridge machine code, lift it to WebAssembly, preserve hardware-visible semantics exactly, and run the unmodified ROM against a host runtime. See the *ARM/THUMB -> WebAssembly recompiler* section below for what is lifted natively today and how correctness is guaranteed.

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

## Current target matrix

| Game | Header title | Game code | Save hardware | Runtime status |
|---|---|---:|---|---|
| Pokémon Ruby | `POKEMON RUBY` | `AXVE` | 128K Flash + RTC | Verified: byte-identical vs interpreter over 600 frames, 99.94% native |
| Pokémon Sapphire | `POKEMON SAPP` | `AXPE` | 128K Flash + RTC | Verified: byte-identical vs interpreter over 600 frames, 99.94% native |
| Pokémon Emerald | `POKEMON EMER` | `BPEE` | 128K Flash + RTC | Verified: boots and animates, byte-identical, 99.8% native |
| Pokémon FireRed | `POKEMON FIRE` | `BPRE` | 128K Flash | Verified: boots and animates, byte-identical, 99.8% native |
| Pokémon LeafGreen | `POKEMON LEAF` | `BPGE` | 128K Flash | Verified: boots and animates, byte-identical, 99.8% native |

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
- **Live in-emulator debugger** (F9 or the ⛏ Debug button): all 16 registers + CPSR flags/mode with a live ARM/THUMB disassembly window around PC; JIT telemetry — cumulative and per-frame **native-WASM vs interpreted** instruction counts, coverage sparkline, blocks compiled/rejected, cache fill, SMC invalidations, bail-reason histogram, hottest native blocks by dispatch count, and an execution-weighted opcode mix; a full 128-sprite OAM atlas decoded live from VRAM/OAM/palette; and decoded MMIO (DISPCNT/DISPSTAT/IE/IF/IME/timers/DMA/keys) with the 512-entry palette. Strictly read-only, ~8 Hz refresh, zero cost while closed
- **Drift-free audio**: emulation paced at the exact GBA frame rate (16.777216 MHz / 280,896 cycles = 59.7275 fps, not a rounded 60), plus dynamic rate control that trims the APU output rate ±2% from audio-queue depth — locking latency at ~93 ms indefinitely instead of drifting out of sync over long play sessions
- Headless agent harness for deterministic input, RAM/CPU observation, SoftReset postmortems, and HBlank stress tests
- Serial I/O (SIO) link-port model: normal 8/32-bit, 16-bit multiplayer, UART, and JOY bus with hardware-correct disconnected-cable semantics, plus a `LocalLinkHub` that links 2-4 machine instances in-process (the `LinkTransport` seam is the designed mount point for a WebRTC link cable)
- Full PSG audio block - square x2 (with frequency sweep), dual-bank wave, noise LFSR, 512 Hz frame sequencer, SOUNDCNT routing and mix ratios - layered onto the Direct Sound path, with the FIFO corrected to the hardware 32 bytes
- Protocol-conformant S-3511A RTC: bit-exact 3-wire serial timing, verified by driving the games' own `siirtc.c` GPIO sequences in tests
- Hardware-correct semi-transparent OBJ rendering: BLDCNT second-target gating, OBJ-over-OBJ never blends
- Multi-game differential harness: every supported game runs on both engines and must produce byte-identical framebuffers at every checkpoint
- Regression suite (20 test files) covering CPU conformance, BIOS affine, boot, frames, multi-game boots, Flash, IRQ wake, THUMB IRQ LR, PPU window/blend, RTC protocol conformance, SIO semantics, PSG behavior, and Ruby Flash sectors

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

## Five games, four root causes, zero hacks

All five mainline Gen 3 games now boot, render, and play **byte-identical to the reference interpreter** at every verified checkpoint, at 99.8-99.9% native WASM coverage with **zero** differential-gate rejections. The recompiler needed *no changes* for the three new games - every blocker was a hardware-model truth, found with a purpose-built instrument and locked with a regression test:

| Symptom | Root cause | The diagnostic that found it |
|---|---|---|
| Emerald/FRLG: white screen forever (168M instructions of busy-wait per 600 frames) | The real BIOS hands off with `DISPCNT=0x0080` (**forced blank**). gflib's `gpu_regs.c` only writes display registers directly during VBlank *or forced blank* - otherwise it defers to the VBlank IRQ handler. Booting with `DISPCNT=0` meant the deferred DISPSTAT write that arms the VBlank IRQ was itself waiting on a VBlank IRQ. | PC histogram (`tools/_probe_spin.ts`) pinned the spin to `WaitForVBlank` at `0x80008ac`; a cold-boot IO trace (`tools/_probe_boot_io.ts`) showed DISPSTAT was never written; pret source archaeology named the contract. Fix: one register at reset. |
| FRLG/Emerald: wireless-adapter probe never terminates | With no link partner, the SI line reads **pulled high** and a master transfer completes with all-1s - that is exactly how the RFU driver detects "no adapter". The runtime had no SIO at all. | New `src/runtime/sio.ts` with hardware-correct disconnected semantics (master completes with 0xFFFFFFFF + serial IRQ; slave never completes; multiplayer no-link slots read 0xFFFF). |
| Emerald: *"the internal battery has run dry"* | The S-3511A presents a data bit on each **falling** SCK edge; the first falling edge after the command byte must *present bit 0*, not skip it. We advanced past it, so every byte the game read was right-shifted one bit: STATUS `0x40` read as `0x20` ("12-hour mode"), BCD datetime garbled. | `tests/rtc_siirtc.test.ts` ports the game's own `siirtc.c` driver loops as a conformance harness and asserts game-visible bytes. Bonus: the old Ruby battery-warning PC hack was masking this same bug - **deleted**. |
| FireRed/LeafGreen: Professor Oak invisible in his own intro | Semi-transparent OBJ (mode 1) must blend **only** when the pixel beneath is a BLDCNT second target (and OBJ-over-OBJ never blends) - otherwise it draws fully opaque. We blended unconditionally; with `BLDCNT=0/BLDALPHA=0` that painted sprites black. | 3-way render diff (`tools/_sprite_blend_probe.ts`): normal vs sprites-off vs forced-opaque separated "doesn't exist" from "exists but invisible"; a scripted-input driver (`tools/_input_probe.ts`) reached the intro headlessly. After the fix, forced-opaque diffs **0 pixels** vs normal - the hardware-semantics proof. |

The link-port model is built around a `LinkTransport` seam; the in-process `LocalLinkHub` already links 2-4 machine instances with real multiplayer data exchange (verified in tests), and a WebRTC adapter on the same four-method interface is the designed path to browser-to-browser trading.

The debugging doctrine that all four fixes followed: **locate (histogram) -> observe (IO trace) -> understand (pret source) -> prove (differential instrument) -> lock (regression test)**. Sections 16-17 of the technical writeup tell the full story.

## Documentation

- [`docs.md`](docs.md) — usage & developer guide: quick start, controls, saves, running the tests, measuring coverage, the diagnostic toolkit, programmatic use, project structure.
- [`TECHNICAL_WRITEUP.md`](TECHNICAL_WRITEUP.md) — the full engineering field note: cartridge parsing, ARM7TDMI contract, BIOS HLE, PPU/DMA/IRQ, Flash/RTC, the ARM→WASM recompiler, self-modifying-code guards, differential verification, the optimization campaign, and the Gen 3 five-game debugging war stories (sections 16–17).
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
node --experimental-strip-types tests/frames_multigame.test.ts
node --experimental-strip-types tests/rtc_siirtc.test.ts
node --experimental-strip-types tests/sio.test.ts
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
