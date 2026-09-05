import {
  Sonifier,
  CanvasSink,
  Recorder,
  SCALES,
  PALETTES,
  DEFAULT_PALETTE_NAME,
  swatchOf,
  wikipedia,
  ingestSource,
  randomSource,
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
async function ensureAudio() {
  setAudioStatus('Preparing sound…');
  const status = await son.unlock();
  describe(status);
  refreshUnlock();
  return status;
}
unlockEl.addEventListener('click', ensureAudio);
refreshUnlock();

// --- the one button that matters -----------------------------------------

const startBtn = $('#start');

function setRunning(on) {
  startBtn.dataset.on = String(on);
  startBtn.textContent = on ? 'Stop' : 'Start listening to Wikipedia';
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
  if (source) son.disconnect(source);
  source = wikipedia({ langs: ['en'], backend: 'eventstreams', onStatus: setStatus });
  son.connect(source);
  setRunning(true);
};
setRunning(false);

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
  await son.setKit(e.target.value);
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

// --- connection (advanced) ------------------------------------------------

function setStatus(state, name) {
  $('#conn').textContent = name ? `${name}: ${state}` : state;
}

$('#source').addEventListener('change', () => {
  $('#ingest-row').hidden = $('#source').value !== 'ingest';
});

function buildSource() {
  const kind = $('#source').value;
  const langs = $('#langs')
    .value.split(/[\s,]+/)
    .filter(Boolean);
  if (kind === 'eventstreams')
    return wikipedia({ langs, backend: 'eventstreams', onStatus: setStatus });
  if (kind === 'wikimon') return wikipedia({ langs, backend: 'wikimon', onStatus: setStatus });
  if (kind === 'ingest')
    return ingestSource({
      url: $('#ingest-url').value.trim() || '/events',
      replay: 10,
      onStatus: setStatus,
    });
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
