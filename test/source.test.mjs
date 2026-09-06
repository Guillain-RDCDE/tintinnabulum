// Source descriptors: the half of a connector that used to be JavaScript.
//
// The point of this file is that a descriptor plus a profile really is enough
// to plug something in -- so it drives a fake HTTP endpoint through the whole
// path, and it drives the shipped descriptors against their real shapes.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileSource, validateSource, resolveSecrets, secretsUsed } from '../src/core/source.js';
import { compileProfile } from '../src/core/profile.js';
import { SourceRunner } from '../server/runner.mjs';

const SERVER = fileURLToPath(new URL('../server/ingest.mjs', import.meta.url));
const PROFILES = fileURLToPath(new URL('../profiles', import.meta.url));
const SOURCES = fileURLToPath(new URL('../sources', import.meta.url));

let fails = 0;
const failedNames = [];
const ok = (n, c, x = '') => { if (!c) { fails++; failedNames.push(n); console.log('FAIL  ' + n + (x ? '  ' + x : '')); } else console.log('ok    ' + n + (x ? '  ' + x : '')); };
const readProfile = (n) => compileProfile(JSON.parse(fs.readFileSync(`${PROFILES}/${n}.json`, 'utf8')));
const readSource = (n) => JSON.parse(fs.readFileSync(`${SOURCES}/${n}.json`, 'utf8'));

// --- validation ----------------------------------------------------------
for (const file of fs.readdirSync(SOURCES).filter((f) => f.endsWith('.json'))) {
  const doc = readSource(file.slice(0, -5));
  const v = validateSource(doc);
  ok('descriptor validates: ' + file, v.ok, v.problems.join(' | '));
  ok('its profile exists: ' + file, typeof doc.profile !== 'string' || fs.existsSync(`${PROFILES}/${doc.profile}.json`), String(doc.profile));
  // A checked-out repository must not start calling other people's APIs.
  ok('it does not start itself: ' + file, doc.enabled !== true);
}

const bad = validateSource({ name: 'x', fetch: { url: 'http://evil.example/x' }, profile: 'p' });
ok('plain http is refused', !bad.ok && /https/.test(bad.problems.join(' ')), bad.problems.join(' | '));
ok('localhost over http is allowed', validateSource({ name: 'x', fetch: { url: 'http://localhost:8080/x' }, profile: 'p' }).ok);
const noProf = validateSource({ name: 'x', fetch: { url: 'https://a.example/' } });
ok('a descriptor without a profile is refused', !noProf.ok && /profile/.test(noProf.problems.join(' ')));
const slow = validateSource({ name: 'x', fetch: { url: 'https://a.example/', interval: 10 }, profile: 'p' });
ok('an absurd interval is refused', !slow.ok && /interval/.test(slow.problems.join(' ')));

// --- secrets -------------------------------------------------------------
const r = resolveSecrets('Bearer ${env.TOKEN_A} and ${env.TOKEN_B}', { TOKEN_A: 'aaa' });
ok('secrets are substituted', r.out.startsWith('Bearer aaa'));
ok('and a missing one is named, not silently blanked', r.missing.includes('TOKEN_B'), r.missing.join(','));
ok('secretsUsed finds every reference', secretsUsed(readSource('pizza-index')).includes('X_BEARER_TOKEN'));

// --- extraction, against the real shape of each API ----------------------
const usgs = compileSource(readSource('earthquakes'), () => readProfile('usgs-quake'), {});
const usgsBody = {
  type: 'FeatureCollection',
  features: [
    { id: 'nc001', properties: { mag: 5.8, place: '10km N of Somewhere', time: 1788688800000, url: 'https://usgs/e/1' } },
    { id: 'nc002', properties: { mag: 1.2, place: 'Elsewhere', time: 1788688801000, url: 'https://usgs/e/2' } },
    { id: 'nc003', properties: { mag: null, place: 'No magnitude yet', time: 1788688802000 } },
  ],
};
const got = usgs.extract(usgsBody);
ok('items selects the array', got.events.length === 2, `${got.events.length} events, ${got.problems.join('; ')}`);
ok('where drops the incomplete one', got.events.every((e) => e.key !== 'nc003'));
ok('the big one is an accent', got.events[0].event.accent === true && got.events[0].event.category === 'alert');
ok('the small one is not', got.events[1].event.accent === false && got.events[1].event.category === 'user');
ok('key comes from the descriptor', got.events[0].key === 'nc001');
ok('the timestamp is the event\'s own', got.events[0].event.ts === 1788688800000);

const x = compileSource(readSource('pizza-index'), () => readProfile('x-search'), { X_BEARER_TOKEN: 'secret' });
const xBody = {
  data: [
    { id: '1', text: 'Pentagon pizza index spiking tonight\nsecond line', lang: 'en', created_at: '2026-09-06T23:10:00Z', public_metrics: { retweet_count: 240, like_count: 900, reply_count: 30 } },
    { id: '2', text: 'pizza meter, encore', lang: 'fr', created_at: '2026-09-06T23:11:00Z', public_metrics: { retweet_count: 0, like_count: 1, reply_count: 9 } },
  ],
};
const xg = x.extract(xBody);
ok('the pizza index extracts both posts', xg.events.length === 2, xg.problems.join('; '));
ok('engagement sets the pitch', xg.events[0].event.magnitude === 1 + 240 * 3 + 900 + 30 * 2, String(xg.events[0].event.magnitude));
ok('a loud post is an accent', xg.events[0].event.accent === true);
ok('replies outweighing reposts flip the polarity', xg.events[1].event.polarity === -1);
ok('lookup() maps the language to a category',
   xg.events[0].event.category === 'user' && xg.events[1].event.category === 'anon',
   xg.events.map((e) => e.event.category).join(','));
ok('the label is the first line only', xg.events[0].event.label === 'Pentagon pizza index spiking tonight');
ok('the url is built from the id', xg.events[0].event.url === 'https://x.com/i/web/status/1');
ok('the secret is resolved into the header', x.headers.Authorization === 'Bearer secret');
ok('and the stored url still hides it', !x.url.includes('secret'));

const noKey = compileSource(readSource('pizza-index'), () => readProfile('x-search'), {});
ok('a missing secret is reported before anything is fetched', noKey.missingSecrets.includes('X_BEARER_TOKEN'));

// A wrong items path must say so rather than silently yielding nothing.
const wrong = compileSource({ ...readSource('earthquakes'), items: '$.nope' }, () => readProfile('usgs-quake'), {});
ok('a wrong items path is explained', wrong.extract(usgsBody).problems.length > 0,
   wrong.extract(usgsBody).problems.join('; '));

// --- every shipped feed must be expressible as a document ----------------
// This is the only honest test of a standard: if it cannot describe our own
// sources, it is not worth offering for anyone else's. Eight feeds shipped as
// hand-written JavaScript in src/sources/; all eight are descriptors now.
{
  const want = ['bitcoin', 'bluesky', 'coinbase', 'earthquakes', 'github', 'hackernews', 'weather', 'wikipedia'];
  const have = fs.readdirSync(SOURCES).map((f) => f.slice(0, -5));
  const absent = want.filter((n) => !have.includes(n));
  ok('every built-in feed exists as a descriptor', absent.length === 0, absent.join(', ') || `${want.length} feeds`);

  const byTransport = { poll: 0, websocket: 0, sse: 0, expand: 0 };
  for (const n of want) {
    const d = readSource(n);
    if (d.stream) byTransport[d.stream.protocol || (d.stream.url.startsWith('ws') ? 'websocket' : 'sse')]++;
    else byTransport.poll++;
    if (d.expand) byTransport.expand++;
  }
  ok('the standard covers every transport those feeds need',
     byTransport.websocket >= 3 && byTransport.sse >= 1 && byTransport.poll >= 4 && byTransport.expand >= 1,
     JSON.stringify(byTransport));
}

// A source polls or it listens, never both, and a stream cannot expand.
ok('fetch and stream together are refused',
   !validateSource({ name: 'x', fetch: { url: 'https://a.example/' }, stream: { url: 'wss://a.example/' }, profile: 'p' }).ok);
ok('neither one is refused', !validateSource({ name: 'x', profile: 'p' }).ok);
ok('a websocket url with sse protocol is refused',
   !validateSource({ name: 'x', stream: { url: 'wss://a.example/', protocol: 'sse' }, profile: 'p' }).ok);
ok('plain ws is refused off localhost',
   !validateSource({ name: 'x', stream: { url: 'ws://evil.example/' }, profile: 'p' }).ok);
ok('expand without ${item} is refused',
   !validateSource({ name: 'x', fetch: { url: 'https://a.example/' }, expand: { url: 'https://a.example/i' }, profile: 'p' }).ok);
ok('expand on a stream is refused',
   !validateSource({ name: 'x', stream: { url: 'wss://a.example/' }, expand: { url: 'https://a/${item}' }, profile: 'p' }).ok);

// The aggregate functions the real feeds needed and paths could not give.
{
  const { compile } = await import('../src/core/expr.js');
  const tx = { out: [{ value: 100 }, { value: 250 }, { nope: 1 }] };
  ok('sumof adds one field across a list', compile('sumof($.out, \'value\')')(tx) === 350);
  ok('sumof of nothing is null, not zero', compile('sumof($.missing, \'value\')')(tx) === null);
  ok('maxof takes the largest', compile('maxof($.out, \'value\')')(tx) === 250);
  ok('sumof cannot reach a prototype', compile('sumof($.out, \'__proto__\')')(tx) === null);
}

// --- the runner, against a local endpoint --------------------------------
let served = 0;
const fake = http.createServer((req, res) => {
  served++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  // The same item twice, so de-duplication has something to do.
  res.end(JSON.stringify({ data: [{ ref: 'a', n: 10 }, { ref: 'b', n: 20 }, { ref: 'a', n: 10 }] }));
});
await new Promise((r) => fake.listen(8901, r));

const emitted = [];
const runner = new SourceRunner({ emit: (e) => emitted.push(e) });
const local = compileSource(
  {
    source: 'tintinnabulum.source/1', name: 'local-test',
    fetch: { url: 'http://localhost:8901/feed', interval: 1000 },
    items: '$.data', key: '$.ref', spread: 0,
    profile: { map: { magnitude: '$.n', id: '$.ref' } },
  },
  (p) => compileProfile(p),
  {}
);

const probe = await runner.test(local);
ok('test fetches without emitting', probe.fetched && emitted.length === 0, JSON.stringify(probe.problems));
ok('test reports how many it found', probe.found === 3, String(probe.found));
ok('test shows the payload shape, so a wrong path is obvious', /keys: data/.test(probe.shape), probe.shape);
ok('test shows a worked example', probe.first && probe.first.event.magnitude === 10, JSON.stringify(probe.first));

const state = runner.start(local);
await new Promise((r) => setTimeout(r, 400));
ok('the runner emits what it polled', emitted.length === 2, `${emitted.length} emitted`);
ok('and de-duplicates within a batch', new Set(emitted.map((e) => e.id)).size === emitted.length);
const before = emitted.length;
await runner.tick(state);
ok('a second poll of unchanged data emits nothing', emitted.length === before, `${emitted.length - before} extra`);
runner.stop('local-test');
ok('stopping clears the source', runner.status('local-test').running === false);

// A failing endpoint must back off rather than hammer.
const dead = compileSource(
  { name: 'dead', fetch: { url: 'http://localhost:8902/nothing', interval: 1000, timeout: 600 }, items: '$.x', profile: { map: { magnitude: '$.n' } } },
  (p) => compileProfile(p), {}
);
const deadState = { source: dead, seen: new Set(), order: [], timers: new Set(), polls: 0, emitted: 0, failures: 0, nextDelay: 1000, lastProblems: [] };
await runner.tick(deadState);
ok('a dead endpoint is recorded, not thrown', deadState.failures === 1 && deadState.lastError, deadState.lastError);
ok('and the next attempt backs off', deadState.nextDelay > dead.interval, `${deadState.nextDelay}ms`);

fake.close();


// --- streams and two-stage sources, against local servers ----------------
{
  const { WebSocketServer } = await import('node:http').then(() => ({ WebSocketServer: null })).catch(() => ({ WebSocketServer: null }));
  // No websocket server without a dependency, so SSE stands in for the live
  // path: same _consume, same dedupe, same reconnect.
  let sseHits = 0;
  const sse = http.createServer((req, res) => {
    sseHits++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
    res.write(frame({ kind: 'tick', n: 7, ref: 'a' }));
    res.write(frame({ kind: 'tick', n: 9, ref: 'b' }));
    res.write('data: not json\n\n'); // a heartbeat is not an error
    res.write(frame({ kind: 'skip', n: 1, ref: 'c' }));
  });
  await new Promise((r) => sse.listen(8904, r));

  const streamSrc = compileSource({
    name: 'sse-test',
    stream: { url: 'http://localhost:8904/s', protocol: 'sse', dedupeSize: 100 },
    key: '$.ref',
    profile: { where: "$.kind == 'tick'", map: { magnitude: '$.n', id: '$.ref' } },
  }, (p) => compileProfile(p), {});
  ok('an sse descriptor compiles as a stream', streamSrc.streaming && streamSrc.protocol === 'sse');

  const probe = await runner.test(streamSrc, { seconds: 4 });
  ok('testing a stream reports what arrived', probe.messages >= 3, `messages=${probe.messages}`);
  ok('and maps them without emitting', probe.found >= 2 && probe.first, `found=${probe.found}`);
  ok('a non-JSON frame is ignored rather than fatal', probe.connected !== false);
  ok('where still drops what it should', probe.found === 2, `found=${probe.found}`);
  sse.close();
}

{
  // Two-stage: a list of identities, then one request per identity.
  let listHits = 0, itemHits = 0;
  const api = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/list') { listHits++; return res.end(JSON.stringify([11, 12, 13])); }
    const id = Number(req.url.split('/').pop().replace('.json', ''));
    itemHits++;
    res.end(JSON.stringify({ id, title: 'story ' + id, score: id * 10 }));
  });
  await new Promise((r) => api.listen(8905, r));

  const two = compileSource({
    name: 'two-stage',
    fetch: { url: 'http://localhost:8905/list', interval: 1000 },
    expand: { url: 'http://localhost:8905/item/${item}.json', limit: 10, concurrency: 2 },
    profile: { map: { magnitude: '$.score', id: 'str($.id)', label: '$.title' } },
  }, (p) => compileProfile(p), {});
  ok('a two-stage descriptor compiles', two.expand !== null && two.expand.limit === 10);

  const t = await runner.test(two);
  ok('it follows the identities to their records', t.found === 3, `found=${t.found}, ${t.problems.join('; ')}`);
  ok('and maps the fetched record, not the identity',
     t.first && t.first.event.label === 'story 11', JSON.stringify(t.first && t.first.event.label));
  ok('one request per identity, plus the list', itemHits >= 3 && listHits >= 1, `list=${listHits} items=${itemHits}`);

  const st = runner.start(two);
  await new Promise((r) => setTimeout(r, 500));
  const firstRun = itemHits;
  await runner.tick(st);
  ok('a second poll does not refetch identities already seen', itemHits === firstRun, `${itemHits - firstRun} refetched`);
  runner.stop('two-stage');
  api.close();
}

// --- over HTTP -----------------------------------------------------------
const PORT = 8903;
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [SERVER, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
for (let i = 0; i < 80; i++) {
  try { await fetch(BASE + '/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
try {
  const listed = await (await fetch(BASE + '/sources')).json();
  ok('GET /sources lists the descriptors', listed.sources.length >= 2, listed.sources.map((s) => s.name).join(', '));
  ok('and states the version it speaks', listed.source === 'tintinnabulum.source/1');
  const pizza = listed.sources.find((s) => s.name === 'pizza-index');
  ok('a descriptor names the secrets it needs', pizza.secrets.includes('X_BEARER_TOKEN'));
  ok('and never leaks a resolved url', !JSON.stringify(listed).includes('Bearer '), 'listing is clean');
  ok('every shipped descriptor reports itself valid', listed.sources.every((s) => s.valid),
     listed.sources.filter((s) => !s.valid).map((s) => s.name).join(', '));

  const s1 = await (await fetch(BASE + '/schema/source')).json();
  ok('GET /schema/source publishes the descriptor schema', s1.version === 'tintinnabulum.source/1');

  const t = await fetch(BASE + '/sources/pizza-index/test', { method: 'POST' });
  const tb = await t.json();
  ok('testing a source without its token fails with instructions',
     t.status === 400 && /X_BEARER_TOKEN/.test(JSON.stringify(tb.problems)), JSON.stringify(tb));

  const missing = await fetch(BASE + '/sources/nope/test', { method: 'POST' });
  ok('an unknown source is a 404', missing.status === 404);
} finally {
  srv.kill();
  await new Promise((r) => (srv.exitCode !== null ? r() : srv.once('exit', r)));
}

console.log(fails ? `\n${fails} FAILURE(S): ${failedNames.join(' | ')}` : '\nall source checks passed');
process.exitCode = fails ? 1 : 0;
