import { readFileSync, writeFileSync } from 'node:fs';

const file = 'tests/recompiler_diff.test.ts';
let src = readFileSync(file, 'utf8');

const edits = [
  // Terminate every test program with `B .` so block discovery stops where the program ends
  // (the expanded lifter now lifts conditional instrs, so trailing zero-memory `andeq r0,r0,r0`
  // no longer bails — real code always ends in a branch, and now so do the test programs).
  [
    `function loadProgram(bus: RamBus, words: number[]) {
  for (let i = 0; i < words.length; i++) bus.write32(BASE + i * 4, words[i] >>> 0);
}`,
    `function loadProgram(bus: RamBus, words: number[]) {
  for (let i = 0; i < words.length; i++) bus.write32(BASE + i * 4, words[i] >>> 0);
  // Terminate with \`B .\` so the recompiled block ends exactly at the program boundary.
  bus.write32(BASE + words.length * 4, 0xeafffffe);
}`,
  ],
  // The terminating branch is itself lifted natively, so expected counts grow by exactly 1.
  [`if (nativeCount !== 4) throw new Error(\`expected 4 native instrs, got \${nativeCount}\`);`,
   `if (nativeCount !== 5) throw new Error(\`expected 4 native instrs + B, got \${nativeCount}\`);`],
  [`if (nativeCount !== 2) throw new Error(\`expected 2 native, got \${nativeCount}\`);
  assertSame(interp, snap, 'add/orr reg');`,
   `if (nativeCount !== 3) throw new Error(\`expected 2 native + B, got \${nativeCount}\`);
  assertSame(interp, snap, 'add/orr reg');`],
  [`if (nativeCount !== 1) throw new Error(\`SUBS not lifted for a=\${a}\`);`,
   `if (nativeCount !== 2) throw new Error(\`SUBS not lifted for a=\${a}\`);`],
  [`if (nativeCount !== 2) throw new Error(\`expected 2 native, got \${nativeCount}\`);
  assertSame(interp, snap, 'shifted op2');`,
   `if (nativeCount !== 3) throw new Error(\`expected 2 native + B, got \${nativeCount}\`);
  assertSame(interp, snap, 'shifted op2');`],
];
for (const [find, replace] of edits) {
  if (!src.includes(find)) { console.log('WARN not found: ' + find.slice(0, 70)); continue; }
  src = src.replace(find, replace);
}
writeFileSync(file, src);
console.log('patched ' + file);
