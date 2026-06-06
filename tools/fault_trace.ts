import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));

// Key bits (active-low): A=0,B=1,Sel=2,Start=3,Right=4,Left=5,Up=6,Down=7,R=8,L=9
const K={A:1<<0,B:1<<1,SEL:1<<2,START:1<<3,RIGHT:1<<4,LEFT:1<<5,UP:1<<6,DOWN:1<<7,R:1<<8,L:1<<9};
function keys(...pressed:number[]){ let v=0x3ff; for(const p of pressed) v&=~p; return v; }

// ---- Fault detection: watch PC region + detect tight infinite loops ----
let lastPc=0, samePcCount=0, faultReported=false;
const pcHist:number[]=[];
function regionName(pc:number){
  const r=(pc>>>24)&0xff;
  if(r===0x00) return 'BIOS';
  if(r===0x02) return 'EWRAM';
  if(r===0x03) return 'IWRAM';
  if(r>=0x08&&r<=0x0d) return 'ROM';
  return 'BAD:0x'+r.toString(16);
}
const origStep=m.cpu.step.bind(m.cpu);
let instrSinceFault=0;
m.cpu.step=function(){
  const pc=m.cpu.st.r[15]>>>0;
  const region=regionName(pc);
  if(region.startsWith('BAD')&&!faultReported){
    console.log(`*** FAULT: PC in ${region} pc=0x${pc.toString(16)} lr=0x${(m.cpu.st.r[14]>>>0).toString(16)} thumb=${!!(m.cpu.st.cpsr&0x20)} frame=${frame}`);
    console.log('   recent PCs:',pcHist.slice(-12).map(p=>'0x'+p.toString(16)).join(' '));
    faultReported=true;
  }
  pcHist.push(pc); if(pcHist.length>32)pcHist.shift();
  return origStep();
};

let frame=0;
function run(nframes:number, keymask:number){
  for(let i=0;i<nframes;i++){ frame++; m.setKeys(keymask); m.runFrame(); }
}

// Capture a "fingerprint" of the screen: hash of framebuffer + whether it changed.
function fbHash(){ const fb=m.ppu.framebuffer; let h=0; for(let i=0;i<fb.length;i+=37){ h=(h*31 + fb[i])>>>0; } return h; }

// 1) Boot to title, press start/A to get into the game world.
run(420, 0x3ff);                 // boot intro/logos
console.log('after boot fbHash', fbHash().toString(16));
// Mash START then A repeatedly to advance through title -> continue/new game.
for(let i=0;i<40;i++){ run(4, keys(K.START)); run(4, 0x3ff); run(4, keys(K.A)); run(4, 0x3ff); }
console.log('after title-mash fbHash', fbHash().toString(16),'frame',frame);

// Snapshot state so we can detect when the START menu opens later.
console.log('PC now 0x'+(m.cpu.st.r[15]>>>0).toString(16), regionName(m.cpu.st.r[15]>>>0));

// 2) Open the START menu (Start button) and look at it.
run(10, 0x3ff);
run(6, keys(K.START)); run(20, 0x3ff);
const menuHash=fbHash();
console.log('after START press fbHash', menuHash.toString(16));

// 3) The player/profile is usually the top item or near it. Press A on it.
const before=fbHash();
run(6, keys(K.A)); run(60, 0x3ff);
console.log('after A-on-menu-item fbHash', fbHash().toString(16),'changed=',fbHash()!==before, 'fault=',faultReported);
console.log('final PC 0x'+(m.cpu.st.r[15]>>>0).toString(16), regionName(m.cpu.st.r[15]>>>0));
