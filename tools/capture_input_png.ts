/** Capture a PNG after running with optional A/START mashing after frame 900. */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { GbaMachine } from '../src/runtime/machine.ts';
const rom = process.argv[2];
const frames = parseInt(process.argv[3] ?? '1200', 10);
const out = process.argv[4] ?? 'build/ruby_input.png';
const m = new GbaMachine(new Uint8Array(readFileSync(rom)));
let fb = new Uint8Array(240*160*4);
for (let f=1; f<=frames; f++) {
  if (f > 900) { const press = (f % 30 < 15) ? (1 << 0) : (1 << 3); m.setKeys(0x3ff & ~press); }
  else m.setKeys(0x3ff);
  fb = m.runFrame();
}
const CRC_TABLE = (()=>{const t=new Uint32Array(256); for(let n=0;n<256;n++){let c=n; for(let k=0;k<8;k++) c=c&1?0xedb88320^(c>>>1):c>>>1; t[n]=c>>>0;} return t;})();
function crc32(buf:Buffer){let c=0xffffffff; for(let i=0;i<buf.length;i++) c=CRC_TABLE[(c^buf[i])&0xff]^(c>>>8); return (c^0xffffffff)>>>0;}
function chunk(type:string,data:Buffer){const len=Buffer.alloc(4); len.writeUInt32BE(data.length); const tb=Buffer.from(type,'ascii'); const body=Buffer.concat([tb,data]); const crc=Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len,body,crc]);}
function png(w:number,h:number,rgba:Uint8Array){const raw=Buffer.alloc((w*4+1)*h); for(let y=0;y<h;y++){raw[y*(w*4+1)]=0; rgba.subarray(y*w*4,(y+1)*w*4).forEach((b,i)=>raw[y*(w*4+1)+1+i]=b);} const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=6; return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
writeFileSync(out, png(240,160,fb));
let nonBlack=0, distinct=new Set<number>(); for(let i=0;i<fb.length;i+=4){const k=(fb[i]<<16)|(fb[i+1]<<8)|fb[i+2]; if(k!==0) nonBlack++; distinct.add(k);}
console.log(`Wrote ${out} after ${frames} frames. nonBlack=${nonBlack}/38400 distinctColors=${distinct.size} DISPCNT=0x${m.io.get16(0).toString(16)} cb1=0x${(m.mem.read32(0x3001774)>>>0).toString(16)}`);
