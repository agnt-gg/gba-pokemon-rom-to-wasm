import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const K={A:1<<0,B:1<<1,START:1<<3,DOWN:1<<7,UP:1<<6};
function keys(...p:number[]){let v=0x3ff;for(const x of p)v&=~x;return v;}
let frame=0; function run(n:number,k:number){for(let i=0;i<n;i++){frame++;m.setKeys(k);m.runFrame();}}

function ascii(label:string){
  const fb=m.ppu.framebuffer; const W=240,H=160;
  const ramp=' .:-=+*#%@';
  console.log('\n=== '+label+' ===');
  for(let y=0;y<H;y+=5){
    let line='';
    for(let x=0;x<W;x+=3){
      const i=(y*W+x)*4; const lum=(fb[i]*0.3+fb[i+1]*0.59+fb[i+2]*0.11)/255;
      line+=ramp[Math.min(ramp.length-1,Math.floor(lum*ramp.length))];
    }
    console.log(line);
  }
}

run(420,0x3ff);
// Title screen: press START/A to get to continue menu.
ascii('after boot ('+frame+'f)');
for(let i=0;i<20;i++){run(3,keys(K.START));run(3,0x3ff);}
ascii('after START mash');
for(let i=0;i<20;i++){run(3,keys(K.A));run(5,0x3ff);}
ascii('after A mash (in-game?)');
