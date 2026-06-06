import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { GbaMachine } from '../src/runtime/machine.ts';

const ROM = process.argv[2] || 'C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const frames = Number(process.argv[3] || 9000); // 150 sec @ 60fps
const m = new GbaMachine(new Uint8Array(readFileSync(ROM)));
const hex=(v:number)=>'0x'+(v>>>0).toString(16);
function nonff(){let n=0; for(const b of m.flash.data) if(b!==0xff)n++; return n;}
let lastInstr=0, lastT=performance.now();
for(let f=1; f<=frames; f++){
  // boot/title mash, then no input. This should expose runtime accumulation without user save.
  if(f>900 && f<1500){ const press=(f%30<15)?1:8; m.setKeys(0x3ff & ~press); } else m.setKeys(0x3ff);
  const t0=performance.now();
  m.runFrame();
  const dt=performance.now()-t0;
  if(f%300===0){
    const now=performance.now();
    const instrDelta=m.instrCount-lastInstr; lastInstr=m.instrCount;
    const mem=process.memoryUsage();
    const samples=m.audio.drainSamples(1_000_000);
    console.log(JSON.stringify({
      f, frameMs:+dt.toFixed(3), wallMs:+(now-lastT).toFixed(1), instrDelta,
      pc:hex(m.pc()), cb1:hex(m.mem.read32(0x3001774)), task0:hex(m.mem.read32(0x3004b20)),
      audioSamples:samples.length/2, nonff:nonff(), dirty:m.flash.dirty,
      heapMB:+(mem.heapUsed/1048576).toFixed(1), rssMB:+(mem.rss/1048576).toFixed(1)
    }));
    lastT=now;
  }
}
