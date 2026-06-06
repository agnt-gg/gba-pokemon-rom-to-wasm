/**
 * The live build reported SoftReset from caller lr=0x8001e7b (ROM) via an EWRAM trampoline at
 * pc=0x202107c. Disassemble the ROM caller region 0x8001e60..0x8001ea0 to understand what code
 * path calls SoftReset. In pokeruby this is almost always one of:
 *   - the EXCEPTION/crash handler (game faulted -> reboot)
 *   - the "no save / corrupt save" path
 *   - the intro RESET after the copyright/Game Freak logo (NORMAL on a fresh boot!)
 * We classify by the surrounding instructions and any string/branch targets.
 */
import { Agent } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);
const m = a.m;
function thumbAt(lo: number, hi: number, label: string){
  log(`\n[${label}] 0x${lo.toString(16)}..0x${hi.toString(16)} (THUMB):`);
  for (let p=lo; p<hi; p+=2) log(`  0x${p.toString(16)}: 0x${m.mem.read16(p).toString(16).padStart(4,'0')}`);
}
function armAt(lo:number,hi:number,label:string){
  log(`\n[${label}] 0x${lo.toString(16)}..0x${hi.toString(16)} (ARM words):`);
  for (let p=lo;p<hi;p+=4) log(`  0x${p.toString(16)}: 0x${(m.mem.read32(p)>>>0).toString(16).padStart(8,'0')}`);
}
// Must boot a little so ROM is mapped & EWRAM trampoline copied; run enough to populate EWRAM.
a.wait(330);
// ROM caller of SoftReset.
thumbAt(0x8001e60, 0x8001ea0, 'ROM caller around lr=0x8001e7b');
// The EWRAM SWI trampoline site (may not be populated this early; show anyway).
thumbAt(0x2021070, 0x2021090, 'EWRAM SWI site around 0x202107c');
// pokeruby SoftReset path is reached from the "Reset" RAM function copied by IntrMain/Init.
// Check what's around the well-known DoSoftReset (0x080000C... no). Instead, scan ROM near caller
// for the literal pool: the word just after the BL likely holds the routine name pointer or a
// known constant. Dump the nearby literal pool.
armAt(0x8001e80, 0x8001ea0, 'literal pool after caller');
log('\n[note] If this region matches the boot/Init reset (logo sequence), a SoftReset here is NORMAL');
log('       and the bug is that we MISHANDLE it (e.g. clobber EWRAM the game expected to persist).');
