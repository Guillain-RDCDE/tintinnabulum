// Pure-logic checks. No browser needed: nothing here touches AudioContext or
// canvas, which is the point of keeping those behind sinks.
import { normalize, unitPosition } from '../src/core/event.js';
import { Mapper } from '../src/core/mapper.js';
import { VoicePool } from '../src/core/voices.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) {
    fails++;
    console.log('FAIL  ' + name + (extra ? '  ' + extra : ''));
  } else console.log('ok    ' + name + (extra ? '  ' + extra : ''));
};

// --- the event contract ---
ok('number shorthand', normalize(42).magnitude === 42);
ok('negative magnitude implies polarity', normalize(-30).polarity === -1 && normalize(-30).magnitude === 30);
ok('explicit polarity wins', normalize({ magnitude: -30, polarity: 1 }).polarity === 1);
ok('non-numeric magnitude rejected', normalize({ magnitude: 'abc' }) === null);
ok('NaN rejected', normalize({ magnitude: NaN }) === null);
ok('null rejected', normalize(null) === null);
ok('zero is a valid magnitude', normalize(0) && normalize(0).magnitude === 0);
ok('defaults applied', normalize(1).category === 'default' && normalize(1).accent === false);

// --- deterministic positioning ---
const a = unitPosition('Paris');
const b = unitPosition('Paris');
const c = unitPosition('Lyon');
ok('same id lands in the same place', a.u === b.u && a.v === b.v);
ok('different ids land apart', a.u !== c.u);
ok('position stays in the unit square', a.u >= 0 && a.u < 1 && a.v >= 0 && a.v < 1);

// --- the headline claim: the mapper calibrates itself ---
const spread = (mapper, samples) => {
  const out = samples.map((m) => mapper.map(m).semitone);
  return { min: Math.min(...out), max: Math.max(...out) };
};

const wiki = new Mapper({ mode: 'adaptive', range: 27 });
const wikiMags = Array.from({ length: 400 }, () => Math.round(Math.exp(Math.random() * 9)));
wikiMags.forEach((m) => wiki.map(m));
const wr = spread(wiki, wikiMags.slice(0, 200));

const latency = new Mapper({ mode: 'adaptive', range: 27 });
const latMags = Array.from({ length: 400 }, () => 40 + Math.random() * 20); // narrow band, tiny values
latMags.forEach((m) => latency.map(m));
const lr = spread(latency, latMags.slice(0, 200));

ok('adaptive spans the range on wiki-like data', wr.max - wr.min > 18, JSON.stringify(wr));
ok('adaptive spans the range on a foreign domain', lr.max - lr.min > 18, JSON.stringify(lr));

// A fixed log curve tuned for one domain collapses on another. This is the
// whole reason the adaptive mode exists.
const logm = new Mapper({ mode: 'log', domain: [1, 100000], range: 27 });
const lg = spread(logm, latMags.slice(0, 200));
ok('fixed log mapping collapses off-domain (expected)', lg.max - lg.min < 6, JSON.stringify(lg));

// --- pitch direction ---
const inv = new Mapper({ mode: 'log', invert: true, range: 27, warmup: 1e9 });
ok('inverted: big event = low note', inv.map(90000).semitone < inv.map(5).semitone);
const noinv = new Mapper({ mode: 'log', invert: false, range: 27, warmup: 1e9 });
ok('not inverted: big event = high note', noinv.map(90000).semitone > noinv.map(5).semitone);

// --- scale quantization ---
const pent = new Mapper({ scale: 'pentatonic', mode: 'log', range: 36, warmup: 1e9 });
const degrees = new Set();
for (let i = 1; i < 5000; i += 7) degrees.add((((pent.map(i).semitone % 12) + 12) % 12));
ok(
  'pentatonic output never leaves the scale',
  [...degrees].every((d) => [0, 2, 4, 7, 9].includes(d)),
  [...degrees].sort((x, y) => x - y).join(',')
);

// --- voice allocation ---
const pool = new VoicePool({ maxVoices: 3 });
const t = 1000;
const s1 = pool.request(0.1, t);
const s2 = pool.request(0.2, t);
const s3 = pool.request(0.3, t);
[s1, s2, s3].forEach((s, i) => s && s.attach(() => {}, 5000 + i));
ok('grants up to maxVoices', Boolean(s1 && s2 && s3) && pool.active === 3);
ok('a weak note is refused when full', pool.request(0.05, t) === null);

let stoppedWeakest = false;
s1.stop = () => {
  stoppedWeakest = true;
};
const strong = pool.request(0.9, t);
ok('a strong note steals the weakest voice', strong !== null && stoppedWeakest);
ok('capacity is respected after a steal', pool.active === 3, 'active=' + pool.active);
ok('expired voices are reclaimed', (() => { pool.request(0.5, t + 60000); return pool.active <= 3; })());

const rl = new VoicePool({ maxVoices: 100, maxPerSecond: 10 });
let granted = 0;
for (let i = 0; i < 50; i++) if (rl.request(0.5, 2000)) granted++;
ok('token bucket caps a burst', granted <= 11, 'granted=' + granted);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall core checks passed');
process.exit(fails ? 1 : 0);
