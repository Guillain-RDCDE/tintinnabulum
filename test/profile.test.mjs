// Mapping profiles: the shipped ones must work, and a bad one must be
// refused with a reason someone can act on.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const DIR = fileURLToPath(new URL('../profiles', import.meta.url));
import { compileProfile, validateProfile, profileFromQuery, ProfileError } from '../src/core/profile.js';

let fails = 0;
const ok = (n, c, x = '') => { if (!c) { fails++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } else console.log('ok    ' + n + (x ? '  ' + x : '')); };

// Every shipped profile must compile and produce a usable event from a
// realistic payload. A profile that does not is a standard telling a lie.
const samples = {
  'http-access-log': { method: 'POST', route: '/checkout', status: 503, duration_ms: 812, time: '2026-09-06T10:00:00Z' },
  'prometheus-alert': { status: 'firing', labels: { alertname: 'DiskFull', instance: 'db-1', severity: 'critical' }, annotations: { summary: 'Disk 97% on db-1' }, generatorURL: 'https://prom/graph', startsAt: '2026-09-06T10:00:00Z' },
  'git-commit': { stats: { total: 143 }, additions: 120, deletions: 23, author: { email: 'a@b.c', name: 'A' }, message: 'Fix the thing\n\nlonger body', url: 'https://git/c/1', timestamp: 1757152800 },
  'usgs-quake': { id: 'ci41542184', properties: { mag: 5.8, place: '6 km NNW of Cabazon, CA', time: 1788719342690, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/ci41542184' } },
  'x-search': { id: '1', text: 'Pentagon pizza index spiking\nsecond line', lang: 'en', created_at: '2026-09-06T23:10:00Z', public_metrics: { retweet_count: 240, like_count: 900, reply_count: 30 } },
  // The shapes each live API actually returns, taken from a real response.
  'blockchain-tx': { op: 'utx', x: { hash: '0ac3825bfda1f9b00897742beaa7', out: [{ value: 574413 }, { value: 12000 }] } },
  'coinbase-match': { type: 'match', trade_id: 1089578614, side: 'buy', size: '0.00016969', price: '79875.01', product_id: 'BTC-USD', time: '2026-09-06T23:10:00Z' },
  'bluesky-post': { kind: 'commit', did: 'did:plc:abc', time_us: 1788719342690000, commit: { operation: 'create', rkey: '3l7', record: { text: 'a post about something' } } },
  'wikimedia-change': { title: 'Q3038619', namespace: 0, bot: false, wiki: 'wikidatawiki', timestamp: 1788719342, length: { old: 4100, new: 4222 }, meta: { uri: 'https://www.wikidata.org/wiki/Q3038619', id: 'e1' } },
  'github-event': { id: '20275266898', type: 'PushEvent', repo: { name: 'someone/repo' }, created_at: '2026-09-06T23:10:00Z', payload: { commits: [{}, {}] } },
  'nws-alert': { id: 'urn:oid:2.49.0.1.840.0.5ba91', properties: { id: 'urn:oid:2.49.0.1.840.0.5ba91', event: 'Special Weather Statement', severity: 'Moderate', areaDesc: 'Grundy; Marion', sent: '2026-09-06T23:00:00Z', '@id': 'https://api.weather.gov/alerts/x' } },
  'hn-story': { id: 49590611, type: 'story', title: 'It took a year to ship WebAssembly', score: 100, descendants: 40, time: 1788719342, url: 'https://example.com/post' },
};

for (const file of fs.readdirSync(DIR)) {
  const doc = JSON.parse(fs.readFileSync(DIR + '/' + file, 'utf8'));
  const v = validateProfile(doc);
  ok('profile validates: ' + file, v.ok, v.problems.join(' | '));
  if (!v.ok) continue;
  const p = compileProfile(doc);
  const sample = samples[doc.name];
  ok('sample exists for ' + doc.name, Boolean(sample));
  if (!sample) continue;
  const r = p.apply(sample);
  ok('produces an event: ' + doc.name, r.event !== null, r.errors.join(' | '));
  if (r.event) {
    console.log('      ->', JSON.stringify({
      magnitude: r.event.magnitude, polarity: r.event.polarity, id: r.event.id,
      category: r.event.category, accent: r.event.accent, label: r.event.label,
      ts: r.event.ts, source: r.event.source,
    }));
  }
}

// where drops what it should
const http = compileProfile(JSON.parse(fs.readFileSync(DIR + '/http-access-log.json', 'utf8')));
ok('where skips a payload with no status', http.apply({ duration_ms: 5 }).skipped === true);
const fired = compileProfile(JSON.parse(fs.readFileSync(DIR + '/prometheus-alert.json', 'utf8')));
ok('where skips a resolved alert', fired.apply({ status: 'resolved', labels: { severity: 'critical' } }).skipped === true);

// The payload survives mapping untouched.
const res = http.apply(samples['http-access-log']);
ok('original payload is carried through', res.event.data.route === '/checkout');

// The trace is the point of /explain.
ok('trace names every mapped field', res.trace.length === Object.keys(JSON.parse(fs.readFileSync(DIR + '/http-access-log.json','utf8')).map).length,
   res.trace.map(t => t.field).join(','));
ok('trace carries the expression and its value',
   res.trace.some(t => t.field === 'magnitude' && t.value === 812 && typeof t.expression === 'string'));

// Bad profiles are refused with reasons, not exceptions in the caller's face.
const bad = validateProfile({ map: { nope: '$.a' } });
ok('unknown target field is reported', !bad.ok && /unknown target field/.test(bad.problems.join(' ')), bad.problems.join(' | '));
const noMag = validateProfile({ map: { id: '$.a' } });
ok('missing magnitude is reported', !noMag.ok && /magnitude/.test(noMag.problems.join(' ')));
const badExpr = validateProfile({ map: { magnitude: '$.a +' } });
ok('a broken expression is reported with its field', !badExpr.ok && /map.magnitude/.test(badExpr.problems.join(' ')), badExpr.problems.join(' | '));
const hostile = validateProfile({ map: { magnitude: 'process.env.SECRET' } });
ok('a hostile expression is refused at validation', !hostile.ok, hostile.problems.join(' | '));
let threw = null;
try { compileProfile({ map: {} }); } catch (e) { threw = e; }
ok('compiling an invalid profile raises ProfileError with problems',
   threw instanceof ProfileError && Array.isArray(threw.problems) && threw.problems.length > 0);

// A payload that produces no magnitude is rejected with a reason a human can act on.
const r2 = http.apply({ status: 200, route: '/x', method: 'GET' });
ok('a missing magnitude is explained, not just counted',
   r2.event === null && /magnitude/.test(r2.errors.join(' ')), r2.errors.join(' | '));

// The old query shorthand still works, now expressed as a profile.
const q = profileFromQuery(new URLSearchParams('magnitude=$.duration_ms&source=manual'));
ok('query shorthand becomes a profile', q && q.map.magnitude === '$.duration_ms' && q.map.source.const === 'manual');
const qp = compileProfile(q);
ok('and it applies', qp.apply({ duration_ms: 33 }).event.magnitude === 33);
ok('no mapping parameters means no profile', profileFromQuery(new URLSearchParams('replay=5')) === null);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall profile checks passed');
process.exitCode = fails ? 1 : 0;
