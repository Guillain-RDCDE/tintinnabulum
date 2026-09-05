# Tintinnabulum

*tintinnabulum, -i, n.* — a small bell.

A sonification engine: anything reducible to **(magnitude, polarity, identity)**
can be heard and seen. Server latencies, git commits, CI builds, sensor
readings, queue depths, Wikipedia edits.

No build step, no dependencies, no `npm install`. ES modules and `node:http`.

## Quick start

```sh
git clone https://github.com/Guillain-RDCDE/tintinnabulum.git
cd tintinnabulum
node server/ingest.mjs
```

Open <http://localhost:8080/demo/>, click to enable sound, press **Connect**.
Then from any other terminal:

```sh
curl "http://localhost:8080/emit?magnitude=4200&id=hello"
```

Choose the **Ingest server** feed in the demo and you will hear it.

## The event contract

`magnitude` is the only required field.

| Field | Type | Meaning |
|---|---|---|
| `magnitude` | number | Size of the event. Drives pitch and radius. A negative value implies `polarity: -1`. |
| `polarity` | `1` / `-1` / `0` | Instrument choice: bell, pluck, neutral. |
| `id` | string | Stable identity. **Seeds the on-screen position**, so the same id always lands in the same spot. |
| `category` | string | Colour and instrument override (`user`, `anon`, `bot`, `alert`, or your own). |
| `accent` | boolean | Rare notable event: plays the swell, shows a banner, bypasses voice stealing. |
| `label` / `url` | string | Shown on hover; clicking the circle opens the url. |
| `ts` | number | Epoch ms, defaults to now. |
| `data` | any | Your original payload, passed through untouched. |

## Library use

```js
import { Sonifier, CanvasSink, wikipedia } from './src/index.js';

const son = new Sonifier({
  kit: 'synth',                       // or 'hatnote' for the sampled bells
  mapping: { mode: 'adaptive', scale: 'pentatonic', range: 27 },
  voices: { maxVoices: 16, maxPerSecond: 25 },
});

son.use(new CanvasSink('#canvas'));
await son.unlock();                   // must be called from a click handler
son.connect(wikipedia({ langs: ['en', 'fr'] }));

son.emit({ magnitude: 512, id: 'anything', category: 'alert' });
```

### Pitch that calibrates itself

Most sonification code carries a constant tuned to one dataset, which makes it
useless for any other. The default `adaptive` mapping instead ranks each
magnitude against a rolling window of the last 500, so an unknown source finds
its own range within seconds — plug in latencies in the tens, or byte counts in
the hundreds of thousands, and both use the full pitch range. Use `log` or
`linear` with an explicit `domain` when you already know the scale.

### Voice allocation

Under load, a note may **steal the weakest sounding voice** rather than being
dropped in arrival order, so a burst of small events never masks the one big
event inside it. `maxPerSecond` adds a token-bucket ceiling on top.

## Sources

| Factory | Use |
|---|---|
| `wikipedia({langs, backend})` | `'eventstreams'` (Wikimedia's own HTTPS SSE) or `'wikimon'` (adds `geo_ip`, `hashtags`, `mentions`) |
| `sseSource({url, map})` | Any Server-Sent Events feed |
| `websocketSource({url, map})` | Any WebSocket, with exponential-backoff reconnect |
| `pollSource({url, interval, map})` | Any JSON endpoint, with id de-duplication |
| `ingestSource({url})` | The bundled ingest server |
| `manualSource()` | Push events in by hand |
| `randomSource({rate})` | Synthetic traffic, for tuning without a network |

A source is any object with `{ name, start(emit), stop() }` — writing your own
takes a dozen lines.

## Ingest server

```
POST /emit          {"magnitude": 1200, "id": "build-42"}     — or an array
GET  /emit?magnitude=42&id=quick-test                          — curl-friendly
GET  /events[?replay=20]                                       — SSE fan-out
GET  /stats
```

### Mapping arbitrary JSON

Query parameters name the fields. A value starting with `$.` is a path into the
posted body; anything else is a literal. That single rule is what lets any JSON
be piped in without writing an adapter:

```sh
# sonify request latency straight from your own logs
curl -X POST "localhost:8080/emit?magnitude=\$.duration_ms&id=\$.route&category=\$.level" \
     -H 'Content-Type: application/json' \
     -d '{"route":"/api/users","duration_ms":312,"level":"warn"}'

# sonify a repository: one note per commit, pitched by lines changed
git log --format='%H %s' -n 200 | while read sha msg; do
  n=$(git show --numstat --format= "$sha" | awk '{s+=$1+$2} END {print s+0}')
  curl -s -o /dev/null "localhost:8080/emit?magnitude=$n&id=$sha"
done
```

Fan-out is SSE rather than WebSocket: the browser only ever consumes this
stream, `EventSource` reconnects on its own, and SSE needs nothing beyond
`node:http`.

## Instruments

Implement `load(ctx)` and `play(ctx, dest, {semitone, velocity})` and you have a
new instrument.

- `SampleInstrument` — plays sampled banks resampled through `playbackRate`, so
  pitch is **continuous** rather than limited to the number of recorded notes.
- `SynthInstrument` — FM and subtractive presets (`bell`, `glass`, `clang`,
  `pluck`, `woody`, `blip`, `pad`). No audio files at all.

`hatnoteKit()` and `synthKit()` return ready-made `{add, sub, accent}` sets and
are interchangeable at runtime.

## Visuals

`CanvasSink` draws expanding circles, shockwave rings, outlined labels and
click-through links on a Canvas 2D surface, at rates that make one DOM node per
event painful. It is optional — the audio core never imports it.

## Recording

```js
const rec = new Recorder(son.engine);
rec.start();
await rec.save();   // prompts a download
```

## Tests

```sh
npm test
```

47 checks, no browser required: the event contract, the adaptive mapper, scale
quantization, voice stealing, rate limiting, and the ingest server end to end
over a real socket. Audio playback and canvas rendering are not covered — those
need a browser.

## Layout

```
src/core/     event contract, adaptive mapper, voice allocator, Sonifier facade
src/audio/    AudioContext + unlock, instruments, audio sink, recorder
src/visual/   Canvas renderer
src/sources/  Wikipedia, SSE, WebSocket, poll, manual, random
server/       zero-dependency ingest + static server
sounds/       sampled celesta, clavichord and string swells
demo/         a page exercising all of it
test/         core and server checks
```

## Credits

The sonification idea — a bell for growth, a plucked string for shrinkage,
pitch inversely proportional to the size of the change — comes from
[Listen to Wikipedia](https://github.com/hatnote/listen-to-wikipedia) by
Stephen LaPorte and Mahmoud Hashemi, and through it from
[BitListen](https://www.bitlisten.com/) by Maximillian Laumeister. The sample
banks under `sounds/` are redistributed from that project under its BSD
3-Clause licence.

Tintinnabulum is an independent implementation, not a fork, and is not endorsed
by any of the above. See [NOTICE](NOTICE) for the full attribution, and use
`kit: 'synth'` if you would rather ship no third-party audio at all.

BSD 3-Clause. See [LICENSE](LICENSE).
