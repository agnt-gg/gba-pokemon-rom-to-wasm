/**
 * Reproduce the PLAYER-SCREEN crash the way the user hits it: in the overworld, press START to open
 * the field menu, navigate to each entry, press A, and watch for the freeze. The user reported that
 * selecting the player profile (POKéNAV/TRAINER CARD) AND wild encounters both freeze with the same
 * VBlankIntrWait signature. We drive the menu deterministically and capture the fingerprint.
 *
 * We instrument at the CPU level: detect the freeze as "fbSig + DISPCNT unchanged for >=100 frames
 * while pc stays in the IntrWait spin (0x81e0xxx) and IE==0x1". When caught, dump everything +
 * the IWRAM wait-flag the main loop is polling (we re-run the loop-read instrumentation inline).
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

// TRUE hang detector: the game is only frozen if the CPU stops visiting distinct code (liveness
// collapses to a tiny handful) for a sustained window. A static-but-alive screen keeps high liveness.
function froze(maxFrames: number): boolean {
  let lowLiveness = 0;
  for (let i = 0; i < maxFrames; i++) {
    a.wait(1);
    const live = (a.m.lastFrameLiveness | 0);
    if (live <= 12) { if (++lowLiveness >= 100) return true; } else lowLiveness = 0;
  }
  return false;
}

// Open the field menu and try every item.
for (let item = 0; item < 8; item++) {
  // Fresh menu: close with B, open with START.
  a.tap('b', 3, 6); a.tap('start', 4, 14);
  const menuD = a.snap().DISPCNT; const menuSig = a.fbSig();
  // Move cursor down `item` times.
  for (let d = 0; d < item; d++) a.tap('down', 3, 6);
  const beforeSig = a.fbSig();
  // Select.
  a.tap('a', 4, 12);
  const afterSig = a.fbSig(); const afterD = a.snap().DISPCNT;
  const changed = afterSig !== beforeSig || afterD !== menuD;
  // Watch for a freeze over the next ~3s.
  const f = froze(200);
  const s = a.snap();
  log(`[item ${item}] selChanged=${changed} DISPCNT 0x${menuD.toString(16)}->0x${afterD.toString(16)} pc=0x${s.pc.toString(16)} IE=0x${s.IE.toString(16)} froze=${f}`);
  if (f) {
    log(`\n*** CRASH REPRODUCED on field-menu item ${item} ***`);
    log(JSON.stringify({
      frame:a.frame, pc:'0x'+s.pc.toString(16), lr:'0x'+s.lr.toString(16), sp:'0x'+s.sp.toString(16),
      cpsr:'0x'+s.cpsr.toString(16), mode:s.mode.toString(16), thumb:s.thumb, halted:s.halted, intrWait:s.intrWait,
      IE:'0x'+s.IE.toString(16), IF:'0x'+s.IF.toString(16), IME:'0x'+s.IME.toString(16),
      biosIF:'0x'+s.biosIF.toString(16), userHandler:'0x'+s.userHandler.toString(16),
      DISPCNT:'0x'+s.DISPCNT.toString(16), DISPSTAT:'0x'+s.DISPSTAT.toString(16), VCOUNT:s.VCOUNT,
      BLDCNT:'0x'+s.BLDCNT.toString(16), DMA0CNT:'0x'+s.DMA0CNT.toString(16), DMA3CNT:'0x'+s.DMA3CNT.toString(16),
    }, null, 2));
    // Find what IWRAM/EWRAM flag the spin loop is polling.
    const reads: Record<string, number> = {};
    const m = a.m; const oR8 = m.mem.read8.bind(m.mem), oR16 = m.mem.read16.bind(m.mem), oR32 = m.mem.read32.bind(m.mem);
    let watch = true;
    const tag = (addr: number, sz: string) => { if (!watch) return; const r = (addr >>> 24) & 0xff; if (r === 0x02 || r === 0x03 || r === 0x04) { const k = sz + ':0x' + (addr >>> 0).toString(16); reads[k] = (reads[k] || 0) + 1; } };
    m.mem.read8 = (x: number) => { tag(x, 'b'); return oR8(x); };
    m.mem.read16 = (x: number) => { tag(x, 'h'); return oR16(x); };
    m.mem.read32 = (x: number) => { tag(x, 'w'); return oR32(x); };
    a.wait(6); watch = false;
    log('\n[spin-loop polls these addresses]:');
    for (const [k, v] of Object.entries(reads).sort((p, q) => q[1] - p[1]).slice(0, 14)) log('   ' + k + ' x' + v);
    break;
  }
}
log('\n[done]');
