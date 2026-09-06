# The Tintinnabulum input standard

Two documents, both machine-readable.

- **[`event.schema.json`](event.schema.json)** — `tintinnabulum.event/1`. What an
  event is. Nine fields, one of them required.
- **[`mapping.schema.json`](mapping.schema.json)** — `tintinnabulum.mapping/1`. How
  your data becomes one, without writing code.

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

**Nothing throws.** A missing path is `null`, not a crash; `$.nope.deeper` is
`null`. Arithmetic on something that is not a number is `null`. This is
deliberate: a mapping meets data it did not expect, and one odd record should
cost you that record, not the stream.

**Nothing escapes.** `$.__proto__`, `$.constructor` and `$["prototype"]` are
`null` whatever the payload contains, including a payload crafted to carry
those keys.
