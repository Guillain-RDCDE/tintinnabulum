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
  drawKitArt,
  SHAPES,
  DEFAULT_SHAPE,
  drawShape,
  SCENES,
  DEFAULT_SCENE,
  previewScene,
  WIKIPEDIA_LANGUAGES,
  WIKIPEDIA_FLAG_CC,
} from '../src/index.js';

import { $, createPicker, fitCanvas, caption } from './dom.js';
import { store } from './store.js';
import { createFeedCatalog } from './feed-catalog.js';

const storedPalette = store.pick('palette', PALETTES, DEFAULT_PALETTE_NAME);

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
  // First, synchronously, while the gesture is still ours: the right to start
  // audio does not survive an await on iOS, so loading a kit before asking
  // would spend the tap without using it.
  son.engine.resumeSync();

  // Gate on being genuinely audible, not merely on the kit having loaded. A
  // kit loads happily while the context stays blocked, and latching on that
  // turned every later tap into a no-op: the overlay kept asking, and nothing
  // it did could ever help.
  if (audioReady && !son.locked) {
    refreshUnlock();
    return son.audioStatus;
  }

  setAudioStatus('Preparing sound…');
  if (sampleState === 'pending' && currentKit === 'hatnote') await son.setKit('synth');
  const status = await son.unlock();
  audioReady = Boolean(status.audible);
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

const FEEDS = createFeedCatalog({
  getLangs: () => langs,
  getBackend: () => $('#backend').value,
  getIngestUrl: () => $('#ingest-url').value.trim() || '/events',
  onStatus: setStatus,
});

let feed = store.pick('feed', FEEDS, 'wikipedia');
let langs = (store.get('langs') || 'en').split(',').filter(Boolean);
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
  feedPicker.mark(name);
  // Feeds differ by two orders of magnitude in rate, so each may cap its own.
  son.pool.maxPerSecond = FEEDS[name].maxPerSecond || 0;
  if (persist) store.set('feed', name);
  if (startBtn.dataset.on !== 'true') setRunning(false);
}

const feedPicker = createPicker($('#feeds'), Object.entries(FEEDS), {
  key: 'feed',
  className: 'card',
  render: (btn, def) => btn.append(caption(def.label, def.blurb, { wrap: false })),
  onPick: (name) => {
    selectFeed(name);
    if (startBtn.dataset.on === 'true') startFeed();
  },
});

// --- Wikipedia editions ---------------------------------------------------
function syncLangs(persist = true) {
  langPicker.mark(langs);
  $('#langs').value = langs.join(',');
  if (persist) store.set('langs', langs.join(','));
}

const langPicker = createPicker(
  $('#langs-grid'),
  WIKIPEDIA_LANGUAGES.map((l) => [l.code, l]),
  {
    key: 'lang',
    className: 'lang',
    multi: true,
    title: (l) => `${l.name} — ${l.native} (${l.code})`,
    render: (btn, l) => {
      // An image, not an emoji: Windows ships no flag glyphs, so emoji flags
      // show as the bare letters "GB" for every visitor on a PC.
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
    },
    onPick: (code) => {
      const i = langs.indexOf(code);
      if (i >= 0) langs.splice(i, 1);
      else langs.push(code);
      if (!langs.length) langs = ['en']; // never leave nothing selected
      syncLangs();
      if (startBtn.dataset.on === 'true' && FEEDS[feed].langs) startFeed();
    },
  }
);

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

let currentKit = store.pick('kit', KITS, 'hatnote');

async function selectKit(name, { persist = true, audition = true } = {}) {
  if (!KITS[name]) return;
  currentKit = name;
  $('#kit-note').textContent = KITS[name].note;
  kitPicker.mark(name);
  if (persist) {
    store.set('kit', name);
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

// Each card carries a drawn signature rather than a waveform. An envelope is
// accurate and unreadable: twelve of them side by side look like twelve of the
// same thing, and the point of a picker is that you recognise the water and
// the night without reading the labels.
function paintKitArt(cv, name) {
  const { ctx, w, h } = fitCanvas(cv, { height: 64 });
  drawKitArt(ctx, name, { w, h, palette: PALETTES[canvas.paletteName].colors });
}

const kitPicker = createPicker($('#kits'), Object.entries(KITS), {
  key: 'kit',
  className: 'card',
  title: (def) => def.note,
  render: (btn, def) => {
    btn.append(
      document.createElement('canvas'),
      caption(def.label, def.sampled ? 'Recorded samples' : 'Synthesised')
    );
  },
  onPick: async (name) => {
    await ensureAudio();
    selectKit(name);
  },
});

const paintKitArts = () => kitPicker.repaint(paintKitArt);
requestAnimationFrame(paintKitArts);

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
  scenePicker.mark(name);
  const usesShapes = name === 'bloom';
  $('#shapes').style.opacity = usesShapes ? '1' : '.4';
  $('#shapes').style.pointerEvents = usesShapes ? '' : 'none';
  $('#shapes-label').textContent = usesShapes ? 'Shapes' : 'Shapes — used by Bloom only';
  if (persist) store.set('scene', name);
}

// Each card carries a still drawn by the scene itself, against synthetic
// events. A stored image would go stale the moment a palette changed; this
// cannot disagree with what you are about to launch.
function paintScenePreview(cv, name) {
  const { ctx, w, h } = fitCanvas(cv, { height: 84 });
  previewScene(ctx, name, {
    w,
    h,
    palette: PALETTES[canvas.paletteName].colors,
    shape: canvas.shape,
  });
}

const scenePicker = createPicker($('#scenes'), Object.entries(SCENES), {
  key: 'scene',
  className: 'card',
  title: (def) => def.note,
  render: (btn, def) => {
    btn.append(
      document.createElement('canvas'),
      caption(def.label, def.positional === false ? 'Composed view' : 'One mark per event')
    );
  },
  onPick: (name) => selectScene(name),
});

const repaintScenePreviews = () => scenePicker.repaint(paintScenePreview);
requestAnimationFrame(repaintScenePreviews);

function selectPalette(name, persist = true) {
  canvas.setPalette(name);
  canvas.canvas.style.background = PALETTES[name].colors.background;
  $('#palette-note').textContent = PALETTES[name].note;
  palettePicker.mark(name);
  if (persist) store.set('palette', name);
  // The swatches and the stills are drawn in the palette's own colours, so
  // they follow the choice rather than lying about it.
  repaintShapeSwatches();
  repaintScenePreviews();
  paintKitArts();
}

const palettePicker = createPicker($('#palettes'), Object.entries(PALETTES), {
  key: 'palette',
  className: 'sw',
  title: (def) => def.note,
  render: (btn, def, name) => {
    const { background, dots } = swatchOf(name);
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = background;
    for (const colour of dots) {
      const dot = document.createElement('i');
      dot.style.background = colour;
      chip.append(dot);
    }
    const label = document.createElement('small');
    label.textContent = def.label;
    btn.append(chip, label);
  },
  onPick: (name) => selectPalette(name),
});

// Swatches are drawn with the same drawShape() the canvas uses, so a preview
// can never drift from the result.
const SHAPE_CHOICES = [...Object.keys(SHAPES), 'mixed'];
const SHAPE_LABELS = { ...SHAPES, mixed: { label: 'Mixed', note: 'A shape per event, fixed by its identity.' } };
function selectShape(name, persist = true) {
  canvas.setShape(name);
  $('#shape-note').textContent = SHAPE_LABELS[name].note;
  shapePicker.mark(name);
  if (persist) store.set('shape', name);
}

function paintSwatch(cv, name) {
  const { ctx, w, h } = fitCanvas(cv, { height: 42, fallbackWidth: 76 });
  const colors = PALETTES[canvas.paletteName].colors;
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = colors.anon;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  drawShape(ctx, name, w / 2, h / 2, 13, -0.25, 0.4);
  ctx.fill(name === 'ring' ? 'evenodd' : 'nonzero');
}

const shapePicker = createPicker(
  $('#shapes'),
  SHAPE_CHOICES.map((name) => [name, SHAPE_LABELS[name]]),
  {
    key: 'shape',
    className: 'sw',
    title: (def) => def.note,
    render: (btn, def) => {
      const label = document.createElement('small');
      label.textContent = def.label;
      btn.append(document.createElement('canvas'), label);
    },
    onPick: (name) => selectShape(name),
  }
);

const repaintShapeSwatches = () => shapePicker.repaint(paintSwatch);
requestAnimationFrame(repaintShapeSwatches);

// How far each event's colour may stray from its category's. The wording says
// what the setting costs, not just what it does: at zero a colour identifies a
// category, and past that it stops being able to.
const RICHNESS_STEPS = [
  [0.001, 'off', 'Every event of a category is the exact same colour, so a colour identifies a category.'],
  [0.25, 'subtle', 'A slight spread, enough to tell one mark from the next where they overlap.'],
  [0.6, 'balanced', 'Each category reads as a family of shades. The default, and the best-looking on a busy feed.'],
  [1.01, 'wide', 'Shades range far enough to drift in hue. Handsome on a dense stream, no longer a colour code.'],
];

let richnessWord = 'balanced';

function selectRichness(value, persist = true) {
  const v = Math.max(0, Math.min(1, value));
  canvas.setRichness(v);
  const [, word, note] = RICHNESS_STEPS.find(([edge]) => v < edge) || RICHNESS_STEPS[3];
  richnessWord = word;
  $('#richness-val').textContent = word;
  $('#richness-note').textContent = note;
  $('#richness').value = String(Math.round(v * 100));
  if (persist) store.set('richness', String(Math.round(v * 100)));
  updateSummaries();
  // The palette swatches and stills are drawn through the same renderer, so
  // they have to be redrawn or they would advertise the wrong setting.
  repaintShapeSwatches();
  repaintScenePreviews();
}

$('#richness').addEventListener('input', (e) => selectRichness(Number(e.target.value) / 100));

$('#depth').addEventListener('change', (e) => {
  canvas.setDepth(e.target.checked);
  store.setFlag('depth', e.target.checked);
});

$('#starfield').addEventListener('change', (e) => {
  canvas.setStarfield(e.target.checked);
  store.setFlag('starfield', e.target.checked);
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
    `${SCENES[canvas.sceneName].label} · ${PALETTES[canvas.paletteName].label}` +
    (richnessWord === 'balanced' ? '' : ` · ${richnessWord} colour`);
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
  // The overlay tracks the context in both directions. It used to be refreshed
  // only while locked, so once sound started by some other route it stayed on
  // screen telling you to tap for audio you could already hear.
  // Only the overlay is updated here. Readiness is deliberately not inferred
  // from a running context: a browser that starts unblocked would latch it
  // before any kit had loaded, and unlock() -- which is what loads the kit --
  // would then never run, leaving a page that looks fine and plays nothing.
  refreshUnlock();

  if (son.engine.locked && son.stats.received > 0) {
    setAudioStatus('Sound is suspended by the browser. Tap anywhere to resume it.', 'bad');
  } else if (son.stats.received > 12 && son.audio.stats.played === 0 && !son.locked) {
    setAudioStatus('Events are arriving but nothing is being played. Check the volume and the filters.', 'bad');
  }
}, 1000);

selectFeed(feed, false);
syncLangs(false);
selectKit(currentKit, { persist: false, audition: false });
selectPalette(canvas.paletteName, false);
selectShape(store.pick('shape', SHAPE_LABELS, DEFAULT_SHAPE), false);
selectScene(store.pick('scene', SCENES, DEFAULT_SCENE), false);
selectRichness(store.number('richness', canvas.richness * 100, 0, 100) / 100, false);
$('#depth').checked = store.flag('depth', true);
canvas.setDepth($('#depth').checked);
$('#cats').addEventListener('change', updateSummaries);
$('#minmag').addEventListener('input', updateSummaries);
updateSummaries();
$('#starfield').checked = store.flag('starfield');
canvas.setStarfield($('#starfield').checked);
setRunning(false);
setAudioStatus('');

// Handy from the console: window.son.emit({magnitude: 5000, id: 'test'})
window.son = son;
