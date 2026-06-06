/**
 * Hunt the real crash: reach overworld, then roam aggressively in all directions to (a) escape the
 * intro start area and (b) walk into tall grass to trigger a wild encounter. The instant the screen
 * STOPS progressing for ~2s while the CPU is spinning in VBlankIntrWait, OR DISPCNT jumps to a
 * battle/transition mode and then freezes, we capture the full fingerprint.
 *
 * Crash signature we look for (matches the live watchdog): fbSig + DISPCNT both unchanged for
 * >120 frames while pc sits in the 0x81e0826 IntrWait spin and IE stays 0x1.
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
log(`[overworld] f${a.frame} DISPCNT=0x${a.snap().DISPCNT.toString(16)} nonBlank=${a.nonBlank()}`);

// Watchdog state.
let lastSig = a.fbSig(), lastD = a.snap().DISPCNT, stuck = 0, captured = false;
const dispcntSeen = new Set<number>();
const dirs: ('up'|'down'|'left'|'right')[] = ['down','down','right','right','up','up','left','left','down','right','up','left'];

function checkStuck(): boolean {
  const s = a.snap();
  dispcntSeen.add(s.DISPCNT);
  const progressed = s.fbSig !== lastSig || s.DISPCNT !== lastD;
  lastSig = s.fbSig; lastD = s.DISPCNT;
  if (progressed) { stuck = 0; return false; }
  stuck++;
  if (stuck >= 120 && !captured) {
    captured = true;
    log(`\n*** FROZEN at f${a.frame} ***`);
    log(JSON.stringify({
      pc:'0x'+s.pc.toString(16), lr:'0x'+s.lr.toString(16), cpsr:'0x'+s.cpsr.toString(16),
      mode:s.mode.toString(16), halted:s.halted, intrWait:s.intrWait,
      IE:'0x'+s.IE.toString(16), IF:'0x'+s.IF.toString(16), IME:'0x'+s.IME.toString(16),
      biosIF:'0x'+s.biosIF.toString(16), userHandler:'0x'+s.userHandler.toString(16),
      DISPCNT:'0x'+s.DISPCNT.toString(16), DISPSTAT:'0x'+s.DISPSTAT.toString(16), VCOUNT:s.VCOUNT,
      BLDCNT:'0x'+s.BLDCNT.toString(16), BLDY:'0x'+s.BLDY.toString(16), MOSAIC:'0x'+s.MOSAIC.toString(16),
      DMA0CNT:'0x'+s.DMA0CNT.toString(16), DMA3CNT:'0x'+s.DMA3CNT.toString(16), nonBlank:s.nonBlank,
    }, null, 2));
    return true;
  }
  return false;
}

// Roam: long walks each direction, with periodic A (talk/confirm) and watching for freeze.
outer:
for (let pass = 0; pass < 8; pass++) {
  for (const dir of dirs) {
    a.hold(dir);
    for (let i = 0; i < 40; i++) { a.wait(1); if (checkStuck()) break outer; }
    a.release(dir);
    for (let i = 0; i < 6; i++) { a.wait(1); if (checkStuck()) break outer; }
  }
  log(`[pass ${pass}] f${a.frame} DISPCNT=0x${a.snap().DISPCNT.toString(16)} distinctDISPCNT=${[...dispcntSeen].map(x=>'0x'+x.toString(16)).join(',')}`);
}

if (!captured) log(`\n[no freeze] roamed to f${a.frame}; DISPCNT modes seen: ${[...dispcntSeen].map(x=>'0x'+x.toString(16)).join(',')}`);
