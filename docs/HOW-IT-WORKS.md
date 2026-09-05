# How Tintinnabulum works

Everything this project does, from the data going in to the sound and the
picture coming out. The first half assumes nothing. The second half assumes you
write code.

- [In plain English](#in-plain-english)
- [The whole pipeline in one picture](#the-whole-pipeline-in-one-picture)
- [Stage by stage](#stage-by-stage)
- [Three worked examples, with real numbers](#three-worked-examples-with-real-numbers)
- [What you get out](#what-you-get-out)
- [Why it is built this way](#why-it-is-built-this-way)

---

## In plain English

### The idea in one paragraph

Computers produce endless streams of numbers: how long a web request took, how
many lines a commit changed, how many bytes someone added to a Wikipedia
article. Normally you read those numbers on a screen. Tintinnabulum plays them
instead. Each number becomes one note. Big numbers become low notes, small
numbers become high notes. Things that grew are played on a bell; things that
shrank are played on a plucked string. At the same time, each event appears as a
circle on a dark canvas — big number, big circle.

The result is that you can *hear* the shape of a stream of data while you look
at something else entirely.

### Why bother turning data into sound?

Your eyes have to be pointed at a thing to see it. Your ears do not. You already
use this every day: you know your car is wrong before you can say why, and you
notice when a room goes quiet. Sound is the sense that works in the background,
and it is very good at two things a dashboard is bad at:

- **Rate.** A dozen notes a second versus one note every few seconds is
  immediately obvious, without reading a single number.
- **The odd one out.** A single low note in a stream of high ones stands out
  even when you are not paying attention.

So it suits anything you want to keep half an eye — half an ear — on for a long
time: a build queue, a server's latency, a live feed of edits.

### One edit, from start to finish

Somebody in Wellington adds 1,247 bytes to the Wikipedia article *Colossal
squid*. Here is everything that happens.

1. **It arrives.** Wikimedia publishes every edit on a public live feed. The
   sandbox is listening to it. The message says: article title, who did it,
   whether it was a robot, and how many bytes the article gained or lost.
2. **It is boiled down.** Tintinnabulum keeps only what it needs to make a
   sound: the **size** (1,247), the **direction** (it grew), and the **name**
   (*Colossal squid*).
3. **A pitch is chosen.** 1,247 bytes is a fairly big edit — bigger than about
   78 % of the edits seen in the last few minutes. Big means low, so it gets a
   fairly low note.
4. **An instrument is chosen.** The article grew, so it is a bell. Had it shrunk,
   it would have been a plucked string.
5. **A place on screen is chosen.** The name *Colossal squid* is turned into a
   position. The same name always gives the same position — so if that article
   is edited five times in a minute, all five circles pulse in the same spot,
   and you can see an edit war happening.
6. **It plays and it draws.** You hear a bell. A circle about 80 pixels across
   fades in at that spot, with a ring expanding out of it, and fades away over
   twelve seconds. Clicking it opens the article.

The whole thing takes a few milliseconds.

### The five words worth knowing

| Word | What it means here |
|---|---|
| **Magnitude** | How big the event was. The only thing the system truly requires. |
| **Polarity** | Whether it grew (+), shrank (−), or neither (0). Chooses the instrument. |
| **Event** | One thing that happened, boiled down to magnitude + polarity + a name. |
| **Source** | Where events come from: Wikipedia, your server logs, anything. |
| **Sink** | Where events go: the speakers, the screen, a recording. |

### It is not only for Wikipedia

Wikipedia is just the demo, because it is a free live feed that never stops.
Anything with a number in it works. If you can send a line of JSON, you can
listen to it:

```bash
curl "http://localhost:8080/emit?magnitude=312&id=/api/users"
```

That is a complete, working data source.

---

## The whole pipeline in one picture

```
  WHAT GOES IN                          WHAT HAPPENS TO IT                       WHAT COMES OUT
  ═══════════                           ══════════════════                       ══════════════

  Wikipedia EventStreams ─┐
  (Wikimedia SSE, HTTPS)  │
                          │
  wikimon WebSocket ──────┤          ┌──────────────┐
  (adds geo-IP, hashtags) │          │  1 NORMALISE │   magnitude is required.
                          ├─ raw ───►│              │   Everything else gets a       ┌──────────────┐
  Any SSE feed ───────────┤  JSON    │  normalize() │   default. Anything without ──►│  rejected    │
                          │          └──────┬───────┘   a finite magnitude is        └──────────────┘
  Any WebSocket ──────────┤                 │           dropped here.
                          │                 ▼
  Any JSON endpoint ──────┤          ┌──────────────┐
  (polled, de-duplicated) │          │  2 MAP       │   Where does this magnitude
                          │          │              │   sit among the last 500?
  Your own code ──────────┤          │  Mapper.map()│   → pitch, loudness, priority
  son.emit({...})         │          └──────┬───────┘
                          │                 │
  HTTP POST /emit ────────┘                 ▼
  (the ingest server;                 ┌──────────────┐
   any JSON, mapped                   │  3 FILTER    │   Fails a filter? It is still
   with $. paths)                     │              │   DRAWN, but DIMMED and        ┌──────────────┐
                                      │  predicates  │   SILENT. Not discarded. ─────►│ drawn, muted │
                                      └──────┬───────┘                                └──────────────┘
                                             │
                                             ▼
                                      ┌──────────────┐
                                      │  4 FAN OUT   │   Every sink sees every event.
                                      │              │   Sinks never talk to each
                                      │  sinks[]     │   other.
                                      └──┬───┬───┬───┘
                                         │   │   │
                    ┌────────────────────┘   │   └────────────────────┐
                    ▼                        ▼                        ▼
            ┌───────────────┐        ┌───────────────┐        ┌───────────────┐
            │  AUDIO SINK   │        │  CANVAS SINK  │        │   RECORDER    │
            │               │        │               │        │               │
            │ pick instrument│       │ position from │        │ taps the master│
            │ ask for a voice│       │ the id's hash │        │ bus into a file│
            │ (may steal one)│       │ radius from p │        │               │
            │ play the note  │       │ ring + fade   │        │               │
            └───────┬───────┘        └───────┬───────┘        └───────┬───────┘
                    ▼                        ▼                        ▼
                    sound                circles on a            a .webm file
                                          dark canvas             you can keep
```

---

## Stage by stage

### 1. Input — what a source is

A source is any object with three members:

```js
{ name: 'my-source', start(emit) { /* call emit(event) */ }, stop() {} }
```

That is the entire interface. The bundled ones:

| Source | Transport | Notes |
|---|---|---|
| `wikipedia({backend:'eventstreams'})` | HTTPS SSE to `stream.wikimedia.org` | One connection for every language. No third-party infrastructure. |
| `wikipedia({backend:'wikimon'})` | WebSocket per language | Carries fields EventStreams lacks: `geo_ip`, `hashtags`, `mentions`, an explicit `is_anon`. |
| `sseSource({url, map})` | `EventSource` | Reconnects on its own. |
| `websocketSource({url, map})` | `WebSocket` | Exponential backoff, 1 s → 30 s. |
| `pollSource({url, interval, map})` | `fetch` on a timer | De-duplicates by `id`, remembering the last 500. |
| `ingestSource({url})` | SSE from the bundled server | See [the ingest server](#11-the-ingest-server). |
| `manualSource()` / `son.emit()` | none | Call it yourself. |
| `randomSource({rate})` | none | Synthetic traffic for tuning offline. |

**What Wikipedia actually sends.** The EventStreams adapter reads a
`recentchange` message and keeps this much:

| Incoming field | Becomes |
|---|---|
| `length.new − length.old` | `magnitude` (absolute) and `polarity` (its sign) |
| `title` | `id` and `label` |
| `meta.uri` | `url` |
| `bot` | `category: 'bot'` |
| `user` matching an IP pattern | `category: 'anon'` — EventStreams has no explicit anonymity flag, so an IP-shaped username is the standard proxy |
| `namespace !== 0` | discarded, unless you ask for every namespace |
| `type === 'log'` with `log_type === 'newusers'` | an `accent` event: swell + banner |
| everything else | kept verbatim under `data` |

Nothing is thrown away permanently: the untouched original payload always rides
along in `event.data`, so a sink of yours can use fields the engine ignores.

### 2. Normalisation — the contract

`normalize()` is the only door in. It is deliberately forgiving in every respect
but one.

| Field | Required | Default |
|---|---|---|
| `magnitude` | **yes**, must be a finite number | — |
| `polarity` | no | the sign of `magnitude` |
| `id` | no | an auto-generated one |
| `category` | no | `'default'` |
| `accent` | no | `false` |
| `label`, `url`, `source` | no | `''` |
| `ts` | no | now |
| `data` | no | `null` |

`son.emit(42)` is valid: a bare number is read as a magnitude. A negative
magnitude carries its own polarity, so `−900` means "shrank by 900" without you
saying so. Anything whose magnitude is not a finite number is counted in
`stats.rejected` and goes no further.

### 3. Mapping — magnitude to pitch

This is the part that makes the engine general rather than a Wikipedia toy.

**The problem.** Wikipedia edits are a few bytes to a few hundred thousand.
HTTP latencies cluster between 40 and 60 ms. A curve tuned for one is useless
for the other. Most sonification code hard-codes a constant for its one dataset
and is stuck there.

**The fix: rank, don't scale.** In `adaptive` mode the mapper keeps the last 500
magnitudes and asks a different question — not *how big is this?* but *how big
is this compared to what I have been seeing?*

```
p = (count of previous magnitudes below it + half the ties) / window size
```

`p` is always between 0 and 1 whatever the units, so the full pitch range is
always used. Plug in an unknown feed and it finds its own footing in about 16
events. Two other modes exist for when you already know the range: `log` and
`linear`, both taking an explicit `domain`.

The test suite pins the difference down. Given latencies between 40 and 60 ms:

| Mapping | Pitch range used |
|---|---|
| `log` with `domain: [1, 100000]` (tuned for Wikipedia) | **1 semitone** — everything sounds the same |
| `adaptive` | **27 semitones** — the full range |

**From `p` to a note.** Four things come out of `map()`:

```
q        = invert ? 1 − p : p        // big event = low note, by default
semis    = q × range                 // range defaults to 27 semitones
semis   += jitter                    // optional random ± wobble
semitone = root + quantize(semis)    // snap onto the chosen scale
velocity = 0.55 + 0.45 × p           // bigger events a little louder
salience = p                         // priority when voices run short
```

`quantize()` snaps to the nearest degree of the active scale, and will jump up to
the next octave's root when that is closer. Scales available: `chromatic`,
`major`, `minor`, `pentatonic`, `pentatonic-minor`, `whole-tone`, `lydian`,
`dorian`, `blues`, `fourths` — or pass your own array of semitone offsets.

Note the ordering: an event's position is computed **before** it joins the
window, so it never ranks against itself.

### 4. Filtering — dimmed, not discarded

Filters are predicates. An event that fails one is marked `dimmed`: the canvas
still draws it, faintly, and the audio sink stays silent. This is inherited from
the original Listen to Wikipedia, where non-article edits appeared as ghost
circles — you can see the traffic you chose not to hear, which is more honest
than making it vanish.

### 5. Fan-out

Every sink receives every event, in registration order, each in its own
`try/catch`. A sink that throws cannot take down the others or the source. Sinks
never communicate; adding the canvas cannot change what you hear.

### 6. The audio sink — choosing and scheduling

**Instrument choice**, in order: a `byCategory` override, then polarity —
positive plays `kit.add`, negative `kit.sub`, zero `kit.neutral` (falling back to
`add`).

**Accents bypass everything.** An `accent` event plays its swell outside the
voice pool, because a rare notable event must never be dropped by a burst of
ordinary ones.

**Voice allocation.** Web Audio will happily play a thousand overlapping notes
and turn your feed into porridge. The pool caps it, and — the important part —
caps it *intelligently*:

```
prune voices whose scheduled end has passed
if a rate ceiling is set and the token bucket is empty  → deny
if fewer voices are sounding than the ceiling           → grant
otherwise, find the weakest sounding voice:
    new salience ≤ weakest salience → deny
    new salience > weakest salience → fade the weak one out over 12 ms,
                                      take its slot
```

The original dropped notes first-come-first-served, which silences the
interesting event inside a burst of dull ones. Stealing by salience means the
biggest thing in any given moment is the thing you hear. Default ceiling: 16
voices, no rate limit.

### 7. Instruments

Two implementations of one interface:

```js
play(ctx, dest, { semitone, velocity, when }) → { duration, stop(fadeSeconds) }
```

**`SampleInstrument`** plays recorded banks. Given a target semitone it picks the
nearest recorded note, then corrects the remainder with `playbackRate`:

```
rel    = (semitone − baseSemitone) / step
idx    = round(rel), clamped to the bank
offset = (rel − idx) × step, clamped to ±12 semitones
rate   = 2 ^ (offset / 12)
```

The original project simply played one file per note and was therefore limited to
27 fixed pitches. Resampling gives continuous pitch from the same 27 files,
including notes above and below anything that was recorded. `step: 0` marks an
unpitched bank (the swells), which picks a variation at random instead.

**`SynthInstrument`** needs no files at all. Two engines:

- *FM* (`bell`, `glass`, `clang`) — a sine carrier at the target frequency, a
  modulator at an **inharmonic** ratio such as 3.51, and a modulation index that
  decays fast. Inharmonic partials are what make metal sound like metal.
- *Subtractive* (`pluck`, `woody`, `blip`, `pad`) — a saw or square through a
  low-pass filter whose cutoff falls sharply, which is the shape of a plucked
  string.

Both shape an exponential attack/decay envelope and return a `stop()` the voice
pool can call to steal them cleanly.

Sample banks resolve their URLs relative to the library's own module location,
so the project works from a local server, a GitHub Pages subpath, or a folder
inside a bigger site, with no configuration.

### 8. The canvas sink

- **Position** comes from the `id` — hashed (xmur3) into a seed, then a
  mulberry32 stream giving a fixed point in the unit square. Deterministic, so
  repeat events pile up in one place.
- **Radius** is `√p × 90` pixels, floored at 3. Area therefore tracks `p`
  directly, which is why the marks read as proportional rather than
  exaggerated.
- **Shape** is whatever you choose: circle, star, sparkle, diamond, hexagon,
  burst, ring or petal — or `mixed`, which assigns one per event from the same
  identity that fixes its position, so an article keeps both its place and its
  shape. Rotation comes from that stream too; without it every star points the
  same way and the canvas reads as wallpaper rather than a sky. The shockwave
  takes the shape of the mark that produced it.
- **Starfield**, optionally: a fixed field of stars drawn from a stable seed,
  each with its own slow twinkle phase so the sky breathes instead of blinking
  in unison. The brightest few carry a soft halo, which is what stops it looking
  like evenly scattered dust.
- **Lifecycle**: fade over 12 s; a shockwave ring expands from `r+20` to `r+40`
  over 2.2 s on an ease-out; the label shows for 3 s and on hover; oldest
  particles are culled past 800.
- **Colour** by category, from the active palette — in the default *Nocturne*:
  white for a logged-in user, green anonymous, purple bot, orange alert. A
  category nobody defined falls back to `default`, so custom data always gets a
  visible colour instead of vanishing.
- Clicking a circle hit-tests newest-first and opens its `url`.

**Palettes.** Nine ship with the project and can be swapped at runtime with
`setPalette()`; circles already on screen are recoloured from the category they
were born with, so the change is immediate rather than waiting for the canvas to
turn over.

They are held to measured standards, not taste. Label text must clear WCAG AA
(4.5:1) against its ground. Circles must stay visible against that ground at the
0.5 fill opacity they are actually drawn with. And the categories must be
distinguishable from **each other** — measured as perceptual distance in CIELAB
(ΔE ≥ 22) rather than luminance contrast, because deep cyan and magenta are
unmistakable to the eye while sharing almost the same luminance. Using contrast
ratio there would reject good palettes and accept bad ones. *Monochrome* is the
deliberate exception: being greyscale, it is held to a lightness floor instead,
which is exactly the promise it makes.

It is Canvas 2D rather than SVG because the original's one-DOM-node-plus-
transition per circle does not survive a busy multi-language feed, and because
D3 v3's API was removed in v4 — a migration was a rewrite either way.

### 9. Failing loudly

Two things make audio fail in ways that are invisible from the outside, and
both are handled explicitly rather than left to chance.

**A partly-broken sample bank.** Loading the banks used to be a single
`Promise.all` over fifty-seven requests, so one failed request left the whole
instrument permanently mute — while the canvas carried on drawing circles. On a
phone, one flaky request out of fifty-seven is close to expected, which is
exactly how this was found. Each file now settles independently: a missing note
drops out of the bank, its neighbour is resampled to cover the gap, and the
failures are recorded in `instrument.failures` with `instrument.coverage`
reporting how much of the bank arrived. If a kit cannot load at all, the engine
falls back to synthesis, which needs no network.

**A muted or suspended context.** `unlock()` sets `navigator.audioSession.type`
to `playback` where it exists: without it, iOS routes Web Audio through the
ambient session, which the hardware ring/silent switch mutes — the page looks
perfectly alive and plays nothing. Mobile browsers also suspend the context when
a tab is backgrounded and do not reliably resume it, so a `visibilitychange`
listener resumes it on return.

`unlock()` returns a status rather than a boolean, because "the context is
running" and "you will actually hear something" are different questions and the
interface has to be able to say which one failed.

### 10. The recorder

Taps the master gain into a `MediaStreamDestination`, runs `MediaRecorder` over
it, and hands back a Blob (Opus in WebM where available). It records what you
actually hear, mix and all.

### 11. The ingest server

`node server/ingest.mjs` — around 250 lines, no dependencies, and it serves the
static files too.

```
POST /emit      a normalized event, or an array of them
GET  /emit      the same via query string, for curl and cron
GET  /events    the SSE fan-out the browser subscribes to
GET  /stats     counters
```

**Mapping arbitrary JSON.** Query parameters name the target fields. A value
starting with `$.` is a path into the posted body; anything else is a literal:

```bash
curl -X POST "localhost:8080/emit?magnitude=\$.duration_ms&id=\$.route&category=\$.level" \
     -H 'Content-Type: application/json' \
     -d '{"route":"/api/users","duration_ms":312,"level":"warn"}'
```

Paths handle nesting and array indices (`$.metrics.bytes[1]`). The original body
is preserved under `data`. Fan-out is SSE rather than WebSocket because the
browser only ever consumes this stream, `EventSource` reconnects by itself, and
SSE needs nothing beyond `node:http`.

---

## Three worked examples, with real numbers

### A Wikipedia edit

> `+1,247 bytes to "Colossal squid"`, by a logged-in user.

| Stage | Result |
|---|---|
| Normalise | `magnitude 1247`, `polarity +1`, `id "Colossal squid"`, `category "user"` |
| Map | bigger than 78 % of recent edits → `p = 0.78` |
| | inverted → `q = 0.22` → `0.22 × 27 = 5.94` → chromatic → **semitone 6** |
| | `velocity = 0.55 + 0.45 × 0.78 = 0.90`, `salience = 0.78` |
| Audio | polarity + → celesta; nearest sample `c007`, offset 0, `playbackRate 1.0` |
| Canvas | `√0.78 × 90 ≈ 80 px`, at the fixed point hashed from the title |
| You get | a fairly low bell, and a large circle that will reappear in the same spot if the article is edited again |

### An HTTP request

> `GET /api/users took 312 ms`, sent with `polarity=-1` so that slow is a pluck.

| Stage | Result |
|---|---|
| Normalise | `magnitude 312`, `polarity −1`, `id "/api/users"`, `category "warn"` |
| Map | your traffic mostly sits at 40–60 ms, so 312 ms is at the very top → `p ≈ 0.99` |
| | `q = 0.01` → **semitone 0**, the lowest note; `velocity ≈ 1.0` |
| Audio | polarity − → plucked string, deep and loud |
| Voices | `salience 0.99` — under load it will steal a voice rather than be dropped |
| You get | one conspicuously deep pluck among a stream of high ticks. That is your slow request, and you did not have to be looking |

Note what the adaptive mapper did here: nobody told it that 40–60 ms was normal.

### A git commit

> `a3f19c2`, 214 lines changed.

| Stage | Result |
|---|---|
| Normalise | `magnitude 214`, `polarity +1`, `id "a3f19c2"` |
| Map | against a history of commits, a middling one → `p ≈ 0.55` |
| | `q = 0.45` → `12.15` → with `scale: 'pentatonic'` snaps to **semitone 12** |
| Canvas | `√0.55 × 90 ≈ 67 px` at the point hashed from the SHA |
| You get | replaying a repository's history as music, each commit one note |

---

## What you get out

**Live.** Sound from the speakers, circles on the canvas, and counters you can
read at any moment:

```js
son.eventsPerMinute          // rolling 60-second count
son.stats                    // received, rejected, dimmed
son.audio.stats              // played, dropped
son.pool.stats               // granted, denied, stolen
son.pool.active              // voices sounding right now
```

**Recorded.** `new Recorder(son.engine)` → `start()` → `save()` gives you an
audio file of the session.

**Programmatic.** `son.on(fn)` hands you every normalized event *after* mapping,
so you can build your own sink — a log, a chart, a webhook — on the same
pipeline.

---

## Why it is built this way

| Decision | Reason |
|---|---|
| **Adaptive mapping by default** | A hard-coded curve makes a sonification engine single-purpose. Ranking against recent history is what lets an unknown feed sound right with no configuration. |
| **Voice stealing by salience** | Dropping notes in arrival order silences exactly the events you most wanted to hear. |
| **Dimmed instead of discarded** | You can see the traffic you chose not to hear. |
| **SSE, not WebSocket, for fan-out** | The browser only consumes. `EventSource` reconnects itself, and SSE costs zero dependencies. |
| **Canvas, not SVG** | One DOM node plus a transition per event does not survive a busy feed. |
| **Sample URLs relative to the module** | Works from any mount point without configuration — a local server, a Pages subpath, a subfolder. |
| **No build step** | Clone it, open it, change a line, refresh. The whole engine is readable in an afternoon. |
| **Accents bypass the pool** | A rare, important event must not be lost to a crowd of ordinary ones. |

---

*Back to the [README](../README.md) · try it in the
[sandbox](https://guillain-rdcde.github.io/tintinnabulum/).*
