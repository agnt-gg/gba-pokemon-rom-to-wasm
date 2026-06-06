import { readFileSync } from 'node:fs';
import { GbaMachine } from '../src/runtime/machine.ts';
const ROM='C:/Users/Studio/Documents/Torrents/Games/Pokemon GBA collection + emulator/Pokemon Ruby/Pokemon Ruby.GBA';
const m:any=new GbaMachine(new Uint8Array(readFileSync(ROM)));
const cnt:Record<number,number>={};
const orig=m.cpu.swiHandler;
let frame=0;
m.cpu.swiHandler=(c:number,cpu:any)=>{
  cnt[c]=(cnt[c]||0)+1;
  if(c===0x00){ console.log('SOFTRESET frame',frame,'pc',(cpu.st.r[15]>>>0).toString(16),'lr',(cpu.st.r[14]>>>0).toString(16)); }
  return orig(c,cpu);
};
// Detect a "restart": PC returning to entrypoint region after we were deep in game code.
let wasDeep=false;
for(frame=1;frame<=2500;frame++){
  let k=0x3ff;
  // boot to menu, mash A on menu
  if(frame>900&&frame<1300){k=0x3ff&~((frame%30<15)?1:8);}
  m.setKeys(k);
  try{ m.runFrame(); }catch(e:any){ console.log('THROW frame',frame, e.message); break; }
  const pc=m.cpu.st.r[15]>>>0;
  if(pc>0x08020000) wasDeep=true;
  if(wasDeep && pc>=0x08000000 && pc<0x08001000){ console.log('PC back at entrypoint region frame',frame,'pc',pc.toString(16)); wasDeep=false; }
}
console.log('SWIs:',Object.entries(cnt).map(([k,v])=>'0x'+(+k).toString(16)+'='+v).join(' '));
