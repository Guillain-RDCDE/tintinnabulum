#!/usr/bin/env node
// Ingest server: anything that speaks HTTP becomes a sound source.
//
//   node server/ingest.mjs [--port 8080] [--root .]
//
// Zero dependencies, deliberately. Fan-out is Server-Sent Events rather than
// WebSocket: browsers only ever consume this stream, EventSource reconnects on
// its own, and SSE needs nothing beyond node:http.
//
//   POST /emit           {"magnitude": 1200, "id": "build-42"}      (or an array)
//   POST /emit?magnitude=$.duration_ms&id=$.service                 (map any JSON)
//   GET  /emit?magnitude=42&id=quick-test                           (curl-friendly)
//   GET  /events[?replay=20]                                        (SSE fan-out)
//   GET  /stats
//
// It also serves static files, so the demo page and the sample banks come from
// the same origin.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const PORT = Number(arg('port', process.env.PORT || 8080));
const ROOT = path.resolve(arg('root', path.join(HERE, '..')));
const RING = Number(arg('ring', 200));
const MAX_BODY = 1 << 20; // 1 MB

const clients = new Set();
const ring = [];
const stats = { started: Date.now(), emitted: 0, rejected: 0 };

// --- helpers --------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Dot-path lookup: "$.a.b[0]" -> value. */
function dig(obj, expr) {
  const p = expr.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1');
  let cur = obj;
  for (const key of p.split('.')) {
    if (key === '') continue;
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

const FIELDS = ['magnitude', 'polarity', 'id', 'label', 'url', 'category', 'accent', 'ts'];

/**
 * Build an event from an arbitrary payload plus a query-string mapping.
 * A value starting with `$.` is a path into the payload; anything else is a
 * literal. That single rule is what lets any JSON on earth be piped in.
 */
function shape(payload, query) {
  const out = {};
  let mapped = false;
  for (const f of FIELDS) {
    const spec = query.get(f);
    if (spec == null) continue;
    mapped = true;
    out[f] = spec.startsWith('$') ? dig(payload, spec) : spec;
  }
  if (!mapped) return payload;
  if (payload && typeof payload === 'object') out.data = payload;
  return out;
}

function coerce(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') raw = { magnitude: raw };
  if (typeof raw !== 'object') return null;
  const m = Number(raw.magnitude);
  if (!Number.isFinite(m)) return null;
  const ev = { ...raw, magnitude: m };
  if (ev.polarity != null) ev.polarity = Number(ev.polarity);
  if (typeof ev.accent === 'string') ev.accent = ev.accent !== 'false' && ev.accent !== '0';
  if (ev.ts != null) ev.ts = Number(ev.ts);
  if (!Number.isFinite(ev.ts)) ev.ts = Date.now();
  if (!ev.source) ev.source = 'ingest';
  return ev;
}

function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch (e) {
      clients.delete(res);
    }
  }
  ring.push(ev);
  if (ring.length > RING) ring.shift();
  stats.emitted++;
}

// --- routes ---------------------------------------------------------------

async function handleEmit(req, res, url) {
  let payload = null;
  if (req.method === 'POST') {
    let text;
    try {
      text = await readBody(req);
    } catch (e) {
      return json(res, 413, { error: String(e.message) });
    }
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch (e) {
        return json(res, 400, { error: 'invalid JSON body' });
      }
    }
  }
  if (payload == null) payload = Object.fromEntries(url.searchParams);

  const list = Array.isArray(payload) ? payload : [payload];
  let accepted = 0;
  for (const item of list) {
    const ev = coerce(shape(item, url.searchParams));
    if (!ev) {
      stats.rejected++;
      continue;
    }
    broadcast(ev);
    accepted++;
  }
  return json(res, accepted ? 202 : 400, {
    accepted,
    rejected: list.length - accepted,
    listeners: clients.size,
  });
}

function handleEvents(req, res, url) {
  cors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // so nginx does not buffer the stream
  });
  res.write(': connected\n\n');

  const replay = Math.min(RING, Number(url.searchParams.get('replay')) || 0);
  if (replay > 0) {
    for (const ev of ring.slice(-replay)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  clients.add(res);
  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clearInterval(beat);
      clients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(beat);
    clients.delete(res);
  });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'not found', path: rel });
    cors(res);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/emit') return handleEmit(req, res, url);
  if (url.pathname === '/events') return handleEvents(req, res, url);
  if (url.pathname === '/stats') {
    return json(res, 200, {
      ...stats,
      uptimeSeconds: Math.round((Date.now() - stats.started) / 1000),
      listeners: clients.size,
      buffered: ring.length,
    });
  }
  if (url.pathname === '/health') return json(res, 200, { ok: true });

  if (req.method === 'GET') return serveStatic(req, res, url);
  return json(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, () => {
  console.log(`tintinnabulum ingest listening on http://localhost:${PORT}`);
  console.log(`  static root : ${ROOT}`);
  console.log(`  demo        : http://localhost:${PORT}/demo/`);
  console.log(`  stream      : http://localhost:${PORT}/events`);
  console.log(`  try         : curl "http://localhost:${PORT}/emit?magnitude=5000&id=hello"`);
});
