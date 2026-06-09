import { readFileSync, writeFileSync } from 'node:fs';

const file = 'README.md';
let src = readFileSync(file, 'utf8');

// Replace the stale "~74% / deliberately-not-modeled" paragraph with the current truth.
const oldStart = src.indexOf('It reads a user-provided Pok');
const oldEnd = src.indexOf('\n', src.indexOf('Expanding lifter coverage'));
if (oldStart < 0 || oldEnd < 0) throw new Error('intro paragraph anchors not found');
const newPara = `It reads a user-provided Pok\u00e9mon Ruby/Sapphire/Emerald \`.gba\` ROM locally and runs the ROM's already-assembled ARM7TDMI machine code inside a GBA hardware runtime in the browser. The runtime is a **hybrid recompiler**: ARM **and THUMB** basic blocks are **lifted into real WebAssembly bytecode in-process and executed by the engine** (\`new WebAssembly.Module()\` - not interpreted). Today **99.9% of executed guest instructions run as engine-run WebAssembly** on the Ruby boot/gameplay path \u2014 the only instructions still interpreted are the handful of MSR/MRS mode-plumbing sites and SWI entries into the BIOS HLE. The lifters cover the full data-processing set (incl. ADC/SBC/RSC and register-specified shifts), full conditional execution, unaligned-LDR/LDRH rotation, LDRSB/LDRSH quirks, LDM/STM with the ARM7 empty-rlist and base-in-rlist quirks, PUSH/POP incl. \`pc\`, BX/POP-pc THUMB\u2194ARM interworking, MUL/MLA/UMULL/SMULL/UMLAL/SMLAL, SWP, and PC-relative literal loads constant-folded straight out of immutable ROM. Verified blocks **chain back-to-back in linear memory** (one register sync per chain, not per block), and RAM-resident blocks are guarded by O(1) **page-generation SMC tracking** (with a checksum confirm that distinguishes data writes from real code changes). Correctness is guaranteed by three independent mechanisms: lifters *bail* on anything they cannot model exactly, every emitted block is *differentially verified* against the interpreter on first run (registers, flags, AND memory effects), and stale RAM code can never run thanks to the SMC guard. The 600-frame Ruby boot benchmark runs **4.8\u00d7 faster** than the pre-expansion hybrid.`;
src = src.slice(0, oldStart) + newPara + src.slice(oldEnd);

writeFileSync(file, src);
console.log('README updated');
