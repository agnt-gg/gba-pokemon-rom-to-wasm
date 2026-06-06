import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const K={A:1<<0,START:1<<3};
function keys(...p:number[]){let v=0x3ff;for(const x of p)v&=~x;return v;}
let frame=0; function run(n:number,k:number){for(let i=0;i<n;i++){frame++;m.setKeys(k);m.runFrame();}}

// Drive into the hanging screen.
run(420,0x3ff);
for(let i=0;i<40;i++){run(4,keys(K.START));run(4,0x3ff);run(4,keys(K.A));run(4,0x3ff);}
run(6,keys(K.START));run(24,0x3ff);
run(8,keys(K.A));run(40,0x3ff);

// Now instrument ONE frame in fine detail.
let vblankRequested=0, vcountValues=new Set<number>(), irqDelivered=0, dispatched=0, maxGuard=0;
const origReq=m.irq.request.bind(m.irq);
m.irq.request=(bits:number)=>{ if(bits&1)vblankRequested++; return origReq(bits); };
const origDeliver=(m.irq as any).deliver?.bind(m.irq);
// deliver is private; hook poll instead to count actual exception entries (pc->0x18).
const origStep=m.cpu.step.bind(m.cpu);
m.cpu.step=function(){ const r=origStep(); const v=m.io.get16(0x4000006)&0xff; vcountValues.add(v); if((m.cpu.st.r[15]>>>0)===0x18)irqDelivered++; return r; };

// Count how the runFrame loop spends its budget: halted vs busy.
let halted=0, busy=0;
const origHalted=Object.getOwnPropertyDescriptor(m.cpu,'halted');

run(1,0x3ff);
console.log('In 1 frame at the hang:');
console.log('  VBlank IRQ requested:', vblankRequested);
console.log('  distinct VCOUNT seen:', [...vcountValues].sort((a,b)=>a-b).join(','));
console.log('  CPU vectored to 0x18 (IRQ entry):', irqDelivered);
console.log('  IE=0x'+m.io.get16(0x4000200).toString(16),'IF=0x'+m.io.get16(0x4000202).toString(16),'IME=0x'+m.io.get16(0x4000208).toString(16));
console.log('  BIOS-IF @0x3007FF8 =0x'+m.mem.read16(0x03007ff8).toString(16));
console.log('  userHandler @0x3007FFC =0x'+(m.mem.read32(0x03007ffc)>>>0).toString(16));
console.log('  CPU halted now?', m.cpu.halted, ' cpsr=0x'+(m.cpu.st.cpsr>>>0).toString(16),' I-flag='+((m.cpu.st.cpsr>>7)&1));
