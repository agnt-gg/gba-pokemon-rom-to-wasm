# gba-recomp — usage & developer guide

Everything you need to run, test, measure, and hack on the recompiler. For the *why and how it works*, read [`TECHNICAL_WRITEUP.md`](TECHNICAL_WRITEUP.md).

## Contents

- [Requirements](#requirements)
- [Quick start: play a ROM](#quick-start-play-a-rom)
- [Controls & frontend UI](#controls--frontend-ui)
- [Saves](#saves)
- [Running the tests](#running-the-tests)
- [Measuring native WASM coverage](#measuring-native-wasm-coverage)
- [The diagnostic toolkit](#the-diagnostic-toolkit)
- [Using the machine programmatically](#using-the-machine-programmatically)
- [Linking two machines (multiplayer groundwork)](#linking-two-machines-multiplayer-groundwork)
- [Project structure](#project-structure)
- [Legal note](#legal-note)

---

## Requirements

| Dependency | Version | Why |
|---|---|---|
| Node.js | **22+** | everything runs via `--experimental-strip-types` — TypeScript executes directly, **no build step** for tests/tools |
| npm | any recent | one dev dependency (`esbuild`) for the browser bundle |
| ffmpeg | optional | only used by diagnostic tools to convert `.ppm` screenshots to `.png` |
| A GBA ROM | your own | `.gba` files are never committed; you supply them locally |

```bash
git clone https://github.com/agnt-gg/gba-pokemon-rom-to-wasm.git
cd gba-pokemon-rom-to-wasm
npm install
```

## Quick start: play a ROM

```bash
npm run build:web   # bundles src/browser/main.ts -> web/js/gba.js (esbuild, ~100ms)
npm run serve       # static server on http://localhost:8077/
```

Open **http://localhost:8077/**, then load your `.gba` ROM with the file picker — or just **drag-and-drop** the file onto the page. The ROM is read locally in your browser; nothing is uploaded anywhere.

Verified targets (byte-identical to the reference interpreter at every checkpoint):

| Game | Code | Native WASM coverage |
|---|---|---|
| Pokémon Ruby / Sapphire | AXVE / AXPE | 99.94% |
| Pokémon Emerald | BPEE | 99.8% |
| Pokémon FireRed / LeafGreen | BPRE / BPGE | 99.8% |

Other GBA ROMs may work (the CPU core passes the full jsmolka conformance suite) but are untested — see the writeup's roadmap.

## Controls & frontend UI

Keyboard (VBA-style defaults):

| Key | GBA button |
|---|---|
| <kbd>Z</kbd> | A |
| <kbd>X</kbd> | B |
| <kbd>Enter</kbd> | START |
| <kbd>Right Shift</kbd> or <kbd>Backspace</kbd> | SELECT |
| <kbd>A</kbd> / <kbd>S</kbd> | L / R |
| Arrow keys | D-pad |
| <kbd>Space</kbd> | pause / resume |

The page also has a full **on-screen touch pad** (D-pad, A/B, L/R, START/SELECT) for mobile.

Toolbar:

| Control | Effect |
|---|---|
| ⏯ Pause | pause/resume emulation (same as <kbd>Space</kbd>) |
| ⟲ Reset | hard reset, ROM stays loaded |
| 🔇 Audio | toggle the AudioContext sink |
| Speed `0.5× / 1× / 2× / 4×` | realtime pacing multiplier |
| Export Save | download the current battery save as a `.sav` file (raw 128 KiB flash image, compatible with mGBA/VBA) |
| Clear Save | wipe the persisted save for this game |
| ⧉ Screenshot | download the current frame as PNG |
| ⛏ Debug | live debugger: registers, disassembly around PC, JIT-vs-interpreter telemetry, OAM sprite atlas, IO/MMIO inspector |

## Saves

- Battery saves (Flash 128K) **auto-persist to `localStorage`**, namespaced by game code — Ruby and Emerald saves don't collide.
- **Export Save** produces a standard raw `.sav` you can load in mGBA/VBA, and vice versa: a desktop-emulator `.sav` of the right size can be imported by loading the ROM and replacing the stored save (or just play on — the in-game save flow writes through the real Flash command protocol).
- RTC state is host-clock-backed (S-3511A protocol-conformant), so time-of-day events in Ruby/Sapphire/Emerald just work.

## Running the tests

The suite is 20 self-contained test files. Each runs standalone:

```bash
node --experimental-strip-types tests/cpu_suite.test.ts        # jsmolka ARM+THUMB conformance (committed MIT ROMs)
node --experimental-strip-types tests/recompiler_diff.test.ts  # lifter-vs-interpreter differential
node --experimental-strip-types tests/sio.test.ts              # link-port semantics
node --experimental-strip-types tests/psg.test.ts              # PSG audio behavior
node --experimental-strip-types tests/rtc_siirtc.test.ts       # RTC protocol conformance (drives the game's own driver sequences)
```

Run everything:

```bash
# bash / zsh
for t in tests/*.test.ts; do node --experimental-strip-types "$t" || break; done

# PowerShell
Get-ChildItem tests/*.test.ts | ForEach-Object { node --experimental-strip-types $_.FullName }

# or via Node's test runner (single process, TAP output)
node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts   # bash globs the files
```

**ROM-dependent tests** (`boot_ruby`, `frames_ruby`, `frames_multigame`, `flash_*`, `ruby_flash_sector`, `pokemon_flash_hle`, `rtc_boot_stable`) read your local ROM files. The paths are constants at the top of each test file — edit them to match your machine. Tests that can't find a ROM skip rather than fail where possible. Hardware/CPU tests (`cpu_suite`, `sio`, `psg`, `rtc_siirtc`, `wasm_encoder`, `arm_core`, …) need no ROMs at all.

## Measuring native WASM coverage

```bash
node --experimental-strip-types tools/recomp_coverage.ts "path/to/rom.gba" 600
```

Sample output (Emerald, 600 frames):

```txt
total guest instrs    : 168,455,085
native (WASM) instrs  : 168,052,534
native coverage       : 99.8%
blocks compiled       : 1,856
blocks rejected (gate): 0
--- bail reasons (block discovery) ---
  A:psr                    16
  T:swi                    5
```

The bail-reason histogram is the steering wheel: if you're extending the lifters, aim at the heaviest bucket. Useful env knobs (read by the tools):

| Env var | Effect |
|---|---|
| `RECOMP_DEBUG=1` | verbose recompiler logging |
| `NO_NATIVE_WHEN_TIMERS=1` | disable the native fast path near timer activity (timing-bug isolation) |
| `THUMB_MAXLEN=n` / `THUMB_DISABLE=grp` | shrink/disable lifter groups (divergence bisection) |
| `FRAMES=n` | frame count for `_multirom_probe` |

## The diagnostic toolkit

All committed under `tools/`, all rerunnable. This is the kit that root-caused every bug in the writeup:

| Tool | Purpose | Invocation |
|---|---|---|
| `_multirom_probe.ts` | run every supported game on **both** engines, hash framebuffers at checkpoints, report coverage + SMC counts. The fleet-wide regression gate. | `node --experimental-strip-types tools/_multirom_probe.ts` |
| `_probe_spin.ts` | PC-sample histogram with decoded code windows, IRQ state, recent SWIs — find where a game is stuck | `... tools/_probe_spin.ts "<rom>" [frames]` |
| `_probe_boot_io.ts` | watch-list IO write trace + IRQ requests from cold boot — find the register that was never written | `... tools/_probe_boot_io.ts "<rom>" [frames]` |
| `_input_probe.ts` | scripted-input headless playthrough with screenshots + OAM/VRAM dumps — reach any screen without a human | `... tools/_input_probe.ts "<rom>" <tag> <frames> "<script>"` |
| `_sprite_blend_probe.ts` | 3-way render diff (normal / sprites-off / forced-opaque) — separates "doesn't exist" from "exists but invisible" | `... tools/_sprite_blend_probe.ts "<rom>" <frames> "<script>"` |
| `_lockstep_diff.ts` | frame-granular interpreter-vs-recompiler lockstep divergence hunt | see file header |
| `capture.ts` | frame capture utility | `npm run capture` |

Input-script syntax for `_input_probe` / `_sprite_blend_probe`: semicolon-separated events, each `frame:KEY` or `from-to/step:KEY` (press every `step` frames across the range). Keys: `A B SELECT START RIGHT LEFT UP DOWN R L`.

```bash
# boot FireRed, mash START through the title, then A through the intro, 4800 frames:
node --experimental-strip-types tools/_input_probe.ts "FireRed.gba" fr 4800 "600-1500/120:START;1560-4800/90:A"
```

## Using the machine programmatically

The whole emulator is a plain TypeScript class — no browser required. This is exactly how the tests and tools drive it:

```ts
import { readFileSync } from 'node:fs';
import { GbaMachine } from './src/runtime/machine.ts';

const m = new GbaMachine(new Uint8Array(readFileSync('rom.gba')));

m.runFrame();                    // advance exactly one frame (~280,896 cycles)
m.setKeys(0x3ff & ~(1 << 0));    // press A (active-low bitmask, bit 0 = A ... bit 9 = L)
const fb = m.ppu.framebuffer;    // 240x160 RGBA bytes, ready for putImageData

m.useRecompiler = false;         // force pure-interpreter mode (the verification oracle)
const r = m.recompiler;          // stats: nativeInstrs, blocksCompiled, smcInvalidations, ...
```

Run it with `node --experimental-strip-types your_script.ts`. The differential pattern — run two machines, one per engine, and compare `framebuffer` hashes — is the project's core verification idiom and fits in ~20 lines (see `tests/frames_multigame.test.ts`).

## Linking two machines (multiplayer groundwork)

The SIO model exposes a transport seam. In-process linking works today:

```ts
import { LocalLinkHub } from './src/runtime/sio.ts';

const hub = new LocalLinkHub();
hub.attach(a.sio);   // machine a -> parent (ID 0)
hub.attach(b.sio);   // machine b -> child  (ID 1)
// run frames on both; multiplayer transfers exchange real data words,
// with correct IDs, SD/SI status bits, and serial IRQs on both sides.
```

A browser-to-browser link cable is a `LinkTransport` implementation away (four methods over a WebRTC DataChannel) — see the writeup's roadmap.

## Project structure

```txt
src/
  recompiler/
    recompiler.ts      block discovery, cache, SMC guards, chaining, differential gate
    arm_lifter.ts      ARM instruction -> WASM bytecode
    thumb_lifter.ts    THUMB instruction -> WASM bytecode
    wasm_encoder.ts    raw WebAssembly module emission
    abi.ts             register-file layout in linear memory
  runtime/
    machine.ts         the GBA: wires CPU, bus, and all hardware together
    memory.ts          bus + memory map (BIOS/EWRAM/IWRAM/IO/VRAM/ROM/backup)
    bios_hle.ts        SWI replacements (CpuSet, LZ77, IntrWait, ...)
    ppu.ts             scanline renderer: text/affine BG, sprites, windows, blending
    dma.ts  timers.ts  interrupts.ts  io.ts
    audio.ts           Direct Sound FIFOs + full PSG block
    sio.ts             link port (normal/multi/UART/JOY) + LocalLinkHub
    flash.ts           128K Flash command protocol + persistence
    rtc.ts             S-3511A real-time clock (GPIO bit-banged serial)
  browser/
    main.ts            frontend host: canvas, input, audio sink, saves, debugger
tests/                 20 self-contained test files (see Running the tests)
tools/                 coverage meter + the diagnostic toolkit
web/                   static frontend (index.html + bundled js)
```

## Legal note

This repository implements public GBA hardware behavior from public documentation (GBATEK conventions and the pret decompilation projects' symbol knowledge). It contains **no Nintendo BIOS code and no commercial ROMs** — you must supply your own legally obtained ROM files. The only committed `.gba` files are the MIT-licensed jsmolka CPU conformance ROMs.
