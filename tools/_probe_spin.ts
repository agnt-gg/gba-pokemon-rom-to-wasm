/**
 * Pinpoint the Emerald/FRLG boot spin: run N frames, then sample the PC for 200k steps,
 * print the hottest PCs with surrounding code bytes, IRQ state, and recent SWIs.
 *   node --experimental-strip-types tools/_probe_spin.ts "<rom path>" [frames]
 */
import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
const frames = Number(process.argv[3] || 120);
const m = new GbaMachine(new Uint8Array(readFileSync(romPath)));
m.useRecompiler = false; // single-step everything for exact PC sampling

console.log(`title="${m.header.title}" code=${m.header.gameCode}`);
for (let f = 0; f < frames; f++) m.runFrame();
console.log(`after ${frames} frames: instrs=${m.instrCount} halted=${m.cpu.halted} pc=0x${m.pc().toString(16)}`);

const hist = new Map<number, number>();
for (let i = 0; i < 200_000; i++) {
  if (m.cpu.halted) m.runFrame();
  hist.set(m.pc() >>> 0, (hist.get(m.pc() >>> 0) || 0) + 1);
  m.step();
}
const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('\nhot PCs:');
for (const [pc, n] of top) {
  const thumb = true;
  let code = '';
  try { for (let i = -4; i <= 4; i++) code += (m.mem.read16((pc + i * 2) >>> 0) & 0xffff).toString(16).padStart(4, '0') + (i === 0 ? '* ' : ' '); } catch {}
  console.log(`  0x${pc.toString(16).padStart(8, '0')}  ${String(n).padStart(7)}  [${code}]`);
}
console.log(`\nIE=0x${m.io.get16(0x200).toString(16)} IF=0x${m.io.get16(0x202).toString(16)} IME=${m.io.get16(0x208)} DISPSTAT=0x${m.io.get16(0x004).toString(16)} DISPCNT=0x${m.io.get16(0x000).toString(16)}`);
console.log('recent SWIs: ' + JSON.stringify((m as any)._swiRing?.slice(-20)));
console.log('regs: ' + [...m.cpu.st.r].map((v, i) => `r${i}=0x${(v >>> 0).toString(16)}`).join(' '));
console.log('cpsr=0x' + (m.cpu.st.cpsr >>> 0).toString(16) + ' thumb=' + ((m.cpu.st.cpsr & 0x20) !== 0));
console.log('_irqDepth=' + (m as any)._irqDepth);
console.log('userIrqHandler@0x3007FFC=0x' + (m.mem.read32(0x3007ffc)>>>0).toString(16));
console.log('flag@0x300310c=0x' + (m.mem.read16(0x300310c)&0xffff).toString(16));
console.log('biosIF@0x3007FF8=0x' + (m.mem.read16(0x3007ff8)&0xffff).toString(16));
console.log('sio transfers: started=' + m.sio.transfersStarted + ' completed=' + m.sio.transfersCompleted);
console.log('SIOCNT=0x' + m.io.get16(0x128).toString(16) + ' RCNT=0x' + m.io.get16(0x134).toString(16));
