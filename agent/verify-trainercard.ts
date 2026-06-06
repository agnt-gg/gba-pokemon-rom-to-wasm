/**
 * Is the "trainer card freeze" real, or just a static screen my naive detector mislabeled?
 * Render the screen as ASCII before selecting, after selecting (the card), and confirm:
 *  - Does B back out of the card to the menu/overworld? (a true hang can't back out)
 *  - Does the card screen have real content (not black/garbage)?
 *  - Does the game keep running (VBlank count increments, input responds)?
 */
import { Agent, bootToTitle } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);
function ascii(label: string) {
  const fb = a.m.ppu.framebuffer; const W = 240, H = 160; const ramp = ' .:-=+*#%@';
  let total = 0, nonblank = 0;
  console.log(`\n=== ${label} (f${a.frame} DISPCNT=0x${a.snap().DISPCNT.toString(16)}) ===`);
  for (let y = 0; y < H; y += 6) { let line = ''; for (let x = 0; x < W; x += 3) { const i = (y * W + x) * 4; const r=fb[i],g=fb[i+1],b=fb[i+2]; const lum=(r*0.3+g*0.59+b*0.11)/255; total++; if(lum>0.04&&lum<0.97)nonblank++; line += ramp[Math.min(9, Math.floor(lum*10))]; } console.log(line); }
  console.log(`  [content: ${nonblank}/${total} mid-tone pixels]`);
}
function reachOverworld() {
  bootToTitle(a, 320);
  for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
  for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
  for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
  a.tap('start', 4, 10);
  for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
}
reachOverworld();
ascii('overworld');

// VBlank counter to prove the game keeps running.
let vblanks = 0; const oReq = a.m.irq.request.bind(a.m.irq); a.m.irq.request = (b: number) => { if (b&1) vblanks++; return oReq(b); };

a.tap('b', 3, 6); a.tap('start', 4, 14);
ascii('field menu open');
for (let d = 0; d < 3; d++) a.tap('down', 3, 6);
ascii('cursor on item 3');
const vb0 = vblanks;
a.tap('a', 4, 30);
ascii('after selecting item 3 (+30f)');
a.wait(120);
ascii('item-3 screen settled (+120f)');
const vb1 = vblanks;
log(`\nVBlanks during the 'frozen' window: ${vb1 - vb0} (should be ~150 if running)`);

// Try to BACK OUT — a true hang can't; a static screen can.
a.tap('b', 4, 20); a.wait(20);
ascii('after pressing B (back out?)');
a.tap('b', 4, 20); a.wait(20);
ascii('after pressing B again');
