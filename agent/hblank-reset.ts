/**
 * LIVE fingerprint (finally captured on the new build):
 *   SoftReset from IWRAM pc=0x30048bc, flag=0, IE=0x3 (VBlank+HBlank), IF=0x2 (HBlank pending),
 *   DISPCNT=0x7f60 (forced-blank), recentSwis = [VBlankIntrWait x20, CpuSet(0xb), VBlankIntrWait, SoftReset].
 *
 * The decisive new fact vs all my prior headless runs: IE=0x3 — the game enabled the HBLANK
 * interrupt. My headless runs only ever saw IE=0x1 (VBlank only). The trainer card / battle / scene
 * transition turns on HBlank for raster effects. So the bug lives on the HBLANK path: either we
 * (a) deliver a bad/duplicate HBlank IRQ that corrupts the handler's dispatch, or (b) our HBlank IRQ
 * timing makes the game's IRQ dispatcher (in IWRAM @0x30048xx) index its handler table wrong and
 * fall through to SoftReset.
 *
 * This script forces the HBlank-enabled scenario headlessly: reach overworld, then poke IE to enable
 * HBlank the way the game does, OR better — drive into the path that enables it and watch HBlank IRQ
 * delivery + the IWRAM dispatcher. We trap SWI 0 and dump the moment IE becomes 0x3.
 */
import { Agent, bootToTitle } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);
const m = a.m;

let ieEverHblank = false, firstHblankFrame = -1, softReset = 0, softResetCtx: any = null;
const origReq = m.irq.request.bind(m.irq);
let hblankDeliveries = 0;
m.irq.request = (bits: number) => { if (bits & 2) hblankDeliveries++; return origReq(bits); };

const origSwi = m.cpu.swiHandler;
m.cpu.swiHandler = (c: number, cpu: any) => {
  if (c === 0x00 && !softResetCtx) {
    softReset++;
    softResetCtx = { frame: a.frame, pc:'0x'+(cpu.st.r[15]>>>0).toString(16), lr:'0x'+(cpu.st.r[14]>>>0).toString(16),
      IE:'0x'+m.io.get16(0x4000200).toString(16), IF:'0x'+m.io.get16(0x4000202).toString(16),
      DISPCNT:'0x'+m.io.get16(0x4000000).toString(16) };
  }
  return origSwi(c, cpu);
};

function checkIe() {
  const ie = m.io.get16(0x4000200);
  if ((ie & 2) && !ieEverHblank) { ieEverHblank = true; firstHblankFrame = a.frame; log(`[HBlank ENABLED] f${a.frame} IE=0x${ie.toString(16)} DISPSTAT=0x${m.io.get16(0x4000004).toString(16)}`); }
}

bootToTitle(a, 320);
for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); checkIe(); }
for (let i = 0; i < 40; i++) { a.tap('a', 3, 6); checkIe(); }
for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
a.tap('start', 4, 10);
for (let i = 0; i < 30; i++) { a.tap('a', 3, 6); checkIe(); }
log(`[overworld] f${a.frame} IE=0x${m.io.get16(0x4000200).toString(16)} hblankSeen=${ieEverHblank} hblankDeliveries=${hblankDeliveries}`);

// Now: trainer card (HBlank raster). Watch IE flip to 0x3 and whether SoftReset follows.
a.tap('b',3,6); a.tap('start',4,14);
for (let d=0; d<3; d++) a.tap('down',3,6);
for (let i=0;i<60;i++){ a.tap('a',1,2); checkIe(); if(softResetCtx)break; }
a.wait(60); checkIe();
log(`[after trainer-card open attempts] f${a.frame} IE=0x${m.io.get16(0x4000200).toString(16)} hblankSeen=${ieEverHblank} firstHblankF=${firstHblankFrame} softReset=${softReset}`);

// Aggressively roam for an encounter/transition (battle enables HBlank too).
if (!softResetCtx) {
  const dirs:('up'|'down'|'left'|'right')[]=['down','right','up','left'];
  for (let pass=0; pass<30 && !softResetCtx; pass++){
    for (const d of dirs){ a.hold(d); for(let k=0;k<30;k++){a.wait(1);checkIe();if(softResetCtx)break;} a.release(d); a.wait(4); if(softResetCtx)break; }
  }
}
log(`\n[final] f${a.frame} IE=0x${m.io.get16(0x4000200).toString(16)} hblankEverSeen=${ieEverHblank} hblankDeliveries=${hblankDeliveries} softResets=${softReset}`);
if (softResetCtx) log('SoftReset ctx: ' + JSON.stringify(softResetCtx));
else log('[no SoftReset headlessly — HBlank path not entered or handled cleanly]');
