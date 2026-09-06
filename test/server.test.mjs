// End-to-end checks against a real ingest server on a real socket.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server/ingest.mjs', import.meta.url));
const PORT = Number(process.env.TEST_PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const failedNames = [];
const ok = (n, c, x = '') => {
  if (!c) {
    fails++; failedNames.push(n);
    console.log('FAIL  ' + n + (x ? '  ' + x : ''));
  } else console.log('ok    ' + n + (x ? '  ' + x : ''));
};

const srv = spawn(process.execPath, [SERVER, '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => console.log('[server stderr] ' + d));

for (let i = 0; i < 60; i++) {
  try {
    await fetch(BASE + '/health');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Hold an SSE connection open for the whole run and record what arrives.
const received = [];
const ac = new AbortController();
const streamDone = (async () => {
  const res = await fetch(BASE + '/events', { signal: ac.signal });
  ok('SSE content-type', (res.headers.get('content-type') || '').startsWith('text/event-stream'));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) received.push(JSON.parse(line.slice(6)));
        }
      }
    }
  } catch {
    /* aborted at the end of the run */
  }
})();

await new Promise((r) => setTimeout(r, 300));

let r = await fetch(BASE + '/emit?magnitude=4200&id=hello&label=first');
ok('GET /emit accepted', r.status === 202, 'status=' + r.status);

r = await fetch(BASE + '/emit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ magnitude: -900, id: 'shrink', category: 'bot' }),
});
ok('POST of a normalized event accepted', r.status === 202);

r = await fetch(BASE + '/emit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify([{ magnitude: 1 }, { magnitude: 2 }, { magnitude: 'nope' }]),
});
const arrRes = await r.json();
ok('array: 2 accepted, 1 rejected', arrRes.accepted === 2 && arrRes.rejected === 1, JSON.stringify(arrRes));

// The feature that makes "plug anything in" true.
r = await fetch(BASE + '/emit?magnitude=$.duration_ms&id=$.route&category=$.level', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ route: '/api/users', duration_ms: 312, level: 'warn' }),
});
ok('arbitrary JSON mapped via $. paths', r.status === 202);

r = await fetch(BASE + '/emit?magnitude=$.metrics.bytes[1]&id=$.name', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'nested', metrics: { bytes: [10, 777] } }),
});
ok('nested and indexed paths resolve', r.status === 202);

r = await fetch(BASE + '/emit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{oops',
});
ok('malformed JSON rejected with 400', r.status === 400, 'status=' + r.status);

r = await fetch(BASE + '/emit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{"id":"no-magnitude"}',
});
ok('event without magnitude rejected with 400', r.status === 400, 'status=' + r.status);

await new Promise((r2) => setTimeout(r2, 400));

ok('every accepted event reached the stream', received.length === 6, 'got ' + received.length);
const byId = Object.fromEntries(received.filter((e) => e.id).map((e) => [e.id, e]));
ok('GET event arrived intact', byId.hello && byId.hello.magnitude === 4200 && byId.hello.label === 'first');
ok('negative magnitude preserved', byId.shrink && byId.shrink.magnitude === -900);
ok('mapped magnitude from $.duration_ms', byId['/api/users'] && byId['/api/users'].magnitude === 312);
ok('mapped category from $.level', byId['/api/users'] && byId['/api/users'].category === 'warn');
ok('original payload kept under data', byId['/api/users'] && byId['/api/users'].data.route === '/api/users');
ok('nested path resolved to 777', byId.nested && byId.nested.magnitude === 777);
ok('source stamped on every event', received.every((e) => e.source === 'ingest'));
ok('timestamp added to every event', received.every((e) => Number.isFinite(e.ts)));

const rp = await fetch(BASE + '/events?replay=3');
const chunk = await rp.body.getReader().read();
const replayed = new TextDecoder().decode(chunk.value).split('\n').filter((l) => l.startsWith('data: ')).length;
ok('replay buffer serves late subscribers', replayed >= 1, 'replayed=' + replayed);
rp.body.cancel().catch(() => {});

const st = await (await fetch(BASE + '/stats')).json();
ok('stats count what was emitted', st.emitted === 6, JSON.stringify(st));

const idx = await fetch(BASE + '/demo/');
ok('serves the demo page', idx.status === 200 && (await idx.text()).includes('<canvas'));
const lib = await fetch(BASE + '/src/index.js');
ok('serves modules as javascript', lib.status === 200 && (lib.headers.get('content-type') || '').includes('javascript'));
const snd = await fetch(BASE + '/sounds/celesta/c001.ogg');
ok('serves the sample bank as audio/ogg', snd.status === 200 && snd.headers.get('content-type') === 'audio/ogg');
const trav = await fetch(BASE + '/../../../../Windows/win.ini');
ok('path traversal blocked', trav.status === 403 || trav.status === 404, 'status=' + trav.status);
ok('CORS is open', idx.headers.get('access-control-allow-origin') === '*');

ac.abort();
await streamDone;
srv.kill();
console.log(fails ? `\n${fails} FAILURE(S): ${failedNames.join(' | ')}` : '\nall server checks passed');
process.exit(fails ? 1 : 0);
