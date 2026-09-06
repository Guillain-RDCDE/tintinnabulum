// Drives source descriptors: fetch, extract, de-duplicate, pace, emit.
//
// This is the half that used to be JavaScript in src/sources/. It runs here
// rather than in the browser for three reasons a page cannot get around: CORS,
// secrets, and the fact that a background tab is throttled.

import { compileSource, SourceError } from '../src/core/source.js';

export class SourceRunner {
  /**
   * @param {object} o
   * @param {(event: object) => void} o.emit   where finished events go
   * @param {(line: string) => void} [o.log]
   */
  constructor({ emit, log = () => {} }) {
    this.emit = emit;
    this.log = log;
    this.running = new Map(); // name -> state
  }

  /**
   * Follow a list of identities to the records they name.
   *
   * The second half of a two-stage source: `items` selected the identities,
   * and each is substituted into `expand.url`. Requests go out a few at a
   * time rather than all at once, because a hundred simultaneous connections
   * is how a polite poll becomes an attack. Failures are dropped, not thrown:
   * one unreachable record should cost that record and nothing else.
   */
  async expand(src, ids, seen) {
    const wanted = [];
    for (const id of ids) {
      const k = String(id);
      if (seen && seen.has(k)) continue;
      wanted.push(k);
      if (wanted.length >= src.expand.limit) break;
    }
    const out = [];
    for (let i = 0; i < wanted.length; i += src.expand.concurrency) {
      const slice = wanted.slice(i, i + src.expand.concurrency);
      const got = await Promise.all(
        slice.map(async (id) => {
          const url = src.expand.url.replaceAll('${item}', encodeURIComponent(id));
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), src.timeout);
          try {
            const res = await fetch(url, { headers: { Accept: 'application/json', ...src.headers }, signal: ctrl.signal });
            return res.ok ? await res.json() : null;
          } catch (e) {
            return null;
          } finally {
            clearTimeout(t);
          }
        })
      );
      out.push(...got.filter((x) => x != null));
    }
    return out;
  }

  /** Fetch once, honouring the declared timeout. */
  async fetchOnce(src) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), src.timeout);
    try {
      const res = await fetch(src.resolvedUrl, {
        method: src.method,
        headers: { Accept: 'application/json', ...src.headers },
        body: src.method === 'POST' && src.body != null ? JSON.stringify(src.body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch (e) {
        return { ok: false, status: res.status, error: 'response was not JSON', sample: text.slice(0, 200) };
      }
      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}`, retryAfter: Number(res.headers.get('retry-after')) || 0, body };
      }
      return { ok: true, status: res.status, body };
    } catch (e) {
      return { ok: false, status: 0, error: e.name === 'AbortError' ? `timed out after ${src.timeout}ms` : String(e.message) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch and extract without emitting anything.
   *
   * The tool a connector author actually needs: it answers what came back, how
   * many items were found, what the first one became, and why nothing appeared
   * if nothing did.
   */
  async test(src, { seconds = 8 } = {}) {
    if (src.streaming) return this.testStream(src, seconds);
    const r = await this.fetchOnce(src);
    if (!r.ok) {
      return {
        name: src.name,
        fetched: false,
        status: r.status,
        problems: [r.error, ...(src.missingSecrets.length ? [`missing secrets: ${src.missingSecrets.join(', ')}`] : [])],
        sample: r.sample,
      };
    }
    let events, problems;
    if (src.expand) {
      const ids = src.select(r.body);
      const records = await this.expand(src, ids.slice(0, 5), null);
      ({ events, problems } = src.mapAll(records));
      problems = [...problems, ...(ids.length && !records.length ? ['"items" found identities but none could be fetched through "expand.url"'] : [])];
    } else {
      ({ events, problems } = src.extract(r.body));
    }
    return {
      name: src.name,
      fetched: true,
      status: r.status,
      profile: src.profileName,
      found: events.length,
      problems,
      // One example is worth more than a count: it shows whether the mapping
      // read the right fields, not merely that it read something.
      first: events[0] ? { key: events[0].key, event: events[0].event } : null,
      // What the payload looked like at the top level, so a wrong `items`
      // path is obvious rather than mysterious.
      shape: Array.isArray(r.body)
        ? `array of ${r.body.length}`
        : r.body && typeof r.body === 'object'
          ? `object with keys: ${Object.keys(r.body).slice(0, 12).join(', ')}`
          : typeof r.body,
    };
  }

  /**
   * Listen for a few seconds and report, without emitting anything.
   *
   * A stream cannot be tested by fetching once, and a connector author needs
   * the same answer either way: did it connect, did anything arrive, and what
   * did the first message become. Messages seen but mapped to nothing are
   * counted separately from messages never received -- the two have completely
   * different causes, and conflating them sends people hunting the wrong one.
   */
  async testStream(src, seconds) {
    const captured = [];
    let received = 0;
    let firstProblems = [];
    const probe = {
      ...src,
      dedupeSize: 0,
      maxPerSecond: 0,
      extract(body) {
        received++;
        const out = src.extract(body);
        if (!out.events.length && out.problems.length && !firstProblems.length) {
          firstProblems = out.problems;
        }
        return out;
      },
    };
    const state = {
      source: probe, seen: new Set(), order: [], timers: new Set(),
      polls: 0, emitted: 0, dropped: 0, failures: 0, lastError: null,
      lastProblems: [], stopped: false, loop: null, socket: null, abort: null,
      windowAt: 0, inWindow: 0,
    };
    const keep = this.emit;
    this.emit = (raw) => { if (captured.length < 5) captured.push(raw); };
    try {
      this._openStream(state);
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline && captured.length < 3) {
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      this.emit = keep;
      state.stopped = true;
      try { if (state.socket) state.socket.close(); } catch (e) {}
      try { if (state.abort) state.abort.abort(); } catch (e) {}
      if (state.loop) clearTimeout(state.loop);
    }

    return {
      name: src.name,
      streaming: true,
      protocol: src.protocol,
      connected: state.failures === 0 && !state.lastError,
      messages: received,
      found: captured.length,
      profile: src.profileName,
      problems: [
        ...(state.lastError ? [state.lastError] : []),
        ...(received === 0 ? [`no message arrived in ${seconds}s -- check the url, and whether this feed needs a subscribe message`] : []),
        ...(received > 0 && captured.length === 0 ? [`${received} messages arrived but none became an event`, ...firstProblems] : []),
      ],
      first: captured[0] ? { key: captured[0].id, event: captured[0] } : null,
    };
  }

  /** One poll of a running source: emit what is new, paced across the gap. */
  async tick(state) {
    const src = state.source;
    const r = await this.fetchOnce(src);
    state.polls++;
    state.lastAt = Date.now();

    if (!r.ok) {
      state.failures++;
      state.lastError = r.error;
      // Back off on failure, and obey Retry-After when the server sends one.
      // Hammering a failing endpoint is how a connector gets a key revoked.
      const backoff = r.retryAfter ? r.retryAfter * 1000 : Math.min(src.interval * 2 ** Math.min(state.failures, 5), 15 * 60000);
      state.nextDelay = backoff;
      this.log(`source ${src.name}: ${r.error}, retrying in ${Math.round(backoff / 1000)}s`);
      return;
    }

    state.failures = 0;
    state.lastError = null;
    state.nextDelay = src.interval;

    let events, problems;
    if (src.expand) {
      const ids = src.select(r.body);
      const records = await this.expand(src, ids, state.seen);
      ({ events, problems } = src.mapAll(records));
      // Identities are remembered here rather than after mapping, so a record
      // that fails to map is not fetched again on every single poll.
      for (const id of ids.slice(0, src.expand.limit)) {
        const k = String(id);
        if (!state.seen.has(k)) { state.seen.add(k); state.order.push(k); }
      }
    } else {
      ({ events, problems } = src.extract(r.body));
    }
    state.lastProblems = problems;

    const fresh = [];
    for (const e of events) {
      if (state.seen.has(e.key)) continue;
      state.seen.add(e.key);
      state.order.push(e.key);
      fresh.push(e);
    }
    while (state.order.length > src.dedupeSize) state.seen.delete(state.order.shift());

    if (!fresh.length) return;
    state.emitted += fresh.length;

    // Pace the batch. A poll that returns forty items is forty notes at once
    // otherwise, which is heard as a glitch rather than as forty things.
    const window = Math.max(0, src.interval * src.spread);
    if (window <= 0 || fresh.length === 1) {
      for (const e of fresh) this.emit(e.raw);
      return;
    }
    const gap = window / fresh.length;
    fresh.forEach((e, i) => {
      const t = setTimeout(() => {
        state.timers.delete(t);
        this.emit(e.raw);
      }, Math.round(i * gap));
      state.timers.add(t);
    });
  }

  /**
   * Hand one message from a live connection to the profile and emit it.
   *
   * Shared by both stream protocols, and by the poll path's own extraction, so
   * a descriptor behaves identically however the bytes arrived.
   */
  _consume(state, body) {
    const src = state.source;
    const { events, problems } = src.extract(body);
    state.lastProblems = problems;
    for (const e of events) {
      if (src.dedupeSize > 0) {
        if (state.seen.has(e.key)) continue;
        state.seen.add(e.key);
        state.order.push(e.key);
        while (state.order.length > src.dedupeSize) state.seen.delete(state.order.shift());
      }
      // A firehose can outrun the ears and the screen both. The ceiling is
      // the descriptor's own, and dropping here rather than downstream keeps
      // the cost off the renderer entirely.
      if (src.maxPerSecond > 0) {
        const now = Date.now();
        if (now - state.windowAt >= 1000) { state.windowAt = now; state.inWindow = 0; }
        if (state.inWindow >= src.maxPerSecond) { state.dropped++; continue; }
        state.inWindow++;
      }
      state.emitted++;
      this.emit(e.raw);
    }
  }

  /**
   * Hold a connection open, and put it back when it drops.
   *
   * Reconnection is not optional: a socket that has been up for a day will
   * close, and a feed that silently stops is worse than one that never
   * started. The delay grows with consecutive failures so a server that is
   * down is not hammered while it recovers.
   */
  _openStream(state) {
    const src = state.source;
    if (state.stopped) return;

    const retry = () => {
      if (state.stopped) return;
      state.failures++;
      const wait = Math.min(src.reconnect * 2 ** Math.min(state.failures - 1, 6), 5 * 60000);
      state.nextDelay = wait;
      const t = setTimeout(() => this._openStream(state), wait);
      if (t.unref) t.unref();
      state.loop = t;
    };

    if (src.protocol === 'websocket') {
      let ws;
      try {
        ws = new WebSocket(src.resolvedUrl);
      } catch (e) {
        state.lastError = String(e.message);
        return retry();
      }
      state.socket = ws;
      ws.addEventListener('open', () => {
        state.failures = 0;
        state.lastError = null;
        state.connectedAt = Date.now();
        for (const msg of src.subscribe) {
          try { ws.send(JSON.stringify(msg)); } catch (e) { /* the close handler retries */ }
        }
        this.log(`source ${src.name}: connected to ${src.url}`);
      });
      ws.addEventListener('message', (ev) => {
        state.polls++;
        let body = null;
        try { body = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); }
        catch (e) { return; } // a heartbeat or a non-JSON frame is not an error
        try { this._consume(state, body); } catch (e) { state.lastError = String(e.message); }
      });
      ws.addEventListener('error', () => { state.lastError = 'socket error'; });
      ws.addEventListener('close', () => {
        state.socket = null;
        if (!state.stopped) {
          this.log(`source ${src.name}: connection closed, reconnecting`);
          retry();
        }
      });
      return;
    }

    // Server-Sent Events, read straight off the response body.
    const ctrl = new AbortController();
    state.abort = ctrl;
    fetch(src.resolvedUrl, {
      headers: { Accept: 'text/event-stream', ...src.headers },
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        state.failures = 0;
        state.lastError = null;
        state.connectedAt = Date.now();
        this.log(`source ${src.name}: streaming ${src.url}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Events are separated by a blank line; only `data:` carries payload.
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = frame
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('');
            if (!data) continue;
            state.polls++;
            try { this._consume(state, JSON.parse(data)); } catch (e) { /* not JSON */ }
          }
        }
        throw new Error('stream ended');
      })
      .catch((e) => {
        if (state.stopped) return;
        state.lastError = String(e.message);
        retry();
      });
  }

  start(src) {
    if (this.running.has(src.name)) this.stop(src.name);
    const state = {
      source: src, seen: new Set(), order: [], timers: new Set(),
      polls: 0, emitted: 0, dropped: 0, failures: 0, lastAt: 0, lastError: null,
      lastProblems: [], nextDelay: src.interval, stopped: false, loop: null,
      socket: null, abort: null, connectedAt: 0, windowAt: 0, inWindow: 0,
    };
    this.running.set(src.name, state);

    if (src.streaming) {
      this._openStream(state);
      this.log(`source ${src.name}: holding ${src.protocol} open to ${src.url}`);
      return state;
    }

    const cycle = async () => {
      if (state.stopped) return;
      try {
        await this.tick(state);
      } catch (e) {
        state.failures++;
        state.lastError = String(e.message);
      }
      if (state.stopped) return;
      state.loop = setTimeout(cycle, state.nextDelay);
      // A pending poll must never hold the process open on its own.
      if (state.loop.unref) state.loop.unref();
    };
    cycle();
    this.log(`source ${src.name}: polling ${src.url} every ${Math.round(src.interval / 1000)}s`);
    return state;
  }

  stop(name) {
    const state = this.running.get(name);
    if (!state) return false;
    state.stopped = true;
    if (state.loop) clearTimeout(state.loop);
    try { if (state.socket) state.socket.close(); } catch (e) { /* already gone */ }
    try { if (state.abort) state.abort.abort(); } catch (e) { /* already gone */ }
    for (const t of state.timers) clearTimeout(t);
    state.timers.clear();
    this.running.delete(name);
    return true;
  }

  stopAll() {
    for (const name of [...this.running.keys()]) this.stop(name);
  }

  status(name) {
    const s = this.running.get(name);
    if (!s) return { running: false };
    return {
      running: true,
      polls: s.polls,
      emitted: s.emitted,
      failures: s.failures,
      lastError: s.lastError,
      lastProblems: s.lastProblems,
      lastAt: s.lastAt || null,
      pending: s.timers.size,
      streaming: s.source.streaming,
      connected: s.source.streaming ? Boolean(s.socket || s.abort) && s.failures === 0 : undefined,
      dropped: s.dropped || 0,
    };
  }
}

export { SourceError };
