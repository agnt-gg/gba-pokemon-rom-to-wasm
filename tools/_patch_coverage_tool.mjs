import { readFileSync, writeFileSync } from 'node:fs';
const file = 'tools/recomp_coverage.ts';
let src = readFileSync(file, 'utf8');
const anchor = `console.log(\`THUMB blocks/null     : \${thmBlk}/\${thmNull}\`);`;
if (!src.includes(anchor)) {
  // fall back: append at end
  src += `\n`;
}
const addition = `
// Bail-reason telemetry: why block discovery stopped, keyed mode:reason, sorted by frequency.
const reasons = [...rec.bailReasons.entries()].sort((a, b) => b[1] - a[1]);
if (reasons.length) {
  console.log('--- bail reasons (block discovery) ---');
  for (const [k, v] of reasons) console.log(\`  \${k.padEnd(24)} \${v}\`);
}
`;
if (src.includes(anchor)) src = src.replace(anchor, anchor + addition);
else src += addition;
writeFileSync(file, src);
console.log('patched ' + file);
