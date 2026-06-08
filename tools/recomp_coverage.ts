/**
 * Measures real ARM->WASM native coverage on a Ruby boot.
 *
 * Reports how many guest ARM instructions executed as native WebAssembly vs interpreter,
 * how many blocks compiled, and how many were rejected by the self-verification gate.
 */
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
if (!romPath) { console.error('usage: recomp_coverage.ts <rom.gba> [frames]'); process.exit(1); }
const frames = Number(process.argv[3] || 300);

if (process.env.RECOMP_DEBUG) (globalThis as any).__RECOMP_DEBUG = true;
if (process.env.NO_NATIVE_WHEN_TIMERS) (globalThis as any).__NO_NATIVE_WHEN_TIMERS = true;
const rom = new Uint8Array(readFileSync(romPath));
const m = new GbaMachine(rom);
m.reset();

const t0 = Date.now();
for (let i = 0; i < frames; i++) m.runFrame();
const dt = Date.now() - t0;

const rec = m.recompiler!;
const total = rec.nativeInstrs + (m.instrCount - rec.nativeInstrs);
const nativePct = (rec.nativeInstrs / m.instrCount) * 100;

console.log('=== ARM -> WASM recompiler coverage (Ruby boot) ===');
console.log(`frames run            : ${frames}`);
console.log(`wall time             : ${dt} ms`);
console.log(`total guest instrs    : ${m.instrCount.toLocaleString()}`);
console.log(`native (WASM) instrs  : ${rec.nativeInstrs.toLocaleString()}`);
console.log(`native coverage       : ${nativePct.toFixed(1)}%`);
console.log(`blocks compiled       : ${rec.blocksCompiled.toLocaleString()}`);
console.log(`blocks rejected (gate): ${rec.blocksRejected.toLocaleString()}`);
console.log(`block cache size (ARM): ${rec.cache.size.toLocaleString()}`);
console.log(`block cache size (THM): ${rec.cacheThumb.size.toLocaleString()}`);
// breakdown of how many cached entries are real blocks vs null ("interpret") per mode
let armBlk = 0, armNull = 0, thmBlk = 0, thmNull = 0;
for (const v of rec.cache.values()) v ? armBlk++ : armNull++;
for (const v of rec.cacheThumb.values()) v ? thmBlk++ : thmNull++;
console.log(`ARM blocks/null       : ${armBlk}/${armNull}`);
console.log(`THUMB blocks/null     : ${thmBlk}/${thmNull}`);
