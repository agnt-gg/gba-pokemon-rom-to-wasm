import { strict as assert } from 'node:assert';
import { GbaPpu } from '../src/runtime/ppu.ts';
import { GbaIo } from '../src/runtime/io.ts';
import { GbaMemory } from '../src/runtime/memory.ts';

let passed=0, failed=0;
function test(name:string, fn:()=>void){try{fn();passed++;console.log('ok   - '+name)}catch(e:any){failed++;console.log('FAIL - '+name+'\n       '+(e?.message||e))}}

test('Window 0 gates the BLDCNT darken effect (the main-menu highlight model)', ()=>{
  const mem=new GbaMemory();
  const io=new GbaIo();
  (mem as any).io = io;
  const ppu=new GbaPpu(mem, io);

  // Mode 0, BG0 on, WIN0 on.
  io.set16(0x000, 0x0100 | 0x2000);
  // BG0CNT: priority 0, charBase 0, screenBase block 1 (0x800) so the map doesn't clobber tile 0.
  io.set16(0x008, (1 << 8));
  // Palette index 1 = white.
  mem.palette[2]=0xff; mem.palette[3]=0x7f;
  // Tile 0 (4bpp): all pixels = color index 1.
  for(let i=0;i<32;i++) mem.vram[i]=0x11;
  // BG map at 0x800: all entries tile 0 (already zero by default).
  // WIN0 rectangle rows 64..95, cols 0..240.
  io.set16(0x040, (0<<8)|240);
  io.set16(0x044, (64<<8)|96);
  // Inside win0: effect OFF (bit5=0); outside: effect ON (bit5=1).
  io.set16(0x048, 0x0001); // WININ: BG0 visible, no effect
  io.set16(0x04a, 0x0021); // WINOUT: BG0 visible + effect enable
  // BLDCNT darken (mode 3), target A = BG0; BLDY = max.
  io.set16(0x050, (3<<6)|0x01);
  io.set16(0x054, 16);

  for(let line=0; line<160; line++) (ppu as any).renderScanline(line);
  const px=(x:number,y:number)=>{const o=(y*240+x)*4; return [ppu.framebuffer[o],ppu.framebuffer[o+1],ppu.framebuffer[o+2]];};
  const inside = px(120, 80);
  const outside = px(120, 20);
  assert.ok(inside[0]>200 && inside[1]>200 && inside[2]>200, `inside should stay bright, got ${inside}`);
  assert.ok(outside[0]<60 && outside[1]<60 && outside[2]<60, `outside should be darkened, got ${outside}`);
});

test('No window + no effect leaves colors untouched', ()=>{
  const mem=new GbaMemory();
  const io=new GbaIo();
  (mem as any).io = io;
  const ppu=new GbaPpu(mem, io);
  io.set16(0x000, 0x0100);
  io.set16(0x008, 0x0000);
  mem.palette[2]=0xff; mem.palette[3]=0x7f;
  for(let i=0;i<32;i++) mem.vram[i]=0x11;
  for(let line=0; line<160; line++) (ppu as any).renderScanline(line);
  const o=(80*240+120)*4;
  assert.ok(ppu.framebuffer[o]>200, `should be bright white, got ${ppu.framebuffer[o]}`);
});

console.log(`\n${passed} passed, ${failed} failed`); if(failed) process.exit(1);
