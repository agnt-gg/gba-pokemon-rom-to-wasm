import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';

const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const hex=(v:number)=>'0x'+(v>>>0).toString(16);

// Bounded trace only: no per-frame histograms, no huge maps, no `more`.
// libagb flash helper targets found from save.c callsites.
const targets = [
  0x081dfa98, // ProgramFlashSectorAndVerify / related sector writer target from TryWriteSector
  0x081df89c, // ReadFlash related helper
  0x081dfadc, // ProgramFlashByte-ish helper
  0x081dfc80, 0x081dfcd8, // erase/program internals
  0x081e0830, 0x081e0838, 0x081e0f08, // memcpy/checksum/helper calls used by save.c
];
const near = (pc:number,t:number)=> pc>=t && pc<t+12;
let logs=0;
for(let f=1; f<=1500 && logs<120; f++){
  if(f>900){ const press=(f%30<15)?1:8; m.setKeys(0x3ff & ~press); }
  else m.setKeys(0x3ff);
  let cycles=0, guard=0;
  while(cycles<280896 && guard<1500000 && logs<120){
    const pc=m.pc();
    for(const t of targets){
      if(near(pc,t)){
        let nonff=0; for(const b of m.flash.data) if(b!==0xff) nonff++;
        console.log(`hit target=${hex(t)} pc=${hex(pc)} r0=${hex(m.cpu.st.r[0])} r1=${hex(m.cpu.st.r[1])} r2=${hex(m.cpu.st.r[2])} r3=${hex(m.cpu.st.r[3])} lr=${hex(m.cpu.st.r[14])} f=${m.frameCount} nonff=${nonff} dirty=${m.flash.dirty}`);
        logs++;
        break;
      }
    }
    cycles += m.step();
    guard++;
  }
  m.frameCount++;
}
let nonff=0; for(const b of m.flash.data) if(b!==0xff) nonff++;
console.log(`done logs=${logs} frame=${m.frameCount} pc=${hex(m.pc())} nonff=${nonff} dirty=${m.flash.dirty}`);
