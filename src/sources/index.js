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

// --- other live feeds -----------------------------------------------------
// Every one of these is public, keyless and reachable over TLS from a static
// page. WebSocket feeds are not subject to CORS; the polled ones were checked
// to send `Access-Control-Allow-Origin: *`.

/**
 * Unconfirmed Bitcoin transactions, from blockchain.info.
 *
 * The ancestor feed: Listen to Wikipedia was built after BitListen, which
 * sonified exactly this. Magnitude is the total output in satoshis.
 */
export function bitcoin({ name = 'bitcoin', whaleBTC = 50, onStatus = null } = {}) {
  return websocketSource({
    name,
    url: 'wss://ws.blockchain.info/inv',
    subscribe: { op: 'unconfirmed_sub' },
    onStatus,
    map(d) {
      if (!d || d.op !== 'utx' || !d.x) return null;
      const sats = (d.x.out || []).reduce((s, o) => s + (o.value || 0), 0);
      if (!sats) return null;
      const btc = sats / 1e8;
      return {
        magnitude: sats,
        polarity: 1,
        id: d.x.hash,
        label: btc.toFixed(btc >= 1 ? 3 : 6) + ' BTC',
        url: 'https://www.blockchain.com/btc/tx/' + d.x.hash,
        category: btc >= whaleBTC ? 'alert' : 'user',
        accent: btc >= whaleBTC,
        source: 'bitcoin',
        data: d.x,
      };
    },
  });
}

/**
 * Trades on Coinbase. Buys ring, sells pluck: the exchange hands us a polarity
 * that means something, which is unusual and worth using.
 */
export function coinbase({ product = 'BTC-USD', name = 'coinbase', onStatus = null } = {}) {
  return websocketSource({
    name: name + '/' + product,
    url: 'wss://ws-feed.exchange.coinbase.com',
    subscribe: { type: 'subscribe', product_ids: [product], channels: ['matches'] },
    onStatus,
    map(d) {
      if (!d || (d.type !== 'match' && d.type !== 'last_match')) return null;
      const size = Number(d.size);
      const price = Number(d.price);
      if (!Number.isFinite(size) || !Number.isFinite(price)) return null;
      return {
        magnitude: size * price, // value in quote currency, not raw coin count
        polarity: d.side === 'sell' ? -1 : 1,
        id: String(d.trade_id ?? d.sequence ?? Date.now()),
        label: `${d.side} ${size} @ ${price}`,
        category: d.side === 'sell' ? 'anon' : 'user',
        source: product,
        data: d,
      };
    },
  });
}

/**
 * Earthquakes, from the USGS. The one feed where "magnitude" is already the
 * domain's own word for it. Quiet by nature: a handful an hour.
 */
export function earthquakes({
  // A day rather than an hour: the past hour holds about ten events, which is
  // a few seconds of sound and then nothing. A day holds a few hundred, so the
  // opening trickle lasts. After that the feed is genuinely quiet, because
  // earthquakes are genuinely rare -- that is the world, not the software.
  window = 'all_day',
  interval = 60000,
  bigMag = 5,
  name = 'earthquakes',
  // The day's backlog is a few hundred events. Played over one poll interval
  // it is a minute of activity and then silence; played over twenty, it is a
  // slow replay of the day that keeps its own swarms and clusters, with live
  // events arriving on top.
  replayOver = 20 * 60000,
} = {}) {
  return pollSource({
    name,
    interval,
    firstSpread: replayOver,
    url: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${window}.geojson`,
    map(body) {
      if (!body || !Array.isArray(body.features)) return [];
      return body.features
        .map((f) => {
          const mag = Number(f.properties && f.properties.mag);
          if (!Number.isFinite(mag)) return null;
          return {
            magnitude: Math.max(0, mag),
            polarity: 1,
            id: f.id,
            label: `M${mag.toFixed(1)} ${f.properties.place || ''}`.trim(),
            url: f.properties.url,
            category: mag >= bigMag ? 'alert' : 'user',
            accent: mag >= bigMag,
            ts: f.properties.time,
            source: 'usgs',
            data: f,
          };
        })
        .filter(Boolean);
    },
  });
}

/**
 * The Bluesky firehose, via Jetstream.
 *
 * Labels deliberately carry the size of a post rather than its text: this is
 * an unfiltered public firehose, and putting arbitrary strangers' words on
 * someone else's screen is not a decision this project should make for them.
 * The full record is still in `data` for anyone who wants it.
 */
export function bluesky({
  name = 'bluesky',
  endpoint = 'wss://jetstream2.us-east.bsky.network/subscribe',
  onStatus = null,
} = {}) {
  return websocketSource({
    name,
    url: endpoint + '?wantedCollections=app.bsky.feed.post',
    onStatus,
    map(d) {
      if (!d || d.kind !== 'commit' || !d.commit) return null;
      if (d.commit.operation !== 'create') return null;
      const rec = d.commit.record;
      if (!rec || typeof rec.text !== 'string') return null;
      const len = rec.text.length;
      return {
        magnitude: Math.max(1, len),
        polarity: 1,
        id: d.did + '/' + d.commit.rkey,
        label: `${len} characters`,
        category: rec.reply ? 'anon' : 'user',
        source: 'bluesky',
        data: d,
      };
    },
  });
}

/** Weights per GitHub event type, so a star and a 40-commit push differ. */
const GH_WEIGHT = {
  PushEvent: 0, // replaced by the commit count
  PullRequestEvent: 8,
  IssuesEvent: 5,
  IssueCommentEvent: 3,
  ReleaseEvent: 20,
  CreateEvent: 4,
  DeleteEvent: 4,
  ForkEvent: 6,
  WatchEvent: 1,
};

/**
 * GitHub's public timeline. Unauthenticated access is capped at 60 requests an
 * hour, so the default poll stays comfortably under one a minute.
 */
export function github({ interval = 75000, name = 'github', perPage = 30 } = {}) {
  return pollSource({
    name,
    interval,
    url: `https://api.github.com/events?per_page=${perPage}`,
    map(body) {
      if (!Array.isArray(body)) return [];
      return body
        .map((e) => {
          const size =
            e.type === 'PushEvent'
              ? Math.max(1, (e.payload && e.payload.size) || 1) * 4
              : GH_WEIGHT[e.type] || 2;
          const actor = (e.actor && e.actor.login) || '';
          return {
            magnitude: size,
            polarity: e.type === 'DeleteEvent' ? -1 : 1,
            id: e.id,
            label: `${(e.type || '').replace(/Event$/, '')} ${e.repo ? e.repo.name : ''}`.trim(),
            url: e.repo ? 'https://github.com/' + e.repo.name : '',
            category: /\[bot\]$/.test(actor) ? 'bot' : 'user',
            ts: Date.parse(e.created_at) || Date.now(),
            source: 'github',
            data: e,
          };
        })
        .filter((x) => x.id);
    },
  });
}

/** Severity is a word, and the mapper needs a number. */
const NWS_SEVERITY = { Extreme: 100, Severe: 60, Moderate: 28, Minor: 10, Unknown: 5 };

/**
 * Active weather alerts from the US National Weather Service.
 *
 * A different kind of feed from the rest: a few hundred alerts stand active at
 * any moment, each carrying the time it was issued, so the replay keeps the
 * real shape of a day's weather rather than spacing it evenly.
 */
export function noaaAlerts({
  interval = 120000,
  name = 'weather',
  // A few hundred alerts stand active. Over fifteen minutes that is a trickle
  // with long empty stretches; over five it reads as weather.
  replayOver = 5 * 60000,
  url = 'https://api.weather.gov/alerts/active',
} = {}) {
  return pollSource({
    name,
    interval,
    url,
    firstSpread: replayOver,
    fetchOptions: { headers: { Accept: 'application/geo+json' } },
    map(body) {
      if (!body || !Array.isArray(body.features)) return [];
      return body.features
        .map((f) => {
          const p = f.properties || {};
          const sev = NWS_SEVERITY[p.severity] ?? 5;
          const big = sev >= 60;
          return {
            magnitude: sev,
            polarity: 1,
            id: p.id || f.id,
            label: `${p.event || 'Alert'} — ${String(p.areaDesc || '').split(';')[0].trim()}`,
            url: p['@id'] || '',
            category: big ? 'alert' : p.severity === 'Moderate' ? 'anon' : 'user',
            accent: p.severity === 'Extreme',
            ts: Date.parse(p.sent) || Date.now(),
            source: 'nws',
            data: f,
          };
        })
        .filter((e) => e.id);
    },
  });
}

/**
 * Hacker News, via its public Firebase API.
 *
 * The list endpoint returns ids only, so each entry costs a second request.
 * `topstories` rather than `newstories`: a brand-new story always scores 1, so
 * the whole feed would land on a single pitch, whereas the top list spans
 * three orders of magnitude. De-duplication means each story sounds once, when
 * it first appears.
 */
export function hackerNews({
  interval = 90000,
  name = 'hackernews',
  list = 'topstories',
  // Thirty stories over ten minutes is three a minute, which is not a feed so
  // much as an occasional noise. Sixty over three gives it a pulse.
  batch = 60,
  replayOver = 3 * 60000,
} = {}) {
  const fetched = new Set();
  return pollSource({
    name,
    interval,
    firstSpread: replayOver,
    url: `https://hacker-news.firebaseio.com/v0/${list}.json`,
    async map(ids) {
      if (!Array.isArray(ids)) return [];
      const wanted = ids.filter((id) => !fetched.has(id)).slice(0, batch);
      const items = await Promise.all(
        wanted.map(async (id) => {
          fetched.add(id);
          if (fetched.size > 3000) fetched.delete(fetched.values().next().value);
          try {
            const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
            return r.ok ? await r.json() : null;
          } catch {
            return null;
          }
        })
      );
      return items
        .filter((it) => it && it.title)
        .map((it) => ({
          magnitude: Math.max(1, (it.score || 0) + (it.descendants || 0) * 2),
          polarity: 1,
          id: String(it.id),
          label: it.title,
          url: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
          category: (it.score || 0) >= 300 ? 'alert' : 'user',
          accent: (it.score || 0) >= 500,
          ts: (it.time || 0) * 1000 || Date.now(),
          source: 'hn',
          data: it,
        }));
    },
  });
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
  // Explicit wiki names, for the sister projects: commonswiki, wikidatawiki,
  // enwiktionary and so on. Overrides `langs` when given.
  wikis: explicitWikis = null,
  onStatus = null,
} = {}) {
  const wikis = explicitWikis
    ? new Set(explicitWikis)
    : new Set(langs.map((l) => l + (project === 'wikipedia' ? 'wiki' : project)));

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

/**
 * Wikipedia languages for a picker: code, English name, endonym, and a flag.
 *
 * Flags are countries and languages are not, so these are a visual cue and
 * nothing more -- the endonym is the identifier. Ten of the Indic editions
 * necessarily share one flag, which is why every entry also carries its name
 * in its own script: Tamil, Kannada and Gujarati are told apart at a glance by
 * their writing, never by the flag above it. Esperanto belongs to no country
 * at all and takes a globe.
 */
/**
 * Which flag image stands for each edition.
 *
 * Kept separate from the emoji above because emoji flags are unusable in
 * practice: Windows ships no country-flag glyphs at all, so every browser on
 * it draws the two letters instead -- "GB", "FR". An interface built on them
 * is broken for a large share of visitors, which is why the picker uses SVG
 * images and these codes rather than the emoji.
 */
export const WIKIPEDIA_FLAG_CC = {
  en: 'gb', fr: 'fr', de: 'de', es: 'es', it: 'it', pt: 'pt', nl: 'nl',
  sv: 'se', no: 'no', fi: 'fi', et: 'ee', pl: 'pl', ru: 'ru', uk: 'ua',
  be: 'by', bg: 'bg', sr: 'rs', mk: 'mk', ro: 'ro', hu: 'hu', el: 'gr',
  he: 'il', hy: 'am', fa: 'ir', ur: 'pk', ar: 'sa', ja: 'jp', zh: 'cn',
  id: 'id', bn: 'bd', eo: 'eo',
  // Ten editions of Indic languages share one flag, which is why every entry
  // also carries its own script underneath: those are what tell them apart.
  hi: 'in', ta: 'in', te: 'in', ml: 'in', kn: 'in', mr: 'in',
  gu: 'in', pa: 'in', or: 'in', as: 'in', sa: 'in',
};

export const WIKIPEDIA_LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', flag: '🇬🇧' },
  { code: 'fr', name: 'French', native: 'Français', flag: '🇫🇷' },
  { code: 'de', name: 'German', native: 'Deutsch', flag: '🇩🇪' },
  { code: 'es', name: 'Spanish', native: 'Español', flag: '🇪🇸' },
  { code: 'it', name: 'Italian', native: 'Italiano', flag: '🇮🇹' },
  { code: 'pt', name: 'Portuguese', native: 'Português', flag: '🇵🇹' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands', flag: '🇳🇱' },
  { code: 'sv', name: 'Swedish', native: 'Svenska', flag: '🇸🇪' },
  { code: 'no', name: 'Norwegian', native: 'Norsk', flag: '🇳🇴' },
  { code: 'fi', name: 'Finnish', native: 'Suomi', flag: '🇫🇮' },
  { code: 'et', name: 'Estonian', native: 'Eesti', flag: '🇪🇪' },
  { code: 'pl', name: 'Polish', native: 'Polski', flag: '🇵🇱' },
  { code: 'ru', name: 'Russian', native: 'Русский', flag: '🇷🇺' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська', flag: '🇺🇦' },
  { code: 'be', name: 'Belarusian', native: 'Беларуская', flag: '🇧🇾' },
  { code: 'bg', name: 'Bulgarian', native: 'Български', flag: '🇧🇬' },
  { code: 'sr', name: 'Serbian', native: 'Српски', flag: '🇷🇸' },
  { code: 'mk', name: 'Macedonian', native: 'Македонски', flag: '🇲🇰' },
  { code: 'ro', name: 'Romanian', native: 'Română', flag: '🇷🇴' },
  { code: 'hu', name: 'Hungarian', native: 'Magyar', flag: '🇭🇺' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά', flag: '🇬🇷' },
  { code: 'he', name: 'Hebrew', native: 'עברית', flag: '🇮🇱' },
  { code: 'hy', name: 'Armenian', native: 'Հայերեն', flag: '🇦🇲' },
  { code: 'fa', name: 'Persian', native: 'فارسی', flag: '🇮🇷' },
  { code: 'ur', name: 'Urdu', native: 'اردو', flag: '🇵🇰' },
  { code: 'ar', name: 'Arabic', native: 'العربية', flag: '🇸🇦' },
  { code: 'ja', name: 'Japanese', native: '日本語', flag: '🇯🇵' },
  { code: 'zh', name: 'Chinese', native: '中文', flag: '🇨🇳' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', flag: '🇮🇳' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', flag: '🇧🇩' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்', flag: '🇮🇳' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు', flag: '🇮🇳' },
  { code: 'ml', name: 'Malayalam', native: 'മലയാളം', flag: '🇮🇳' },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ', flag: '🇮🇳' },
  { code: 'mr', name: 'Marathi', native: 'मराठी', flag: '🇮🇳' },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી', flag: '🇮🇳' },
  { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ', flag: '🇮🇳' },
  { code: 'or', name: 'Odia', native: 'ଓଡ଼ିଆ', flag: '🇮🇳' },
  { code: 'as', name: 'Assamese', native: 'অসমীয়া', flag: '🇮🇳' },
  { code: 'sa', name: 'Sanskrit', native: 'संस्कृतम्', flag: '🇮🇳' },
  { code: 'eo', name: 'Esperanto', native: 'Esperanto', flag: '🌍' },
];
