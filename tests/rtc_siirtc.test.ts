/**
 * RTC protocol conformance: drive GbaRtc with the EXACT GPIO sequences pokeemerald/pokeruby
 * siirtc.c uses (WriteCommand MSB-first with data-while-SCK-low, ReadData sampling AFTER the
 * rising edge, LSB-first assembly) and assert the bytes the GAME would assemble.
 *
 * This reproduces the Emerald "battery has run dry" root cause: the first falling edge after
 * the command must PRESENT bit 0, not skip it. A shift-by-one here garbles STATUS (0x40 -> 0x20
 * = "12-hour mode") and all BCD datetime bytes -> RtcCheckInfo error flags -> battery message.
 */
import { strict as assert } from 'node:assert';
import { GbaRtc } from '../src/runtime/rtc.ts';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e: any) { failed++; console.log('FAIL - ' + name + '\n       ' + (e?.message || e)); }
}

const SCK = 1, SIO = 2, CS = 4;

// Mirror siirtc.c macros.
const CMD = (n: number) => 0x60 | (n << 1);
const RD = 1, WR = 0;
const CMD_RESET = CMD(0), CMD_STATUS = CMD(1), CMD_DATETIME = CMD(2), CMD_TIME = CMD(3);

class SiiRtcDriver {
  rtc = new GbaRtc();
  constructor() { this.rtc.write(0xc8, 1); } // GPIO read-enable, as the games set at init

  private out(v: number) { this.rtc.write(0xc4, v); }

  /** siirtc.c transfer prologue: SCK hi, then SCK|CS hi, all pins output. */
  begin() {
    this.out(SCK);
    this.out(SCK | CS);
    this.rtc.write(0xc6, 7); // DIR_ALL_OUT
  }
  /** siirtc.c epilogue: SCK hi (CS drops), twice. */
  end() {
    this.out(SCK);
    this.out(SCK);
  }

  /** WriteCommand: MSB first; data presented with SCK low (x3), latched on SCK rise. */
  writeCommand(value: number) {
    for (let i = 0; i < 8; i++) {
      const t = (value >> (7 - i)) & 1;
      const d = (t << 1) | CS;
      this.out(d); this.out(d); this.out(d);
      this.out(d | SCK);
    }
  }

  /** WriteData: LSB first (used for SiiRtcSetStatus / SetDateTime). */
  writeData(value: number) {
    for (let i = 0; i < 8; i++) {
      const t = (value >> i) & 1;
      const d = (t << 1) | CS;
      this.out(d); this.out(d); this.out(d);
      this.out(d | SCK);
    }
  }

  /** ReadData: per bit -> SCK low (x5), SCK high, THEN sample SIO. LSB-first assembly. */
  readData(): number {
    this.rtc.write(0xc6, 5); // DIR_0_OUT | DIR_1_IN | DIR_2_OUT (SIO becomes input)
    let value = 0;
    for (let i = 0; i < 8; i++) {
      this.out(CS); this.out(CS); this.out(CS); this.out(CS); this.out(CS);
      this.out(CS | SCK);
      const t = (this.rtc.read(0xc4) & SIO) >> 1;
      value = ((value >> 1) | (t << 7)) & 0xff;
    }
    return value;
  }

  getStatus(): number {
    this.begin();
    this.writeCommand(CMD_STATUS | RD);
    const v = this.readData();
    this.end();
    return v;
  }

  getDateTime(): number[] {
    this.begin();
    this.writeCommand(CMD_DATETIME | RD);
    this.rtc.write(0xc6, 5);
    const out: number[] = [];
    for (let b = 0; b < 7; b++) out.push(this.readData());
    this.end();
    return out;
  }

  getTime(): number[] {
    this.begin();
    this.writeCommand(CMD_TIME | RD);
    this.rtc.write(0xc6, 5);
    const out: number[] = [];
    for (let b = 0; b < 3; b++) out.push(this.readData());
    this.end();
    return out;
  }

  reset() {
    this.begin();
    this.writeCommand(CMD_RESET | WR);
    this.end();
    // SiiRtcReset then calls SiiRtcSetStatus(24HOUR):
    this.begin();
    this.writeCommand(CMD_STATUS | WR);
    this.writeData(0x40);
    this.end();
  }
}

function isBcd(v: number): boolean { return (v & 0x0f) <= 9 && ((v >> 4) & 0x0f) <= 9; }
function fromBcd(v: number): number { return ((v >> 4) & 0xf) * 10 + (v & 0xf); }

test('STATUS reads exactly 0x40 (24-hour mode, battery good) via the real siirtc sequence', () => {
  const d = new SiiRtcDriver();
  const status = d.getStatus();
  assert.equal(status, 0x40, `status read as 0x${status.toString(16)} - bit alignment broken`);
});

test('STATUS is stable across repeated reads (probe does several)', () => {
  const d = new SiiRtcDriver();
  for (let i = 0; i < 4; i++) assert.equal(d.getStatus(), 0x40, `read ${i}`);
});

test('SiiRtcProbe sequence succeeds: status 24h -> no reset path -> TIME has no TEST_MODE bit', () => {
  const d = new SiiRtcDriver();
  const status = d.getStatus();
  assert.equal(status & 0x40, 0x40, '24-hour flag');
  assert.equal(status & 0x80, 0, 'no power-failure flag');
  const [h, m, s] = d.getTime();
  assert.equal(s & 0x80, 0, 'TEST_MODE clear in seconds');
  assert.ok(isBcd(h) && fromBcd(h) < 24, `hour BCD: 0x${h.toString(16)}`);
  assert.ok(isBcd(m) && fromBcd(m) < 60, `minute BCD: 0x${m.toString(16)}`);
});

test('DATETIME: all 7 bytes valid BCD in range (RtcCheckInfo must produce zero error flags)', () => {
  const d = new SiiRtcDriver();
  const [yr, mo, day, wd, h, mi, s] = d.getDateTime();
  assert.ok(isBcd(yr) && fromBcd(yr) <= 99, `year 0x${yr.toString(16)}`);
  assert.ok(isBcd(mo) && fromBcd(mo) >= 1 && fromBcd(mo) <= 12, `month 0x${mo.toString(16)}`);
  assert.ok(isBcd(day) && fromBcd(day) >= 1 && fromBcd(day) <= 31, `day 0x${day.toString(16)}`);
  assert.ok(wd <= 6, `weekday 0x${wd.toString(16)}`);
  assert.ok(isBcd(h) && fromBcd(h) < 24, `hour 0x${h.toString(16)}`);
  assert.ok(isBcd(mi) && fromBcd(mi) < 60, `minute 0x${mi.toString(16)}`);
  assert.ok(isBcd(s & 0x7f) && fromBcd(s & 0x7f) < 60, `second 0x${s.toString(16)}`);
});

test('DATETIME matches host clock date (sanity: values are real, not zeros)', () => {
  const d = new SiiRtcDriver();
  const [yr, mo, day] = d.getDateTime();
  const now = new Date();
  assert.equal(fromBcd(yr), now.getFullYear() % 100, 'year');
  assert.equal(fromBcd(mo), now.getMonth() + 1, 'month');
  assert.equal(fromBcd(day), now.getDate(), 'day');
});

test('reset + SetStatus(24h) keeps battery-good status', () => {
  const d = new SiiRtcDriver();
  d.reset();
  assert.equal(d.getStatus(), 0x40);
});

test('back-to-back transfers do not leak bit alignment between commands', () => {
  const d = new SiiRtcDriver();
  d.getDateTime();
  assert.equal(d.getStatus(), 0x40, 'status after datetime');
  d.getTime();
  assert.equal(d.getStatus(), 0x40, 'status after time');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
