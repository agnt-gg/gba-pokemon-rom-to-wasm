import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const DIR='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/';
const rom=new Uint8Array(readFileSync(DIR+'Pokemon Ruby.GBA'));
const sav=new Uint8Array(readFileSync(DIR+'Pokemon Ruby.sav'));
const m:any=new GbaMachine(rom);
// Inject the existing 64KB/128KB save into Flash.
m.flash.data.set(sav.subarray(0, m.flash.data.length));
console.log('Loaded save, nonFF bytes:', [...m.flash.data].filter(b=>b!==0xff).length);

const K={A:1<<0,B:1<<1,START:1<<3,DOWN:1<<7,UP:1<<6,LEFT:1<<5,RIGHT:1<<4};
function keys(...p:number[]){let v=0x3ff;for(const x of p)v&=~x;return v;}
let frame=0; function run(n:number,k:number){for(let i=0;i<n;i++){frame++;m.setKeys(k);m.runFrame();}}
function fbHash(){const fb=m.ppu.framebuffer;let h=0;for(let i=0;i<fb.length;i+=37)h=(h*31+fb[i])>>>0;return h;}
function ascii(label:string){
  const fb=m.ppu.framebuffer; const W=240,H=160; const ramp=' .:-=+*#%@';
  console.log('\n=== '+label+' (f'+frame+') ===');
  for(let y=0;y<H;y+=8){ let line=''; for(let x=0;x<W;x+=4){ const i=(y*W+x)*4; const lum=(fb[i]*0.3+fb[i+1]*0.59+fb[i+2]*0.11)/255; line+=ramp[Math.min(9,Math.floor(lum*10))]; } console.log(line); }
}

run(300,0x3ff);
ascii('boot (title?)');
// Title -> press A/Start to reach the continue menu, then A to load save.
for(let i=0;i<25;i++){run(3,keys(K.A));run(4,0x3ff);run(3,keys(K.START));run(4,0x3ff);}
ascii('after A/Start mash');
let h=fbHash();
for(let i=0;i<6;i++){ run(30,0x3ff); const nh=fbHash(); console.log('  +30f 0x'+nh.toString(16)+(nh===h?' SAME':' changed')); h=nh; }
ascii('settled');
