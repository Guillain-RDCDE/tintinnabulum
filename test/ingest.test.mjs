// The input standard, end to end over HTTP: schemas, profiles, explain, and
// the shorthand that now runs through the same machinery.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const SERVER = fileURLToPath(new URL('../server/ingest.mjs', import.meta.url));

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [SERVER, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
for (let i = 0; i < 80; i++) {
  try { await fetch(BASE + '/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

let fails = 0;
const ok = (n, c, x = '') => { if (!c) { fails++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } else console.log('ok    ' + n + (x ? '  ' + x : '')); };
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

try {
  // --- the standard is published -----------------------------------------
  const ev = await fetch(BASE + '/schema');
  ok('GET /schema serves the event schema', ev.ok && /schema\+json/.test(ev.headers.get('content-type')), ev.headers.get('content-type'));
  const evj = await ev.json();
  ok('and it is the versioned document', evj.version === 'tintinnabulum.event/1' && evj.required.includes('magnitude'), evj.version);
  const mp = await (await fetch(BASE + '/schema/mapping')).json();
  ok('GET /schema/mapping serves the mapping schema', mp.version === 'tintinnabulum.mapping/1');

  const list = await (await fetch(BASE + '/profiles')).json();
  ok('GET /profiles lists the shipped profiles', list.profiles.length >= 3, list.profiles.map((p) => p.name).join(', '));
  ok('every shipped profile reports itself valid', list.profiles.every((p) => p.valid),
     list.profiles.filter((p) => !p.valid).map((p) => p.name + ': ' + p.problems.join('; ')).join(' | '));

  // --- a saved profile, by name ------------------------------------------
  const r1 = await post('/emit?profile=http-access-log',
    [{ method: 'GET', route: '/a', status: 200, duration_ms: 12, time: '2026-09-06T10:00:00Z' },
     { method: 'POST', route: '/b', status: 503, duration_ms: 900, time: '2026-09-06T10:00:01Z' }]);
  ok('a named profile maps a batch', r1.status === 202 && r1.body.accepted === 2, JSON.stringify(r1.body));
  ok('the response says which profile ran', r1.body.profile === 'http-access-log');

  // --- `where` drops rather than rejects ---------------------------------
  const r2 = await post('/emit?profile=http-access-log', [{ duration_ms: 5 }]);
  ok('a payload the filter excludes is skipped, not rejected',
     r2.body.skipped === 1 && r2.body.rejected === 0, JSON.stringify(r2.body));

  // --- an inline profile -------------------------------------------------
  const r3 = await post('/emit', { profile: { map: { magnitude: '$.bytes * 8', id: "'inline'" } }, events: [{ bytes: 512 }] });
  ok('a profile sent with the request works', r3.status === 202 && r3.body.accepted === 1, JSON.stringify(r3.body));

  const r4 = await post('/emit', { profile: { map: { magnitude: '$.a +' } }, events: [{ a: 1 }] });
  ok('a broken inline profile is refused with the reason',
     r4.status === 400 && /map.magnitude/.test(JSON.stringify(r4.body.problems)), JSON.stringify(r4.body));

  const r5 = await post('/emit', { profile: { map: { magnitude: 'process.env.HOME' } }, events: [{}] });
  ok('a hostile inline profile is refused', r5.status === 400, JSON.stringify(r5.body));

  const r6 = await post('/emit?profile=nope', [{ magnitude: 1 }]);
  ok('an unknown profile name is a 404 that says so', r6.status === 404 && /nope/.test(r6.body.error), JSON.stringify(r6.body));

  const r7 = await post('/emit?profile=../../package', [{ magnitude: 1 }]);
  ok('a profile name cannot escape the directory', r7.status === 404, JSON.stringify(r7.body));

  // --- explain ------------------------------------------------------------
  const x1 = await post('/explain?profile=http-access-log',
    { method: 'POST', route: '/checkout', status: 503, duration_ms: 812, time: '2026-09-06T10:00:00Z' });
  ok('explain returns the event it would have sent', x1.body.accepted && x1.body.result.magnitude === 812);
  ok('explain names the expression behind each field',
     x1.body.fields.some((f) => f.field === 'category' && f.value === 'alert' && f.expression.includes('500')),
     JSON.stringify(x1.body.fields.find((f) => f.field === 'category')));
  ok('explain states the versions it speaks',
     x1.body.event === 'tintinnabulum.event/1' && x1.body.mapping === 'tintinnabulum.mapping/1');

  const x2 = await post('/explain?profile=http-access-log', { method: 'GET', route: '/x', status: 200 });
  ok('explain says why a payload was refused',
     x2.body.accepted === false && /magnitude/.test(x2.body.problems.join(' ')), x2.body.problems.join(' | '));

  const x3 = await post('/explain', { magnitude: 42, id: 'plain' });
  ok('explain works with no mapping at all', x3.body.accepted && x3.body.result.magnitude === 42);

  // --- the old shorthand still works, through the new machinery ----------
  const r8 = await post('/emit?magnitude=$.duration_ms&id=$.service&source=manual', { duration_ms: 77, service: 'api' });
  ok('the query shorthand is unbroken', r8.status === 202 && r8.body.accepted === 1, JSON.stringify(r8.body));

  const r9 = await fetch(BASE + '/emit?magnitude=42&id=quick');
  ok('the GET form is unbroken', (await r9.json()).accepted === 1);

  // The shorthand used to walk properties unguarded.
  const r10 = await post('/emit?magnitude=$.__proto__.x', { a: 1 });
  ok('the shorthand can no longer reach a prototype', r10.body.accepted === 0, JSON.stringify(r10.body));

  // --- plain events still work -------------------------------------------
  const r11 = await post('/emit', { magnitude: 1200, id: 'build-42' });
  ok('an unmapped event still works', r11.body.accepted === 1);
} finally {
  // Wait for the child to actually go. Killing it and calling process.exit()
  // straight after races libuv's teardown on Windows, which aborts the process
  // with an assertion -- and an aborted process reports an exit code that has
  // nothing to do with whether the checks passed.
  srv.kill();
  await new Promise((r) => (srv.exitCode !== null ? r() : srv.once('exit', r)));
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall ingest checks passed');
process.exitCode = fails ? 1 : 0;
