/** Render the current screen as ASCII at key intro checkpoints so I can SEE where the agent is. */
import { Agent, bootToTitle } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
function ascii(label: string) {
  const fb = a.m.ppu.framebuffer; const W = 240, H = 160; const ramp = ' .:-=+*#%@';
  console.log(`\n=== ${label} (f${a.frame} DISPCNT=0x${a.snap().DISPCNT.toString(16)}) ===`);
  for (let y = 0; y < H; y += 5) { let line = ''; for (let x = 0; x < W; x += 3) { const i = (y * W + x) * 4; const lum = (fb[i]*0.3+fb[i+1]*0.59+fb[i+2]*0.11)/255; line += ramp[Math.min(9, Math.floor(lum*10))]; } console.log(line); }
}
bootToTitle(a, 320);
ascii('title');
for (let i = 0; i < 12; i++) { a.tap('start', 4, 8); a.tap('a', 4, 8); }
ascii('after title/menu mash');
for (let i = 0; i < 40; i++) a.tap('a', 3, 6);
ascii('after speech-A x40');
for (let i = 0; i < 4; i++) a.tap('a', 3, 4);
a.tap('start', 4, 10);
for (let i = 0; i < 30; i++) a.tap('a', 3, 6);
ascii('after name+confirm+speech');
// walk down a bunch
a.hold('down'); a.wait(60); a.release('down'); a.wait(10);
ascii('after walking down');
