<p align="center">
  <img src=".github/social-preview.png" width="100%" alt="Tintinnabulum — turn any stream of events into sound">
</p>

# Tintinnabulum

**Turn any stream of events into sound.** Numbers you would normally read in a
dashboard become bells and plucked strings — big things low, small things high —
so you can *hear* what your data is doing while you look at something else.

**[▶ Open the sandbox](https://guillain-rdcde.github.io/tintinnabulum/)** — no install, runs in your browser. · **[How it works](docs/HOW-IT-WORKS.md)** — the whole pipeline explained, beginner to expert. · **[The engine room ↓](#-pro--the-engine-room)**

> *tintinnabulum, -i, n.* — Latin for a small bell. The plural, *tintinnabuli*,
> is the name Arvo Pärt gave to his bell-like compositional style.

---

## 🟢 Beginner — "I just want to hear something"

**[Click here.](https://guillain-rdcde.github.io/tintinnabulum/)** Then click once
anywhere on the page to allow sound, and press **Connect**.

You are now listening to Wikipedia. Every circle is somebody editing an article,
somewhere in the world, right now.

- 🔔 **A bell** — someone added text
- 🎸 **A plucked string** — someone deleted text
- **Low note** = a big edit · **high note** = a small one
- 🟢 **Green circle** = an anonymous editor · 🟣 **purple** = a bot · ⚪ **white** = a logged-in person
- Click any circle to open the article that made the sound

That's it. Leave it running in a background tab — it is quite pleasant.

**Curious what's actually happening?** [**How it works**](docs/HOW-IT-WORKS.md)
follows a single Wikipedia edit from the live feed to the note in your speakers,
in plain English first and full detail afterwards.

**Want to hear something other than Wikipedia?** In the **Source** box, pick
*Synthetic traffic* for a steady stream of made-up events. To hear your *own*
data, see [Feed it your own data](#feed-it-your-own-data) below — it is one
`curl` command.

### Things worth trying

| Try this | What happens |
|---|---|
| **Instruments → Synthesis** | The same events played by a synthesiser instead of recorded bells. No audio files involved at all. |
| **Mapping → Scale → pentatonic** | Notes snap to a five-note scale. Suddenly it sounds composed rather than random. |
| **Languages → `en,fr,de,ja`** | Four Wikipedias at once. Busier, denser, more musical. |
| **Instruments → ● Record** | Records what you are hearing to an audio file you can keep. |
| **Untick "Big event = low note"** | Inverts the whole thing. Big edits become shrill. Worse! But instructive. |

---

## 🔵 Pro — the engine room

A dependency-free sonification engine. Anything reducible to
**(magnitude, polarity, identity)** can be heard and seen: request latencies,
git commits, CI builds, queue depths, sensor readings, Wikipedia edits.

No build step, no bundler, no `npm install`. ES modules and `node:http`.

### The event contract

`magnitude` is the only required field.

| Field | Type | Meaning |
|---|---|---|
| `magnitude` | number | Size of the event. Drives pitch and radius. A negative value implies `polarity: -1`. |
| `polarity` | `1` / `-1` / `0` | Instrument choice: bell, pluck, neutral. |
| `id` | string | Stable identity. **Seeds the on-screen position**, so the same id always lands in the same spot — an article edited twice pulses in one place. |
| `category` | string | Colour and instrument override (`user`, `anon`, `bot`, `alert`, or your own). |
| `accent` | boolean | Rare notable event: plays the swell, shows a banner, bypasses voice stealing. |
| `label` / `url` | string | Shown on hover; clicking the circle opens the url. |
| `ts` | number | Epoch ms, defaults to now. |
| `data` | any | Your original payload, passed through untouched. |

### Library use

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
its own range within seconds.

The test suite demonstrates the difference: on latencies clustered between 40
and 60 ms, a fixed logarithmic curve tuned for Wikipedia's byte counts collapses
into **1 semitone**, while the adaptive mapping still spans the full **27**. Use
`log` or `linear` with an explicit `domain` when you already know the scale.

### Voice allocation

Under load, a note may **steal the weakest sounding voice** rather than being
dropped in arrival order, so a burst of small events never masks the one big
event inside it. `maxPerSecond` adds a token-bucket ceiling on top.

### Sources

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

### Feed it your own data

Run the ingest server, which also serves the page:

```bash
node server/ingest.mjs           # http://localhost:8080/demo/
```

```
POST /emit          {"magnitude": 1200, "id": "build-42"}     — or an array
GET  /emit?magnitude=42&id=quick-test                          — curl-friendly
GET  /events[?replay=20]                                       — SSE fan-out
GET  /stats
```

Query parameters name the fields. A value starting with `$.` is a path into the
posted body; anything else is a literal. That single rule is what lets any JSON
be piped in without writing an adapter:

```bash
# sonify request latency straight from your own logs
curl -X POST "localhost:8080/emit?magnitude=\$.duration_ms&id=\$.route&category=\$.level" \
     -H 'Content-Type: application/json' \
     -d '{"route":"/api/users","duration_ms":312,"level":"warn"}'

# sonify a repository: one note per commit, pitched by lines changed
git log --format='%H' -n 200 | while read sha; do
  n=$(git show --numstat --format= "$sha" | awk '{s+=$1+$2} END {print s+0}')
  curl -s -o /dev/null "localhost:8080/emit?magnitude=$n&id=$sha"
done
```

Fan-out is SSE rather than WebSocket: the browser only ever consumes this
stream, `EventSource` reconnects on its own, and SSE needs nothing beyond
`node:http`.

### Instruments

Implement `load(ctx)` and `play(ctx, dest, {semitone, velocity})` and you have a
new instrument.

- `SampleInstrument` — plays sampled banks resampled through `playbackRate`, so
  pitch is **continuous** rather than limited to the number of recorded notes.
- `SynthInstrument` — FM and subtractive presets (`bell`, `glass`, `clang`,
  `pluck`, `woody`, `blip`, `pad`). No audio files at all.

`hatnoteKit()` and `synthKit()` return ready-made `{add, sub, accent}` sets and
are interchangeable at runtime. The sample banks are resolved relative to the
library itself, so the project runs from any mount point.

### Tests

```bash
npm test
```

Core logic and the ingest server end to end over a real socket. The browser half
— sample decoding, audio scheduling, canvas rendering — is covered separately by
a headless Chromium run in [`test/browser.test.mjs`](test/browser.test.mjs).

### Layout

```
src/core/     event contract, adaptive mapper, voice allocator, Sonifier facade
src/audio/    AudioContext + unlock, instruments, audio sink, recorder
src/visual/   Canvas renderer
src/sources/  Wikipedia, SSE, WebSocket, poll, manual, random
server/       zero-dependency ingest + static server
sounds/       sampled celesta, clavichord and string swells
demo/         the sandbox page
test/         core, server and browser checks
```

---

<sub>The idea — a bell for growth, a plucked string for shrinkage, pitch inversely proportional to the size of the change — comes from <a href="https://github.com/hatnote/listen-to-wikipedia">Listen to Wikipedia</a> by Stephen LaPorte and Mahmoud Hashemi, and through it from <a href="https://www.bitlisten.com/">BitListen</a> by Maximillian Laumeister. The sample banks in <code>sounds/</code> are redistributed from that project under its BSD 3-Clause licence. Tintinnabulum is an independent implementation, not a fork, and is not endorsed by any of the above — see <a href="NOTICE">NOTICE</a>, and use <code>kit: 'synth'</code> to ship no third-party audio at all. BSD 3-Clause, see <a href="LICENSE">LICENSE</a>.</sub>
