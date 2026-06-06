import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const K={A:1<<0,START:1<<3};
function keys(...p:number[]){let v=0x3ff;for(const x of p)v&=~x;return v;}
let frame=0; function run(n:number,k:number){for(let i=0;i<n;i++){frame++;m.setKeys(k);m.runFrame();}}
run(420,0x3ff);
for(let i=0;i<40;i++){run(4,keys(K.START));run(4,0x3ff);run(4,keys(K.A));run(4,0x3ff);}
run(6,keys(K.START));run(24,0x3ff);
run(8,keys(K.A));run(40,0x3ff);

// Hook poll() to log each call's decision.
let pollCalls=0, delivered=0, rejIme=0, rejIflag=0, rejPending=0, wakes=0;
const ioGet=m.io.get16.bind(m.io);
const origReq=m.irq.request.bind(m.irq);
m.irq.request=(bits:number)=>{ const wasHalted=m.cpu.halted; origReq(bits); if(wasHalted&&!m.cpu.halted)wakes++; };
const origPoll=m.irq.poll.bind(m.irq);
m.irq.poll=function(){
  pollCalls++;
  const ime=ioGet(0x4000208)&1; if(!ime){rejIme++;return;}
  if(m.cpu.st.cpsr & 0x80){rejIflag++;return;}
  const ie=ioGet(0x4000200); const pend=ie & m.irq.ifFlags;
  if(!pend){rejPending++;return;}
  delivered++;
  return origPoll();
};

run(1,0x3ff);
console.log('Over 1 frame at the hang:');
console.log('  poll() calls:', pollCalls);
console.log('  -> delivered (IRQ taken):', delivered);
console.log('  -> rejected IME=0:', rejIme);
console.log('  -> rejected CPSR.I set:', rejIflag);
console.log('  -> rejected no pending (IE&IF==0):', rejPending);
console.log('  CPU wakes from request():', wakes);
console.log('  final halted=', m.cpu.halted, 'IF=0x'+ioGet(0x4000202).toString(16), 'BIOS-IF=0x'+m.mem.read16(0x03007ff8).toString(16));
