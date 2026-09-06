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
//   POST /emit?profile=http-access-log                              (a saved mapping)
//   POST /emit?magnitude=$.duration_ms&id=$.service                 (the shorthand)
//   GET  /emit?magnitude=42&id=quick-test                           (curl-friendly)
//   POST /explain[?profile=…]                                       (what did it understand?)
//   GET  /events[?replay=20]                                        (SSE fan-out)
//   GET  /profiles  ·  GET /schema  ·  GET /schema/mapping
//   GET  /stats
//
// It also serves static files, so the demo page and the sample banks come from
// the same origin.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compileProfile,
  validateProfile,
  profileFromQuery,
  ProfileError,
  MAPPING_VERSION,
  EVENT_VERSION,
} from '../src/core/profile.js';
import { compileSource, validateSource, secretsUsed, SOURCE_VERSION } from '../src/core/source.js';
import { SourceRunner } from './runner.mjs';

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

// The query-string shorthand used to have its own dot-path lookup here. It now
// goes through the same profile machinery as everything else, which is one
// code path instead of two -- and its lookup walked properties without
// guarding them, so `?magnitude=$.__proto__.x` reached a prototype. The
// expression engine does not.

// --- profiles -------------------------------------------------------------

const PROFILE_DIR = path.join(ROOT, 'profiles');
const compiled = new Map(); // name -> compiled profile

/**
 * Load and compile a profile by name.
 *
 * Names are a single path segment and are checked against the directory
 * listing rather than joined blindly, so `?profile=../../etc/passwd` selects
 * nothing. Compiled profiles are cached: parsing is the expensive half and a
 * profile is applied to every event.
 */
function profileByName(name) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || name.startsWith('.')) return null;
  if (compiled.has(name)) return compiled.get(name);
  const file = path.join(PROFILE_DIR, name + '.json');
  if (!file.startsWith(PROFILE_DIR + path.sep) || !fs.existsSync(file)) return null;
  try {
    const p = compileProfile(JSON.parse(fs.readFileSync(file, 'utf8')));
    compiled.set(name, p);
    return p;
  } catch (e) {
    return null;
  }
}

// --- sources --------------------------------------------------------------

const SOURCE_DIR = path.join(ROOT, 'sources');
const runner = new SourceRunner({ emit: broadcast, log: (l) => console.log(l) });

function readSourceDoc(name) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || name.startsWith('.')) return null;
  const file = path.join(SOURCE_DIR, name + '.json');
  if (!file.startsWith(SOURCE_DIR + path.sep) || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

/** Compile a descriptor, resolving its profile by name or taking it inline. */
function buildSource(doc) {
  return compileSource(
    doc,
    (p) => (typeof p === 'string' ? profileByName(p) : compileProfile(p)),
    process.env
  );
}

function listSources() {
  let files = [];
  try {
    files = fs.readdirSync(SOURCE_DIR).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }
  return files.map((f) => {
    const name = f.slice(0, -5);
    const doc = readSourceDoc(name);
    if (!doc) return { name, valid: false, problems: ['could not be read as JSON'] };
    const v = validateSource(doc);
    const needed = secretsUsed(doc);
    const missing = needed.filter((s) => !process.env[s]);
    return {
      name: doc.name || name,
      description: doc.description || '',
      // The declared URL, with `${env.X}` left in place: the resolved one may
      // carry a token in a query string and must not leave the machine.
      url: doc.fetch && doc.fetch.url,
      profile: typeof doc.profile === 'string' ? doc.profile : 'inline',
      interval: (doc.fetch && doc.fetch.interval) || null,
      enabled: Boolean(doc.enabled),
      secrets: needed,
      missingSecrets: missing,
      valid: v.ok,
      problems: v.problems,
      ...runner.status(doc.name || name),
    };
  });
}

/** Start every descriptor that asks for it and can actually run. */
function startEnabledSources() {
  for (const info of listSources()) {
    if (!info.enabled) continue;
    if (!info.valid) {
      console.log(`source ${info.name}: not started, ${info.problems.join('; ')}`);
      continue;
    }
    if (info.missingSecrets.length) {
      console.log(`source ${info.name}: not started, missing ${info.missingSecrets.join(', ')}`);
      continue;
    }
    try {
      runner.start(buildSource(readSourceDoc(info.name)));
    } catch (e) {
      console.log(`source ${info.name}: not started, ${e.message}`);
    }
  }
}

/** The published schemas, served so tooling can validate against them. */
function serveSchema(res, file) {
  const p = path.join(ROOT, 'spec', file);
  if (!fs.existsSync(p)) return json(res, 404, { error: 'schema not found' });
  cors(res);
  const buf = fs.readFileSync(p);
  res.writeHead(200, {
    'Content-Type': 'application/schema+json; charset=utf-8',
    'Content-Length': buf.length,
  });
  return res.end(buf);
}

function listProfiles() {
  let files = [];
  try {
    files = fs.readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }
  return files.map((f) => {
    const name = f.slice(0, -5);
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, f), 'utf8'));
      const v = validateProfile(doc);
      return {
        name: doc.name || name,
        description: doc.description || '',
        fields: Object.keys(doc.map || {}),
        valid: v.ok,
        problems: v.problems,
      };
    } catch (e) {
      return { name, description: '', fields: [], valid: false, problems: [String(e.message)] };
    }
  });
}

/**
 * Work out which mapping a request wants, and where the payloads are.
 *
 * Three ways in, in order of precedence: a profile sent inline with the
 * request, a saved profile named in the query, and the original query-string
 * shorthand. Returning the reason for a refusal matters as much as returning
 * the profile: an unusable mapping is the single most likely thing to go wrong.
 */
function resolveMapping(body, query) {
  if (body && typeof body === 'object' && !Array.isArray(body) && body.profile !== undefined) {
    const doc = body.profile;
    if (typeof doc === 'string') {
      const p = profileByName(doc);
      if (!p) return { error: `no profile named "${doc}"`, status: 404 };
      return { profile: p, items: body.events !== undefined ? body.events : [] };
    }
    const v = validateProfile(doc);
    if (!v.ok) return { error: 'invalid profile', problems: v.problems, status: 400 };
    return { profile: compileProfile(doc), items: body.events !== undefined ? body.events : [] };
  }

  const named = query.get('profile');
  if (named) {
    const p = profileByName(named);
    if (!p) return { error: `no profile named "${named}"`, status: 404 };
    return { profile: p, items: body };
  }

  const fromQuery = profileFromQuery(query);
  if (fromQuery) return { profile: compileProfile(fromQuery), items: body };

  return { profile: null, items: body };
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

  const m = resolveMapping(payload, url.searchParams);
  if (m.error) return json(res, m.status, { error: m.error, problems: m.problems });

  const list = Array.isArray(m.items) ? m.items : [m.items];
  let accepted = 0;
  let skipped = 0;
  const problems = [];

  for (const item of list) {
    let ev = null;
    if (m.profile) {
      const r = m.profile.apply(item);
      if (r.skipped) {
        skipped++;
        continue;
      }
      // Only the first few reasons: a bad mapping fails on every record, and
      // ten thousand copies of one message helps nobody.
      if (!r.event && problems.length < 5) problems.push(...r.errors);
      ev = r.event ? coerce(r.raw) : null;
    } else {
      ev = coerce(item);
    }
    if (!ev) {
      stats.rejected++;
      continue;
    }
    broadcast(ev);
    accepted++;
  }

  const body = {
    accepted,
    skipped,
    rejected: list.length - accepted - skipped,
    listeners: clients.size,
  };
  if (problems.length) body.problems = problems;
  if (m.profile) body.profile = m.profile.name;
  // Accepting nothing is only an error if nothing was deliberately skipped.
  return json(res, accepted || skipped ? 202 : 400, body);
}

/**
 * Say what the engine understood, without making a sound.
 *
 * A mapping is something you have to get working, and debugging it by
 * listening is hopeless. This answers with the event, which expression fed
 * each field, what each evaluated to, and why anything was refused.
 */
async function handleExplain(req, res, url) {
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

  const m = resolveMapping(payload, url.searchParams);
  if (m.error) return json(res, m.status, { error: m.error, problems: m.problems });

  const first = Array.isArray(m.items) ? m.items[0] : m.items;
  if (first === undefined) {
    return json(res, 400, { error: 'nothing to explain: send a payload' });
  }

  if (!m.profile) {
    const ev = coerce(first);
    return json(res, 200, {
      event: EVENT_VERSION,
      profile: null,
      note: 'No mapping was given, so the payload was read as an event directly.',
      accepted: Boolean(ev),
      result: ev,
      problems: ev ? [] : ['no finite "magnitude" field in the payload'],
    });
  }

  const r = m.profile.apply(first);
  return json(res, 200, {
    event: EVENT_VERSION,
    mapping: MAPPING_VERSION,
    profile: m.profile.name,
    input: first,
    skipped: r.skipped,
    accepted: Boolean(r.event),
    result: r.event,
    fields: r.trace,
    problems: r.errors,
  });
}

/**
 * test, start and stop one source.
 *
 * `test` is the one that matters: it fetches once and reports what it found
 * without emitting anything, so a connector can be got working without
 * listening to it or waiting for an interval.
 */
async function handleSourceAction(req, res, name, action) {
  const doc = readSourceDoc(name);
  if (!doc) return json(res, 404, { error: `no source named "${name}"` });

  if (action === 'stop') {
    return json(res, 200, { name, stopped: runner.stop(doc.name || name) });
  }

  let src;
  try {
    src = buildSource(doc);
  } catch (e) {
    return json(res, 400, { error: 'invalid source', problems: e.problems || [String(e.message)] });
  }
  if (src.missingSecrets.length) {
    return json(res, 400, {
      error: 'missing secrets',
      problems: src.missingSecrets.map((s) => `set ${s} in the environment before using this source`),
    });
  }

  if (action === 'start') {
    runner.start(src);
    return json(res, 202, { name: src.name, started: true, interval: src.interval });
  }
  return json(res, 200, await runner.test(src));
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
  if (url.pathname === '/explain') return handleExplain(req, res, url);
  if (url.pathname === '/events') return handleEvents(req, res, url);
  if (url.pathname === '/profiles') {
    return json(res, 200, { mapping: MAPPING_VERSION, profiles: listProfiles() });
  }
  if (url.pathname === '/sources') {
    return json(res, 200, { source: SOURCE_VERSION, sources: listSources() });
  }
  if (url.pathname === '/schema/source') return serveSchema(res, 'source.schema.json');
  {
    const m = url.pathname.match(/^\/sources\/([A-Za-z0-9._-]{1,64})\/(test|start|stop)$/);
    if (m) return handleSourceAction(req, res, m[1], m[2]);
  }
  if (url.pathname === '/schema' || url.pathname === '/schema/event') {
    return serveSchema(res, 'event.schema.json');
  }
  if (url.pathname === '/schema/mapping') return serveSchema(res, 'mapping.schema.json');
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
  startEnabledSources();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    runner.stopAll();
    server.close(() => process.exit(0));
  });
}
