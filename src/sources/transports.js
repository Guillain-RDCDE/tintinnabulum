// Generic transports: the plumbing every feed is built on.
//
// A source is any object with { name, start(emit), stop() }. Nothing here
// knows what the events mean; that belongs to the feed modules beside it.

/**
 * Reconnecting WebSocket source. Replaces the vendored
 * reconnecting-websocket.js with ~30 lines and exponential backoff.
 */
export function websocketSource({
  url,
  map = (d) => d,
  protocols,
  name = 'websocket',
  reconnect = true,
  minDelay = 1000,
  maxDelay = 30000,
  onStatus = null,
  subscribe = null, // sent on every open, including after a reconnect
}) {
  let ws = null;
  let closed = false;
  let delay = minDelay;
  let timer = 0;

  return {
    name,
    url,
    get status() {
      if (!ws) return 'idle';
      return ['connecting', 'open', 'closing', 'closed'][ws.readyState] || 'unknown';
    },
    start(emit) {
      closed = false;
      const open = () => {
        if (closed) return;
        if (onStatus) onStatus('connecting', name);
        ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
        ws.onopen = () => {
          delay = minDelay;
          if (onStatus) onStatus('open', name);
          if (subscribe) {
            try {
              ws.send(typeof subscribe === 'string' ? subscribe : JSON.stringify(subscribe));
            } catch (e) {
              console.warn(name + ': subscribe failed', e);
            }
          }
        };
        ws.onmessage = (msg) => {
          let payload;
          try {
            payload = JSON.parse(msg.data);
          } catch (e) {
            return;
          }
          const out = map(payload);
          if (!out) return;
          if (Array.isArray(out)) out.forEach(emit);
          else emit(out);
        };
        ws.onerror = () => {
          if (onStatus) onStatus('error', name);
        };
        ws.onclose = () => {
          if (onStatus) onStatus('closed', name);
          if (closed || !reconnect) return;
          timer = setTimeout(open, delay);
          delay = Math.min(maxDelay, delay * 2);
        };
      };
      open();
    },
    stop() {
      closed = true;
      clearTimeout(timer);
      if (ws) {
        try {
          ws.close();
        } catch (e) {}
      }
      ws = null;
    },
  };
}

/** Server-Sent Events source. EventSource reconnects on its own. */
export function sseSource({
  url,
  map = (d) => d,
  eventName = 'message',
  name = 'sse',
  withCredentials = false,
  onStatus = null,
}) {
  let es = null;
  return {
    name,
    url,
    get status() {
      if (!es) return 'idle';
      return ['connecting', 'open', 'closed'][es.readyState] || 'unknown';
    },
    start(emit) {
      es = new EventSource(url, { withCredentials });
      es.onopen = () => onStatus && onStatus('open', name);
      es.onerror = () => onStatus && onStatus('error', name);
      es.addEventListener(eventName, (e) => {
        let payload;
        try {
          payload = JSON.parse(e.data);
        } catch (err) {
          return;
        }
        const out = map(payload);
        if (!out) return;
        if (Array.isArray(out)) out.forEach(emit);
        else emit(out);
      });
    },
    stop() {
      if (es) es.close();
      es = null;
    },
  };
}

/**
 * Poll an HTTP endpoint. `map` returns an event or an array of them.
 *
 * Batches are trickled out rather than delivered in one instant. A poller that
 * emits its whole page at once produces a single blurred chord -- most of it
 * dropped, since only so many voices exist -- followed by a minute of silence,
 * which sounds broken even though nothing is. Spreading the batch across the
 * gap until the next poll turns the same data into a steady stream.
 */
export function pollSource({
  url,
  interval = 5000,
  map = (d) => d,
  name = 'poll',
  fetchOptions,
  dedupe = true,
  dedupeSize = 500,
  spread = true,
  // Cover almost the whole gap to the next poll. A shorter window leaves an
  // audible hole at the end of every cycle -- 45 s of sound then 30 s of
  // nothing, which is heard as the feed dying rather than as pacing.
  spreadFraction = 0.95,
  maxSpread = Infinity,
  firstSpread = 0, // longer window for the opening backlog; 0 = same as the rest
}) {
  let timer = 0;
  let stopped = false;
  const pending = new Set();
  const seen = new Set();
  const order = [];

  const fresh = (ev) => {
    if (!dedupe || !ev || ev.id == null) return true;
    const k = String(ev.id);
    if (seen.has(k)) return false;
    seen.add(k);
    order.push(k);
    if (order.length > dedupeSize) seen.delete(order.shift());
    return true;
  };

  let firstBatch = true;

  const deliver = (list, emit) => {
    if (!spread || list.length <= 1) {
      for (const ev of list) emit(ev);
      return;
    }
    // The opening batch is a backlog: it may be given a longer window of its
    // own, so a sparse feed plays out as a slow replay instead of a minute of
    // activity followed by silence.
    const window = firstBatch && firstSpread ? firstSpread : Math.min(maxSpread, interval * spreadFraction);
    firstBatch = false;

    // Play the batch to its own rhythm where the events carry real times.
    // Spacing them evenly discards exactly what is interesting about a feed
    // like seismicity, which arrives in swarms rather than on a metronome.
    const stamps = list.map((e) => Number(e && e.ts));
    const dated = stamps.every(Number.isFinite);

    // Bounds are taken from percentiles rather than min and max. Feeds like
    // active weather alerts hold one item issued days ago among hundreds from
    // the last few hours; on raw extremes that single outlier claims the start
    // of the window and squeezes everything else into its final few percent,
    // which plays as one event and then silence.
    const sorted = dated ? [...stamps].sort((a, b) => a - b) : [];
    const at = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p)))];
    const lo = dated ? at(0.05) : 0;
    const hi = dated ? at(0.97) : 0;
    const useTimes = dated && hi > lo;

    const ordered = useTimes ? [...list].sort((a, b) => Number(a.ts) - Number(b.ts)) : list;
    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const offsets = useTimes
      ? ordered.map((e) => clamp01((Number(e.ts) - lo) / (hi - lo)) * window)
      : ordered.map((_, i) => (window / ordered.length) * i);

    // Clamping the outliers stacks them on the boundary, and genuine ties land
    // together too, so a dozen events can share one instant and sound as a
    // single blurred chord. Nudge each one just past its predecessor: gaps
    // wider than the minimum are left exactly as they were, so real clustering
    // survives while simultaneity does not.
    const minGap = Math.max(70, Math.min(400, window / (ordered.length * 4)));
    for (let i = 1; i < offsets.length; i++) {
      if (offsets[i] < offsets[i - 1] + minGap) offsets[i] = offsets[i - 1] + minGap;
    }

    ordered.forEach((ev, i) => {
      const t = setTimeout(() => {
        pending.delete(t);
        if (!stopped) emit(ev);
      }, Math.round(offsets[i]));
      pending.add(t);
    });
  };

  return {
    name,
    url,
    async start(emit) {
      stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          const res = await fetch(url, fetchOptions);
          const body = await res.json();
          // `map` may be async: some feeds return a list of ids and need a
          // second request per entry before there is anything to sonify.
          const out = await map(body);
          const list = Array.isArray(out) ? out : out ? [out] : [];
          deliver(list.filter(fresh), emit);
        } catch (e) {
          console.warn(name + ': poll failed', e);
        }
        if (!stopped) timer = setTimeout(tick, interval);
      };
      tick();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      for (const t of pending) clearTimeout(t);
      pending.clear();
    },
  };
}

/** Push events in by hand. Useful for tests and for wiring up anything else. */
export function manualSource({ name = 'manual' } = {}) {
  let sink = null;
  return {
    name,
    start(emit) {
      sink = emit;
    },
    stop() {
      sink = null;
    },
    push(ev) {
      if (sink) sink(ev);
    },
  };
}

/** Synthetic traffic, for demos and for tuning the mapper without a network. */
export function randomSource({
  name = 'random',
  rate = 4, // events per second
  magnitude = () => Math.round(Math.exp(Math.random() * 9)),
  accentEvery = 60,
} = {}) {
  let timer = 0;
  let n = 0;
  const words = ['alpha', 'bravo', 'delta', 'echo', 'kilo', 'lima', 'nova', 'zulu'];
  return {
    name,
    start(emit) {
      const tick = () => {
        n++;
        const id = words[n % words.length] + '-' + ((n * 7919) % 97);
        emit({
          magnitude: magnitude() * (Math.random() < 0.35 ? -1 : 1),
          id,
          label: id,
          category: Math.random() < 0.15 ? 'bot' : Math.random() < 0.3 ? 'anon' : 'user',
          accent: accentEvery > 0 && n % accentEvery === 0,
          source: name,
        });
        timer = setTimeout(tick, (1000 / rate) * (0.4 + Math.random() * 1.2));
      };
      tick();
    },
    stop() {
      clearTimeout(timer);
    },
  };
}

/** Reads the bundled ingest server's fan-out stream. */
export function ingestSource({ url = '/events', replay = 0, name = 'ingest', onStatus } = {}) {
  const full = replay > 0 ? url + (url.includes('?') ? '&' : '?') + 'replay=' + replay : url;
  return sseSource({ url: full, name, onStatus });
}
