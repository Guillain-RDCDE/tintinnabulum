// A source descriptor: where the data is, and how often to go and get it.
//
// A profile says how a payload becomes an event. It does not say where the
// payload comes from, and until now that half was JavaScript living inside
// this repository -- so "plug anything in" meant "open src/sources/feeds.js and
// write a function". That is a library with conventions, not a standard.
//
// A descriptor closes it. Connection, extraction and mapping in one document:
//
//   {
//     "source": "tintinnabulum.source/1",
//     "name": "pizza-index",
//     "fetch": {
//       "url": "https://api.example.com/search?query=pizza",
//       "headers": { "Authorization": "Bearer ${env.API_TOKEN}" },
//       "interval": 60000
//     },
//     "items": "$.data",
//     "key": "$.id",
//     "profile": "twitter-search"
//   }
//
// Two things a descriptor deliberately cannot do: name a secret inline, and
// reach anything but the URL it declares. Secrets are `${env.NAME}` and are
// resolved where the runner lives, never stored in the document and never
// returned by the API.

import { compile, check, ExprError } from './expr.js';

export const SOURCE_VERSION = 'tintinnabulum.source/1';

export const DEFAULTS = {
  reconnect: 2000,
  interval: 60000,
  timeout: 15000,
  method: 'GET',
  dedupeSize: 1000,
  // Spread a batch across most of the gap to the next poll. A poll that
  // delivers forty items at once is forty notes at once; the same forty over a
  // minute is a feed. See pollSource, which does the same thing in the browser.
  spread: 0.9,
};

const LIMITS = {
  interval: [1000, 24 * 3600 * 1000],
  timeout: [500, 120000],
  dedupeSize: [0, 100000],
  headers: 24,
  urlLength: 4096,
};

export class SourceError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.problems = problems;
  }
}

/** `${env.NAME}` -> the value of that environment variable. */
const ENV_REF = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Substitute secrets, and say which ones were missing.
 *
 * Missing is reported rather than silently blanked: a request that quietly
 * goes out with `Bearer undefined` fails in a way nobody can read.
 */
export function resolveSecrets(text, env) {
  const missing = [];
  const out = String(text).replace(ENV_REF, (_, name) => {
    const v = env[name];
    if (v == null || v === '') {
      missing.push(name);
      return '';
    }
    return v;
  });
  return { out, missing };
}

/** Every `${env.X}` the descriptor mentions, without resolving any of them. */
export function secretsUsed(doc) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(ENV_REF)) found.add(m[1]);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(doc && doc.fetch);
  walk(doc && doc.stream);
  return [...found];
}

/** A live connection rather than a poll: `stream` instead of `fetch`. */
function validateStream(s, problems) {
  if (typeof s.url !== 'string' || !s.url) {
    problems.push('"stream.url" is required');
  } else {
    let u = null;
    try {
      u = new URL(s.url.replace(ENV_REF, 'x'));
    } catch (e) {
      problems.push(`"stream.url" is not a URL: ${s.url}`);
    }
    if (u) {
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      const secure = u.protocol === 'wss:' || u.protocol === 'https:';
      if (!secure && !local) problems.push('"stream.url" must be wss: or https:, except against localhost');
      const proto = s.protocol || (u.protocol.startsWith('ws') ? 'websocket' : 'sse');
      if (!['websocket', 'sse'].includes(proto)) {
        problems.push('"stream.protocol" must be "websocket" or "sse"');
      }
      if (proto === 'websocket' && !u.protocol.startsWith('ws')) {
        problems.push('a websocket stream needs a ws: or wss: url');
      }
      if (proto === 'sse' && !u.protocol.startsWith('http')) {
        problems.push('an sse stream needs an http: or https: url');
      }
    }
  }
  if (s.subscribe != null) {
    const list = Array.isArray(s.subscribe) ? s.subscribe : [s.subscribe];
    if (list.some((m) => m == null || typeof m !== 'object')) {
      problems.push('"stream.subscribe" must be a JSON message, or an array of them');
    }
  }
  if (s.headers != null && (typeof s.headers !== 'object' || Array.isArray(s.headers))) {
    problems.push('"stream.headers" must be an object');
  }
  for (const [k, [lo, hi]] of Object.entries({
    reconnect: [250, 300000], dedupeSize: LIMITS.dedupeSize, maxPerSecond: [0, 10000],
  })) {
    if (s[k] == null) continue;
    const n = Number(s[k]);
    if (!Number.isFinite(n) || n < lo || n > hi) {
      problems.push(`"stream.${k}" must be a number between ${lo} and ${hi}`);
    }
  }
}

export function validateSource(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, problems: ['a source must be a JSON object'] };
  }
  if (doc.source != null && doc.source !== SOURCE_VERSION) {
    problems.push(`unknown source version "${doc.source}", expected "${SOURCE_VERSION}"`);
  }
  if (!doc.name || typeof doc.name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(doc.name)) {
    problems.push('"name" is required: letters, digits, dot, dash or underscore, up to 64');
  }

  if (doc.fetch && doc.stream) {
    problems.push('a source polls or it listens: give "fetch" or "stream", not both');
  }
  if (!doc.fetch && !doc.stream) {
    problems.push('"fetch" (poll an endpoint) or "stream" (hold a connection open) is required');
  }

  if (doc.stream) {
    if (typeof doc.stream !== 'object' || Array.isArray(doc.stream)) {
      problems.push('"stream" must be an object with at least a url');
    } else {
      validateStream(doc.stream, problems);
    }
  }

  const f = doc.fetch;
  if (f === undefined) {
    // A stream carries the connection instead; nothing more to check here.
  } else if (!f || typeof f !== 'object' || Array.isArray(f)) {
    problems.push('"fetch" must be an object with at least a url');
  } else {
    if (typeof f.url !== 'string' || !f.url) problems.push('"fetch.url" is required');
    else if (f.url.length > LIMITS.urlLength) problems.push('"fetch.url" is too long');
    else {
      // The URL is checked with the secrets left as-is: a token cannot change
      // the scheme or the host, so this is a fair test of where it will go.
      let u = null;
      try {
        u = new URL(f.url.replace(ENV_REF, 'x'));
      } catch (e) {
        problems.push(`"fetch.url" is not a URL: ${f.url}`);
      }
      if (u && u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        problems.push('"fetch.url" must be https, except against localhost');
      }
    }
    if (f.method != null && !['GET', 'POST'].includes(String(f.method).toUpperCase())) {
      problems.push('"fetch.method" must be GET or POST');
    }
    if (f.headers != null) {
      if (typeof f.headers !== 'object' || Array.isArray(f.headers)) {
        problems.push('"fetch.headers" must be an object');
      } else if (Object.keys(f.headers).length > LIMITS.headers) {
        problems.push(`"fetch.headers" has more than ${LIMITS.headers} entries`);
      }
    }
    for (const [k, [lo, hi]] of Object.entries({
      interval: LIMITS.interval, timeout: LIMITS.timeout, dedupeSize: LIMITS.dedupeSize,
    })) {
      if (f[k] == null) continue;
      const n = Number(f[k]);
      if (!Number.isFinite(n) || n < lo || n > hi) {
        problems.push(`"fetch.${k}" must be a number between ${lo} and ${hi}`);
      }
    }
  }

  if (doc.expand != null) {
    const x = doc.expand;
    if (typeof x !== 'object' || Array.isArray(x)) {
      problems.push('"expand" must be an object with a url');
    } else {
      if (typeof x.url !== 'string' || !x.url.includes('${item}')) {
        problems.push('"expand.url" is required and must contain ${item}, the value taken from "items"');
      }
      if (x.limit != null && (!Number.isFinite(Number(x.limit)) || Number(x.limit) < 1 || Number(x.limit) > 500)) {
        problems.push('"expand.limit" must be between 1 and 500');
      }
      if (x.concurrency != null && (!Number.isFinite(Number(x.concurrency)) || Number(x.concurrency) < 1 || Number(x.concurrency) > 16)) {
        problems.push('"expand.concurrency" must be between 1 and 16');
      }
      if (doc.stream) problems.push('"expand" belongs to a polled source, not a stream');
    }
  }

  for (const key of ['items', 'key']) {
    if (doc[key] == null) continue;
    if (typeof doc[key] !== 'string') problems.push(`"${key}" must be an expression string`);
    else {
      const r = check(doc[key]);
      if (!r.ok) problems.push(`"${key}": ${r.error}`);
    }
  }

  if (doc.profile == null) {
    problems.push('"profile" is required: a profile name, or a profile document');
  } else if (typeof doc.profile !== 'string' && typeof doc.profile !== 'object') {
    problems.push('"profile" must be a profile name or a profile document');
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Compile a descriptor into something a runner can drive.
 *
 * `resolveProfile` is injected rather than imported so that this module has no
 * opinion about where profiles are stored -- a file, a database, a request.
 *
 * @param {object} doc
 * @param {(nameOrDoc: string|object) => {name: string, apply: Function}} resolveProfile
 * @param {Record<string,string>} [env]
 */
export function compileSource(doc, resolveProfile, env = {}) {
  const { ok, problems } = validateSource(doc);
  if (!ok) throw new SourceError('invalid source', problems);

  const profile = resolveProfile(doc.profile);
  if (!profile) throw new SourceError('invalid source', [`no profile named "${doc.profile}"`]);

  const streaming = Boolean(doc.stream);
  const f = doc.stream || doc.fetch;
  const url = resolveSecrets(f.url, env);
  const headers = {};
  const missing = [...url.missing];
  for (const [k, v] of Object.entries(f.headers || {})) {
    const r = resolveSecrets(v, env);
    headers[k] = r.out;
    missing.push(...r.missing);
  }

  const items = doc.items ? compile(doc.items) : null;
  const key = doc.key ? compile(doc.key) : null;

  return {
    name: doc.name,
    description: doc.description || '',
    profileName: profile.name,
    // The resolved URL is never exposed: it may carry a token in a query
    // parameter. The unresolved one is what a listing shows.
    url: f.url,
    resolvedUrl: url.out,
    streaming,
    protocol: streaming
      ? f.protocol || (f.url.startsWith('ws') ? 'websocket' : 'sse')
      : null,
    // Sent once the socket opens. Several feeds say nothing until asked.
    subscribe: streaming && f.subscribe
      ? (Array.isArray(f.subscribe) ? f.subscribe : [f.subscribe])
      : [],
    reconnect: Number(f.reconnect) || DEFAULTS.reconnect,
    // A firehose can outrun both the ears and the screen, so a stream may
    // declare its own ceiling. 0 means every message.
    maxPerSecond: Number(f.maxPerSecond) || 0,
    method: String(f.method || DEFAULTS.method).toUpperCase(),
    body: f.body ?? null,
    headers,
    interval: Number(f.interval) || DEFAULTS.interval,
    timeout: Number(f.timeout) || DEFAULTS.timeout,
    dedupeSize: f.dedupeSize == null ? DEFAULTS.dedupeSize : Number(f.dedupeSize),
    spread: doc.spread == null ? DEFAULTS.spread : Number(doc.spread),
    // A list endpoint that returns identities, and a detail endpoint that turns
    // one identity into a record, is one of the commonest shapes on the web --
    // Hacker News, Reddit, half of REST. Without this the standard could
    // describe neither, and a connector author fell straight back to code.
    expand: doc.expand
      ? {
          url: resolveSecrets(doc.expand.url, env).out,
          limit: Number(doc.expand.limit) || 60,
          concurrency: Number(doc.expand.concurrency) || 6,
        }
      : null,
    missingSecrets: [...new Set(missing)],
    secrets: secretsUsed(doc),

    /**
     * Turn one fetched body into events, in order, with a stable key each.
     * Returns the reasons alongside, because a source that produces nothing is
     * the thing a connector author most needs explained.
     */
    extract(body) {
      let list;
      if (items) {
        try {
          list = items(body);
        } catch (e) {
          return { events: [], problems: [`items: ${e instanceof ExprError ? e.message : String(e)}`] };
        }
      } else {
        list = body;
      }
      if (list == null) return { events: [], problems: ['"items" selected nothing'] };
      if (!Array.isArray(list)) list = [list];
      return this.mapAll(list);
    },

    /** Select the identities `expand` should follow, before any are fetched. */
    select(body) {
      let list = items ? items(body) : body;
      if (list == null) return [];
      return Array.isArray(list) ? list : [list];
    },

    /** Run the profile over records that are already in hand. */
    mapAll(list) {
      const events = [];
      const problems = [];
      for (const item of list) {
        const r = profile.apply(item);
        if (r.skipped) continue;
        if (!r.event) {
          if (problems.length < 5) problems.push(...r.errors);
          continue;
        }
        let k = null;
        if (key) {
          try {
            const v = key(item);
            k = v == null ? null : String(v);
          } catch (e) {
            k = null;
          }
        }
        events.push({ event: r.event, raw: r.raw, key: k ?? r.event.id });
      }
      return { events, problems };
    },
  };
}
