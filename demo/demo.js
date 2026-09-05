import {
  Sonifier,
  CanvasSink,
  Recorder,
  SCALES,
  wikipedia,
  ingestSource,
  randomSource,
} from '../src/index.js';

const $ = (sel) => document.querySelector(sel);

// No sampleBaseUrl: the kit resolves the banks relative to the library itself,
// so this page works from a local server, a GitHub Pages subpath, anywhere.
const son = new Sonifier({
  kit: 'hatnote',
  mapping: { mode: 'adaptive', scale: 'chromatic', range: 27, jitter: 0.5 },
  voices: { maxVoices: 16 },
  volume: 0.7,
});

const canvas = new CanvasSink('#canvas', { showHud: true });
son.use(canvas);

const recorder = new Recorder(son.engine);
let source = null;

// --- unlock ---------------------------------------------------------------

const unlockEl = $('#unlock');
function refreshUnlock() {
  unlockEl.classList.toggle('show', son.locked);
}
unlockEl.addEventListener('click', async () => {
  await son.unlock();
  refreshUnlock();
});
refreshUnlock();

// --- controls -------------------------------------------------------------

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
    btn.textContent = '● Record';
    btn.classList.remove('rec');
    await recorder.save();
  } else {
    if (son.locked) await son.unlock();
    recorder.start();
    btn.textContent = '■ Stop & save';
    btn.classList.add('rec');
  }
};

// Filters: everything that fails is drawn dimmed but stays silent, which is
// how the original treated non-article edits.
function activeCategories() {
  return new Set([...$('#cats').selectedOptions].map((o) => o.value));
}

// The checkboxes only govern the categories they actually list. Anything else
// -- a category of your own arriving through the ingest server, say "warn" --
// must stay audible, or feeding in custom data yields silence with no clue why.
const LISTED = new Set([...$('#cats').options].map((o) => o.value));
son.filter((ev) => !LISTED.has(ev.category) || activeCategories().has(ev.category));
son.filter((ev) => ev.magnitude >= (Number($('#minmag').value) || 0));

// --- connection -----------------------------------------------------------

function setStatus(state, name) {
  $('#conn').textContent = name ? `${name}: ${state}` : state;
}

// The ingest feed needs a server of its own; the others do not. Show its URL
// field only when it is selected, so a static deployment stays self-evident.
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
  if (son.locked) await son.unlock();
  if (source) son.disconnect(source);
  source = buildSource();
  setStatus('connecting', source.name);
  son.connect(source);
  refreshUnlock();
};

// --- log + stats ----------------------------------------------------------

const log = $('#log');
son.on((ev) => {
  if (ev.dimmed) return;
  const li = document.createElement('li');
  li.className = 'cat-' + ev.category;
  const verb =
    ev.polarity > 0 ? `+${ev.magnitude}` : ev.polarity < 0 ? `−${ev.magnitude}` : `${ev.magnitude}`;
  li.textContent = `${verb}  ${ev.label || ev.id}  ${ev.source ? '(' + ev.source + ')' : ''}`;
  log.prepend(li);
  while (log.children.length > 25) log.lastChild.remove();
});

setInterval(() => {
  $('#stat').textContent =
    `${son.eventsPerMinute} events/min · ${son.audio.stats.played} played · ` +
    `${son.audio.stats.dropped} dropped · ${son.pool.active} voices`;
}, 1000);

// Handy from the console: window.son.emit({magnitude: 5000, id: 'test'})
window.son = son;
