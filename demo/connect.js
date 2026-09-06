// "Connect your data": the input standard, usable from the page.
//
// The standard was published as schemas, an ingest server and a /explain
// endpoint -- none of which the sandbox showed, and none of which work on
// GitHub Pages, which serves static files and runs no server at all. So the
// one place anybody actually meets this project could not demonstrate the
// thing it is for.
//
// Everything here runs in the browser. The expression language and the profile
// machinery are plain modules with no I/O, so a mapping can be written, judged
// and heard without a server anywhere. Only the fetching half needs one, and
// that is the half a page cannot do anyway: CORS, secrets and a throttled
// background tab.

import { compileProfile, validateProfile } from '../src/index.js';
import { $ } from './dom.js';

/** Every path into a payload, so a guess has something to choose from. */
function paths(value, prefix = '$', depth = 0, out = []) {
  if (depth > 4 || value == null) return out;
  if (Array.isArray(value)) {
    if (value.length) paths(value[0], `${prefix}[0]`, depth + 1, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      const p = `${prefix}.${k}`;
      out.push({ path: p, value: v, type: Array.isArray(v) ? 'array' : typeof v });
      paths(v, p, depth + 1, out);
    }
  }
  return out;
}

const NUMERIC_HINTS = /count|size|bytes|length|value|amount|score|duration|latency|ms|magnitude|price|total|weight/i;
const LABEL_HINTS = /title|name|label|text|message|summary|subject|description/i;
const ID_HINTS = /^\$\.(id|_id|uuid|key|hash|slug)$/i;
const TIME_HINTS = /time|date|created|updated|stamp|at$/i;
const URL_HINTS = /url|link|href|permalink/i;

/**
 * Propose a mapping for a payload nobody has seen before.
 *
 * A guess is not the point -- being wrong in a way you can see and correct is.
 * `magnitude` is the only field that must be found, so it is the only one
 * chosen with any determination: the numeric field whose name sounds like a
 * size, else any number at all.
 */
export function suggestMapping(sample) {
  const found = paths(sample);
  const numbers = found.filter((f) => f.type === 'number');
  const strings = found.filter((f) => f.type === 'string');
  const pick = (list, re) => (list.find((f) => re.test(f.path)) || null);

  const magnitude =
    pick(numbers, NUMERIC_HINTS) ||
    numbers[0] ||
    // Nothing numeric: the length of the longest string is at least honest,
    // and it is visibly a placeholder rather than a silent wrong answer.
    (strings.length ? { path: `len(${strings[0].path})`, synthetic: true } : null);

  const map = {};
  if (magnitude) map.magnitude = magnitude.synthetic ? magnitude.path : magnitude.path;
  const id = pick(found, ID_HINTS) || pick(strings, /id$/i);
  if (id) map.id = `str(${id.path})`;
  const label = pick(strings, LABEL_HINTS);
  if (label) map.label = label.path;
  const url = pick(strings, URL_HINTS);
  if (url) map.url = url.path;
  const ts = found.find((f) => TIME_HINTS.test(f.path) && (f.type === 'number' || f.type === 'string'));
  if (ts) map.ts = `epoch(${ts.path})`;

  return { profile: 'tintinnabulum.mapping/1', map };
}

/** Where the array of things lives, when the payload is not itself the array. */
export function suggestItems(payload) {
  if (Array.isArray(payload)) return null;
  if (!payload || typeof payload !== 'object') return null;
  const arrays = Object.entries(payload).filter(([, v]) => Array.isArray(v) && v.length);
  if (!arrays.length) return null;
  // The longest array is nearly always the records; the others are facets,
  // links or metadata.
  arrays.sort((a, b) => b[1].length - a[1].length);
  return `$.${arrays[0][0]}`;
}

const EXAMPLE = `{
  "records": [
    { "id": "a1", "route": "/checkout", "status": 503, "duration_ms": 812 },
    { "id": "a2", "route": "/search",   "status": 200, "duration_ms": 41  },
    { "id": "a3", "route": "/cart",     "status": 404, "duration_ms": 15  }
  ]
}`;

/**
 * @param {object} io
 * @param {(events: object[]) => void} io.play     hand finished events to the engine
 * @param {(text: string) => void} [io.onState]     one line for the panel header
 */
export function setupConnect({ play, onState = () => {} }) {
  const paste = $('#connect-json');
  const mapBox = $('#connect-map');
  const itemsBox = $('#connect-items');
  const out = $('#connect-out');
  const status = $('#connect-status');
  const playBtn = $('#connect-play');
  if (!paste) return null;

  paste.value = EXAMPLE;
  let ready = [];

  const say = (text, state = '') => {
    status.textContent = text;
    status.dataset.state = state;
    // The panel header carries its own state like every other one, so the
    // page still reads at a glance with everything folded away.
    onState(state === 'good' ? text : state === 'bad' ? 'not mapping yet' : 'Paste JSON, hear it');
  };

  function readPayload() {
    const text = paste.value.trim();
    if (!text) return { error: 'Paste some JSON above.' };
    try {
      return { payload: JSON.parse(text) };
    } catch (e) {
      return { error: 'That is not valid JSON: ' + e.message };
    }
  }

  /** Run the mapping over the pasted payload and show what it understood. */
  function explain() {
    out.textContent = '';
    ready = [];
    playBtn.disabled = true;

    const { payload, error } = readPayload();
    if (error) return say(error, 'bad');

    let doc;
    try {
      doc = JSON.parse(mapBox.value);
    } catch (e) {
      return say('The mapping is not valid JSON: ' + e.message, 'bad');
    }
    const v = validateProfile(doc);
    if (!v.ok) return say(v.problems[0], 'bad');

    let profile;
    try {
      profile = compileProfile(doc);
    } catch (e) {
      return say((e.problems || [e.message])[0], 'bad');
    }

    // Select the records the same way a descriptor's `items` would.
    let list = payload;
    const itemsPath = itemsBox.value.trim();
    if (itemsPath) {
      try {
        const sel = compileProfile({ map: { magnitude: '0', label: itemsPath } });
        const t = sel.apply(payload).trace.find((x) => x.field === 'label');
        list = t && t.value != null ? t.value : null;
      } catch (e) {
        return say('The items path is not an expression: ' + e.message, 'bad');
      }
    }
    if (list == null) return say('The items path selected nothing.', 'bad');
    if (!Array.isArray(list)) list = [list];

    const rows = [];
    let skipped = 0;
    const problems = [];
    for (const item of list) {
      const r = profile.apply(item);
      if (r.skipped) { skipped++; continue; }
      if (!r.event) { if (problems.length < 3) problems.push(...r.errors); continue; }
      ready.push(r.event);
      if (rows.length === 0) rows.push(...r.trace);
    }

    // The first record's working, field by field: the same answer /explain
    // gives, which is the difference between "rejected" and knowing why.
    const table = document.createElement('table');
    table.className = 'trace';
    const head = document.createElement('tr');
    for (const h of ['field', 'expression', 'value']) {
      const th = document.createElement('th');
      th.textContent = h;
      head.append(th);
    }
    table.append(head);
    for (const t of rows) {
      const tr = document.createElement('tr');
      if (t.error) tr.dataset.state = 'bad';
      for (const cell of [t.field, t.expression, t.error ? t.error : JSON.stringify(t.value)]) {
        const td = document.createElement('td');
        td.textContent = String(cell);
        tr.append(td);
      }
      table.append(tr);
    }
    if (rows.length) out.append(table);

    playBtn.disabled = ready.length === 0;
    if (!ready.length) {
      return say(problems[0] || `Nothing became an event${skipped ? `, and ${skipped} were filtered out by "where"` : ''}.`, 'bad');
    }
    say(`${ready.length} event${ready.length > 1 ? 's' : ''} ready${skipped ? `, ${skipped} filtered out` : ''}.`, 'good');
  }

  $('#connect-explain').addEventListener('click', explain);
  playBtn.addEventListener('click', () => play(ready));

  $('#connect-guess').addEventListener('click', () => {
    const { payload, error } = readPayload();
    if (error) return say(error, 'bad');
    const items = suggestItems(payload);
    itemsBox.value = items || '';
    const first = items
      ? payload[items.slice(2)][0]
      : Array.isArray(payload) ? payload[0] : payload;
    const guess = suggestMapping(first);
    mapBox.value = JSON.stringify(guess, null, 2);
    if (!guess.map.magnitude) {
      return say('No number to hear. Add a magnitude expression by hand.', 'bad');
    }
    explain();
  });

  // Something is on screen from the start, so the panel explains itself.
  itemsBox.value = '$.records';
  mapBox.value = JSON.stringify(
    {
      profile: 'tintinnabulum.mapping/1',
      where: '$.status != null',
      map: {
        magnitude: '$.duration_ms',
        id: '$.id',
        category: "$.status >= 500 ? 'alert' : $.status >= 400 ? 'anon' : 'user'",
        accent: '$.status >= 500',
        label: "str($.status) + ' ' + $.route",
      },
    },
    null,
    2
  );

  return { explain };
}
