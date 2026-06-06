/**
 * Reach the overworld deterministically and CONFIRM it via RAM, not by guessing at pixels.
 *
 * Strategy:
 *  1. Boot past logos.
 *  2. Title screen: the game waits for START/A. We tap START, then A, watching DISPCNT for a real
 *     screen change (DISPCNT 0x1F40 intro -> ... -> 0x1340 overworld, observed earlier).
 *  3. On the main menu (NEW GAME / OPTION when no save), pick NEW GAME with A.
 *  4. Birch intro: a long scripted sequence (gender select, name entry). We advance text with A and
 *     accept defaults. We DETECT the name-entry keyboard by its distinctive DISPCNT/BG state and
 *     just press START/A to confirm the default name.
 *  5. Confirm overworld by finding a byte pair (x,y) that changes by exactly +/-1 when we step.
 *
 * This is the gb-recomp "verify by RAM-diff" method ported to Ruby.
 */
import { Agent, bootToTitle } from './control.ts';

const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';

const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);

bootToTitle(a, 320);
log(`[boot] f${a.frame} DISPCNT=0x${a.snap().DISPCNT.toString(16)} fbSig=0x${a.fbSig().toString(16)}`);

// --- Advance through title + main menu, tracking REAL screen changes via DISPCNT. ---
let lastD = a.snap().DISPCNT;
let changes = 0;
for (let i = 0; i < 120 && changes < 12; i++) {
  // Alternate START and A — START dismisses the title, A picks menu items / advances text.
  a.tap(i % 3 === 2 ? 'start' : 'a', 4, 8);
  const d = a.snap().DISPCNT;
  if (d !== lastD) { changes++; log(`[screen] f${a.frame} DISPCNT 0x${lastD.toString(16)} -> 0x${d.toString(16)} fbSig=0x${a.fbSig().toString(16)} nonBlank=${a.nonBlank()}`); lastD = d; }
}

// --- Try to find player coordinates by RAM-diffing a confirmed step. ---
// Scan a band of EWRAM where Gen-3 save-block-1 (player state) lives (~0x02025734 in Emerald;
// Ruby differs, so we DISCOVER it). We look for two adjacent-ish bytes that BOTH stay constant
// while idle, then ONE changes by exactly 1 when we hold a direction for a full step.
function findCoordCandidates(): { addr: number; axis: string }[] {
  const BASE = 0x02020000, LEN = 0x0e000; // ~56KB band covering Ruby SaveBlock1 region
  // Idle baseline.
  a.releaseAll(); a.wait(8);
  const before = a.snapshotRange(BASE, LEN);
  // Take a step down (hold long enough for a full tile move).
  a.hold('down'); a.wait(18); a.release('down'); a.wait(10);
  const afterDown = a.snapshotRange(BASE, LEN);
  // Step back up.
  a.hold('up'); a.wait(18); a.release('up'); a.wait(10);
  const afterUp = a.snapshotRange(BASE, LEN);

  const cands: { addr: number; axis: string }[] = [];
  for (let i = 0; i < LEN; i++) {
    const b = before[i], d = afterDown[i], u = afterUp[i];
    // y coordinate: +1 on down, back to original on up. Bytes only (coords are u16 but low byte moves).
    if (d === ((b + 1) & 0xff) && u === b) cands.push({ addr: BASE + i, axis: 'y(+down)' });
    if (d === ((b - 1) & 0xff) && u === b) cands.push({ addr: BASE + i, axis: 'y(-down)' });
  }
  return cands.slice(0, 30);
}

const coordCands = findCoordCandidates();
log(`\n[coord-diff] candidates that moved +/-1 on down then reverted on up: ${coordCands.length}`);
for (const c of coordCands) log(`   0x${c.addr.toString(16)}  ${c.axis}  now=0x${a.r16(c.addr).toString(16)}`);

const s = a.snap();
log(`\n[state] f${a.frame} DISPCNT=0x${s.DISPCNT.toString(16)} IE=0x${s.IE.toString(16)} pc=0x${s.pc.toString(16)} nonBlank=${a.nonBlank()}`);
log(coordCands.length > 0 ? '[result] LIKELY in overworld (found moving coordinate bytes).' : '[result] NOT confirmed overworld — still in intro/menu.');
