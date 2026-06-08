import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
const frames = parseInt(process.argv[3] || '170', 10);
const rom = new Uint8Array(readFileSync(romPath));

const M: any = new GbaMachine(rom);
M.useRecompiler = true;

let vReads = 0, vCorrected = 0, maxPending = 0;
const ppu = M.ppu;
const origLive = ppu.liveVcount.bind(ppu);
ppu.liveVcount = (pend: number) => {
  vReads++;
  if (pend > maxPending) maxPending = pend;
  const v = origLive(pend);
  // compare to the stored (un-reconciled) vcount
  if ((v & 0xff) !== (ppu.vcount & 0xff)) vCorrected++;
  return v;
};

for (let i = 0; i < frames; i++) M.runFrame();
console.log(JSON.stringify({ frames, vReads, vCorrected, maxPending }, null, 2));
