import {
  Sonifier,
  CanvasSink,
  Recorder,
  SCALES,
  PALETTES,
  DEFAULT_PALETTE_NAME,
  swatchOf,
  SHAPES,
  DEFAULT_SHAPE,
  drawShape,
  wikipedia,
  bitcoin,
  coinbase,
  earthquakes,
  bluesky,
  github,
  ingestSource,
  randomSource,
  WIKIPEDIA_LANGUAGES,
} from '../src/index.js';

const $ = (sel) => document.querySelector(sel);

// Per-viewer conveniences only. Storage can be unavailable (private window,
// blocked site data) and must never break the page.
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

const storedPalette = PALETTES[store.get('tintinnabulum:palette')]
  ? store.get('tintinnabulum:palette')
  : DEFAULT_PALETTE_NAME;

const son = new Sonifier({
  kit: 'hatnote',
  mapping: { mode: 'adaptive', scale: 'chromatic', range: 27, jitter: 0.5 },
  voices: { maxVoices: 16 },
  volume: 0.7,
});

const canvas = new CanvasSink('#canvas', { showHud: true, palette: storedPalette });
son.use(canvas);

const recorder = new Recorder(son.engine);
let source = null;

// --- simple / advanced ----------------------------------------------------

function setMode(mode, persist = true) {
  const advanced = mode === 'advanced';
  $('#advanced').hidden = !advanced;
  $('#simple').hidden = advanced;
  if (persist) store.set('tintinnabulum:mode', mode);
}

$('#to-advanced').onclick = () => setMode('advanced');
$('#to-simple').onclick = () => setMode('simple');
setMode(store.get('tintinnabulum:mode') === 'advanced' ? 'advanced' : 'simple', false);

// --- audio status ---------------------------------------------------------
// The first version of this page failed silently: if the sample bank did not
// load, circles kept appearing and nothing ever made a sound, with no way for
// anyone to tell why. Audio state is now always stated plainly.

function setAudioStatus(text, state = '') {
  const el = $('#audio-status');
  el.textContent = text;
  el.dataset.state = state;
}

function describe(status) {
  if (!status) return;
  if (!status.running) {
    setAudioStatus('Sound is blocked by the browser. Tap anywhere to enable it.', 'bad');
  } else if (!status.usable) {
    setAudioStatus('No instrument could be loaded, so there is no sound.', 'bad');
  } else if (status.fellBackToSynth) {
    setAudioStatus('Sound on, using synthesis: the recorded bells could not be downloaded.', 'good');
  } else if (status.problems && status.problems.length) {
    setAudioStatus('Sound on. Some samples were unavailable and are covered by their neighbours.', 'good');
  } else {
    setAudioStatus('Sound on.', 'good');
  }
}

const unlockEl = $('#unlock');
function refreshUnlock() {
  unlockEl.classList.toggle('show', son.locked);
}

// Downloading fifty-seven samples over a phone connection takes seconds, and
// during those seconds the feed is already drawing circles. Rather than leave
// that window silent, start on synthesis -- which needs no network at all --
// and move to the recorded bells once they have arrived.
let sampleState = 'pending'; // pending | upgrading | done | chosen
async function upgradeToSamples() {
  if (sampleState !== 'pending' || $('#kit').value !== 'hatnote') return;
  sampleState = 'upgrading';
  try {
    await son.setKit('hatnote');
    const st = son.audio.status;
    if (!st || !st.usable) throw new Error('sample kit unusable');
    sampleState = 'done';
    setAudioStatus(
      st.problems && st.problems.length
        ? 'Sound on. Some samples were unavailable and are covered by their neighbours.'
        : 'Sound on.',
      'good'
    );
  } catch (e) {
    await son.setKit('synth');
    sampleState = 'done';
    setAudioStatus('Sound on, using synthesis: the recorded bells could not be downloaded.', 'good');
  }
}

async function ensureAudio() {
  setAudioStatus('Preparing sound…');
  if (sampleState === 'pending' && $('#kit').value === 'hatnote') {
    await son.setKit('synth'); // instant, so the first event is never silent
  }
  const status = await son.unlock();
  describe(status);
  refreshUnlock();
  if (status.audible) upgradeToSamples(); // deliberately not awaited
  return status;
}
unlockEl.addEventListener('click', ensureAudio);
refreshUnlock();

// --- the one button that matters -----------------------------------------

// Every feed the sandbox can listen to. `langs` marks the ones that take a
// Wikipedia edition list, which is the only feed-specific control there is.
const FEEDS = {
  eventstreams: {
    label: 'Wikipedia',
    blurb: 'Live edits, worldwide',
    langs: true,
    note: 'Every mark is somebody editing an article right now. A bell means text was added, a plucked string means it was removed.',
    make: (langs) => wikipedia({ langs, backend: 'eventstreams', onStatus: setStatus }),
  },
  bitcoin: {
    label: 'Bitcoin',
    blurb: 'Unconfirmed transactions',
    note: 'Each transaction as it enters the network, pitched by its value. This is the feed the whole idea began with: Listen to Wikipedia was built after BitListen, which sonified exactly this.',
    make: () => bitcoin({ onStatus: setStatus }),
  },
  coinbase: {
    label: 'Coinbase',
    blurb: 'BTC-USD trades',
    note: 'Trades as they execute. Buys ring, sells pluck: this is the one feed that hands over a direction meaning something on its own.',
    make: () => coinbase({ onStatus: setStatus }),
  },
  earthquakes: {
    label: 'Earthquakes',
    blurb: 'USGS, past hour',
    note: 'The only feed where magnitude is already the word the field uses. Quiet by nature: a handful an hour, so expect long silences.',
    make: () => earthquakes(),
  },
  bluesky: {
    label: 'Bluesky',
    blurb: 'Public post firehose',
    note: 'Posts as they are written, pitched by length. Labels carry the size rather than the text: an unfiltered firehose is not something to put on your screen unasked.',
    make: () => bluesky({ onStatus: setStatus }),
  },
  github: {
    label: 'GitHub',
    blurb: 'Public events',
    note: 'Pushes, pull requests, releases and stars across all of GitHub. Polled once a minute, which is what the unauthenticated rate limit allows.',
    make: () => github(),
  },
  random: {
    label: 'Synthetic',
    blurb: 'Generated traffic',
    note: 'Made-up events at a steady rate. Useful for hearing what a setting does without waiting for the world to produce something.',
    make: () => randomSource({ rate: 5 }),
  },
};

let feed = store.get('tintinnabulum:feed') in FEEDS ? store.get('tintinnabulum:feed') : 'eventstreams';
let langs = (store.get('tintinnabulum:langs') || 'en').split(',').filter(Boolean);
if (!langs.length) langs = ['en'];

const startBtn = $('#start');

function setRunning(on) {
  startBtn.dataset.on = String(on);
  startBtn.textContent = on ? 'Stop' : `Start listening to ${FEEDS[feed].label}`;
}

function selectFeed(name, persist = true) {
  if (!FEEDS[name]) return;
  feed = name;
  $('#feed-note').textContent = FEEDS[name].note;
  $('#langs-wrap').hidden = !FEEDS[name].langs;
  for (const b of $('#feeds-simple').children) {
    b.setAttribute('aria-pressed', String(b.dataset.feed === name));
  }
  if ($('#source').value !== name && FEEDS[name]) $('#source').value = name;
  if (persist) store.set('tintinnabulum:feed', name);
  if (startBtn.dataset.on !== 'true') setRunning(false);
}

for (const [name, def] of Object.entries(FEEDS)) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'feed';
  btn.dataset.feed = name;
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = `<b></b><span></span>`;
  btn.querySelector('b').textContent = def.label;
  btn.querySelector('span').textContent = def.blurb;
  btn.addEventListener('click', () => {
    selectFeed(name);
    if (startBtn.dataset.on === 'true') startFeed(); // switch live
  });
  $('#feeds-simple').appendChild(btn);
}

// --- Wikipedia editions, as flags rather than two-letter codes ------------
const langGrid = $('#langs-grid');
function syncLangs(persist = true) {
  for (const b of langGrid.children) {
    b.setAttribute('aria-pressed', String(langs.includes(b.dataset.lang)));
  }
  $('#langs').value = langs.join(',');
  if (persist) store.set('tintinnabulum:langs', langs.join(','));
}

for (const l of WIKIPEDIA_LANGUAGES) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lang';
  btn.dataset.lang = l.code;
  btn.title = `${l.name} — ${l.native} (${l.code})`;
  btn.setAttribute('aria-pressed', 'false');
  const fl = document.createElement('span');
  fl.className = 'fl';
  fl.textContent = l.flag || l.code.toUpperCase();
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = l.native;
  btn.append(fl, nm);
  btn.addEventListener('click', () => {
    const i = langs.indexOf(l.code);
    if (i >= 0) langs.splice(i, 1);
    else langs.push(l.code);
    if (!langs.length) langs = ['en']; // never leave nothing selected
    syncLangs();
    if (startBtn.dataset.on === 'true' && FEEDS[feed].langs) startFeed();
  });
  langGrid.appendChild(btn);
}

function startFeed() {
  if (source) son.disconnect(source);
  source = FEEDS[feed].make(langs);
  setStatus('connecting', source.name);
  son.connect(source);
  setRunning(true);
}

startBtn.onclick = async () => {
  if (startBtn.dataset.on === 'true') {
    if (source) son.disconnect(source);
    source = null;
    setRunning(false);
    setStatus('idle');
    return;
  }
  await ensureAudio();
  startFeed();
};

// --- controls (advanced) --------------------------------------------------

const scaleSel = $('#scale');
for (const name of Object.keys(SCALES)) {
  const o = document.createElement('option');
  o.value = o.textContent = name;
  scaleSel.appendChild(o);
}
scaleSel.value = 'chromatic';

scaleSel.onchange = () => son.mapper.setScale(scaleSel.value);
$('#mode').onchange = (e) => {
  son.mapper.mode = e.target.value;
  son.mapper.reset();
};
$('#range').oninput = (e) => (son.mapper.range = Number(e.target.value) || 27);
$('#invert').onchange = (e) => (son.mapper.invert = e.target.checked);
$('#volume').oninput = (e) => (son.volume = Number(e.target.value) / 100);
$('#voices').oninput = (e) => (son.pool.maxVoices = Math.max(1, Number(e.target.value) || 16));
$('#kit').onchange = async (e) => {
  sampleState = 'chosen'; // an explicit choice must not be overridden later
  await son.setKit(e.target.value);
  describe({ ...son.audio.status, running: !son.locked, audible: !son.locked });
};

$('#record').onclick = async (ev) => {
  const btn = ev.currentTarget;
  if (recorder.recording) {
    btn.textContent = 'Record';
    btn.classList.remove('rec');
    await recorder.save();
  } else {
    await ensureAudio();
    recorder.start();
    btn.textContent = 'Stop and save';
    btn.classList.add('rec');
  }
};

// Filters. Anything that fails is still drawn, dimmed, but stays silent.
function activeCategories() {
  return new Set([...$('#cats').selectedOptions].map((o) => o.value));
}
// The checkboxes govern only the categories they list. A category of your own
// arriving through the ingest server must stay audible, or feeding in custom
// data yields silence with no clue why.
const LISTED = new Set([...$('#cats').options].map((o) => o.value));
son.filter((ev) => !LISTED.has(ev.category) || activeCategories().has(ev.category));
son.filter((ev) => ev.magnitude >= (Number($('#minmag').value) || 0));

// --- palette picker -------------------------------------------------------
// Swatches rather than a dropdown: the choice is visual, so the control is too.

const paletteNote = $('#palette-note');
const grids = [$('#palettes'), $('#palettes-simple')];

function selectPalette(name, persist = true) {
  canvas.setPalette(name);
  canvas.canvas.style.background = PALETTES[name].colors.background;
  paletteNote.textContent = PALETTES[name].note;
  for (const grid of grids) {
    for (const b of grid.children) {
      b.setAttribute('aria-pressed', String(b.dataset.palette === name));
    }
  }
  if (persist) store.set('tintinnabulum:palette', name);
  // The shape swatches are drawn in the palette's own colours, so they follow.
  if (typeof repaintShapeSwatches === 'function' && $('#shapes').children.length) {
    repaintShapeSwatches();
  }
}

for (const grid of grids) {
  for (const [name, def] of Object.entries(PALETTES)) {
    const { background, dots } = swatchOf(name);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pal';
    btn.dataset.palette = name;
    btn.title = def.note;
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML =
      `<span class="chip" style="background:${background}">` +
      dots.map((c) => `<i style="background:${c}"></i>`).join('') +
      `</span><small>${def.label}</small>`;
    btn.addEventListener('click', () => selectPalette(name));
    grid.appendChild(btn);
  }
}
selectPalette(canvas.paletteName, false);

// --- shape picker ---------------------------------------------------------
// Each swatch is drawn with the same drawShape() the canvas uses, so the
// preview can never drift from what you actually get.

const shapeNote = $('#shape-note');
const shapeGrids = [$('#shapes'), $('#shapes-simple')];
const SHAPE_CHOICES = [...Object.keys(SHAPES), 'mixed'];
const SHAPE_LABELS = { ...SHAPES, mixed: { label: 'Mixed', note: 'A shape per event, fixed by its identity.' } };

function selectShape(name, persist = true) {
  canvas.setShape(name);
  shapeNote.textContent = SHAPE_LABELS[name].note;
  for (const grid of shapeGrids) {
    for (const b of grid.children) {
      b.setAttribute('aria-pressed', String(b.dataset.shape === name));
    }
  }
  if (persist) store.set('tintinnabulum:shape', name);
}

function paintSwatch(cv, name) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 64;
  const h = 42;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = PALETTES[canvas.paletteName].colors;
  cv.style.background = colors.background;
  c.clearRect(0, 0, w, h);
  c.fillStyle = colors.anon;
  c.globalAlpha = 0.85;
  c.beginPath();
  drawShape(c, name, w / 2, h / 2, 13, -0.25, 0.4);
  c.fill(name === 'ring' ? 'evenodd' : 'nonzero');
}

for (const grid of shapeGrids) {
  for (const name of SHAPE_CHOICES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shp';
    btn.dataset.shape = name;
    btn.title = SHAPE_LABELS[name].note;
    btn.setAttribute('aria-pressed', 'false');
    const cv = document.createElement('canvas');
    const small = document.createElement('small');
    small.textContent = SHAPE_LABELS[name].label;
    btn.append(cv, small);
    btn.addEventListener('click', () => selectShape(name));
    grid.appendChild(btn);
    requestAnimationFrame(() => paintSwatch(cv, name));
  }
}

function repaintShapeSwatches() {
  for (const grid of shapeGrids) {
    for (const b of grid.children) paintSwatch(b.querySelector('canvas'), b.dataset.shape);
  }
}

const storedShape = store.get('tintinnabulum:shape');
selectShape(SHAPE_CHOICES.includes(storedShape) ? storedShape : DEFAULT_SHAPE, false);

// --- starry sky -----------------------------------------------------------
const starBoxes = [$('#starfield'), $('#starfield-simple')];
function setStarfield(on, persist = true) {
  canvas.setStarfield(on);
  for (const b of starBoxes) b.checked = on;
  if (persist) store.set('tintinnabulum:starfield', on ? '1' : '0');
}
for (const b of starBoxes) b.addEventListener('change', () => setStarfield(b.checked));
setStarfield(store.get('tintinnabulum:starfield') === '1', false);

// --- connection (advanced) ------------------------------------------------

function setStatus(state, name) {
  $('#conn').textContent = name ? `${name}: ${state}` : state;
}

$('#source').addEventListener('change', () => {
  const kind = $('#source').value;
  $('#ingest-row').hidden = kind !== 'ingest';
  $('#langs').closest('label').hidden = !(FEEDS[kind] && FEEDS[kind].langs) && kind !== 'wikimon';
  if (FEEDS[kind]) selectFeed(kind);
});

// The advanced view keeps a raw comma-separated field: flags are friendlier,
// but typing codes is faster once you know them. Both drive the same state.
$('#langs').addEventListener('change', () => {
  const parsed = $('#langs').value.split(/[\s,]+/).filter(Boolean);
  langs = parsed.length ? parsed : ['en'];
  syncLangs();
});

function buildSource() {
  const kind = $('#source').value;
  if (kind === 'wikimon') return wikipedia({ langs, backend: 'wikimon', onStatus: setStatus });
  if (kind === 'ingest')
    return ingestSource({
      url: $('#ingest-url').value.trim() || '/events',
      replay: 10,
      onStatus: setStatus,
    });
  if (FEEDS[kind]) return FEEDS[kind].make(langs);
  return randomSource({ rate: 5 });
}

$('#connect').onclick = async () => {
  await ensureAudio();
  if (source) son.disconnect(source);
  source = buildSource();
  setStatus('connecting', source.name);
  son.connect(source);
  setRunning(true);
};

selectFeed(feed, false);
syncLangs(false);
setRunning(false);

// --- log and stats --------------------------------------------------------

const log = $('#log');
son.on((ev) => {
  if (ev.dimmed) return;
  const li = document.createElement('li');
  const verb =
    ev.polarity > 0 ? `+${ev.magnitude}` : ev.polarity < 0 ? `−${ev.magnitude}` : `${ev.magnitude}`;
  li.textContent = `${verb}  ${ev.label || ev.id}  ${ev.source ? '(' + ev.source + ')' : ''}`;
  log.prepend(li);
  while (log.children.length > 25) log.lastChild.remove();
});

setInterval(() => {
  $('#stat').textContent = son.stats.received
    ? `${son.eventsPerMinute} events/min · ${son.audio.stats.played} played · ${son.pool.active} voices`
    : '';

  // A last safety net: if events are flowing and nothing has been played, say
  // so rather than leaving someone staring at silent circles.
  if (son.engine.locked && son.stats.received > 0) {
    setAudioStatus('Sound is suspended by the browser. Tap anywhere to resume it.', 'bad');
    refreshUnlock();
  } else if (son.stats.received > 12 && son.audio.stats.played === 0 && !son.locked) {
    setAudioStatus('Events are arriving but nothing is being played. Check the volume and the filters.', 'bad');
  }
}, 1000);

// Handy from the console: window.son.emit({magnitude: 5000, id: 'test'})
window.son = son;
