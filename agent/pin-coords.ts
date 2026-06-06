/**
 * Pin down the TRUE player coordinate pair in Ruby's EWRAM.
 * The real (x,y) satisfies ALL of:
 *   - y byte: +1 on a full DOWN step, -1 on UP, unchanged by L/R.
 *   - x byte: +1 on RIGHT, -1 on LEFT, unchanged by U/D.
 *   - The pair lives adjacent (x then y, 2 bytes apart in the SaveBlock1 object struct).
 * We intersect the down/up diff with the right/left diff to eliminate camera/animation noise.
 */
import { Agent, bootToTitle } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);
const BASE = 0x02000000, LEN = 0x40000;

function reachOverworld() {
  bootToTitle(a, 320);
  for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
  for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
  for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
  a.tap('start', 4, 10);
  for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
}
function snap() { return a.snapshotRange(BASE, LEN); }
function stepDiff(dir: 'down'|'up'|'left'|'right') {
  a.releaseAll(); a.wait(10);
  const b = snap();
  a.hold(dir); a.wait(20); a.release(dir); a.wait(12);
  const after = snap();
  // return back to keep position stable
  const back = { down:'up', up:'down', left:'right', right:'left' } as const;
  a.hold(back[dir]); a.wait(20); a.release(back[dir]); a.wait(12);
  const reverted = snap();
  const moved = new Map<number, number>(); // addr -> delta
  for (let i = 0; i < LEN; i++) {
    const d = (after[i] - b[i]) & 0xff;
    if ((d === 1 || d === 0xff) && reverted[i] === b[i]) moved.set(BASE + i, d === 1 ? 1 : -1);
  }
  return moved;
}

reachOverworld();
log(`[overworld] f${a.frame} DISPCNT=0x${a.snap().DISPCNT.toString(16)}`);

const down = stepDiff('down');
const right = stepDiff('right');
log(`[diff] down-movers=${down.size} right-movers=${right.size}`);

// y candidates = moved on down but NOT on right; x candidates = moved on right but NOT on down.
const yCands = [...down.keys()].filter(addr => !right.has(addr));
const xCands = [...right.keys()].filter(addr => !down.has(addr));
log(`[y-only] ${yCands.length}  [x-only] ${xCands.length}`);

// The real pair: an x-candidate and a y-candidate that are 2 bytes apart (u16 fields x@+0, y@+2)
// OR adjacent. Find the closest x/y pairing.
const pairs: { x: number; y: number; gap: number }[] = [];
for (const x of xCands) for (const y of yCands) { const gap = y - x; if (gap > 0 && gap <= 4) pairs.push({ x, y, gap }); }
pairs.sort((p, q) => p.gap - q.gap);
log(`\n[player-coord pairs] (x then y, small gap = real object struct):`);
for (const p of pairs.slice(0, 10)) log(`   x@0x${p.x.toString(16)}=0x${a.r16(p.x).toString(16)}  y@0x${p.y.toString(16)}=0x${a.r16(p.y).toString(16)}  gap=${p.gap}`);

if (pairs.length) {
  const best = pairs[0];
  log(`\n[BEST GUESS] player X=0x${best.x.toString(16)} (${a.r16(best.x)})  Y=0x${best.y.toString(16)} (${a.r16(best.y)})`);
}
