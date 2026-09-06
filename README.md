<p align="center">
  <img src=".github/social-preview.png" width="100%" alt="Tintinnabulum — turn any stream of events into sound">
</p>

# Tintinnabulum

**Hear your data.**

Something happens. You hear a note.

Big things sound low. Small things sound high. Things that grow ring. Things
that shrink are plucked.

That is the whole idea.

**[Open the sandbox →](https://guillain-rdcde.github.io/tintinnabulum/)**
Nothing to install. It runs in a browser, and on a phone.

> *tintinnabulum* — Latin, a small bell.

---

## Try it

Press **Start**. That is the only step.

You are listening to Wikipedia. Every circle is somebody editing an article,
somewhere, at that moment.

- A bell means text was added. A plucked string means it was removed.
- A low note is a large edit. A high note is a small one.
- Click a circle to open the article.

Leave it in a background tab and get on with something else.

Eleven other feeds sit in the same list: Bitcoin, Coinbase, earthquakes,
Bluesky, GitHub, severe weather, Hacker News. To send your own, see
[Sending your own data](#sending-your-own-data). It is one `curl` command.

Everything lives on one page, in five sections you can fold away. Each says what
it is set to. Each keeps the rest behind **Advanced**. No setting exists twice.

For what happens between the feed and the speaker, read
**[How it works](docs/HOW-IT-WORKS.md)**.

### Worth trying

| | |
|---|---|
| **Sound → Water** | The same events as drops in a cavity. Eleven of the twelve kits are pure synthesis: no audio files at all. |
| **Sound → Gongs** | Pair it with Earthquakes. Long, slow, inharmonic. |
| **Sound → Scale → pentatonic** | Notes snap to five. It stops sounding arbitrary and starts sounding composed. |
| **Sound → Restraint** | Space between notes. On a fast feed, only the most significant event in each gap sounds, and the rest are passed over. |
| **Coinbase** | Buys ring, sells pluck. The one feed where direction means something on its own. |
| **Several Wikipedias at once** | Pick them from the flag grid. Four together are denser than one, and more musical. |
| **Look** | Seventeen visualisations and seventeen palettes. Marks already on screen recolour at once. |
| **Record** | Captures what you are hearing to an audio file. |
| **Untick "Large events sound low"** | Inverts the mapping. Large edits turn shrill. Worse, and instructive. |

---

## Reference

A sonification engine with no dependencies.

Anything that reduces to **(magnitude, polarity, identity)** can be heard and
seen. Latencies. Commits. Build results. Queue depths. Sensor readings.

No build step. No bundler. No `npm install`. ES modules and `node:http`.

### The event contract

`magnitude` is the only required field.

| Field | Type | Meaning |
|---|---|---|
| `magnitude` | number | Size of the event. Drives pitch and radius. A negative value implies `polarity: -1`. |
| `polarity` | `1` / `-1` / `0` | Instrument choice: bell, pluck, neutral. |
| `id` | string | Stable identity. Seeds the on-screen position, so the same id always lands in the same place — an article edited twice pulses in one spot. |
| `category` | string | Colour and instrument override (`user`, `anon`, `bot`, `alert`, or your own). |
| `accent` | boolean | Rare, notable event: plays the swell, shows a banner, bypasses voice stealing. |
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

son.use(new CanvasSink('#canvas', { palette: 'bronze' }));
await son.unlock();                   // must be called from a click handler
son.connect(wikipedia({ langs: ['en', 'fr'] }));

son.emit({ magnitude: 512, id: 'anything', category: 'alert' });
```

### Musical rules

Five controls decide how a stream of numbers becomes music.

| Control | Effect |
|---|---|
| **Scale** | Nineteen of them: modes, pentatonics, blues, whole-tone, octatonic, the Japanese *hirajoshi*, *in-sen* and *kumoi*, and bare fourths, fifths and octaves. Pitches snap to the set, so nothing lands outside it. |
| **Key** | Transposes the whole thing. |
| **Humanise** | Up to ±2 semitones of wobble. Repeated values stop sounding mechanical. |
| **Tempo** | Events arrive whenever the world produces them, which is arrhythmic by definition. A tempo holds each note until the next quarter, eighth or sixteenth. The same data turns metrical. |
| **Restraint** | Space between notes. See below. |

```js
son.mapper.setScale('hirajoshi');
son.mapper.root = 5;          // transpose to F
son.mapper.jitter = 0.8;      // semitones of humanising
son.audio.setTempo(96, 8);    // eighth notes at 96bpm; 0 for free time
son.audio.setRestraint(700);  // ms between notes; 0 sounds everything
```

Quantising costs a little synchronisation. A note waits at most one
subdivision, so at a slow tempo the picture leads the sound.

### Restraint

Wikipedia produces a couple of edits a second. Each note is a bell with a
two-second decay, and the silence between them is filled by resonance. That is
most of why it is pleasant to listen to.

Point the same engine at a feed running thirty a second and there is no silence
left. Every note is masked by the next. The result is a texture, not a rhythm.

A rate cap does not fix this. The voice pool has one, and it spends its token
on whichever event happens to arrive while a token is free — so what comes out
is an arbitrary sample of the stream at a constant rate. Which is what
undifferentiated noise sounds like.

`setRestraint(ms)` chooses instead of thinning. Events arriving inside a gap are
held. When the gap elapses, the most significant of them sounds and the rest are
passed over. Accents outrank significance, because the point of marking an event
notable is that a burst of ordinary ones must not bury it.

The peaks survive. The filler does not. The rhythm becomes the shape of the
data rather than the shape of the network.

It costs latency: a note can wait one gap. The visuals are not held back, so at
a long gap the picture leads the sound.

### Pitch that calibrates itself

Most sonification code carries a constant tuned to one dataset, which makes it
useless for any other. The default `adaptive` mapping instead ranks each
magnitude against a rolling window of the last 500, so an unfamiliar source
finds its own range within about sixteen events.

The test suite pins down the difference. Given latencies clustered between 40
and 60 ms, a fixed logarithmic curve tuned for Wikipedia's byte counts collapses
into **one semitone**, while the adaptive mapping still spans the full **27**.
Use `log` or `linear` with an explicit `domain` when the range is known in
advance.

### Voice allocation

Under load, a note may steal the weakest sounding voice rather than being
dropped in arrival order, so a burst of small events never masks the one large
event inside it. `maxPerSecond` adds a token-bucket ceiling on top.

### Sources

Eight live feeds are built in. All public, all keyless, all reachable over TLS
from a static page.

| Feed | What you hear | Rate |
|---|---|---|
| `wikipedia({langs})` | Edits across 42 Wikipedia editions, pitched by bytes changed | busy |
| `bitcoin()` | Unconfirmed transactions, pitched by value. **The feed the idea began with:** Listen to Wikipedia was built after BitListen, which sonified exactly this | steady |
| `coinbase({product})` | Trades as they execute — **buys ring, sells pluck**, the one feed that supplies a meaningful polarity of its own | busy |
| `earthquakes()` | USGS seismic events. The only feed where *magnitude* is already the field's own word | a handful an hour |
| `bluesky()` | The public post firehose, pitched by post length | very busy |
| `github()` | Pushes, pull requests, releases and stars across GitHub | polled once a minute |
| `noaaAlerts()` | Active US severe-weather alerts, pitched by severity. Each carries the moment it was issued, so the replay keeps the shape of the day | a few hundred standing |
| `hackerNews()` | Front-page stories, pitched by score and comments. A new story always scores one, so the front page is used instead: it spans three orders of magnitude | slow |

Bluesky labels carry the size of a post rather than its text: an unfiltered
firehose is not something to put on someone's screen unasked. The full record
stays in `event.data`.

And the generic adapters:

| Factory | Use |
|---|---|
| `wikipedia({langs, backend})` | `'eventstreams'` (Wikimedia's own HTTPS SSE) or `'wikimon'` (adds `geo_ip`, `hashtags`, `mentions`) |
| `sseSource({url, map})` | Any Server-Sent Events feed |
| `websocketSource({url, map})` | Any WebSocket, with exponential-backoff reconnect |
| `pollSource({url, interval, map})` | Any JSON endpoint, with de-duplication by id |
| `ingestSource({url})` | The bundled ingest server |
| `manualSource()` | Push events in by hand |
| `randomSource({rate})` | Synthetic traffic, for tuning without a network |

A source is any object with `{ name, start(emit), stop() }`, so writing your own
takes a dozen lines.

### Sending your own data

Run the ingest server, which also serves the page:

```bash
node server/ingest.mjs           # http://localhost:8080/demo/
```

```
POST /emit          {"magnitude": 1200, "id": "build-42"}     — or an array
GET  /emit?magnitude=42&id=quick-test                          — convenient from curl
GET  /events[?replay=20]                                       — SSE fan-out
GET  /stats
```

Query parameters name the target fields. A value beginning with `$.` is a path
into the posted body; anything else is a literal. That single rule is what
allows arbitrary JSON to be piped in without writing an adapter:

```bash
# request latency, straight from your own logs
curl -X POST "localhost:8080/emit?magnitude=\$.duration_ms&id=\$.route&category=\$.level" \
     -H 'Content-Type: application/json' \
     -d '{"route":"/api/users","duration_ms":312,"level":"warn"}'

# a repository's history: one note per commit, pitched by lines changed
git log --format='%H' -n 200 | while read sha; do
  n=$(git show --numstat --format= "$sha" | awk '{s+=$1+$2} END {print s+0}')
  curl -s -o /dev/null "localhost:8080/emit?magnitude=$n&id=$sha"
done
```

Fan-out uses Server-Sent Events rather than WebSocket: the browser only ever
consumes this stream, `EventSource` reconnects on its own, and SSE requires
nothing beyond `node:http`.

### Instruments

Implement `load(ctx)` and `play(ctx, dest, {semitone, velocity})` and you have a
new instrument.

Twelve kits ship, selectable at runtime.

| Kit | Sound |
|---|---|
| **Bells** | The recorded celesta and clavichord — the original sound |
| **Synth bell** | An FM bell and a plucked string, generated |
| **Water** | Drops in a cavity; the rising pitch is what makes it read as water |
| **Music box** | Plucked metal tines, bright and short |
| **Marimba** | Tuned wooden bars, the least tiring over a long session |
| **Gongs** | Large, slow, deliberately inharmonic. Best with a sparse feed |
| **Glass** | Long and ringing; turns a busy feed into a wash |
| **Wind chimes** | Tubes rather than bars, with a long tail |
| **Steel pan** | Nearly harmonic partials, so it sings where a gong clangs |
| **Plucked strings** | Harp above, deep pizzicato below. The warmest of the set |
| **Dawn chorus** | Birdsong, built from swept whistles rather than recordings |
| **Night** | Crickets and low wind. The quietest thing here |

Only the first uses audio files. **The other eleven are pure synthesis: nothing
to download, nothing to license, and they work offline.**

- `SampleInstrument` plays recorded banks, resampled through `playbackRate`, so
  pitch is continuous rather than limited to the number of recorded notes.
- `SynthInstrument` needs no audio files. FM and subtractive engines, with a
  `sweep` parameter that bends the pitch during the attack — that bend is the
  entire difference between a water drop and a beep.

```js
son.setKit('water');            // or any name in KITS
```

`hatnoteKit()`, `synthKit()` and `makeKit(name)` return `{add, sub, accent}`
sets and are interchangeable at runtime; nothing is swapped in until it can
actually play. Sample banks resolve relative to the library itself, so the
project runs from any mount point.

### Palettes

Seventeen, selectable at runtime and stored as plain data in
[`src/visual/palettes.js`](src/visual/palettes.js):

| | | |
|---|---|---|
| **Marine** — deep water, the default | **Blueprint** — technical, calmest | **Nocturne** — slate blue, the original |
| **Bronze** — brass and copper | **Aurora** — mint and violet | **Ember** — banked fire |
| **Ultraviolet** — magenta and cyan | **Sakura** — blossom on plum | **Nordic** — ice and steel |
| **Lacquer** — vermilion and gold on black | **Solar** — daylight on deep navy | **Sunset** — coral, teal and gold |
| **Neon** — arcade colours on black | **Rust** — weathered iron and sand | **Daylight** — ink on paper |
| **Papyrus** — a warmer light option | **Monochrome** — lightness only | |

```js
new CanvasSink('#canvas', { palette: 'bronze' });
sink.setPalette('aurora');                    // circles already drawn recolour
sink.setPalette({ anon: '#00ffcc' });         // or override individual roles
```

Adding one means adding an entry to that file. The test suite holds them to
measured standards rather than taste: label text must clear WCAG AA (4.5:1)
against its background, circles must remain visible at their 50 % fill opacity,
and the categories must be perceptually distinct — **CIELAB ΔE ≥ 22**, not
luminance contrast, because two colours can differ obviously to the eye while
sharing a luminance band. *Monochrome* is the deliberate exception, held to a
lightness floor instead, since its purpose is to remain readable without colour
vision.

### Colour variety

A palette names one colour per category. For a long time that meant a screen
carried four.

That is not what made it look flat. The commonest category in a live feed is
`user`, and in fifteen of the seventeen palettes `user` was a near-white. Most
of a running screen was white, whichever palette you chose. Every palette now
gives that category a real hue.

On top of that, each event takes its own shade of its category's colour.

```js
new CanvasSink('#canvas', { richness: 0.45, depth: true });
sink.setRichness(0);   // one exact colour per category
sink.setRichness(1);   // shades spread far enough to drift in hue
```

The variation is computed in OKLab, not HSL. Darken a teal in HSL and it slides
towards green, so one category would read as several
([`src/visual/color.js`](src/visual/color.js)). Colours that fall outside the
gamut lose chroma rather than being clipped channel by channel, which is what
turns a dark ink into pure red.

Lightness varies first, hue last. Depth in a dense field comes from value.
Spreading hue early is how a visualisation turns into confetti.

`richness: 0` is an exact identity. It is the honest setting whenever colour is
meant to *identify* a category rather than decorate it.

`depth` adds a shallow gradient and an outline. The outline is the part that
matters: a pile of translucent marks with no edges averages into one pale wash.

### Keeping a burst from taking the machine

Feeds are not polite. Bluesky runs to a couple of thousand posts a minute, and
a backlogged poll can deliver a day at once. A surge has to cost frames, never
the tab.

```js
new CanvasSink('#canvas', { maxParticles: 800 });
sink.setMaxParticles(3000);   // longer history, more work per frame
sink.setMaxParticles(300);    // for a machine that is struggling
```

One number bounds everything that accumulates.

That was not always true. The marks were capped, but each scene also kept
collections of its own — falling drops, flow-field trails, spiral seeds,
skyline bars — behind private hard-coded limits. Raising the ceiling governed
the marks and nothing else. They now size against a shared budget
([`src/visual/scenes/budget.js`](src/visual/scenes/budget.js)), by a factor per
scene: a trail costs sixty line segments, a spiral seed costs one disc.

Two collections had no ceiling at all, and neither depended on how many marks
were on screen.

- The banner queue was drawn newest-first and stopped at the first one still
  alive. On any feed with a steady trickle of accent events that one was always
  fresh, so the loop broke immediately and every stale banner behind it was
  never examined again. Expiry and drawing are now separate passes.
- The list of event timestamps behind the rate counter was trimmed inside the
  counter's own draw call, so switching the counter off left it growing by one
  entry per event for as long as the page stayed open.

The test suite floods the renderer with thousands of events per scene and
asserts that nothing exceeds its budget.

### Visualisations

A scene decides what a moment of data looks like. Seventeen ship — the four
below join Bloom, Constellation, Flow field, Ripples, Grid, Truchet, Orbits,
Rain, Radar, Spiral, Tree rings, Terrain and Skyline:

| Scene | What it draws |
|---|---|
| **Pile** | Events fall, bounce and settle into a heap, so sheer volume becomes visible |
| **Threads** | Level threads pushed aside by each event, weaving a fabric |
| **Lissajous** | Each event draws a figure whose two frequencies come from its size |
| **Nebula** | Soft glows added on top of one another, so busy moments burn bright |

The full set:

| Scene | What it draws |
|---|---|
| **Bloom** | The original: each event opens once and fades, with a shockwave in its own shape |
| **Constellation** | Events become stars and join to their neighbours; bursts draw themselves as clusters |
| **Flow field** | Each event releases a mote into a slowly turning noise field, and it draws where it drifts |
| **Ripples** | Concentric wavefronts that cross and interfere |
| **Grid** | An ordered grid that each event knocks out of true, settling back — after Vera Molnár |
| **Truchet** | Quarter-arc tiles that flip as events land, so unbroken curves wander the field |
| **Orbits** | Each event is captured into an orbit; small ones fast and close, large ones slow and wide |
| **Rain** | Events fall, gather speed and break on a surface. The partner to the Water kit |
| **Radar** | A sweep that lights each event as it passes, so the field is read once a turn |
| **Spiral** | Events laid on a golden-angle spiral in arrival order, so the sequence becomes the form |
| **Tree rings** | A clock face: arrival sets the angle, size the distance out |
| **Terrain** | A ridgeline pushed up by each event and scrolling away, leaving a profile of what happened |
| **Skyline** | A scrolling record: one bar per event, height by size |

**Adding one is adding an object** to
one of the families in [`src/visual/scenes/`](src/visual/scenes), or registering it from
outside:

```js
import { registerScene } from './src/index.js';

registerScene('rain', {
  label: 'Rain',
  positional: false,             // marks are not at their event's position
  init(api)      { api.scene.drops = []; },
  event(p, api)  { api.scene.drops.push({ x: p.x, y: 0, v: p.r }); },
  frame(ctx, api) { /* draw with the Canvas 2D context */ },
});
```

`api` carries `{ w, h, palette, particles, shape, now, dt, scene }`. Every
scene reads the same particle model, so lifetimes, hit-testing and the event
contract stay in one place.

**On p5.js:** it is a friendly wrapper over the Canvas 2D API this already
uses, so importing it would cost about a megabyte and the offline guarantee
while buying no capability. What was missing was not a library but this
extension point.

### Shapes

Used by the **Bloom** scene, which draws one mark per event. Eight marks are
available, plus `mixed`,
which assigns one per event from its identity — so a given article keeps the
same shape as well as the same place on screen.

| | | | |
|---|---|---|---|
| **Circle** — area tracks size directly | **Star** — five points | **Sparkle** — four-point twinkle | **Diamond** |
| **Hexagon** | **Burst** — eight thin rays | **Ring** — hollow, stays readable when crowded | **Petal** — six rounded lobes |

```js
new CanvasSink('#canvas', { shape: 'star', starfield: true });
sink.setShape('mixed');
sink.setStarfield(true);
```

The shockwave that expands from each event takes the shape of the mark that
produced it. `starfield` adds a fixed, slowly breathing field of stars behind
everything, drawn from a stable seed so it never crawls.

Shapes are pure geometry in [`src/visual/shapes.js`](src/visual/shapes.js): a
`draw(ctx, x, y, r, rot)` that builds a path, nothing more. The swatches in the
sandbox are drawn with the same function as the canvas, so a preview can never
drift from what you actually get.

### Tests

```bash
npm test              # core logic and the ingest server
npm run test:browser  # headless Chromium, if playwright-core is installed
```

The browser suite verifies audio by rendering instruments through an
`OfflineAudioContext` and measuring peak amplitude, so a silent instrument
fails rather than passing quietly.

### Layout

Everything public is re-exported from [`src/index.js`](src/index.js), so the
files below can be split or renamed without breaking a caller.

```
src/core/               event contract, adaptive mapper, voice allocator, Sonifier facade
src/audio/
  engine.js             AudioContext, unlock, the iOS synchronous resume
  instrument.js         the note-playing contract
  sample-instrument.js  sampled banks, resampled by playback rate
  synth-instrument.js   FM and subtractive engines, vibrato, pitch bend
  presets.js            timbres as data
  kits.js               named kits, and makeKit for your own
  instruments.js        the barrel the rest of the library imports
  audio-sink.js         routing events to voices
  recorder-sink.js      offline rendering to WAV
src/visual/
  canvas-sink.js        the canvas loop
  scenes/               marks, fields, structures, physical, budget -- one file per family
  palettes.js           colour schemes
  color.js              OKLab shading, gamut fitting, per-event variation
  shapes.js             mark geometry
  kit-art.js            the drawn signature on each kit card
src/sources/
  transports.js         WebSocket, SSE, poll, manual, random, ingest
  feeds.js              Bitcoin, Coinbase, earthquakes, Bluesky, GitHub, NOAA, HN
  wikimedia.js          Wikipedia and its editions
server/                 zero-dependency ingest and static server
sounds/                 sampled celesta, clavichord and string swells
tools/
  render.mjs            drive the real visualiser headless, out to PNG
  make-social-preview.mjs  regenerate the card in .github/, from the engine
demo/
  demo.js               the sandbox page
  dom.js                picker, canvas sizing and caption helpers
  store.js              guarded local storage
  feed-catalog.js       what the sandbox can listen to, as data
test/                   core, server and browser checks
```

---

<sub>The idea — a bell for growth, a plucked string for shrinkage, pitch inversely proportional to the size of the change — comes from <a href="https://github.com/hatnote/listen-to-wikipedia">Listen to Wikipedia</a> by Stephen LaPorte and Mahmoud Hashemi, and through it from <a href="https://www.bitlisten.com/">BitListen</a> by Maximillian Laumeister. The sample banks in <code>sounds/</code> are redistributed from that project under its BSD 3-Clause licence. Tintinnabulum is an independent implementation, not a fork, and is not endorsed by any of the above — see <a href="NOTICE">NOTICE</a>, and use <code>kit: 'synth'</code> to ship no third-party audio at all. BSD 3-Clause, see <a href="LICENSE">LICENSE</a>.</sub>
