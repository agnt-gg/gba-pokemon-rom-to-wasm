import { readFileSync, writeFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const romPath = process.argv[2];
const frames = parseInt(process.argv[3] ?? '600', 10);
const out = process.argv[4] ?? 'build/audio.wav';
const m = new GbaMachine(new Uint8Array(readFileSync(romPath)));
const samples:number[]=[];
for(let f=0; f<frames; f++){
  m.runFrame();
  const s=m.audio.drainSamples(4096);
  for(const v of s) samples.push(Math.max(-1, Math.min(1, v)));
}
const data=Buffer.alloc(samples.length*2);
for(let i=0;i<samples.length;i++) data.writeInt16LE(Math.round(samples[i]*32767), i*2);
const hdr=Buffer.alloc(44);
hdr.write('RIFF',0); hdr.writeUInt32LE(36+data.length,4); hdr.write('WAVE',8); hdr.write('fmt ',12);
hdr.writeUInt32LE(16,16); hdr.writeUInt16LE(1,20); hdr.writeUInt16LE(2,22); hdr.writeUInt32LE(44100,24);
hdr.writeUInt32LE(44100*2*2,28); hdr.writeUInt16LE(4,32); hdr.writeUInt16LE(16,34); hdr.write('data',36); hdr.writeUInt32LE(data.length,40);
writeFileSync(out, Buffer.concat([hdr,data]));
let peak=0,sum=0; for(const v of samples){const a=Math.abs(v); if(a>peak)peak=a; sum+=a;}
console.log(`Wrote ${out}; stereoFrames=${samples.length/2}; peak=${peak.toFixed(3)} avg=${(sum/Math.max(1,samples.length)).toFixed(4)}`);
