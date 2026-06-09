import { readFileSync, readdirSync } from 'node:fs';
const dir = 'tmp_prof';
const f = readdirSync(dir).filter(x => x.endsWith('.cpuprofile')).sort().pop();
const prof = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
const { nodes, samples, timeDeltas } = prof;
const byId = new Map(nodes.map(n => [n.id, n]));
const self = new Map();
for (let i = 0; i < samples.length; i++) {
  const id = samples[i];
  const dt = timeDeltas[i] || 0;
  self.set(id, (self.get(id) || 0) + dt);
}
const agg = new Map();
let total = 0;
for (const [id, t] of self) {
  const n = byId.get(id);
  if (!n) continue;
  const cf = n.callFrame;
  const key = `${cf.functionName || '(anon)'} @ ${(cf.url || '').split(/[\\/]/).pop()}:${cf.lineNumber}`;
  agg.set(key, (agg.get(key) || 0) + t);
  total += t;
}
const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log(`total sampled: ${(total / 1000).toFixed(0)} ms`);
for (const [k, t] of top) console.log(`${((t / total) * 100).toFixed(1).padStart(5)}%  ${(t / 1000).toFixed(0).padStart(6)}ms  ${k}`);
