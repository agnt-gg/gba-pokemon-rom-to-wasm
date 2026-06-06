import { readFileSync } from 'node:fs';
const path=process.argv[2];
if(!path) throw new Error('usage: analyze_save_image.ts file.sav');
const d=new Uint8Array(readFileSync(path));
const hex=(v:number)=>'0x'+(v>>>0).toString(16);
function u16(o:number){return d[o]|(d[o+1]<<8)}
function u32(o:number){return (d[o]|(d[o+1]<<8)|(d[o+2]<<16)|(d[o+3]<<24))>>>0}
function checksum(base:number){let sum=0; for(let i=0;i<0xff4;i+=4) sum=(sum+u32(base+i))>>>0; return ((sum>>>16)+(sum&0xffff))&0xffff;}
for(let s=0;s<32;s++){
 const b=s*0x1000; const id=u16(b+0xff4), chk=u16(b+0xff6), sig=u32(b+0xff8), cnt=u32(b+0xffc); let non=0; for(let i=0;i<0x1000;i++) if(d[b+i]!==0xff) non++;
 console.log(`sec=${s} non=${non} id=${id} chk=${hex(chk)} calc=${hex(checksum(b))} sig=${hex(sig)} cnt=${cnt}`);
}
