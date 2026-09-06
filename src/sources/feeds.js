// Live feeds from the wider world.
//
// Every one is public, keyless and reachable over TLS from a static page.
// WebSocket feeds are exempt from CORS; the polled ones were checked to send
// `Access-Control-Allow-Origin: *`.

import { websocketSource, pollSource } from './transports.js';


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
