import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const K={A:1<<0,B:1<<1,START:1<<3,DOWN:1<<7,UP:1<<6,L:1<<5,R:1<<4};
function keys(...p:number[]){let v=0x3ff;for(const x of p)v&=~x;return v;}
let frame=0; function run(n:number,k:number){for(let i=0;i<n;i++){frame++;m.setKeys(k);m.runFrame();}}
function fbHash(){const fb=m.ppu.framebuffer;let h=0;for(let i=0;i<fb.length;i+=37)h=(h*31+fb[i])>>>0;return h;}
function dispcnt(){return m.io.get16(0x4000000);}

// Boot to the title/main menu (no save -> NEW GAME path). Track DISPCNT to detect REAL screen changes.
run(300,0x3ff);
console.log('boot DISPCNT=0x'+dispcnt().toString(16)+' hash=0x'+fbHash().toString(16));

// Real title: press A to advance. Watch for DISPCNT change = real screen transition.
let lastD=dispcnt();
for(let i=0;i<200;i++){
  const k = (i%2===0)?keys(K.A):keys(K.START);
  run(2,k); run(3,0x3ff);
  const d=dispcnt();
  if(d!==lastD){ console.log('frame'+frame+': DISPCNT 0x'+lastD.toString(16)+' -> 0x'+d.toString(16)+' hash=0x'+fbHash().toString(16)); lastD=d; }
}
console.log('final DISPCNT=0x'+dispcnt().toString(16));
