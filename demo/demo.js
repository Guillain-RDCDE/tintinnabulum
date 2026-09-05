import {
  Sonifier,
  CanvasSink,
  Recorder,
  SCALES,
  KEYS,
  PALETTES,
  DEFAULT_PALETTE_NAME,
  swatchOf,
  KITS,
  SHAPES,
  DEFAULT_SHAPE,
  drawShape,
  SCENES,
  DEFAULT_SCENE,
  previewScene,
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
  WIKIPEDIA_LANGUAGES,
  WIKIPEDIA_FLAG_CC,
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
      localStorage.setItem(k, String(v));
    } catch {
      /* ignore */
    }
  },
};

const storedPalette = PALETTES[store.get('t:palette')] ? store.get('t:palette') : DEFAULT_PALETTE_NAME;

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

// =========================================================================
// Audio state, always stated
// =========================================================================

function setAudioStatus(text, state = '') {
  const el = $('#audio-status');
  el.textContent = text;
  el.dataset.state = state;
}

function describe(status) {
  if (!status) return;
  if (!status.running) setAudioStatus('Sound is blocked by the browser. Tap anywhere to enable it.', 'bad');
  else if (!status.usable) setAudioStatus('No instrument could be loaded, so there is no sound.', 'bad');
  else if (status.fellBackToSynth)
    setAudioStatus('Sound on, using synthesis: the recorded bells could not be downloaded.', 'good');
  else if (status.problems && status.problems.length)
    setAudioStatus('Sound on. Some samples were unavailable and are covered by their neighbours.', 'good');
  else setAudioStatus('Sound on.', 'good');
}

const unlockEl = $('#unlock');
const refreshUnlock = () => unlockEl.classList.toggle('show', son.locked);

// Downloading the sample banks takes seconds on a phone, and the feed is
// already drawing by then. Start on synthesis, which needs no network, and
// move to the recorded bells once they arrive.
let sampleState = 'pending'; // pending | upgrading | done | chosen
async function upgradeToSamples() {
  if (sampleState !== 'pending' || currentKit !== 'hatnote') return;
  sampleState = 'upgrading';
  try {
    await son.setKit('hatnote');
    if (!son.audio.status || !son.audio.status.usable) throw new Error('sample kit unusable');
    sampleState = 'done';
    describe({ ...son.audio.status, running: true });
  } catch {
    await son.setKit('synth');
    sampleState = 'done';
    setAudioStatus('Sound on, using synthesis: the recorded bells could not be downloaded.', 'good');
  }
}

let audioReady = false;
async function ensureAudio() {
  // Gate on "the kit is loaded", not on "the context is running". Some
  // browsers start with a running context, and short-circuiting on that alone
  // skipped the kit load entirely -- leaving the page permanently silent.
  if (audioReady) return son.audioStatus;
  setAudioStatus('Preparing sound…');
  if (sampleState === 'pending' && currentKit === 'hatnote') await son.setKit('synth');
  const status = await son.unlock();
  audioReady = Boolean(status.usable);
  describe(status);
  refreshUnlock();
  if (status.audible) upgradeToSamples();
  return status;
}

unlockEl.addEventListener('click', ensureAudio);
refreshUnlock();

// =========================================================================
// Listen to
// =========================================================================

function setStatus(state, name) {
  $('#stat').textContent = name ? `${name}: ${state}` : state;
}

const FEEDS = {
  wikipedia: {
    label: 'Wikipedia',
    blurb: 'Live edits worldwide',
    langs: true,
    note: 'Every mark is somebody editing an article right now. A bell means text was added, a plucked string means it was removed.',
    make: () =>
      wikipedia({ langs, backend: $('#backend').value, onStatus: setStatus }),
  },
  bitcoin: {
    label: 'Bitcoin',
    blurb: 'Unconfirmed transactions',
    note: 'Each transaction as it enters the network, pitched by its value. This is where the whole idea began: Listen to Wikipedia was built after BitListen, which sonified exactly this.',
    make: () => bitcoin({ onStatus: setStatus }),
  },
  coinbase: {
    label: 'Coinbase',
    blurb: 'BTC-USD trades',
    note: 'Trades as they execute. Buys ring and sells pluck: this is the one feed that supplies a direction meaning something on its own.',
    make: () => coinbase({ onStatus: setStatus }),
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
    make: () => bluesky({ onStatus: setStatus }),
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
    make: () =>
      wikipedia({ wikis: ['commonswiki'], mainNamespaceOnly: false, onStatus: setStatus }),
  },
  wikidata: {
    label: 'Wikidata',
    blurb: 'Structured-data edits',
    note: 'The machine-readable knowledge base underneath the encyclopedias. Busy, and almost entirely the work of bots.',
    make: () => wikipedia({ wikis: ['wikidatawiki'], onStatus: setStatus }),
  },
  ingest: {
    label: 'Your own data',
    blurb: 'Via the ingest server',
    needsUrl: true,
    note: 'Anything you send to the bundled ingest server. One curl command is a complete data source — see the README.',
    make: () => ingestSource({ url: $('#ingest-url').value.trim() || '/events', replay: 10, onStatus: setStatus }),
  },
  random: {
    label: 'Synthetic',
    blurb: 'Generated traffic',
    note: 'Made-up events at a steady rate. Useful for hearing what a setting does without waiting for the world to produce something.',
    make: () => randomSource({ rate: 5 }),
  },
};

let feed = FEEDS[store.get('t:feed')] ? store.get('t:feed') : 'wikipedia';
let langs = (store.get('t:langs') || 'en').split(',').filter(Boolean);
if (!langs.length) langs = ['en'];

const startBtn = $('#start');
const setRunning = (on) => {
  startBtn.dataset.on = String(on);
  startBtn.textContent = on ? 'Stop' : `Start listening to ${FEEDS[feed].label}`;
};

function selectFeed(name, persist = true) {
  if (!FEEDS[name]) return;
  feed = name;
  $('#feed-note').textContent = FEEDS[name].note;
  $('#langs-wrap').hidden = !FEEDS[name].langs;
  $('#ingest-wrap').hidden = !FEEDS[name].needsUrl;
  for (const b of $('#feeds').children) b.setAttribute('aria-pressed', String(b.dataset.feed === name));
  // Feeds differ by two orders of magnitude in rate, so each may cap its own.
  son.pool.maxPerSecond = FEEDS[name].maxPerSecond || 0;
  if (persist) store.set('t:feed', name);
  if (startBtn.dataset.on !== 'true') setRunning(false);
}

for (const [name, def] of Object.entries(FEEDS)) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  btn.dataset.feed = name;
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = '<b></b><span></span>';
  btn.querySelector('b').textContent = def.label;
  btn.querySelector('span').textContent = def.blurb;
  btn.addEventListener('click', () => {
    selectFeed(name);
    if (startBtn.dataset.on === 'true') startFeed();
  });
  $('#feeds').appendChild(btn);
}

// --- Wikipedia editions ---------------------------------------------------
const langGrid = $('#langs-grid');
function syncLangs(persist = true) {
  for (const b of langGrid.children) b.setAttribute('aria-pressed', String(langs.includes(b.dataset.lang)));
  $('#langs').value = langs.join(',');
  if (persist) store.set('t:langs', langs.join(','));
}

for (const l of WIKIPEDIA_LANGUAGES) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lang';
  btn.dataset.lang = l.code;
  btn.title = `${l.name} — ${l.native} (${l.code})`;
  btn.setAttribute('aria-pressed', 'false');
  // An image, not an emoji: Windows ships no flag glyphs, so emoji flags show
  // as the bare letters "GB" for every visitor on a PC.
  const fl = document.createElement('img');
  fl.className = 'fl';
  fl.src = `flags/${WIKIPEDIA_FLAG_CC[l.code] || 'eo'}.svg`;
  fl.alt = '';
  fl.width = 24;
  fl.height = 18;
  fl.loading = 'lazy';
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

// The same setting, typed rather than clicked. One state, two ways in.
$('#langs').addEventListener('change', () => {
  const parsed = $('#langs').value.split(/[\s,]+/).filter(Boolean);
  langs = parsed.length ? parsed : ['en'];
  syncLangs();
  if (startBtn.dataset.on === 'true' && FEEDS[feed].langs) startFeed();
});
$('#backend').addEventListener('change', () => {
  if (startBtn.dataset.on === 'true' && FEEDS[feed].langs) startFeed();
});

function startFeed() {
  if (source) son.disconnect(source);
  source = FEEDS[feed].make();
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

// =========================================================================
// Sound
// =========================================================================

let currentKit = KITS[store.get('t:kit')] ? store.get('t:kit') : 'hatnote';

async function selectKit(name, { persist = true, audition = true } = {}) {
  if (!KITS[name]) return;
  currentKit = name;
  $('#kit-note').textContent = KITS[name].note;
  for (const b of $('#kits').children) b.setAttribute('aria-pressed', String(b.dataset.kit === name));
  if (persist) {
    store.set('t:kit', name);
    sampleState = 'chosen'; // an explicit choice is never overridden
  }
  await son.setKit(name); // while locked this only assigns
  if (son.locked) return;
  describe({ ...son.audio.status, running: true });
  // A sound cannot be judged from a label, so play a few notes.
  if (audition) {
    [4, 11, 19].forEach((_, i) =>
      setTimeout(() => son.emit({ magnitude: 900 * (3 - i), id: `audition-${name}-${i}` }), i * 170)
    );
  }
}

for (const [name, def] of Object.entries(KITS)) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  btn.dataset.kit = name;
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = '<b></b><span></span>';
  btn.querySelector('b').textContent = def.label;
  btn.querySelector('span').textContent = def.sampled ? 'Recorded samples' : 'Synthesised';
  btn.addEventListener('click', async () => {
    await ensureAudio();
    selectKit(name);
  });
  $('#kits').appendChild(btn);
}

const scaleSel = $('#scale');
for (const name of Object.keys(SCALES)) {
  const o = document.createElement('option');
  o.value = o.textContent = name;
  scaleSel.appendChild(o);
}
scaleSel.value = 'chromatic';
scaleSel.onchange = () => son.mapper.setScale(scaleSel.value);

const keySel = $('#key');
KEYS.forEach((name, semis) => {
  const o = document.createElement('option');
  o.value = String(semis);
  o.textContent = name;
  keySel.appendChild(o);
});
keySel.onchange = (e) => (son.mapper.root = Number(e.target.value) || 0);

// Free time means notes sound the instant their event arrives, which is by
// definition arrhythmic. A tempo holds each note to the next subdivision.
function applyTempo() {
  const bpm = Number($('#bpm').value) || 0;
  $('#bpm-val').textContent = bpm ? `${bpm} bpm` : 'free';
  son.audio.setTempo(bpm, Number($('#division').value) || 8);
}
$('#bpm').oninput = applyTempo;
$('#division').onchange = applyTempo;

$('#humanise').oninput = (e) => {
  const v = Number(e.target.value) / 10; // 0 to 2 semitones of wobble
  son.mapper.jitter = v;
  $('#humanise-val').textContent = v ? `± ${v.toFixed(1)} semitones` : '0';
};

$('#mode').onchange = (e) => {
  son.mapper.mode = e.target.value;
  son.mapper.reset();
};
$('#range').oninput = (e) => (son.mapper.range = Number(e.target.value) || 27);
$('#invert').onchange = (e) => (son.mapper.invert = e.target.checked);
$('#volume').oninput = (e) => (son.volume = Number(e.target.value) / 100);
$('#voices').oninput = (e) => (son.pool.maxVoices = Math.max(1, Number(e.target.value) || 16));

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

// =========================================================================
// Look
// =========================================================================

// Scenes are whole ways of drawing the same events. Shapes only apply to the
// ones that draw a mark per event, so the shape picker follows the choice.
function selectScene(name, persist = true) {
  if (!SCENES[name]) return;
  canvas.setScene(name);
  $('#scene-note').textContent = SCENES[name].note;
  for (const b of $('#scenes').children) b.setAttribute('aria-pressed', String(b.dataset.scene === name));
  const usesShapes = name === 'bloom';
  $('#shapes').style.opacity = usesShapes ? '1' : '.4';
  $('#shapes').style.pointerEvents = usesShapes ? '' : 'none';
  $('#shapes-label').textContent = usesShapes ? 'Shapes' : 'Shapes — used by Bloom only';
  if (persist) store.set('t:scene', name);
}

// Each card carries a still drawn by the scene itself, against synthetic
// events. A stored image would go stale the moment a palette changed; this
// cannot disagree with what you are about to launch.
function paintScenePreview(cv, name) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth || 148;
  const h = 84;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  previewScene(c, name, {
    w, h,
    palette: PALETTES[canvas.paletteName].colors,
    shape: canvas.shape,
  });
}

for (const [name, def] of Object.entries(SCENES)) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  btn.dataset.scene = name;
  btn.setAttribute('aria-pressed', 'false');
  btn.title = def.note;
  const cv = document.createElement('canvas');
  const cap = document.createElement('span');
  cap.className = 'cap';
  cap.innerHTML = '<b></b><span></span>';
  cap.querySelector('b').textContent = def.label;
  cap.querySelector('span').textContent =
    def.positional === false ? 'Composed view' : 'One mark per event';
  btn.append(cv, cap);
  btn.addEventListener('click', () => selectScene(name));
  $('#scenes').appendChild(btn);
  requestAnimationFrame(() => paintScenePreview(cv, name));
}

function repaintScenePreviews() {
  for (const b of $('#scenes').children) paintScenePreview(b.querySelector('canvas'), b.dataset.scene);
}

const paletteGrid = $('#palettes');
function selectPalette(name, persist = true) {
  canvas.setPalette(name);
  canvas.canvas.style.background = PALETTES[name].colors.background;
  $('#palette-note').textContent = PALETTES[name].note;
  for (const b of paletteGrid.children) b.setAttribute('aria-pressed', String(b.dataset.palette === name));
  if (persist) store.set('t:palette', name);
  // The swatches and the scene stills are drawn in the palette's own colours,
  // so they follow the choice rather than lying about it.
  if ($('#shapes').children.length) repaintShapeSwatches();
  if ($('#scenes').children.length) repaintScenePreviews();
}

for (const [name, def] of Object.entries(PALETTES)) {
  const { background, dots } = swatchOf(name);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sw';
  btn.dataset.palette = name;
  btn.title = def.note;
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML =
    `<span class="chip" style="background:${background}">` +
    dots.map((c) => `<i style="background:${c}"></i>`).join('') +
    `</span><small>${def.label}</small>`;
  btn.addEventListener('click', () => selectPalette(name));
  paletteGrid.appendChild(btn);
}

// Swatches are drawn with the same drawShape() the canvas uses, so a preview
// can never drift from the result.
const SHAPE_CHOICES = [...Object.keys(SHAPES), 'mixed'];
const SHAPE_LABELS = { ...SHAPES, mixed: { label: 'Mixed', note: 'A shape per event, fixed by its identity.' } };
const shapeGrid = $('#shapes');

function selectShape(name, persist = true) {
  canvas.setShape(name);
  $('#shape-note').textContent = SHAPE_LABELS[name].note;
  for (const b of shapeGrid.children) b.setAttribute('aria-pressed', String(b.dataset.shape === name));
  if (persist) store.set('t:shape', name);
}

function paintSwatch(cv, name) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 76;
  const h = 42;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = PALETTES[canvas.paletteName].colors;
  c.fillStyle = colors.background;
  c.fillRect(0, 0, w, h);
  c.fillStyle = colors.anon;
  c.globalAlpha = 0.9;
  c.beginPath();
  drawShape(c, name, w / 2, h / 2, 13, -0.25, 0.4);
  c.fill(name === 'ring' ? 'evenodd' : 'nonzero');
}

for (const name of SHAPE_CHOICES) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sw';
  btn.dataset.shape = name;
  btn.title = SHAPE_LABELS[name].note;
  btn.setAttribute('aria-pressed', 'false');
  const cv = document.createElement('canvas');
  const small = document.createElement('small');
  small.textContent = SHAPE_LABELS[name].label;
  btn.append(cv, small);
  btn.addEventListener('click', () => selectShape(name));
  shapeGrid.appendChild(btn);
  requestAnimationFrame(() => paintSwatch(cv, name));
}

function repaintShapeSwatches() {
  for (const b of shapeGrid.children) paintSwatch(b.querySelector('canvas'), b.dataset.shape);
}

$('#starfield').addEventListener('change', (e) => {
  canvas.setStarfield(e.target.checked);
  store.set('t:starfield', e.target.checked ? '1' : '0');
});
$('#labels').addEventListener('change', (e) => (canvas.showLabels = e.target.checked));
$('#hud').addEventListener('change', (e) => (canvas.showHud = e.target.checked));

// =========================================================================
// Filter
// =========================================================================

const activeCategories = () => new Set([...$('#cats').selectedOptions].map((o) => o.value));
// The list governs only the categories it names. A category of your own
// arriving through the ingest server must stay audible, or feeding in custom
// data yields silence with no clue why.
const LISTED = new Set([...$('#cats').options].map((o) => o.value));
son.filter((ev) => !LISTED.has(ev.category) || activeCategories().has(ev.category));
son.filter((ev) => ev.magnitude >= (Number($('#minmag').value) || 0));

// =========================================================================
// Activity and startup
// =========================================================================

// Each panel header carries its own current value, so the whole configuration
// can be read at a glance without opening anything.
function updateSummaries() {
  const cats = [...$('#cats').selectedOptions].map((o) => o.value);
  const minmag = Number($('#minmag').value) || 0;
  const langNames = langs
    .map((c) => (WIKIPEDIA_LANGUAGES.find((l) => l.code === c) || {}).native || c)
    .slice(0, 3)
    .join(', ');
  $('#sum-listen').textContent =
    FEEDS[feed].label + (FEEDS[feed].langs ? ` · ${langNames}${langs.length > 3 ? '…' : ''}` : '');
  $('#sum-sound').textContent =
    KITS[currentKit].label + (son.audio.tempo.bpm ? ` · ${son.audio.tempo.bpm} bpm` : '');
  $('#sum-look').textContent =
    `${SCENES[canvas.sceneName].label} · ${PALETTES[canvas.paletteName].label}`;
  $('#sum-filter').textContent =
    (cats.length === 4 ? 'Everything' : cats.join(', ') || 'Nothing') +
    (minmag > 0 ? ` · above ${minmag}` : '');
}

const log = $('#log');
son.on((ev) => {
  if (ev.dimmed || !$('#sec-activity').open) return;
  const li = document.createElement('li');
  const verb = ev.polarity > 0 ? `+${ev.magnitude}` : ev.polarity < 0 ? `−${ev.magnitude}` : `${ev.magnitude}`;
  li.textContent = `${verb}  ${ev.label || ev.id}  ${ev.source ? '(' + ev.source + ')' : ''}`;
  log.prepend(li);
  while (log.children.length > 25) log.lastChild.remove();
});

setInterval(() => {
  if (son.stats.received) {
    $('#stat').textContent =
      `${son.eventsPerMinute}/min · ${son.audio.stats.played} played · ${son.pool.active} voices`;
    $('#sum-activity').textContent = `${son.eventsPerMinute} events per minute`;
  }
  updateSummaries();
  if (son.engine.locked && son.stats.received > 0) {
    setAudioStatus('Sound is suspended by the browser. Tap anywhere to resume it.', 'bad');
    refreshUnlock();
  } else if (son.stats.received > 12 && son.audio.stats.played === 0 && !son.locked) {
    setAudioStatus('Events are arriving but nothing is being played. Check the volume and the filters.', 'bad');
  }
}, 1000);

selectFeed(feed, false);
syncLangs(false);
selectKit(currentKit, { persist: false, audition: false });
selectPalette(canvas.paletteName, false);
selectShape(SHAPE_CHOICES.includes(store.get('t:shape')) ? store.get('t:shape') : DEFAULT_SHAPE, false);
selectScene(SCENES[store.get('t:scene')] ? store.get('t:scene') : DEFAULT_SCENE, false);
$('#cats').addEventListener('change', updateSummaries);
$('#minmag').addEventListener('input', updateSummaries);
updateSummaries();
$('#starfield').checked = store.get('t:starfield') === '1';
canvas.setStarfield($('#starfield').checked);
setRunning(false);
setAudioStatus('');

// Handy from the console: window.son.emit({magnitude: 5000, id: 'test'})
window.son = son;
