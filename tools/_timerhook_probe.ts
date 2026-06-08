import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const romPath = process.argv[2];
const frames = parseInt(process.argv[3] || '170', 10);
const rom = new Uint8Array(readFileSync(romPath));

const M: any = new GbaMachine(rom);
M.useRecompiler = true;

let calls = 0;
let nonzeroPending = 0;
const byCh = [0, 0, 0, 0];
const orig = M.io.timerReadHook;
M.io.timerReadHook = (ch: number) => {
  calls++;
  byCh[ch]++;
  const pend = M.recompiler.pendingCycles();
  if (pend !== 0) nonzeroPending++;
  return orig(ch);
};

for (let i = 0; i < frames; i++) M.runFrame();
console.log(JSON.stringify({ frames, calls, nonzeroPending, byCh }, null, 2));
