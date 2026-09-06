// What the sandbox can listen to, and how each one is described.
//
// Configuration rather than logic: the entries say what a feed is called, what
// it sounds like and how to build it. The four things a feed might need from
// the page -- the chosen editions, the Wikipedia backend, the ingest URL and
// somewhere to report connection state -- are passed in, so this table has no
// opinion about the DOM and can be read on its own.

import {
  wikipedia,
  bitcoin,
  coinbase,
  earthquakes,
  bluesky,
  github,
  noaaAlerts,
  hackerNews,
  ingestSource,
  randomSource,
} from '../src/index.js';

/**
 * @param {object} io
 * @param {() => string[]} io.getLangs       Wikipedia editions currently chosen
 * @param {() => string}   io.getBackend     'eventstreams' or 'wikimon'
 * @param {() => string}   io.getIngestUrl   where the ingest stream lives
 * @param {Function}       io.onStatus       connection reporter
 */
export function createFeedCatalog({ getLangs, getBackend, getIngestUrl, onStatus }) {
  return {
    wikipedia: {
      label: 'Wikipedia',
      blurb: 'Live edits worldwide',
      langs: true,
      note: 'Every mark is somebody editing an article right now. A bell means text was added, a plucked string means it was removed.',
      make: () => wikipedia({ langs: getLangs(), backend: getBackend(), onStatus }),
    },
    bitcoin: {
      label: 'Bitcoin',
      blurb: 'Unconfirmed transactions',
      note: 'Each transaction as it enters the network, pitched by its value. This is where the whole idea began: Listen to Wikipedia was built after BitListen, which sonified exactly this.',
      make: () => bitcoin({ onStatus }),
    },
    coinbase: {
      label: 'Coinbase',
      blurb: 'BTC-USD trades',
      note: 'Trades as they execute. Buys ring and sells pluck: this is the one feed that supplies a direction meaning something on its own.',
      make: () => coinbase({ onStatus }),
    },
    earthquakes: {
      label: 'Earthquakes',
      blurb: 'USGS, past day',
      note: 'The only feed where magnitude is already the word the field uses. The day’s events arrive as a trickle, and after that it is genuinely quiet — earthquakes are rare.',
      make: () => earthquakes(),
    },
    bluesky: {
      label: 'Bluesky',
      blurb: 'Public post firehose',
      maxPerSecond: 12,
      note: 'Posts as they are written, pitched by length. Around two thousand a minute, so only the most substantial are given a voice. Labels carry the size rather than the text: an unfiltered firehose is not something to put on your screen unasked.',
      make: () => bluesky({ onStatus }),
    },
    github: {
      label: 'GitHub',
      blurb: 'Public events',
      note: 'Pushes, pull requests, releases and stars across all of GitHub, polled once a minute and spread out so it plays as a stream rather than a clump.',
      make: () => github(),
    },
    weather: {
      label: 'Severe weather',
      blurb: 'US alerts, live',
      note: 'Active alerts from the National Weather Service, pitched by severity. A few hundred stand active at once, and each carries the moment it was issued, so the replay keeps the real shape of the day rather than a metronome.',
      make: () => noaaAlerts(),
    },
    hackernews: {
      label: 'Hacker News',
      blurb: 'Front page, by score',
      note: 'Each story sounds once, when it first reaches the top list, pitched by score and comments. A brand-new story always scores one, so the front page is used instead: it spans three orders of magnitude.',
      make: () => hackerNews(),
    },
    commons: {
      label: 'Wikimedia Commons',
      blurb: 'Media uploads and edits',
      note: 'The shared media library behind every Wikipedia: photographs, maps, scans and audio, edited continuously.',
      make: () => wikipedia({ wikis: ['commonswiki'], mainNamespaceOnly: false, onStatus }),
    },
    wikidata: {
      label: 'Wikidata',
      blurb: 'Structured-data edits',
      note: 'The machine-readable knowledge base underneath the encyclopedias. Busy, and almost entirely the work of bots.',
      make: () => wikipedia({ wikis: ['wikidatawiki'], onStatus }),
    },
    ingest: {
      label: 'Your own data',
      blurb: 'Via the ingest server',
      needsUrl: true,
      note: 'Anything you send to the bundled ingest server. One curl command is a complete data source — see the README.',
      make: () => ingestSource({ url: getIngestUrl(), replay: 10, onStatus }),
    },
    random: {
      label: 'Synthetic',
      blurb: 'Generated traffic',
      note: 'Made-up events at a steady rate. Useful for hearing what a setting does without waiting for the world to produce something.',
      make: () => randomSource({ rate: 5 }),
    },
  };
}
