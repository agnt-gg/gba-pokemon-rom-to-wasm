/**
 * New (cleaner) fingerprint after the nested-IRQ guard:
 *   SoftReset from EWRAM pc=0x20200d0, lr=0x8060665 (REAL ROM, not 0!), IE=0x3, IF=0x2 (HBlank).
 *   recentSwis are now LEGIT (0x5 VBlankIntrWait, 0xb CpuSet, 0xf ObjUnComp at ROM 0x81e07xx) until
 *   one garbage '0xc0@pc0x202006c' then '0x0@pc0x20200d0' (SoftReset).
 *
 * So the stack is no longer shredded; instead a SINGLE bad control-transfer lands the PC in EWRAM at
 * 0x2020xxx and runs a few bytes into SoftReset. lr=0x8060665 is the ROM caller. The callerCode
 * window (around lr) had a BL: '0xf7ff 0xff65' = a THUMB BL. Decode the ROM caller 0x8060640..0x80606a0
 * AND dump the EWRAM landing 0x2020060..0x20200e0 to see what code (if any) is actually there.
 *
 * Hypothesis: lr=0x8060665 calls a function pointer that SHOULD point into a copied IWRAM/EWRAM
 * routine, but the pointer is stale/zero so it jumps to 0x2020xxx which is uninitialised/zeroed EWRAM
 * -> executes 0x0000 (which is THUMB 'lsl r0,r0,#0' / harmless) until it hits a byte = SWI -> reset.
 * The real bug is whatever was supposed to populate 0x2020xxx (a CpuSet/decompress dest) or the
 * function-pointer table the caller indexes.
 */
import { Agent } from './control.ts';
const ROM = process.env.ROM || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const a = Agent.fromRom(ROM);
const log = (s: string) => console.log(s);
const m = a.m;
function thumb(lo: number, hi: number, label: string){
  log(`\n[${label}] 0x${lo.toString(16)}..0x${hi.toString(16)} (THUMB):`);
  for (let p=lo; p<hi; p+=2) log(`  0x${p.toString(16)}: 0x${(m.mem.read16(p)&0xffff).toString(16).padStart(4,'0')}`);
}
a.wait(330);
// ROM caller around lr=0x8060665 (THUMB BL returns to lr; the BL itself is at lr-4..lr-2 typ).
thumb(0x8060640, 0x80606a0, 'ROM caller around lr=0x8060665');
// EWRAM landing site.
thumb(0x2020050, 0x20200e0, 'EWRAM landing 0x2020050..0x20200e0 (SWI sites 0x202006c / 0x20200d0)');
// Decode the BL right before lr. callerCode around lr was: idx7 '0xf7ff' idx8 '0xff65' => BL.
const blHi = 0xf7ff, blLo = 0xff65; const lr = 0x8060665 & ~1;
const off = (((blHi & 0x7ff) << 11) | (blLo & 0x7ff)); let s = off; if (s & 0x400000) s -= 0x800000;
const blPc = (lr - 2) >>> 0; // BL low half is at lr-2 (it returns to lr)
const tgt = (blPc + 2 + s * 2) >>> 0;
log(`\n[BL decode] caller BL at ~0x${blPc.toString(16)} -> target 0x${tgt.toString(16)}`);
log('[note] if target is a sane ROM/IWRAM address, the function pointer is fine and the fault is');
log('       inside that callee writing/jumping to 0x2020xxx; if target is 0x2020xxx, the pointer is bad.');
