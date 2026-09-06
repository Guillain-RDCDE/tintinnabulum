# The Tintinnabulum input standard

Three documents, all machine-readable.

- **[`event.schema.json`](event.schema.json)** — `tintinnabulum.event/1`. What an
  event is. Nine fields, one of them required.
- **[`mapping.schema.json`](mapping.schema.json)** — `tintinnabulum.mapping/1`. How
  your data becomes one, without writing code.
- **[`source.schema.json`](source.schema.json)** — `tintinnabulum.source/1`. Where
  live data comes from and how often to fetch it.

A profile and a descriptor together are a complete connector, and neither is
code. Nothing in this repository has to be edited to add one.

---

## The event

One thing happened. Describe it, and it can be heard.

```json
{ "magnitude": 1200, "id": "GET /api/users", "category": "alert", "ts": 1757152800000 }
```

**`magnitude` is the only required field.** It is the one thing the engine
cannot invent. Everything else has a defined default, because a source that
cannot supply a field should not be forced to make one up.

The unit does not matter and does not need declaring. Bytes, milliseconds,
dollars, magnitude on the Richter scale — the engine ranks each value against
the recent ones and finds the range itself, usually within sixteen events. That
is why the same standard fits a feed you have never seen.

| Field | Required | Default | What it does |
|---|---|---|---|
| `magnitude` | **yes** | — | Size. Drives pitch and how big the mark is. Negative implies `polarity: -1`. |
| `polarity` | no | `0` | `1` rings, `-1` plucks, `0` is neutral. Supply it only when direction means something. |
| `id` | no | generated | Stable identity. The same id lands in the same place, so a repeat pulses in one spot. |
| `category` | no | `"default"` | Free-form bucket, selects colour. Unknown values get the palette's default rather than disappearing. |
| `accent` | no | `false` | Rare and notable. Plays the swell, shows a banner, outranks ordinary events. |
| `label` | no | `""` | Short text, shown on hover. It goes on a screen — do not put anything there unasked. |
| `url` | no | `""` | Opened when the mark is clicked. |
| `ts` | no | now | Epoch milliseconds. A real timestamp is what lets a batch replay with its own timing instead of as a metronome. |
| `source` | no | `""` | Who produced it. Informational. |
| `data` | no | `null` | Your original payload, untouched. Whatever the mapping did not use is still here. |

Send one, or an array:

```bash
curl -X POST localhost:8080/emit -d '{"magnitude": 1200, "id": "build-42"}'
```

---

## The mapping

Most data is not shaped like the event above, and rewriting a producer to emit
it is a poor trade. Instead, describe the correspondence once:

```json
{
  "profile": "tintinnabulum.mapping/1",
  "name": "http-access-log",
  "where": "$.status != null",
  "map": {
    "magnitude": "$.duration_ms",
    "id":        "$.method + ' ' + $.route",
    "category":  "$.status >= 500 ? 'alert' : $.status >= 400 ? 'anon' : 'user'",
    "accent":    "$.status >= 500",
    "label":     "$.method + ' ' + $.route + ' ' + $.status",
    "ts":        "epoch($.time)"
  }
}
```

Save it as `profiles/http-access-log.json` and use it by name:

```bash
curl -X POST 'localhost:8080/emit?profile=http-access-log' -d @access.json
```

Or send the profile with the request, for a source you are still working out:

```bash
curl -X POST localhost:8080/emit \
  -H 'Content-Type: application/json' \
  -d '{"profile": {"map": {"magnitude": "$.bytes"}}, "events": [{"bytes": 4096}]}'
```

`where` is optional. When present, a payload becomes an event only if it is
truthy — which is how you drop what you do not want to hear at the source,
rather than filtering after the fact.

### Getting a mapping right

Do not debug a mapping by listening to it. Ask what the engine understood:

```bash
curl -X POST 'localhost:8080/explain?profile=http-access-log' -d @one-sample.json
```

It answers with the event it produced, which expression fed each field, what
each one evaluated to, what defaulted, and the reason for any rejection.

---

## The source

A profile says how a payload becomes an event. It does not say where the
payload comes from. That was the half still written in JavaScript, inside this
repository — so "plug anything in" quietly meant "open `src/sources/` and write
a function".

A descriptor closes it. Save it as `sources/<name>.json`:

```json
{
  "source": "tintinnabulum.source/1",
  "name": "earthquakes",
  "fetch": {
    "url": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
    "interval": 300000
  },
  "items": "$.features",
  "key": "$.id",
  "profile": "usgs-quake"
}
```

`items` selects the array in the response. `key` gives each item a stable
identity, so a poll returning the same things again does not replay them.
`profile` is a name from `profiles/`, or a whole mapping document inline.

### Listening instead of polling

Most of what is worth hearing does not wait to be asked. Replace `fetch` with
`stream`:

```json
"stream": {
  "url": "wss://ws.blockchain.info/inv",
  "protocol": "websocket",
  "subscribe": { "op": "unconfirmed_sub" },
  "maxPerSecond": 12
}
```

`wss:` is a WebSocket, `https:` is Server-Sent Events; the protocol is inferred
from the scheme unless you say otherwise. `subscribe` is sent once the socket
opens, because many feeds say nothing until asked. `maxPerSecond` is the
descriptor's own ceiling — a firehose outruns both the ears and the screen, and
dropping at the source keeps the cost off the renderer entirely.

Reconnection is automatic and backs off: a socket that has been up for a day
will close, and a feed that silently stops is worse than one that never
started.

### Two-stage sources

A list endpoint that returns identities, and a detail endpoint that turns one
identity into a record, is one of the commonest shapes on the web. Add
`expand`:

```json
"fetch":  { "url": "https://hacker-news.firebaseio.com/v0/topstories.json" },
"expand": { "url": "https://hacker-news.firebaseio.com/v0/item/${item}.json",
            "limit": 60, "concurrency": 6 }
```

Each value `items` selected is substituted into `expand.url` and fetched, and
the record that comes back is what the profile maps. Requests go out a few at
a time: a hundred at once is how a polite poll becomes an attack. Identities
already followed are remembered, so a poll of an unchanged list costs nothing.

Get it working before you listen to it:

```bash
curl -X POST localhost:8080/sources/earthquakes/test
```

That fetches once, emits nothing, and answers with the upstream status, the
shape of what came back, how many items `items` found, and what the first one
became. A wrong path is then obvious rather than mysterious.

Then `POST /sources/earthquakes/start`, or set `"enabled": true` to have it
start with the server. It is off by default on purpose: a checked-out
repository should not begin calling other people's APIs on its own.

**Secrets never go in the document.** Write `${env.NAME}` and set it in the
environment where the server runs:

```json
"headers": { "Authorization": "Bearer ${env.X_BEARER_TOKEN}" }
```

`GET /sources` lists what each descriptor needs and what is missing, and never
returns a resolved URL — a token in a query string would otherwise leak
through the listing.

Polling is paced and defended: a batch is spread across most of the interval
so forty items are forty notes over a minute rather than a glitch, repeats are
dropped by key, and a failing endpoint backs off exponentially and obeys
`Retry-After`. Hammering a failing API is how a key gets revoked.

### Writing one

1. Find the URL and look at what it returns. `curl` it.
2. Write `profiles/<yours>.json`: `magnitude` first, then whatever else is
   worth hearing. `POST /explain` with one sample until it reads right.
3. Write `sources/<yours>.json`: the URL, the interval, the `items` path.
4. `POST /sources/<yours>/test` until `found` is the number you expect.
5. Start it.

### What ships, and why it is worth reading

Every feed built into this project is a descriptor. All eight of them — they
used to be three hundred lines of JavaScript inside `src/sources/`, and if the
standard could not express them it would not be worth offering for anyone
else's data:

| | Transport | Shows |
|---|---|---|
| `bitcoin` | websocket | `subscribe`, and `sumof()` over a transaction's outputs |
| `coinbase` | websocket | a polarity that means something: buys ring, sells pluck |
| `bluesky` | websocket | `maxPerSecond`, on a feed running two thousand a minute |
| `wikipedia` | sse | Server-Sent Events, and no de-duplication at all |
| `earthquakes` | poll | the simplest one. Needs no key: copy this first |
| `weather` | poll | `lookup()` against a table of severities |
| `github` | poll | a table mapping event types to categories |
| `hackernews` | poll + `expand` | two stages: a list of identities, then each record |

`sources/pizza-index.json` is the shape of a connector that needs a token —
posts about late-night pizza deliveries near the Pentagon, on the folk theory
that a crisis is catered before it is announced.

### Without a server at all

The sandbox has a **Your data** panel. Paste a sample, describe the mapping,
see what the engine understood field by field, and hear it — no install, no
server, nothing uploaded. The expression language and the profile machinery are
plain modules with no I/O, so all of that runs in the page. Only the fetching
half needs a server, and that is the half a browser cannot do anyway: CORS,
secrets, and a throttled background tab.

---

## The expression language

Deliberately small, and deliberately not a general one. A profile may arrive
over the network, so an expression is untrusted input: there is no `eval` here,
no `new Function`, and no way to name anything except the payload and the
functions below. Length, nesting, node count and evaluation work are all
capped. See [`src/core/expr.js`](../src/core/expr.js).

```
$.a.b   $["a b"]   $.items[0]     the payload
'text'   12.5   true   false   null
+ - * / %                         arithmetic       (÷0 and %0 give null)
== != < <= > >=                   comparison
and   or   not                    logic, short-circuiting
cond ? a : b                      conditional
```

| Function | Does |
|---|---|
| `abs` `sign` `round` `floor` `ceil` | the obvious |
| `min(…)` `max(…)` `clamp(v, lo, hi)` | bounds |
| `log(x)` | natural log; `null` for zero and below |
| `num(x)` `str(x)` `len(x)` | conversion and length |
| `lower` `upper` `trim` `concat(…)` | text |
| `coalesce(…)` | the first argument that is not null and not empty |
| `contains` `startswith` `endswith` `replace` `split` | text tests and surgery |
| `at(x, i)` | index into an array or a string; negative counts from the end |
| `epoch(x)` | ISO text, seconds or milliseconds → milliseconds |
| `now()` | current epoch milliseconds |
| `lookup(table, key, fallback)` | a named table from the profile's `tables`, for vocabularies too long to write as conditionals |

**Nothing throws.** A missing path is `null`, not a crash; `$.nope.deeper` is
`null`. Arithmetic on something that is not a number is `null`. This is
deliberate: a mapping meets data it did not expect, and one odd record should
cost you that record, not the stream.

**Nothing escapes.** `$.__proto__`, `$.constructor` and `$["prototype"]` are
`null` whatever the payload contains, including a payload crafted to carry
those keys.
