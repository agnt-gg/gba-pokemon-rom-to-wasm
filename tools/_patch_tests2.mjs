import { readFileSync, writeFileSync } from 'node:fs';

const file = 'tests/recompiler_diff.test.ts';
let src = readFileSync(file, 'utf8');

const edits = [
  // MVN/LSL chain: + terminating B
  [`  const interp = runInterp(prog, 2, init);
  const { snap, nativeCount } = runWasm(prog, init);
  if (nativeCount !== 2) throw new Error(\`expected 2 native, got \${nativeCount}\`);
  assertSame(interp, snap, 'mvn/lsl');`,
   `  const interp = runInterp(prog, 2, init);
  const { snap, nativeCount } = runWasm(prog, init);
  if (nativeCount !== 3) throw new Error(\`expected 2 native + B, got \${nativeCount}\`);
  assertSame(interp, snap, 'mvn/lsl');`],

  // STR + word LDR: the LDR (with ARM unaligned rotation) is NOW lifted natively.
  [`test('STR word is lifted natively; word LDR bails (unaligned-rotation safety)', () => {
  // STR is bit-exact and lifted; the following word LDR is intentionally NOT lifted (it can
  // require ARM unaligned-read rotation), so the native block must stop after the STR.
  const prog = [
    strImm(0, 1, 0x10),   // mem[r1+0x10] = r0   (native)
    ldrImm(2, 1, 0x10),   // r2 = mem[...]        (bails)
  ];
  const init = (c: ArmCore) => { c.st.r[0] = 0xdeadbeef | 0; c.st.r[1] = WORK; };
  const { nativeCount } = runWasm(prog, init);
  if (nativeCount !== 1) throw new Error(\`expected STR-only native block (1), got \${nativeCount}\`);
  // And the store itself must be correct vs interpreter after 1 step.
  const interp = runInterp(prog, 1, init);
  const { snap } = runWasm([strImm(0, 1, 0x10)], init);
  assertSame(interp, snap, 'str word native');
});`,
   `test('STR word + word LDR (native unaligned-rotation) match interpreter', () => {
  // Both the STR and the word LDR are lifted natively now: the LDR emits the ARM7
  // unaligned-read rotation as rotr(read32(addr & ~3), 8*(addr & 3)).
  const prog = [
    strImm(0, 1, 0x10),   // mem[r1+0x10] = r0   (native)
    ldrImm(2, 1, 0x10),   // r2 = mem[...]        (native, rotation-exact)
  ];
  const init = (c: ArmCore) => { c.st.r[0] = 0xdeadbeef | 0; c.st.r[1] = WORK; };
  const interp = runInterp(prog, 2, init);
  const { snap, nativeCount } = runWasm(prog, init);
  if (nativeCount !== 3) throw new Error(\`expected fully-native STR+LDR+B (3), got \${nativeCount}\`);
  assertSame(interp, snap, 'str+ldr word native');
});

test('unaligned word LDR rotation matches interpreter for every addr&3', () => {
  for (const mis of [0, 1, 2, 3]) {
    const prog = [ldrImm(2, 1, 0)]; // r2 = ldrWord(r1)
    const init = (c: ArmCore) => { c.st.r[1] = (WORK + 0x200 + mis) >>> 0; };
    const seed = (bus: RamBus) => bus.write32(WORK + 0x200, 0x11223344);
    const a = freshCpu(prog, init); seed(a.bus); a.cpu.step();
    const b = freshCpu(prog, init); seed(b.bus);
    const rec = new Recompiler(b.bus);
    const n = rec.tryRunNative(b.cpu);
    if (n < 1) throw new Error(\`unaligned LDR (mis=\${mis}) not native\`);
    assertSame(snapshot(a.cpu), snapshot(b.cpu), \`ldr rot mis=\${mis}\`);
  }
});`],

  // STRB/LDRB: +B
  [`  if (nativeCount !== 2) throw new Error(\`expected 2 native, got \${nativeCount}\`);
  assertSame(interp, snap, 'strb/ldrb');`,
   `  if (nativeCount !== 3) throw new Error(\`expected 2 native + B, got \${nativeCount}\`);
  assertSame(interp, snap, 'strb/ldrb');`],

  // post-indexed STR: +B
  [`  if (nativeCount !== 1) throw new Error(\`post-idx not lifted\`);
  assertSame(interp, snap, 'str post writeback');`,
   `  if (nativeCount !== 2) throw new Error(\`post-idx not lifted\`);
  assertSame(interp, snap, 'str post writeback');`],

  // pre-indexed LDR writeback: now fully native
  [`  // The pre-indexed word LDR bails (unaligned-rotation safety), so only the seeding STR is native.
  const { nativeCount } = runWasm(prog, init);
  if (nativeCount !== 1) throw new Error(\`expected STR-only native (1), got \${nativeCount}\`);
  // Correctness of the full sequence is still guaranteed because the interpreter handles the LDR.
  const interp = runInterp(prog, 2, init);
  const full = freshCpu(prog, init);
  const rec2 = new Recompiler(full.bus);
  let done = 0; while (done < 2) { const n = rec2.tryRunNative(full.cpu); if (n > 0) done += n; else { full.cpu.step(); done++; } }
  assertSame(interp, snapshot(full.cpu), 'ldr pre wb via hybrid');`,
   `  // The pre-indexed word LDR (incl. writeback) is now lifted natively.
  const interp = runInterp(prog, 2, init);
  const { snap, nativeCount } = runWasm(prog, init);
  if (nativeCount !== 3) throw new Error(\`expected fully-native STR+LDR!+B (3), got \${nativeCount}\`);
  assertSame(interp, snap, 'ldr pre wb native');`],
];

for (const [find, replace] of edits) {
  if (!src.includes(find)) { console.log('WARN not found: ' + find.slice(0, 80).replace(/\n/g, ' ')); continue; }
  src = src.replace(find, replace);
}
writeFileSync(file, src);
console.log('patched ' + file);
