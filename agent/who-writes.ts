/**
 * Find who SHOULD write 0x3001274 (the flag the trainer-card spin-loop waits on) — and why our
 * runtime never writes it. We reach the crash, then watch every write to 0x3001270-0x3001280 and
 * every DMA/IRQ event for several frames to see what mechanism is supposed to set it.
 */
import { Agent, bootToTitle } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);

function reachOverworld() {
  bootToTitle(a, 320);
  for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
  for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
  for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
  a.tap('start', 4, 10);
  for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
}
reachOverworld();
// Open menu, select item 3 (trainer card) to enter the crash.
a.tap('b', 3, 6); a.tap('start', 4, 14);
for (let d = 0; d < 3; d++) a.tap('down', 3, 6);
a.tap('a', 4, 12);

const m = a.m;
const WLO = 0x3001270, WHI = 0x3001280;
// Watch writes to the flag region across the WHOLE run (from before selection would be ideal, but
// we already selected; the loop runs forever so we observe what DOES/DOESN'T write it now).
const writes: string[] = [];
const oW8 = m.mem.write8.bind(m.mem), oW16 = m.mem.write16.bind(m.mem), oW32 = m.mem.write32.bind(m.mem);
const note = (addr: number, v: number, sz: string) => { const al = addr >>> 0; if (al >= WLO && al < WHI) writes.push(`pc=0x${(m.cpu.st.r[15]>>>0).toString(16)} ${sz} [0x${al.toString(16)}]=0x${v.toString(16)}`); };
m.mem.write8 = (x: number, v: number) => { note(x, v, 'b'); return oW8(x, v); };
m.mem.write16 = (x: number, v: number) => { note(x, v, 'h'); return oW16(x, v); };
m.mem.write32 = (x: number, v: number) => { note(x, v, 'w'); return oW32(x, v); };

// Also count IRQ types fired and DMA runs.
let vblank = 0, hblank = 0, vcount = 0, dmaRuns = 0;
const oReq = m.irq.request.bind(m.irq);
m.irq.request = (bits: number) => { if (bits & 1) vblank++; if (bits & 2) hblank++; if (bits & 4) vcount++; return oReq(bits); };
const oRunCh = m.dma.runChannel?.bind(m.dma);
if (oRunCh) m.dma.runChannel = (ch: number, fifo?: boolean) => { dmaRuns++; return oRunCh(ch, fifo); };

a.wait(120);
log(`Over 120 frames while frozen on trainer card:`);
log(`  VBlank IRQs: ${vblank}  HBlank: ${hblank}  VCount: ${vcount}  DMA runs: ${dmaRuns}`);
log(`  writes to 0x3001270-7f: ${writes.length}`);
for (const w of writes.slice(0, 10)) log('    ' + w);
log(`  flag values: 0x3001274=0x${a.r32(0x3001274).toString(16)} 0x3001278=0x${a.r32(0x3001278).toString(16)}`);
log(`  IE=0x${a.snap().IE.toString(16)} (bit1=HBlank bit2=VCount) DISPSTAT=0x${a.snap().DISPSTAT.toString(16)}`);

// What does the loop COMPARE 0x3001274 against? Disassemble around the spin PC 0x81e0826 region and
// the THUMB at the actual hot loop. The reads were at 0x3001274; show the instructions referencing it.
log(`\n[hot THUMB around spin]`);
for (let p = 0x81e0810; p <= 0x81e0830; p += 2) log(`  0x${p.toString(16)}: 0x${m.mem.read16(p).toString(16).padStart(4,'0')}`);
