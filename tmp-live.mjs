import fs from 'node:fs';
import { compileProfile } from './src/core/profile.js';
import { compileSource } from './src/core/source.js';
import { SourceRunner } from './server/runner.mjs';

const runner = new SourceRunner({ emit: () => {}, log: () => {} });
const prof = (n) => compileProfile(JSON.parse(fs.readFileSync(`profiles/${n}.json`, 'utf8')));

for (const file of fs.readdirSync('sources')) {
  const doc = JSON.parse(fs.readFileSync('sources/' + file, 'utf8'));
  let src;
  try {
    src = compileSource(doc, (p) => (typeof p === 'string' ? prof(p) : compileProfile(p)), process.env);
  } catch (e) {
    console.log(`FAIL ${doc.name}: ${(e.problems || [e.message]).join('; ')}`); continue;
  }
  if (src.missingSecrets.length) {
    console.log(`skip ${doc.name.padEnd(12)} secret absent: ${src.missingSecrets.join(',')}`); continue;
  }
  const r = await runner.test(src, { seconds: 10 });
  const found = r.found ?? 0;
  const flag = found > 0 ? 'ok  ' : 'FAIL';
  console.log(`${flag} ${doc.name.padEnd(12)} ${src.streaming ? src.protocol.padEnd(10) : 'poll'.padEnd(10)} evenements=${found}` +
    (r.messages != null ? ` messages=${r.messages}` : '') +
    (r.problems && r.problems.length ? `  ${r.problems.slice(0,2).join(' | ')}` : ''));
  if (r.first) {
    const e = r.first.event;
    console.log(`       -> ${JSON.stringify({ magnitude: e.magnitude, polarity: e.polarity, id: String(e.id).slice(0,28), category: e.category, label: String(e.label||'').slice(0,42) })}`);
  }
}
process.exit(0);
