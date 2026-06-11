# From Pokémon Ruby/Sapphire ROM bytes to a live browser GBA

> Research note · AGNT autonomous build system · 2026-06-06

An implementation-level account of the GBA recompilation/runtime pipeline: cartridge parsing, ARM7TDMI execution, BIOS replacement, scanline hardware, Flash/RTC persistence, browser hosting, and the autonomous debugging machinery that turned opaque game resets into measurable CPU invariants.

`AXVE / AXPE` · `ARM7TDMI` · `THUMB + ARM` · `BIOS SWI HLE` · `PPU scanlines` · `DMA / Timers / IRQ` · `Flash 128K` · `RTC GPIO` · `ARM->WASM JIT` · `SMC guard` · `bit-exact verified`

---

## 00 · Premise

A GBA Pokémon ROM is not “a game file” in the way a web application is a bundle. It is machine code plus data designed to run against a very specific handheld computer: an ARM7TDMI CPU, a BIOS, memory-mapped video hardware, DMA engines, timers, audio FIFOs, keypad input, Flash save chips, and serial/GPIO devices such as the real-time clock.

The project’s job is to present an unmodified retail Ruby/Sapphire ROM with a convincing machine. The browser is only the outer shell. The core problem is architectural fidelity: the ROM must observe the same register side effects, interrupt return semantics, memory aliasing, scanline cadence, save-chip behavior, and BIOS helper results it expects from the original GBA.
- **16 MiB** — Retail Ruby/Sapphire ROM size
- **280,896** — Cycles per GBA frame approximation
- **0x08000000** — GamePak ROM execution base

```txt
ROM bytes
  ├─ Nintendo header: title, game code, entrypoint, checksum
  ├─ ARM code, THUMB code, literal pools, jump tables
  ├─ compressed tiles/maps/palettes/sprites/scripts
  └─ save type strings / Flash command assumptions
        │
        ▼
GBA runtime contract
  CPU + bus + BIOS HLE + PPU + DMA + timers + IRQ + Flash + RTC
        │
        ▼
Browser host
  canvas pixels, keyboard/touch, AudioContext, localStorage save persistence
```

---

## 01 · Cartridge identity and memory map

Ruby and Sapphire identify as `AXVE` and `AXPE`. That identity is not cosmetic: it selects save behavior, RTC handling, boot workarounds, and browser persistence namespaces. The runtime maps the ROM at the cartridge address window and routes every CPU load/store through a bus that knows the GBA memory layout.

| Region | Address range | Function | Implementation consequence |
|---|---|---|---|
| BIOS | `00000000-00003FFF` | Nintendo boot/SWI/IRQ code | Not shipped. Replaced with documented HLE for SWIs and an HLE IRQ dispatcher. |
| EWRAM | `02000000-0203FFFF` | 256 KiB external RAM | Save blocks, script state, task structures, OAM mirrors, affine buffers, transition tables. |
| IWRAM | `03000000-03007FFF` | 32 KiB fast internal RAM | Pokémon copies IRQ handlers and hot routines here; banked SPs live here after BIOS init. |
| I/O | `04000000-040003FF` | MMIO registers | PPU, DMA, timers, keypad, sound, IE/IF/IME, waitstate control, serial/GPIO. |
| Palette / VRAM / OAM | `05000000 / 06000000 / 07000000` | Graphics memory | Requires halfword/word behavior, scanline rendering, tile and sprite interpretation. |
| GamePak ROM | `08000000+` | Executable cartridge space | ARM/THUMB opcodes, data tables, literal pools; reads from the retail ROM bytes. |
| Backup | `0E000000+` | SRAM/Flash/EEPROM window | Ruby/Sapphire use Flash command protocols and two rotating save slots. |

---

## 02 · ARM7TDMI as the contract surface

The CPU core is the center of the system. The ROM alternates between ARM and THUMB state, uses banked exception modes, depends on pipeline-visible PC behavior, and expects exact flag semantics. A single wrong offset in `r15` or `LR_irq` can boot for minutes and then destroy a transition scene.

### State modeled

**Registers.** `r0-r15`, CPSR, SPSR for exception modes, banked SP/LR for SVC/IRQ, system/user register sharing.

**ARM classes.** Data processing, immediate/register shifts, multiply, long multiply, branch/BX, load/store, halfword/signed transfers, block transfers, SWI.

**THUMB classes.** Shift/add/sub, immediates, ALU ops, high-register ops/BX, PC-relative loads, SP-relative loads, push/pop, block transfers, conditional branches, SWI, BL pairs.

**Quirks.** Empty register lists, base-in-list writeback, PC reads, STR PC values, banked LR/SPSR interactions.

```txt
// IRQ delivery now uses one rule for ARM and THUMB:
// r15 already points at the next instruction when poll() runs.
// BIOS-style return lands at LR_irq - 4.
const retAddr = (st.r[15] + 4) >>> 0;
```

> The most expensive bugs were not broad missing features. They were one-instruction contract errors: a THUMB IRQ return offset, an LDM writeback quirk, a BIOS IntrWait flag-clearing detail. Pokémon is an excellent hardware test because it combines copied IWRAM routines, nested IRQs, SWIs, DMA, and save-state machines.

---

## 03 · ROM execution model and the path to WASM

The core executes the ROM through a **hybrid recompiler**: ARM and THUMB basic blocks are lifted into real WebAssembly bytecode in-process (`new WebAssembly.Module()`) and run by the engine, with a reference interpreter as the verification oracle and fallback. On the measured Ruby boot/gameplay path, **99.9% of executed guest instructions run as engine-executed WASM** — the only interpreted instructions left are a handful of MSR/MRS mode-plumbing sites and SWI entries into the BIOS HLE. The architectural separation is exactly the one a static or hybrid recompiler uses: decode guest instructions into a host-level form, preserve all guest-visible side effects, and route hardware interaction through imports.

```txt
Static/hybrid recompilation shape

ROM block discovery
  ├─ entrypoint from header
  ├─ direct branch/BL targets
  ├─ interrupt handler entrypoints copied to IWRAM
  ├─ switch/jump tables and literal pools
  └─ dynamic fallback for unresolved indirect branches

Lowering
  ARM/THUMB opcode → IR/basic block → WASM function

Host imports
  load8/load16/load32, store8/store16/store32,
  request_irq, dma_step, ppu_step, timer_step, bios_swi,
  read_keyinput, flash_command, rtc_gpio
```

The GBA version is harder than a single Game Boy ROM because the CPU has two instruction sets, multiple exception modes, a much denser MMIO surface, DMA channels that can run at HBlank/VBlank, and games that copy executable routines into IWRAM. Any full static compiler needs a dynamic escape hatch for indirect branches and RAM-resident routines.

---

## 04 · BIOS replacement: SWI HLE

The project does not ship Nintendo BIOS code. Instead, documented BIOS functions are implemented as high-level handlers. This is enough because Pokémon mostly depends on deterministic services: waits, copies, decompression, affine math, and reset behavior.

| SWI | Name | Why Pokémon cares |
|---|---|---|
| `00h` | SoftReset | Reset behavior and crash diagnostic hook. |
| `04h/05h` | IntrWait / VBlankIntrWait | Main-loop pacing. Must interact correctly with BIOS-IF at `0x03007FF8`. |
| `06h-08h` | Div / DivArm / Sqrt | Gameplay and transform math. |
| `0Bh/0Ch` | CpuSet / CpuFastSet | Bulk fills/copies to EWRAM, VRAM, OAM mirrors, transition buffers. |
| `0Eh/0Fh` | BgAffineSet / ObjAffineSet | Matrix generation for rotating/scaling backgrounds and sprites. |
| `11h-15h` | LZ77 / Huffman / RLE | Graphics and map asset decompression. |

Two BIOS details were decisive: `IntrWait` must not repeatedly discard the same old flags after being rewound, and BIOS-IF must be updated by the IRQ dispatch path rather than polluted speculatively by every HBlank request.

---

## 05 · PPU, DMA, scanline timing

Ruby/Sapphire do not merely draw frames. They schedule effects around scanline phases. HBlank IRQs and HBlank DMA are active in trainer-card, battle, and transition scenes. The runtime therefore advances hardware in scanline-sized phases rather than pretending graphics are a single end-of-frame operation.

```txt
One frame, approximated

228 scanlines × 1232 cycles
  visible lines 0..159
    HDraw: background/sprite preparation
    HBlank: render scanline, optional HBlank IRQ, HBlank DMA
  line 160
    enter VBlank, request VBlank IRQ, VBlank DMA, latch framebuffer
  lines 160..227
    game runs post-frame tasks, copies OAM/palette/tile data, services audio/timers
```

The PPU implements enough tiled background, sprite, palette, window, and blend behavior for Ruby to boot and render. DMA integrates with the same timing model so transfers happen at the same phase the ROM expects.

---

## 06 · Flash saves and RTC

Ruby/Sapphire use Flash backup, with sector erase/program commands and rotating save sectors. The browser persists the Flash array into localStorage using versioned keys. The save model must tolerate partial-sector updates and only flush at safe times; synchronous browser stalls in the middle of a Flash polling loop can become gameplay-visible.

The RTC path matters because Ruby/Sapphire/Emerald use a GPIO-connected real-time clock. If the RTC/status path is absent or stale, the game can hang in boot/menu state machines or show the internal-battery warning. The runtime includes RTC HLE sufficient to report a sane battery/status/date-time path for the Gen 3 boot checks.

---

## 07 · Browser host

The browser wrapper is deliberately thin. It uploads the ROM locally, constructs `GbaMachine`, repeatedly calls `runFrame()`, copies the framebuffer into a canvas, maps keyboard/touch into GBA KEYINPUT bits, drains audio samples into an AudioContext sink, and persists Flash data.

| Host feature | Guest-visible behavior |
|---|---|
| Canvas | Receives 240×160 framebuffer data generated by the PPU. |
| Keyboard/touch | Mapped to active-low KEYINPUT bits. |
| AudioContext | Consumes FIFO/timer-generated PCM samples. |
| localStorage | Stores 128 KiB Flash save blobs per game code/title. |
| Cache-busted bundle | Prevents stale emulator code after rebuilds. |

---

## 08 · Autonomous instrumentation

The system was made debuggable by agents that run the emulator without a browser and convert visual/player complaints into CPU facts. These agents inspect memory, drive deterministic input, force IRQ stress, trap SoftReset, and summarize liveness.

### State-aware input

Agents can tap/hold GBA buttons, run exact frame counts, snapshot PC/IE/IF/DISPCNT, calculate framebuffer signatures, and identify whether a screen is static-but-alive or genuinely wedged.

### SoftReset postmortem

Every reset captures PC, LR, frame, recent SWIs, caller code, IE/IF, DISPCNT, and Flash dirty state.

### HBlank pressure tests

Dedicated scripts keep HBlank IRQ pressure high for hundreds/thousands of frames and fail on garbage SWIs or SoftReset.

### RAM-diff strategy

For gameplay state, the agent compares RAM snapshots across controlled movements and interactions. Candidate addresses are accepted only if they change with the expected input and revert with opposite input. This is how a black-box ROM becomes a measurable state machine.

---

## 09 · Failure archaeology

The hardest part of the project was not writing the happy path; it was refusing to accept plausible explanations. Several hypotheses explained part of the symptom and were then falsified by better diagnostics.
1. **White-screen boot.** CPU conformance passed but Ruby did not progress. The issue was a BIOS IntrWait/VBlankIntrWait handshake that re-cleared BIOS-IF on every re-entry.
2. **RTC/save gate.** Ruby advanced to a state where an async RTC/save task stayed busy. GPIO RTC HLE unblocked the boot path.
3. **Trainer-card / encounter reset.** Live logs showed `IE=0x3`, `IF=0x2`, `DISPCNT=0x7f60`, then execution from `0x020200xx` data.
4. **False roots removed.** CpuSet overrun, ObjAffineSet stride, SoftReset flag logic, speculative BIOS-IF, and nested sentinel bugs were investigated. Some were improved; none fully matched the final repeated fingerprint.
5. **Final invariant.** HBlank interrupts were returning THUMB code to the interrupted halfword. Under repeated HBlank pressure, this corrupts control flow until data is executed as code.

```txt
Representative live fingerprint

SoftReset from pc=0x020200d0
lr=0x0806065d
IE=0x3, IF=0x2, DISPCNT=0x7f60
recent SWIs:
  VBlankIntrWait, CpuSet, ObjAffineSet, ObjAffineSet, ...
  0xc0 @ 0x0202006c   // garbage SWI from EWRAM data
  0x00 @ 0x020200d0   // SoftReset
```

---

## 10 · IRQ return correction

IRQ exception entry stores a return address in `LR_irq`. The BIOS-style return subtracts four. In this interpreter, IRQ delivery happens after an instruction has completed and `r15` already points at the next guest instruction. Therefore the stored IRQ LR must be `next + 4` for both ARM and THUMB.

```txt
Old THUMB IRQ path
  r15 = next
  LR_irq = next + 2
  return PC = LR_irq - 4 = next - 2   ← re-executes interrupted halfword

Correct path
  r15 = next
  LR_irq = next + 4
  return PC = LR_irq - 4 = next       ← resumes exactly after interrupted instruction
```

The regression `irq_thumb_lr.test.ts` constructs a tiny CPU/IO/IRQ environment, delivers an IRQ from THUMB state, captures banked `LR_irq`, performs the BIOS-style return, and asserts the PC lands on the next THUMB instruction.

> **Current build:** `20260606-irqlrthumbfix`. The fix is committed as `f5709c4 fix(gba): correct IRQ LR for THUMB HBlank interrupts`.

---

## 11 · Validation matrix

| Validation | Coverage | Result |
|---|---|---|
| `arm_core.test.ts` | Instruction-level CPU checks | 27 passed, 0 failed |
| `boot_ruby.test.ts` | Ruby boot and machine progress | 6 passed, 0 failed |
| `frames_ruby.test.ts` | Frame loop / PPU / timing health | 5 passed, 0 failed |
| `irq_wake.test.ts` | IntrWait wake and IRQ dispatch | 2 passed, 0 failed |
| `irq_thumb_lr.test.ts` | THUMB IRQ return offset regression | 1 passed, 0 failed |
| `verify-nested-forced.ts` | 1500-frame HBlank IRQ storm | SoftResets=0, garbage SWIs=0, framesAlive=1500/1500 |
| `verify-nested-irq.ts` | PPU-driven HBlank stress | SoftResets=0, garbage SWIs=0 |
| `flash_* / ruby_flash_sector` | Flash save behavior | sector/program tests pass |
| `rtc_boot_stable.test.ts` | RTC boot/menu stability | 3 passed, 0 failed |

---

## 12 -- The ARM/THUMB -> WebAssembly recompiler

The interpreter proved the machine contract. The recompiler turns that contract into native speed: it reads the guest's own ARM7TDMI instruction stream and emits real WebAssembly functions at runtime, one per basic block, that the browser's JIT then compiles to machine code. This is not transpilation of source -- there is no source. It is binary translation of the cartridge's compiled code into a second compiled form the browser can run directly.

### Why a recompiler at all

A decode-and-dispatch interpreter pays a tax on *every* guest instruction: fetch the opcode, branch through a giant switch, unpack operands, mutate a register file held in JS objects, repeat. For a 16.78 MHz CPU rendering 60 frames/second that tax dominates. A recompiler pays the decode cost **once per block**, bakes the operand math into straight-line WASM, keeps the hot register file in linear memory, and lets the host turn the result into native code. The interpreter never goes away -- it remains the oracle and the fallback -- but the bulk of execution moves to compiled blocks.

### The pipeline, end to end

```txt
guest ROM/RAM bytes
   |
   v
[1] block discovery     start at PC, decode forward until a branch/unknown op
   |                    (compileBlock for ARM, compileBlockThumb for THUMB)
   v
[2] per-instruction     each instr -> liftArm() / liftThumb() emits WASM ops
    lifting             into a shared CodeBuilder; unsupported instrs "bail"
   |                    and end the block early
   v
[3] WASM module         wasm_encoder.ts writes a one-function module:
    assembly            (func (result i32) ... return nextPc)
   |                    imports: env.mem (guest RAM) + host read/write helpers
   v
[4] instantiate         new WebAssembly.Module + Instance, exports.block()
   |                    cached by start PC (separate ARM and THUMB caches)
   v
[5] execute             block.fn() runs to completion, returns the next PC;
   |                    host JIT compiles the hot ones to native
   v
[6] hardware step       cycles returned feed PPU/DMA/timer/audio/IRQ exactly
                        as the interpreter path does -- identical ordering
```

### The register file lives in linear memory

The single most important design decision is that compiled blocks do **not** touch the JS `cpu.st` object directly. The 16 ARM registers, the CPSR, and the intra-block cycle counter live at fixed offsets inside the WASM module's linear memory (the same `ArrayBuffer` the guest RAM uses). A lifted `ADD r2, r0, r1` becomes three memory ops -- load r0, load r1, store the sum to r2's slot -- with no function-call boundary. `syncIn` copies the JS register file into linear memory before a block runs; `syncOut` copies it back when control returns to JS. Everything in between is pure WASM integer math.

```txt
linear memory layout (conceptual)
  0x.. r0  r1  r2 ... r15   CPSR   CYCLES   ...guest RAM follows...
       ^------- register file -------^
  loadReg(n)  = i32.load  (regOff(n))
  storeReg(n) = i32.store (regOff(n), value)
```

### Lifting an instruction: a concrete example

THUMB `NEG r2, r2` (a quirky ALU op: `0 - r2`, with carry set when the operand was zero and a specific overflow rule) compiles to:

```txt
loadReg(rs) -> local L_B          ; read the source register from memory
i32.const 0
local.get L_B
i32.sub      -> local L_RES        ; 0 - r2
storeRegFromLocal(rd, L_RES)       ; write result back to r2's slot
setNZ(L_RES)                       ; N/Z from the result
setCF( L_B == 0 )                  ; carry = operand was zero  (ARM quirk)
setVF( (L_B & L_RES) >> 31 )       ; overflow per the interpreter's exact rule
```

The flag rules are not "ARM textbook" -- they are copied *bit for bit* from what the interpreter does, because the interpreter is the contract. Any deviation, no matter how academically defensible, would diverge from real hardware behavior the game depends on.

### What gets lifted, what bails

The lifters now model essentially the whole user-mode instruction set, including the semantics that were originally deferred as "subtle": the ARM7 **unaligned word-LDR rotation** is emitted natively as `rotr(read32(addr & ~3), 8*(addr & 3))` (branchless — `rotr` by 0 is the identity); **BX and POP {pc}** perform the THUMB&harr;ARM mode switch by rewriting the CPSR T bit in linear memory so the dispatcher picks the right instruction set for the next block; **LDM/STM register lists are unrolled at compile time** (the list is a compile-time constant) including the ARM7 empty-rlist and STM base-in-rlist quirks; **full conditional execution** wraps any liftable body in an `if(cond)` block with an architectural `else PC=pc+4`; ADC/SBC/RSC take carry-in from the exploded C flag with an exact two-step carry-out; register-specified shifts reproduce the barrel shifter's &ge;32 edge cases; long multiplies use i64 math; and `ldr rd, [pc, #imm]` literal-pool loads from immutable ROM are **constant-folded into `i32.const`** — zero host calls. What still bails: MSR/MRS (banked-mode plumbing), SWI (BIOS HLE entry), LDM/STM with the S bit, and DP ops writing PC (exception returns). A bail ends the block; the interpreter executes that instruction and compilation resumes at the next PC. This is still the "hybrid" guarantee — **correctness is never traded for coverage** — but the measured outcome is now 99.9% native on the Ruby boot path, with a bail-reason telemetry histogram in the coverage tool proving the residue is exactly 16 MSR/MRS sites and 6 SWI sites.

> **Design rule, evolved:** v1's rule was "a lifter must decide to bail *before* it emits any WASM" — two early load lifters left dead, half-finished code in the shared builder by bailing late. v2 replaces the convention with a **mechanical guarantee**: the block builder snapshots the CodeBuilder length before every lift and truncates back to it on any bail. Lifters are now free to bail at any point (which the full-coverage lifters need — e.g. a register-shifted logical S-op discovers its dynamic-carry case mid-decode), and partial emission can never corrupt a block by construction.

---

## 13 -- The hardest bug: self-modifying code

Pokemon Ruby boots, runs hundreds of frames identically to the interpreter, and then -- on exactly one frame, deep inside a copy routine -- the recompiled run takes a branch the interpreter does not. The screen that should appear never does. This was the single hardest defect in the entire project, and its root cause is one of the oldest hazards in dynamic binary translation.

### The symptom

A frame-accurate differential harness rendered the same frame on both engines and compared the framebuffers byte for byte. Most frames were identical. A handful were not. Walking the divergence backward through a register trace produced a precise, baffling fact:

```txt
frame 168, inside a routine at 0x3007d6a (IWRAM)
  interpreter: r2 = 0xFFFFFFFF   (correct)
  recompiler:  r2 = 0x00001000   (wrong)

  the diverging instruction was NEG r2,r2 -- but NEG was correct.
  its INPUT r2 was already wrong on entry... no, the ENTRY regs
  were identical in both engines. so the block itself ran wrong.
```

Entry registers matched. The NEG lifter was provably correct in isolation. The block at `0x3007d6a` nonetheless produced a different result in the recompiler than in the interpreter. A block that is correct per-instruction, given identical inputs, that still produces a different output, is a contradiction -- unless the bytes the block was compiled from are not the bytes that are there now.

### The cause

The address `0x3007d6a` is in **IWRAM** -- writable work RAM, not ROM. Pokemon, like many GBA titles, *copies routines into RAM and runs them there*, and reuses the same RAM region for different code at different times (a hand-rolled overlay/relocation scheme). The recompiler cached every compiled block keyed only by its start PC. When the game later overwrote the bytes at `0x3007d6a` with a *different* routine, the cache still held the WASM compiled from the *old* bytes. The next call to that PC ran stale native code -- a memcpy loop whose terminating compare-and-branch belonged to a function that no longer existed in memory. It took the wrong branch, corrupted `r2`, and the boot state machine wedged.

```txt
stale-block hazard

  t0:  game writes routine A to 0x3007d6a
       recompiler compiles block(A), caches it under PC 0x3007d6a
  t1:  game OVERWRITES 0x3007d6a with routine B
  t2:  game calls 0x3007d6a
       recompiler cache HIT -> runs block(A)    runs B  <-- correct
```

### The fix: a self-modifying-code guard

Every block compiled from a writable region (IWRAM at `0x03......`, EWRAM at `0x02......`) now carries an **FNV-1a checksum of the exact instruction bytes it was lifted from**, plus the byte length it covers. On every cache lookup the recompiler re-hashes the live bytes at that PC and compares. A match means the code is unchanged and the cached block is safe to run. A mismatch means the RAM has been rewritten: the stale block is discarded and the PC is recompiled from the bytes that are actually there. Blocks compiled from ROM and BIOS -- which can never change -- carry a guard of `0` and skip the check entirely, so the immutable hot path pays nothing.

```txt
// on lookup, for a RAM-resident block:
if (block.guard === 0 || checksum(pc, block.guardLen) === block.guard)
    return block;        // unchanged -> safe
cache.delete(pc);        // stale -> drop it
recompile(pc);           // re-lift from the live bytes
```

This is the classic correctness mechanism real JITs use for self-modifying code, specialized to the GBA: a cheap content hash gates the cache so relocated/overwritten routines can never run as their previous incarnation. With the guard in place, the recompiler's framebuffers became **byte-for-byte identical to the interpreter across every tested frame from boot through gameplay**.

> **Why a checksum and not a write-invalidation hook?** Trapping every guest store to test whether it lands in a cached block's byte range is possible but expensive on the GBA's tight store-heavy loops, and it is easy to get wrong (partial-word writes, DMA-driven copies, BIOS LZ77/Huffman decompressors writing code). A lazy checksum at lookup time is simpler, has no per-store cost, and is impossible to bypass: if the bytes differ, the hash differs, period.

---

## 14 -- Differential self-verification

A recompiler is only trustworthy if it can prove, at runtime, that each block it emits behaves exactly like the interpreter it is replacing. The engine does precisely this on a block's first execution, and only "trusts" a block after it has matched the oracle.

### The verification gate

The first time a freshly compiled block runs, the recompiler:

```txt
first-run verification of block(PC)

  1. snapshot register file + CPSR
  2. (store/load block) snapshot writable RAM + live IO registers
  3. run the native WASM block        -> capture result regs + RAM
  4. restore the pre-block snapshot
  5. run the SAME instrs on a throwaway interpreter core (the oracle)
  6. compare: r0..r15, CPSR flags, and -- for store blocks -- every
     byte of guest RAM the block could have touched
  7. MATCH  -> mark verified, trust it forever after
     MISMATCH -> roll back fully, reject the block, interpret instead
```

Verification is recorded as a per-block `verified` flag (so a block recompiled after an SMC invalidation correctly re-verifies), making it a one-time cost amortized across thousands of later executions. A rejected block is permanently marked and always interpreted, so a single mis-lift can never corrupt the run — it just costs a little speed. Verified blocks also unlock **block chaining**: registers live in WASM linear memory between blocks, so the dispatcher syncs in once, runs up to a 256-instruction budget of verified blocks back-to-back (mode switches included — the next block's ARM/THUMB cache is chosen from the CPSR T bit in linear memory), and syncs out once. The budget equals the maximum single-block span, so the IRQ guard-band timing model is unchanged, and chains hard-stop at machine intercept PCs (BIOS IRQ-return sentinels, flash-HLE entry, RTC quirk returns) and HALTCNT halts.

### Live observability: the in-emulator debugger

The browser frontend ships a read-only debugger drawer (F9) that makes the hybrid model *visible while playing*. A CPU tab shows all 16 registers, decoded CPSR flags/mode, and a live ARM/THUMB disassembly window around PC (a compact ARMv4T disassembler covering every ARM class and all 19 THUMB formats). A JIT tab shows the cumulative and **per-frame split between engine-executed WASM and interpreted instructions** with a coverage sparkline, block-engine counters (compiled / verify-rejected / cache fill / SMC invalidations), the live bail-reason histogram, the hottest native blocks ranked by a per-block dispatch counter, and an execution-weighted opcode mix. A sprite tab decodes the entire 128-entry OAM from live VRAM/OAM/palette (4bpp/8bpp, 1D/2D mapping, affine flagged), and an IO tab decodes DISPCNT/DISPSTAT/IE/IF/IME/timers/DMA/keys plus the full 512-color palette. Refresh is throttled to ~8 Hz and costs nothing while closed.

### Audio clocking: two clocks, one queue

A long-session audio desync traced to a clock mismatch, not the APU: the run loop paced emulation at a rounded 60 fps while a real GBA frame is 280,896 cycles at 16.777216 MHz = **59.7275 fps**. The emulator generated +0.456% more emulated time (and samples) per real second than the 44.1 kHz device consumed, so the audio queue gained ~0.27 s of latency per minute until its cap — and pausing "fixed" it precisely because the device kept draining while production stopped. The fix is two-layered: pace at the exact frame rate, and apply **dynamic rate control** — the APU output rate is trimmed &plusmn;2% (inaudible) from the sink-queue depth each frame, locking latency at ~93 ms and absorbing every residual skew (non-60 Hz displays, audio-crystal vs `performance.now()` drift, rAF jitter, pause/resume transients). The debugger's IO tab displays the live queue depth and effective APU rate so the lock is verifiable.

### Why store and load blocks needed special handling

Verifying a pure-arithmetic block is easy: same inputs in, compare registers out. Memory makes it subtle in two directions.

**Stores** mutate guest RAM, so you cannot run native and then run the oracle over the same RAM -- the first run would pollute the input of the second. The gate snapshots RAM before the native run, captures the native memory result, *restores* RAM, runs the oracle on the clean snapshot, and only then compares both the registers *and* the resulting memory bytes. If either differs, the block is rejected and RAM is rolled back so the caller can cleanly re-interpret.

**Loads** are sneakier. A block that reads a volatile IO register -- IME, IF, VCOUNT -- can observe a *different value* on the native run than the oracle run, because hardware state advances between them. That would cause a false rejection, or worse, accept a value that depended on read timing. The fix is to snapshot the live IO register file alongside RAM and restore it before the oracle replay, so the reference run reads exactly the bytes the native run read. To know which blocks need this, the block builder tracks a `hasLoad` flag (mirroring the existing `hasStore`) by decoding the load/store class of each instruction as it walks the block.

> **Layered safety net.** Three independent mechanisms guarantee correctness: (1) lifters *bail* on anything they cannot model exactly; (2) every emitted block is *differentially verified* against the interpreter on first run; (3) RAM-resident blocks are *SMC-guarded* so they can never run stale. Coverage can grow aggressively because none of those gains can ever produce a wrong frame -- the worst case is always "fall back to the interpreter," never "render something incorrect."

### Proven result

| Validation | Coverage | Result |
|---|---|---|
| framebuffer equivalence | recompiler vs interpreter, frames 60-600 | byte-for-byte IDENTICAL |
| `cpu_suite.test.ts` (jsmolka) | full ARM + THUMB conformance ROMs | ARM=PASS THUMB=PASS |
| `recompiler_diff.test.ts` | ARM block lift vs interpreter (incl. native unaligned-LDR rotation at every addr&3) | 12 passed, 0 failed |
| `thumb_diff.test.ts` | THUMB block lift vs interpreter | 43 passed, 0 failed |
| native coverage | share of executed instrs run as WASM (600-frame Ruby boot, 20.4M instrs) | 99.9% — residue is 16 MSR/MRS + 6 SWI sites |
| verify-gate rejections | differential first-run verification, 46M instrs (1200 frames) | 0 rejected blocks |
| wall-clock speed | 600-frame Ruby boot, same machine | 16.2s → 3.4s (4.8×) with chaining + O(1) schedulers + page-generation SMC guard |
| full suite | 16 test files | all passing, 0 failures |
| observability | in-emulator debugger (regs/disasm, JIT split, OAM atlas, MMIO) | live at ~8 Hz, read-only, zero cost closed |
| audio stability | exact 59.7275 fps pacing + &plusmn;2% dynamic rate control | queue locked at ~93 ms; no long-session drift |

---

## 15 — The optimization campaign, measured

One working session took the recompiler from 64.6% native coverage at 16.2 s per 600-frame boot to 99.96% coverage at 3.4 s — a 4.8× end-to-end speedup with **zero** verification regressions across 46 million differentially-checked instructions. Every step below was driven by measurement, not intuition, and every claim is reproducible from `tools/recomp_coverage.ts` and the committed test suite.

### Step 0 — measure before touching anything

The baseline run exposed the real problem immediately: of 3,495 THUMB block-start PCs, **1,714 (49%) could not lift even their first instruction**. Gen 3 functions open with `push {rN…, lr}`, load constants via `ldr rd, [pc, #imm]`, and read structs with word loads — all three were bail classes in the v1 lifter. A bail-reason telemetry histogram was added to block discovery *first*, so each subsequent lifter was aimed at the heaviest measured bucket rather than guessed at.

| Stage | Native coverage | 600-frame wall time | What changed |
|---|---|---|---|
| v1 baseline | 64.6% | 16,166 ms | conservative lifter: word-LDR, PUSH/POP, LDM/STM, BX, conditionals all bailed |
| + lifter v2 | 99.9% | 7,326 ms | full THUMB + ARM instruction coverage incl. every rotation/quirk path (details below) |
| + profiler kills | 99.9% | 4,148 ms | three O(n)→O(1)/O(overflows) rewrites found by `--cpu-prof` (details below) |
| + block chaining | 99.9% | 3,415 ms | verified blocks run back-to-back in linear memory; one register sync per chain |
| 1200-frame validation | 99.96% | 6,956 ms (46.0M instrs) | residue is exactly 16 MSR/MRS sites + 6 SWI sites — nothing else interprets |

Block-population shift: 1,848 short blocks → 1,391 longer ones; THUMB null entries (un-liftable block starts) collapsed **1,714 → 5**, ARM nulls 123 → 8. The verify gate rejected **0** of the new blocks (v1 had 15 rejections — all traced to the late-bail emission bug fixed by the rollback discipline).

### The profiler-driven kills

After the lifters landed, a V8 CPU profile showed the remaining time was *not* in guest execution at all. Each hotspot was rewritten as a complexity-class change, not a micro-tweak:

| Hotspot (profile share) | Was | Now |
|---|---|---|
| `cyclesUntilIrq` / frame-latch (13% + part of 21%) | scanned up to 228 scanlines through an IO-register getter *on every dispatch* | closed-form O(1) modular arithmetic — identical results, property-checked against the scan |
| timer stepping (8.6%) | per-CPU-cycle JS loop; Timer0 at prescaler 1 (the audio sample clock) ticked ~280,000 times per frame | bulk advance: O(overflows) per step, jumping counter math straight to each overflow |
| store-block verification (8.0% + 4.5%) | byte-by-byte JS compare + 5 fresh typed-array allocations (~390 KB) per verified store block | `Buffer.compare` memcmp + two pooled snapshot buffers — same exactness, near-zero GC |
| SMC guard on cache hits | FNV checksum over the block's code bytes on *every* RAM-block dispatch — O(blockLen) | O(1) page-generation stamps (256-byte pages, bumped by the bus on write), with a checksum *confirm* that re-stamps instead of recompiling when a data write merely shares the page |
| dispatch overhead | syncIn + Map lookup + syncOut per block | verified blocks chain in linear memory under a 256-instruction budget — chosen to equal the existing max block span so the IRQ guard-band timing model is provably unchanged; chains hard-stop at machine intercept PCs and HALTCNT |

After all five, the profile shows the CPU side is done: the top entries are now the PPU renderer (~36%) — guest code itself has effectively vanished from the JS profile because it executes inside the WASM engine.

### The correctness traps that had to be bit-exact

Coverage is the easy half. Each of these is a real ARM7TDMI behavior where a plausible-looking lift is *wrong*, and where the differential gate would have caught — and in several cases did catch — a naive implementation:

| Trap | Exact behavior the WASM must reproduce |
|---|---|
| Unaligned word LDR | `rotr(read32(addr & ~3), 8*(addr & 3))` — emitted branchless; proven for every `addr & 3` by a dedicated differential test |
| Unaligned LDRH | halfword loads rotate too: `rotr(read16(addr & ~1), 8*(addr & 1))` |
| Odd-address LDRSH | silently degrades to LDRSB (sign-extend the *byte*) — an ARM7 quirk, not a spec behavior |
| LDM/STM empty rlist | transfers PC and adjusts the base by &plusmn;0x40 — the jsmolka suite tests this explicitly |
| STM with base in rlist | stores the *post-writeback* base value unless the base is the lowest register listed |
| SBC/RSC carry ordering | carry-out is computed against the *incoming* C flag; the lift must read OFF_CF for both the sum and the new flag before overwriting it — an ordering bug here is invisible until a borrow chain crosses it |
| ADC 33-bit carry | two-step detection `(t <u a) \| (res <u t)`, exact for a+b+cin without 64-bit math |
| Shifter carry edge cases | LSR/ASR #0 mean #32; ROR #0 is RRX (33-bit rotate through carry); register shifts by 0 leave C untouched, by &ge;32 have their own table |
| NEG flag quirk | the interpreter's C=(b==0), V=(b & res)>>31 — mirrored verbatim, because the contract is the interpreter, not the manual |
| PC-relative reads | ARM reads PC as +8, *except* register-specified shifts read +12; STR of PC stores +12; THUMB reads +4 |
| BX / POP {pc} interworking | the CPSR T bit is rewritten in linear memory so a mode switch propagates through syncOut and the dispatcher picks the other instruction-set cache — this is what lets chains cross THUMB&harr;ARM boundaries |
| Late-bail emission | v1's "decide before emitting" convention was replaced by a mechanical snapshot/truncate of the CodeBuilder around every lift — partial emission became impossible by construction, and the 15 historical gate rejections went to zero |

### Why the numbers are trustworthy

Three independent mechanisms have to agree before any of this counts: (1) the jsmolka hardware-conformance ROMs report ALL PASS for ARM and THUMB *through the hybrid path*; (2) every compiled block's first execution is differentially replayed on the interpreter — registers, all four flags, and memory effects — with **0 rejections across 46M instructions**; (3) the 16-file regression suite (boot, 600-frame render, IRQ wake/LR semantics, flash sectors, RTC, PPU window/blend) stays green after every stage. The coverage and timing figures come from a committed, rerunnable tool — not from a one-off measurement.

---

## 16 - Five games, one engine: the Gen 3 campaign

Ruby and Sapphire were the bring-up targets. Getting **Emerald, FireRed, and LeafGreen** from an infinite white screen to byte-identical, 99.8%-native verified boots took exactly three hardware truths the newer engine depends on - and *none of them were in the recompiler*. The lifters needed zero changes for three new games: across 168 million executed instructions per boot, the only non-native residue is the same 16 MSR/MRS sites and 5 SWI entries Ruby has, and the differential gate rejected **0** blocks. That is the architecture's thesis holding under load: when correctness is enforced by bail + verify + SMC-guard, new games stress the *hardware model*, not the compiler.

| Game | Code | 600-frame result | Native coverage | Gate rejections |
|---|---|---|---|---|
| Ruby | AXVE | byte-identical at every checkpoint | 99.94% | 0 |
| Sapphire | AXPE | byte-identical at every checkpoint | 99.94% | 0 |
| Emerald | BPEE | byte-identical at every checkpoint | 99.8% | 0 |
| FireRed | BPRE | byte-identical at every checkpoint | 99.8% | 0 |
| LeafGreen | BPGE | byte-identical at every checkpoint | 99.8% | 0 |

### Root cause #1 - the BIOS leaves the screen in forced blank, and gflib knows it

All three newer games burned exactly 168,453,824 instructions per 600 frames - identical counts, ~8× Ruby's - the signature of a busy-wait that never sleeps. A PC histogram (`tools/_probe_spin.ts`) put 100% of samples in a five-halfword THUMB loop at ROM `0x80008ac`: `WaitForVBlank()`, polling `gMain.intrCheck` at IWRAM `0x30030f0+0x1c` for a VBlank interrupt that never came. A cold-boot IO write trace (`tools/_probe_boot_io.ts`) showed why: IE=0x85, IME=1... but **DISPSTAT was never written**, so the VBlank IRQ was never armed.

Source archaeology against the pret decompilations closed the loop. FRLG/Emerald route all display-register writes through `gpu_regs.c`, whose `SetGpuReg()` writes hardware *directly* only while in VBlank **or forced blank** - otherwise it defers the write to the VBlank interrupt handler. The real BIOS hands control to the cartridge with `DISPCNT = 0x0080` (forced blank set). Our machine booted with `DISPCNT = 0`, so the deferred DISPSTAT write that would have armed the VBlank IRQ was itself waiting on a VBlank IRQ. A deadlock baked into a boot register.

```txt
the deadlock, in one breath

  BIOS contract:   DISPCNT = 0x0080 at handoff (forced blank)
  gpu_regs.c:      in VBlank or forced blank -> write hardware NOW
                   otherwise                 -> defer to VBlank IRQ handler
  we booted with:  DISPCNT = 0x0000
  so:              DISPSTAT (arms VBlank IRQ)  deferred -> to a handler
                   that needs the IRQ          that DISPSTAT would arm
  fix:             one register at reset.  io.set16(DISPCNT, 0x0080)
```

Ruby and Sapphire never hit this because they predate `gpu_regs.c` and write DISPSTAT directly. This is the purest example yet of the project's recurring lesson: **the game is a conformance test for the BIOS contract, not just the CPU**.

### Root cause #2 - a disconnected link cable reads HIGH

Next blocker: FRLG/Emerald probe for the wireless adapter at boot over normal-mode serial. The runtime had no SIO at all, so the probe wedged. The fix was a full link-port model (`src/runtime/sio.ts`: normal 8/32-bit, 16-bit multiplayer, UART, JOY bus) - but the part that actually matters is the *disconnected-cable semantics*, which are subtle and exactly what the games test:

| Situation | Hardware behavior the games rely on |
|---|---|
| Normal mode, nothing attached | the SI input line (SIOCNT bit 2) is **pulled high** - the RFU driver reads SI=1 as "no adapter present" and exits its retry loop |
| Master transfer, no partner | **completes** (master drives its own clock) with all-1s data: 0xFF / 0xFFFFFFFF; busy clears; serial IRQ fires if enabled |
| Slave transfer, no master | **never completes** - no external clock ever arrives; the game's timeout path is the only exit |
| Multiplayer, no link | SD=0 (not all ready); a started round completes with the GBA's own word in slot 0 and 0xFFFF in slots 1-3, ID=0 |

The model is built around a `LinkTransport` seam, and the in-process reference implementation - `LocalLinkHub` - already links two to four machine instances: the test suite performs a real two-machine multiplayer exchange with correct IDs, SD/SI bits, and serial IRQs on both sides. A WebRTC DataChannel adapter implementing the same four-method interface is the designed path to browser-to-browser link cable.

### And the missing half of the audio path: the PSG block

Pokémon's m4a engine mixes music on the CPU into Direct Sound FIFOs - which the runtime had - but layers instruments and SFX on the four legacy PSG channels, which it did not. The campaign added the complete block: square 1 with frequency sweep, square 2, the GBA's dual-bank/64-sample wave channel, the 15/7-bit noise LFSR, the 512 Hz frame sequencer (length @ 0/2/4/6, sweep @ 2/6, envelope @ 7 - GBA periods are exactly DMG ×4), SOUNDCNT_L per-channel routing, and the 25/50/100% PSG mix ratio. The Direct Sound FIFO depth was also corrected to the hardware's 32 bytes. Eight PSG behavior tests (trigger, envelope decay, length expiry, sweep-overflow kill, banked wave playback, LFSR advance, routing mute, master gate) assert on the actual resampled output stream - RMS levels, not vibes.

---

## 17 - Two one-bit bugs: a clock edge and a blend gate

With all five games booting, the playthrough reports came in: Emerald greeted players with *"the internal battery has run dry"*, and FireRed's Professor Oak was simply absent from his own intro. Both were single-bit semantic errors - one in time, one in space - and both fell to purpose-built differential instruments rather than guesswork. Both fixes *deleted* code: a per-game hack and an unconditional branch.

### The RTC presented bit 0 one edge too late

The S-3511A RTC speaks a 3-wire serial protocol: the chip presents a data bit on each **falling** SCK edge, and the GBA samples while SCK is high (`siirtc.c`'s ReadData: five SCK-low writes, one SCK-high write, *then* read). The contract hiding in that sequence: after the 8-bit command byte, the *first* falling edge must **present bit 0** - not advance past it. Our clock-fall handler bumped the bit index unconditionally, so every byte the game assembled was right-shifted by one bit, with bit 7 leaking in from the following byte.

```txt
one edge, every byte wrong

  chip register   STATUS = 0x40        (24-hour mode, battery good)
  game reads      STATUS = 0x20        ("12-hour mode" -> reset path)
  chip register   year  = 0x26  month = 0x06
  game reads      year  = 0x13  month = 0x83   (BCD invalid -> error flags)
  RtcCheckInfo    error flags != 0  ->  "the internal battery has run dry"
```

The instrument that nailed it is the project's favorite verification trick generalized: **port the game's own driver as the test harness**. `tests/rtc_siirtc.test.ts` reimplements pokeemerald's `siirtc.c` GPIO loops verbatim - WriteCommand MSB-first with data presented while SCK is low, ReadData sampling after the rising edge with LSB-first assembly - and asserts the exact bytes the *game* would see. Before the fix: STATUS read 0x20, BCD garbage. After (a three-line `firstFallPending` latch): all 7 conformance tests green.

The satisfying epilogue: Ruby's old battery-warning suppression - a recompiler chain-stop plus a forced `r0=0` at the `RtcGetErrorStatus` return PC - turned out to have been masking *this same bug* the whole time. It is now deleted. All five games read a healthy clock through the real protocol, with zero per-game patches. **Root cause beats hack, even when the hack is yours.**

### Semi-transparent sprites are opaque until proven blendable

FRLG's intro sprites (Oak included) are OBJ mode 1 - *semi-transparent*. The renderer alpha-blended every mode-1 pixel with BLDALPHA unconditionally. But the intro runs with `BLDCNT=0, BLDALPHA=0`: blend coefficients EVA=0, EVB=0. Unconditional blending therefore computed `0×sprite + 0×background` - and painted Oak **black on black**. The hardware rule the renderer was missing: a semi-transparent sprite pixel blends *only* when the topmost pixel beneath it is enabled as a **second target** in BLDCNT bits 8-13 (and OBJ-over-OBJ never blends - the OBJ layer is flattened before color math). Otherwise it draws **fully opaque**.

Diagnosis ran on two new instruments. `tools/_input_probe.ts` is a scripted-input headless driver (press schedules like `600-1500/120:START`) that walked the game to the intro unattended, dumping screenshots plus live OAM/VRAM occupancy - which proved the sprites *existed* (correct OAM entries, 1,208 nonzero OBJ-VRAM bytes) yet contributed nothing visible. Then `tools/_sprite_blend_probe.ts` ran the same scripted boot **three times** - (A) normal, (B) sprites disabled, (C) mode-1 sprites forced opaque - and diffed framebuffers:

```txt
three renders, one verdict

           before fix              after fix
  A vs B   0 px   (sprites invisible)   1,406 px  (sprites visible)
  A vs C   1,406 px (opacity reveals)       0 px  (already correct)
  B vs C   1,406 px (they exist!)       1,406 px

  A==C with no blend programmed is the hardware-semantics proof:
  mode-1 sprites now draw exactly as opaque pixels unless a real
  second target sits beneath them.
```

The fix is one gate in `renderSprites`: compute the BLDCNT second-target mask per scanline, and blend a mode-1 (or OBJ-first-target) pixel only when the layer beneath qualifies. The full 20-file suite and the five-game byte-identity matrix stayed green - the gate changed FRLG's intro and nothing else.

### The instrument rack

Every bug above fell to a purpose-built, rerunnable tool rather than speculation. They are all committed - this is the project's standing diagnostic kit:

| Instrument | What it answers | Bug it cracked |
|---|---|---|
| `tools/_probe_spin.ts` | PC-sample histogram with decoded code windows, IRQ state, recent SWIs - "where is the game stuck and what is it reading?" | WaitForVBlank deadlock located to one THUMB loop |
| `tools/_probe_boot_io.ts` | watch-list IO write trace + IRQ requests from cold boot - "which register was never written?" | DISPSTAT never armed → forced-blank contract |
| `tools/_multirom_probe.ts` | every game × both engines × N frames: FNV framebuffer hashes at checkpoints, coverage, SMC counts - the fleet-wide byte-identity gate | proved all fixes regression-free, five games at once |
| `tools/_input_probe.ts` | scripted-input headless playthroughs with screenshot + OAM/VRAM dumps - reach any screen without a human | reproduced the missing-Oak intro on demand |
| `tools/_sprite_blend_probe.ts` | 3-way render diff (normal / no-sprites / forced-opaque) - separates "doesn't exist" from "exists but invisible" | semi-transparent blend gate |
| `tests/rtc_siirtc.test.ts` | the game's own driver code, ported as a conformance harness - asserts game-visible bytes, not implementation internals | RTC one-edge bit shift |
| pret source archaeology | decompilation symbols (`gMain` = `0x30030f0`, `gpu_regs.c`, `siirtc.c`) as ground truth for what the ROM *intends* | all of the above |

The pattern worth stealing: **locate (histogram) → observe (trace) → understand (source) → prove (differential instrument) → lock (regression test)**. No fix shipped on fewer than all five steps.

---

## 18 -- Roadmap

The recompiler is real and shipping, and the architecture leaves obvious room to grow native coverage without ever risking correctness, because every gain is protected by the bail / verify / SMC-guard trifecta.

```txt
next coverage targets (each currently bails to interpreter)

  LDM/STM register lists     batched memory transfers in prologues/epilogues
  BX / mode switches         ARMTHUMB transitions as block-ending edges
  unaligned word-LDR         model ARM's load rotation exactly, then lift it
  PC-relative loads          literal pools -- resolvable at compile time
  block linking              jump compiled-block -> compiled-block directly,
                             skipping the JS dispatch loop on hot edges
  inline IO fast paths       lift common MMIO reads instead of host-calling
```

The deeper lesson from Ruby/Sapphire holds: the compiler is the easy part only once the machine contract is real and self-checking. The interpreter established that contract; the differential verifier keeps the compiler honest against it; the SMC guard keeps the cache honest against the game's own relocation tricks. With those three in place, turning more of the cartridge's compiled code into the browser's compiled code is now a matter of carefully extending the lifter, one verified instruction class at a time.
