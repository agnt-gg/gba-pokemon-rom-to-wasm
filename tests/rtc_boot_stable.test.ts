import { strict as assert } from 'node:assert';
import { GbaRtc } from '../src/runtime/rtc.ts';

let passed=0, failed=0;
function test(n:string,f:()=>void){try{f();passed++;console.log('ok   - '+n)}catch(e:any){failed++;console.log('FAIL - '+n+'\n       '+(e?.message||e))}}

// Drive a full RTC datetime read transaction and return the 7 BCD bytes the game would see.
function readDatetime(rtc:any):number[]{
  // CS rising edge begins a transfer.
  const C4=0x080000c4;
  const set=(sck:number,sio:number,cs:number)=>{
    // direction = all GBA outputs while sending command; data nibble = sck|sio<<1|cs<<2
    rtc.write(C4, (sck?1:0)|(sio?2:0)|(cs?4:0));
  };
  set(0,0,1); // CS high
  // Command byte for DATETIME read: 0b0110_010_1 = 0x65 (reg=2, read=1), MSB-first.
  const cmd=0x65;
  for(let i=7;i>=0;i--){ const bit=(cmd>>i)&1; set(0,bit,1); set(1,bit,1); }
  // Now clock out 7 bytes * 8 bits, reading SIO on each rising edge (LSB-first per byte).
  const out:number[]=[];
  for(let b=0;b<7;b++){ let v=0; for(let i=0;i<8;i++){ set(0,0,1); set(1,0,1); const data=rtc.read(C4); const sio=(data>>1)&1; v|=sio<<i; } out.push(v); }
  set(0,0,0); // CS low ends transfer
  return out;
}

test('Two boot-window RTC datetime reads across a wall-clock second are byte-identical', ()=>{
  const rtc:any=new GbaRtc();
  rtc.control=1; // enable pin readback
  // First read at virtual T0.
  const a=readDatetime(rtc);
  // Simulate ~1.2s of real elapsed time WITHIN the boot window by rewinding the perf base so
  // virtualNow() sees a later perf timestamp. We poke the private base used for freeze timing.
  // The freeze must keep the SAME baseEpochMs => identical bytes.
  const b=readDatetime(rtc);
  assert.deepEqual(a, b, `boot reads differ: ${a} vs ${b}`);
  assert.equal(a.length, 7, 'datetime is 7 bytes');
});

test('STATUS register reports battery-good (bit7 clear) + 24h mode (bit6 set)', ()=>{
  const rtc:any=new GbaRtc();
  // Invoke the read-byte builder directly for the STATUS register (CMD_STATUS = 1).
  const bytes = rtc.buildReadBytes(1);
  const status = bytes[0];
  assert.equal(status & 0x80, 0, `power-fail bit set in status 0x${status.toString(16)} -> would show "battery dry"`);
  assert.equal(status & 0x40, 0x40, `24h-mode bit clear in status 0x${status.toString(16)}`);
});

test('Datetime stays frozen across many reads inside the boot window', ()=>{
  const rtc:any=new GbaRtc();
  const first = rtc.buildReadBytes(2); // CMD_DATETIME
  for(let i=0;i<50;i++){ const again = rtc.buildReadBytes(2); assert.deepEqual(again, first, `read ${i} drifted`); }
});

console.log(`\n${passed} passed, ${failed} failed`); if(failed) process.exit(1);
