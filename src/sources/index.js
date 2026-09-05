// Sources are adapters: they turn some stream of the world into normalized
// events. A source is any object with { name, start(emit), stop() }.

// --- generic transports ---------------------------------------------------

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

/** Poll an HTTP endpoint. `map` returns an event or an array of them. */
export function pollSource({
  url,
  interval = 5000,
  map = (d) => d,
  name = 'poll',
  fetchOptions,
  dedupe = true,
  dedupeSize = 500,
}) {
  let timer = 0;
  let stopped = false;
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
          const out = map(body);
          const list = Array.isArray(out) ? out : out ? [out] : [];
          for (const ev of list) if (fresh(ev)) emit(ev);
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

// --- Wikipedia ------------------------------------------------------------

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|:/;

/**
 * Wikipedia recent changes.
 *
 * backend 'eventstreams' (default) uses Wikimedia's own public SSE endpoint:
 * HTTPS, no Hatnote infrastructure, every wiki on one connection. That makes
 * the whole thing hostable as static files.
 *
 * backend 'wikimon' keeps the original Hatnote WebSockets, which carry extras
 * EventStreams does not: geo_ip, hashtags, mentions, is_anon.
 */
export function wikipedia({
  langs = ['en'],
  backend = 'eventstreams',
  mainNamespaceOnly = true,
  welcomeNewUsers = true,
  project = 'wikipedia',
  onStatus = null,
} = {}) {
  const wikis = new Set(langs.map((l) => l + (project === 'wikipedia' ? 'wiki' : project)));

  if (backend === 'eventstreams') {
    return sseSource({
      name: 'wikipedia/eventstreams',
      url: 'https://stream.wikimedia.org/v2/stream/recentchange',
      onStatus,
      map(d) {
        if (!d || !wikis.has(d.wiki)) return null;

        if (d.type === 'log') {
          if (!welcomeNewUsers || d.log_type !== 'newusers') return null;
          return {
            magnitude: 1,
            polarity: 0,
            id: 'newuser:' + d.user,
            label: `Welcome, ${d.user} has joined Wikipedia!`,
            url: d.meta && d.meta.uri,
            category: 'alert',
            accent: true,
            source: d.wiki,
            data: d,
          };
        }
        if (d.type !== 'edit' && d.type !== 'new') return null;
        if (mainNamespaceOnly && d.namespace !== 0) return null;

        const len = d.length || {};
        const delta = (len.new || 0) - (len.old || 0);
        // EventStreams has no is_anon flag; an IP-shaped username is the
        // standard proxy for it.
        const anon = IP_RE.test(d.user || '');
        return {
          magnitude: Math.abs(delta),
          polarity: Math.sign(delta),
          id: d.title,
          label: d.title,
          url: (d.meta && d.meta.uri) || d.server_url + '/wiki/' + encodeURIComponent(d.title),
          category: d.bot ? 'bot' : anon ? 'anon' : 'user',
          source: d.wiki,
          data: d,
        };
      },
    });
  }

  if (backend !== 'wikimon') throw new Error('Unknown Wikipedia backend: ' + backend);

  // One socket per language, as the original did.
  const secure = typeof location === 'undefined' || location.protocol === 'https:';
  const children = langs.map((lang) =>
    websocketSource({
      name: 'wikimon/' + lang,
      url: secure
        ? `wss://wikimon.hatnote.com/v2/${lang}/`
        : `ws://wikimon.hatnote.com:${WIKIMON_PORTS[lang] || 9000}`,
      onStatus,
      map(d) {
        if (!d) return null;
        if (d.page_title === 'Special:Log/newusers' && d.url !== 'byemail') {
          if (!welcomeNewUsers) return null;
          return {
            magnitude: 1,
            polarity: 0,
            id: 'newuser:' + d.user,
            label: `Welcome, ${d.user} has joined ${lang} Wikipedia!`,
            url: `https://${lang}.wikipedia.org/wiki/User_talk:${encodeURIComponent(d.user)}`,
            category: 'alert',
            accent: true,
            source: lang,
            data: d,
          };
        }
        if (mainNamespaceOnly && d.ns !== 'Main') return null;
        const size = Number(d.change_size);
        if (!Number.isFinite(size)) return null;
        return {
          magnitude: Math.abs(size),
          polarity: Math.sign(size),
          id: d.page_title,
          label: d.page_title,
          url: d.url,
          category: d.is_bot ? 'bot' : d.is_anon ? 'anon' : 'user',
          source: lang,
          data: d, // keeps geo_ip, hashtags, mentions, rev_id available downstream
        };
      },
    })
  );

  return {
    name: 'wikipedia/wikimon',
    children,
    start(emit) {
      children.forEach((c) => c.start(emit));
    },
    stop() {
      children.forEach((c) => c.stop());
    },
  };
}

/** Legacy per-language ports, only needed for the plain-ws fallback. */
export const WIKIMON_PORTS = {
  en: 9000, de: 9010, ru: 9020, ja: 9030, es: 9040, fr: 9050, nl: 9060,
  it: 9070, sv: 9080, ar: 9090, id: 9100, ta: 9110, pa: 9120, mr: 9130,
  hi: 9140, as: 9150, bn: 9160, te: 9165, kn: 9170, or: 9180, sa: 9190,
  gu: 9200, fa: 9210, wikidata: 9220, he: 9230, zh: 9240, ml: 9250,
  pl: 9260, mk: 9270, be: 9280, sr: 9290, bg: 9300, uk: 9310, hu: 9320,
  fi: 9330, no: 9340, el: 9350, eo: 9360, pt: 9370, et: 9380, ur: 9390,
  ro: 9400, hy: 9410,
};

export const WIKIPEDIA_LANGS = {
  en: 'English', de: 'German', ru: 'Russian', uk: 'Ukrainian', ja: 'Japanese',
  es: 'Spanish', fr: 'French', nl: 'Dutch', it: 'Italian', sv: 'Swedish',
  ar: 'Arabic', fa: 'Farsi', he: 'Hebrew', id: 'Indonesian', zh: 'Chinese',
  as: 'Assamese', hi: 'Hindi', bn: 'Bengali', pa: 'Punjabi', te: 'Telugu',
  ta: 'Tamil', ml: 'Malayalam', mr: 'Marathi', kn: 'Kannada', or: 'Odia',
  sa: 'Sanskrit', gu: 'Gujarati', pl: 'Polish', mk: 'Macedonian',
  be: 'Belarusian', sr: 'Serbian', bg: 'Bulgarian', hu: 'Hungarian',
  fi: 'Finnish', no: 'Norwegian', el: 'Greek', eo: 'Esperanto',
  pt: 'Portuguese', et: 'Estonian', ur: 'Urdu', ro: 'Romanian', hy: 'Armenian',
};
