import { readFileSync, writeFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const K={A:1<<0,B:1<<1,START:1<<3,DOWN:1<<7,UP:1<<6};
function keys(...p:number[]){let v=0x3ff;for(const x of p)v&=~x;return v;}
let frame=0; function run(n:number,k:number){for(let i=0;i<n;i++){frame++;m.setKeys(k);m.runFrame();}}
function fbHash(){const fb=m.ppu.framebuffer;let h=0;for(let i=0;i<fb.length;i+=37)h=(h*31+fb[i])>>>0;return h;}

// Minimal PNG writer (RGBA, no compression filter complexity) using zlib.
import zlib from 'node:zlib';
function savePng(path:string){
  const W=240,H=160; const fb=m.ppu.framebuffer;
  const raw=Buffer.alloc((W*4+1)*H);
  for(let y=0;y<H;y++){ raw[y*(W*4+1)]=0; for(let x=0;x<W*4;x++) raw[y*(W*4+1)+1+x]=fb[y*W*4+x]; }
  const idat=zlib.deflateSync(raw);
  const chunk=(type:string,data:Buffer)=>{ const len=Buffer.alloc(4); len.writeUInt32BE(data.length); const tc=Buffer.concat([Buffer.from(type),data]); const crc=Buffer.alloc(4); crc.writeUInt32BE(crc32(tc)>>>0); return Buffer.concat([len,tc,crc]); };
  function crc32(buf:Buffer){let c=~0;for(let i=0;i<buf.length;i++){c^=buf[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xedb88320&-(c&1));}return ~c;}
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(H,4); ihdr[8]=8; ihdr[9]=6;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);
  writeFileSync(path,png);
}

run(420,0x3ff);
for(let i=0;i<40;i++){run(4,keys(K.START));run(4,0x3ff);run(4,keys(K.A));run(4,0x3ff);}
savePng('tools/shot_overworld.png'); console.log('overworld saved, hash',fbHash().toString(16));

run(6,keys(K.START));run(30,0x3ff);
savePng('tools/shot_menu.png'); console.log('menu saved, hash',fbHash().toString(16));

// Select top item (player profile is usually top in Ruby start menu? actually POKEDEX/POKEMON...).
run(8,keys(K.A));run(20,0x3ff);
savePng('tools/shot_after_A.png'); console.log('after-A saved, hash',fbHash().toString(16));

// Now watch 120 frames and see if the screen freezes (hang) or animates.
let prev=fbHash(); let frozen=0,maxFrozen=0,changes=0;
for(let i=0;i<120;i++){ run(1,0x3ff); const h=fbHash(); if(h===prev){frozen++; if(frozen>maxFrozen)maxFrozen=frozen;} else {frozen=0;changes++;} prev=h; }
savePng('tools/shot_final.png');
console.log('over 120 frames: changes='+changes+' maxConsecutiveFrozen='+maxFrozen+' finalHash='+fbHash().toString(16));
console.log('overworldHashAgain (did it revert to overworld/title?)');
