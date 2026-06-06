/**
 * Catch the SoftReset(SWI 0x00) that reboots the game on the trainer card / wild encounter.
 * We drive to the overworld, then (a) open the trainer card and (b) force a wild encounter, while
 * trapping SWI 0x00 to capture the FULL call context: the PC/LR that invoked it, the surrounding
 * code, recent SWIs, and the IO/CPU state. A game only SoftResets when an upstream invariant broke
 * (bad read, failed DMA, RNG/asset assert). The capture tells us which.
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

// Trap SWI 0x00 + log a ring buffer of recent SWIs.
const m = a.m;
const swiLog: string[] = [];
let softResetCtx: any = null;
const origSwi = m.cpu.swiHandler;
m.cpu.swiHandler = (comment: number, cpu: any) => {
  const pc = cpu.st.r[15] >>> 0, lr = cpu.st.r[14] >>> 0;
  swiLog.push(`swi 0x${comment.toString(16)} pc=0x${pc.toString(16)} lr=0x${lr.toString(16)}`);
  if (swiLog.length > 24) swiLog.shift();
  if (comment === 0x00 && !softResetCtx) {
    softResetCtx = {
      frame: a.frame, pc: '0x'+pc.toString(16), lr: '0x'+lr.toString(16),
      regs: Array.from({length:16},(_,i)=>'0x'+(cpu.st.r[i]>>>0).toString(16)),
      flag3007FFA: m.mem.read8(0x03007ffa),
      recentSwis: [...swiLog],
      // The instructions just before LR (the caller).
      callerCode: Array.from({length:8},(_,i)=>'0x'+m.mem.read16((lr-12+i*2)>>>0).toString(16).padStart(4,'0')),
    };
  }
  return origSwi(comment, cpu);
};

reachOverworld();
log(`[overworld] f${a.frame} DISPCNT=0x${a.snap().DISPCNT.toString(16)}`);

// (a) Trainer card: open menu, item 3, A, wait.
a.tap('b',3,6); a.tap('start',4,14);
for (let d=0; d<3; d++) a.tap('down',3,6);
a.tap('a',4,12);
a.wait(180);
log(`[after trainer card] SoftReset seen? ${!!softResetCtx}`);

// (b) Wild encounter: walk in grass aggressively.
if (!softResetCtx) {
  const dirs:('up'|'down'|'left'|'right')[]=['down','right','up','left'];
  for (let pass=0; pass<20 && !softResetCtx; pass++){
    for (const d of dirs){ a.hold(d); a.wait(30); a.release(d); a.wait(6); if(softResetCtx)break; }
  }
  log(`[after roaming for encounter] f${a.frame} SoftReset seen? ${!!softResetCtx}`);
}

if (softResetCtx) {
  log('\n*** SoftReset(SWI 0) CAPTURED ***');
  log(JSON.stringify(softResetCtx, null, 2));
} else {
  log('\n[no SoftReset triggered headlessly in this run]');
}
