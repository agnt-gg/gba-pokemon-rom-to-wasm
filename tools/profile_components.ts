import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m=new GbaMachine(new Uint8Array(readFileSync(ROM)));
let total=0, max=0;
for(let f=1;f<=2400;f++){
  if(f>900&&f<1500){const press=(f%30<15)?1:8;m.setKeys(0x3ff&~press);} else m.setKeys(0x3ff);
  const t=performance.now(); m.runFrame(); const dt=performance.now()-t; total+=dt; if(dt>max)max=dt;
  if(f%300===0){const mem=process.memoryUsage(); console.log(`f=${f} avg=${(total/300).toFixed(2)} max=${max.toFixed(2)} heap=${(mem.heapUsed/1048576).toFixed(1)} rss=${(mem.rss/1048576).toFixed(1)} out=${m.audio.drainSamples(1e9).length/2}`); total=0; max=0;}
}
