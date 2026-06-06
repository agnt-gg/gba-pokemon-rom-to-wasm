import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const K={A:1<<0,B:1<<1,START:1<<3,DOWN:1<<7,UP:1<<6,LEFT:1<<5,RIGHT:1<<4};
function keys(...p:number[]){let v=0x3ff;for(const x of p)v&=~x;return v;}
let frame=0; function run(n:number,k:number){for(let i=0;i<n;i++){frame++;m.setKeys(k);m.runFrame();}}
function ascii(label:string){
  const fb=m.ppu.framebuffer; const W=240,H=160; const ramp=' .:-=+*#%@';
  console.log('\n=== '+label+' (f'+frame+') ===');
  for(let y=0;y<H;y+=6){ let line=''; for(let x=0;x<W;x+=3){ const i=(y*W+x)*4; const lum=(fb[i]*0.3+fb[i+1]*0.59+fb[i+2]*0.11)/255; line+=ramp[Math.min(9,Math.floor(lum*10))]; } console.log(line); }
}
function fbHash(){const fb=m.ppu.framebuffer;let h=0;for(let i=0;i<fb.length;i+=37)h=(h*31+fb[i])>>>0;return h;}

run(420,0x3ff);
// Get into the game proper: title -> continue/new
for(let i=0;i<30;i++){run(3,keys(K.START));run(3,0x3ff);}
for(let i=0;i<30;i++){run(3,keys(K.A));run(5,0x3ff);}
ascii('after-A-mash');
// Try walking into grass: mash a direction for a while to trigger an encounter.
for(let dir of [K.UP,K.DOWN,K.LEFT,K.RIGHT]){
  for(let i=0;i<30;i++){run(4,keys(dir));run(2,0x3ff);}
}
ascii('after-walking');
// Watch 200 frames, log hash every 25 to see if it's animating or truly frozen.
let prev=fbHash();
for(let i=0;i<8;i++){ run(25,0x3ff); const h=fbHash(); console.log('  +25f hash=0x'+h.toString(16)+(h===prev?' (SAME)':' (changed)')); prev=h; }
ascii('final');
