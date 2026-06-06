/**
 * Drive the Ruby Birch intro to completion and into free-roam overworld.
 *
 * The intro is a long scripted sequence: Prof. Birch speech -> gender select (2-option menu) ->
 * name entry (on-screen keyboard, default name is fine) -> confirm -> truck/overworld.
 *
 * We can't see pixels well, so we drive by HEURISTIC + RAM progress:
 *  - Spam A to blow through all text/speech boxes.
 *  - When a 2-option menu appears (gender), A picks the highlighted default (BOY) — fine.
 *  - The NAME KEYBOARD is the real blocker: pressing A types letters. We must press START (or the
 *    "OK" via select) to confirm the (possibly empty/default) name. Ruby allows an empty-ish name?
 *    No — it requires >=1 char. The cursor starts on a letter, so a few A presses type a name, then
 *    START confirms. We do: type ~3 letters (A,A,A on default row) then START.
 *  - After confirmation more speech, then control. We detect overworld by the coordinate RAM-diff.
 *
 * We loop this whole policy and re-test the coordinate diff every ~200 frames until it succeeds.
 */
import { Agent, bootToTitle } from './control.ts';

const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);

function coordDiff(): { addr: number; axis: string }[] {
  const BASE = 0x02000000, LEN = 0x40000; // whole EWRAM (256KB) — be thorough this time
  a.releaseAll(); a.wait(10);
  const before = a.snapshotRange(BASE, LEN);
  a.hold('down'); a.wait(20); a.release('down'); a.wait(12);
  const afterDown = a.snapshotRange(BASE, LEN);
  a.hold('up'); a.wait(20); a.release('up'); a.wait(12);
  const afterUp = a.snapshotRange(BASE, LEN);
  const cands: { addr: number; axis: string }[] = [];
  for (let i = 0; i < LEN; i++) {
    const b = before[i], d = afterDown[i], u = afterUp[i];
    if (d === ((b + 1) & 0xff) && u === b) cands.push({ addr: BASE + i, axis: 'y+' });
    else if (d === ((b - 1) & 0xff) && u === b) cands.push({ addr: BASE + i, axis: 'y-' });
  }
  return cands;
}

bootToTitle(a, 320);

// Phase 1: title -> main menu -> NEW GAME. Mash START then A.
for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
log(`[after title] f${a.frame} DISPCNT=0x${a.snap().DISPCNT.toString(16)} nonBlank=${a.nonBlank()}`);

// Phase 2: Birch speech + gender + name. Run several policy rounds, testing coords between rounds.
let round = 0, found: { addr: number; axis: string }[] = [];
while (round < 10 && found.length === 0) {
  round++;
  // Blow through speech with A.
  for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
  // Try name-keyboard handling: type a few letters then confirm with START.
  for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
  a.tap('start', 4, 10);
  // More speech.
  for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
  // Test if we can move now.
  found = coordDiff();
  log(`[round ${round}] f${a.frame} DISPCNT=0x${a.snap().DISPCNT.toString(16)} nonBlank=${a.nonBlank()} coordCands=${found.length}`);
}

if (found.length) {
  log(`\n[FOUND OVERWORLD] coordinate bytes:`);
  for (const c of found.slice(0, 12)) log(`   0x${c.addr.toString(16)} ${c.axis} val=0x${a.r8(c.addr).toString(16)}`);
} else {
  log(`\n[still stuck] last DISPCNT=0x${a.snap().DISPCNT.toString(16)} pc=0x${a.snap().pc.toString(16)}`);
}
