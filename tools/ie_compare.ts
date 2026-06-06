import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const K={A:1<<0,START:1<<3};
function keys(...p:number[]){let v=0x3ff;for(const x of p)v&=~x;return v;}
let frame=0; function run(n:number,k:number){for(let i=0;i<n;i++){frame++;m.setKeys(k);m.runFrame();}}
function snap(label:string){
  console.log(label+': IE=0x'+m.io.get16(0x4000200).toString(16)+' DISPCNT=0x'+m.io.get16(0x4000000).toString(16)+' DISPSTAT=0x'+(m.io.get16(0x4000004)&0xff38).toString(16)+' BLDCNT=0x'+m.io.get16(0x4000050).toString(16)+' MOSAIC=0x'+m.io.get16(0x400004c).toString(16)+' DMA0CNT=0x'+m.io.get16(0x40000ba).toString(16)+' DMA3CNT=0x'+m.io.get16(0x40000de).toString(16));
}
run(420,0x3ff);
for(let i=0;i<40;i++){run(4,keys(K.START));run(4,0x3ff);run(4,keys(K.A));run(4,0x3ff);}
snap('overworld   ');
run(6,keys(K.START));run(24,0x3ff);
snap('menu open   ');
run(8,keys(K.A));run(10,0x3ff);
snap('after A +10f ');
run(30,0x3ff);
snap('after A +40f ');
run(60,0x3ff);
snap('after A +100f');

// Is HBlank IRQ ever enabled? Track IE bit1 (HBlank) and bit2 (VCount) across the transition.
let sawHblankIE=false, sawVcountIE=false;
const oGet=m.io.get16.bind(m.io);
for(let i=0;i<60;i++){ run(1,0x3ff); const ie=oGet(0x4000200); if(ie&2)sawHblankIE=true; if(ie&4)sawVcountIE=true; }
console.log('\nDuring transition: HBlank-IRQ ever enabled?', sawHblankIE, ' VCount-IRQ ever enabled?', sawVcountIE);
console.log('Final IE=0x'+oGet(0x4000200).toString(16));
