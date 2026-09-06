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
  async test(src) {
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
    const { events, problems } = src.extract(r.body);
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

    const { events, problems } = src.extract(r.body);
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

  start(src) {
    if (this.running.has(src.name)) this.stop(src.name);
    const state = {
      source: src, seen: new Set(), order: [], timers: new Set(),
      polls: 0, emitted: 0, failures: 0, lastAt: 0, lastError: null,
      lastProblems: [], nextDelay: src.interval, stopped: false, loop: null,
    };
    this.running.set(src.name, state);

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
    };
  }
}

export { SourceError };
