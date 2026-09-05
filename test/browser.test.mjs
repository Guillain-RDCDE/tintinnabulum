// Browser-half checks: sample decoding, audio synthesis, scheduling, canvas.
//
// Everything here needs a real Web Audio implementation and a real canvas, so
// it runs headless Chromium rather than Node. Playwright is NOT a dependency of
// this project: if it is absent the suite reports "skipped" and exits 0.
//
//   npm i -D playwright-core && node test/browser.test.mjs
//
// The audio assertions do not merely check that nothing threw. They render the
// instruments through an OfflineAudioContext and measure the peak amplitude, so
// a silent instrument fails.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('skipped - playwright-core is not installed');
    console.log('  npm i -D playwright-core   then re-run');
    process.exit(0);
  }
}

const SERVER = fileURLToPath(new URL('../server/ingest.mjs', import.meta.url));
const PORT = Number(process.env.TEST_PORT || 8793);
const BASE = process.env.TEST_BASE || `http://127.0.0.1:${PORT}`;
const USE_LOCAL_SERVER = !process.env.TEST_BASE;

let fails = 0;
const ok = (n, c, x = '') => {
  if (!c) {
    fails++;
    console.log('FAIL  ' + n + (x ? '  ' + x : ''));
  } else console.log('ok    ' + n + (x ? '  ' + x : ''));
};

let srv = null;
if (USE_LOCAL_SERVER) {
  srv = spawn(process.execPath, [SERVER, '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + '/health');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function launch() {
  const args = ['--autoplay-policy=no-user-gesture-required'];
  try {
    return await chromium.launch({ headless: true, channel: 'chrome', args });
  } catch {
    return await chromium.launch({ headless: true, args });
  }
}

const browser = await launch();
const page = await browser.newPage();
const consoleErrors = [];
const badResponses = [];
// One check below deliberately requests files that do not exist, to prove a
// partly-broken sample bank still plays. Those failures are expected, so page
// hygiene is not recorded while that probe runs.
let probing = false;
page.on('console', (m) => {
  if (!probing && m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => {
  if (!probing) consoleErrors.push('pageerror: ' + e.message);
});
page.on('response', (r) => {
  if (!probing && r.status() >= 400) badResponses.push(r.status() + ' ' + r.url());
});

const resp = await page.goto(BASE + '/demo/', { waitUntil: 'networkidle' });
ok('demo page loads', resp && resp.ok(), 'status=' + (resp && resp.status()));

// The sandbox root must redirect here, or the Pages URL is a dead end.
const rootResp = await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForURL(/\/demo\/?$/, { timeout: 10000 }).catch(() => {});
ok('site root redirects to the sandbox', /\/demo\/?$/.test(page.url()), page.url());
ok('root returned 200', rootResp && rootResp.ok());

await page.waitForFunction(() => window.son, null, { timeout: 15000 });
ok('engine is exposed on the page', true);

// --- one surface, progressively disclosed --------------------------------
// There used to be a "simple" and an "advanced" screen that duplicated most
// controls, with the same setting offered two different ways. Now every
// setting exists exactly once, and the deeper ones are revealed in place.
const openMore = async (sel) => {
  await page.evaluate((s) => {
    const d = document.querySelector(s);
    if (d && !d.open) d.open = true;
  }, sel);
};

for (const sec of ['#sec-listen', '#sec-sound', '#sec-look', '#sec-filter', '#sec-activity']) {
  ok(`${sec.replace('#sec-', '')} is on the page from the start`,
     await page.locator(sec).isVisible());
}
ok('there is a single obvious start button', await page.locator('#start').isVisible());
ok('the essentials need no digging',
   (await page.locator('#feeds .card').count()) >= 6 &&
   (await page.locator('#kits .card').count()) >= 6 &&
   (await page.locator('#palettes .sw').count()) >= 8);

const disclosures = await page.evaluate(() =>
  [...document.querySelectorAll('details.more')].map((d) => ({ id: d.id, open: d.open }))
);
ok('advanced options exist but stay folded away', disclosures.length >= 4 && disclosures.every((d) => !d.open),
   disclosures.map((d) => d.id).join(', '));

// The duplication that made the old interface confusing must not come back.
const dupes = await page.evaluate(() => {
  const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
  const seen = new Set();
  const dup = new Set();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  const controls = [...document.querySelectorAll('[data-feed],[data-kit],[data-palette],[data-shape],[data-lang]')];
  const keys = controls.map((c) => JSON.stringify(c.dataset));
  const dupControls = keys.length - new Set(keys).size;
  return { dupIds: [...dup], dupControls };
});
ok('no element id appears twice', dupes.dupIds.length === 0, dupes.dupIds.join(', '));
ok('no control is offered in two places', dupes.dupControls === 0, dupes.dupControls + ' duplicated');

// --- unlock + sample decoding -------------------------------------------
const unlocked = await page.evaluate(async () => {
  await window.son.unlock();
  return {
    state: window.son.engine.ctx.state,
    instruments: window.son.audio.instruments().map((i) => ({
      name: i.name,
      ready: Boolean(i.ready),
      buffers: i._buffers ? i._buffers.length : null,
    })),
  };
});
ok('AudioContext is running after unlock', unlocked.state === 'running', unlocked.state);
const banks = unlocked.instruments.filter((i) => i.buffers !== null);
ok('all three sample banks decoded', banks.length === 3 && banks.every((b) => b.ready),
   banks.map((b) => `${b.name}:${b.buffers}`).join(' '));
ok('celesta bank has all 27 notes',
   banks.some((b) => b.name === 'celesta' && b.buffers === 27),
   JSON.stringify(banks.map((b) => b.buffers)));

// Decoded audio must not be silent -- a 404 that decoded to nothing would
// otherwise pass every check above.
const bankPeak = await page.evaluate(() => {
  const inst = window.son.audio.instruments().find((i) => i.name === 'celesta');
  const buf = inst._buffers[10];
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  return { peak, duration: buf.duration, rate: buf.sampleRate };
});
ok('decoded sample carries real audio', bankPeak.peak > 0.01,
   `peak=${bankPeak.peak.toFixed(3)} dur=${bankPeak.duration.toFixed(2)}s`);

// --- instruments actually produce sound ---------------------------------
// Rendered offline, so this does not depend on a working output device.
const rendered = await page.evaluate(async () => {
  const mod = await import('../src/audio/instruments.js');
  const out = {};
  const measure = async (inst, semitone) => {
    const off = new OfflineAudioContext(1, 44100 * 2, 44100);
    if (inst.load) await inst.load(off);
    const v = inst.play(off, off.destination, { semitone, velocity: 1 });
    if (!v) return -1;
    const buf = await off.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    return peak;
  };
  const synth = mod.synthKit();
  out.synthBell = await measure(synth.add, 12);
  out.synthPluck = await measure(synth.sub, 4);
  const samples = mod.hatnoteKit();
  out.sampleCelesta = await measure(samples.add, 9);
  out.sampleClav = await measure(samples.sub, 20);
  // Continuous pitch: a semitone far outside the recorded range must still
  // sound, which is the whole point of resampling through playbackRate.
  out.sampleStretched = await measure(samples.add, 34);
  return out;
});
ok('FM bell renders audible signal', rendered.synthBell > 0.01, 'peak=' + rendered.synthBell?.toFixed(3));
ok('synth pluck renders audible signal', rendered.synthPluck > 0.01, 'peak=' + rendered.synthPluck?.toFixed(3));
ok('sampled celesta renders audible signal', rendered.sampleCelesta > 0.01, 'peak=' + rendered.sampleCelesta?.toFixed(3));
ok('sampled clav renders audible signal', rendered.sampleClav > 0.01, 'peak=' + rendered.sampleClav?.toFixed(3));
ok('resampling past the recorded range still sounds', rendered.sampleStretched > 0.01,
   'peak=' + rendered.sampleStretched?.toFixed(3));

// --- resilience: a bank with missing files must still play --------------
// This is the bug that made the page silent on a phone: one failed request out
// of fifty-seven used to reject the whole load and leave the instrument mute
// forever, while the canvas carried on drawing.
probing = true;
const partial = await page.evaluate(async () => {
  const { SampleInstrument } = await import('../src/audio/instruments.js');
  const files = [];
  for (let i = 1; i <= 27; i++) files.push('c' + String(i).padStart(3, '0'));
  // Break a third of the bank by pointing those names at files that do not exist.
  const broken = files.map((f, i) => (i % 3 === 0 ? f + '-does-not-exist' : f));
  const inst = new SampleInstrument({
    name: 'partial',
    baseUrl: new URL('../sounds/celesta/', location.href).href,
    files: broken,
  });
  const off = new OfflineAudioContext(1, 44100 * 2, 44100);
  await inst.load(off);
  if (!inst.ready) return { ready: false };
  const v = inst.play(off, off.destination, { semitone: 0, velocity: 1 }); // a missing index
  const buf = await off.startRendering();
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  return { ready: true, coverage: inst.coverage, failures: inst.failures.length, peak, played: Boolean(v) };
});
probing = false;
ok('a bank with missing files still loads', partial.ready === true);
ok('the failures are recorded rather than swallowed', partial.failures === 9, 'failures=' + partial.failures);
ok('coverage is reported honestly', Math.abs(partial.coverage - 18 / 27) < 0.01,
   'coverage=' + (partial.coverage || 0).toFixed(2));
ok('a missing note is covered by its neighbour and still sounds', partial.peak > 0.01,
   'peak=' + (partial.peak || 0).toFixed(3));

// --- every kit must actually make a sound -------------------------------
// Rendered offline and measured. A synth preset with one bad parameter is
// silent, and silence is exactly the failure this project keeps hitting.
const kitPeaks = await page.evaluate(async () => {
  const m = await import('../src/audio/instruments.js');
  const out = {};
  for (const name of Object.keys(m.KITS)) {
    const kit = m.KITS[name].make();
    out[name] = {};
    for (const role of ['add', 'sub', 'accent']) {
      const inst = kit[role];
      if (!inst) continue;
      const off = new OfflineAudioContext(1, 44100 * 3, 44100);
      try {
        if (inst.load) await inst.load(off);
        const v = inst.play(off, off.destination, { semitone: 9, velocity: 1 });
        if (!v) {
          out[name][role] = -1;
          continue;
        }
        const buf = await off.startRendering();
        const d = buf.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
        out[name][role] = Number(peak.toFixed(3));
      } catch (e) {
        out[name][role] = 'ERR ' + e.message;
      }
    }
  }
  return out;
});
const silentRoles = [];
for (const [kit, roles] of Object.entries(kitPeaks)) {
  for (const [role, peak] of Object.entries(roles)) {
    if (typeof peak !== 'number' || peak < 0.01) silentRoles.push(`${kit}.${role}=${peak}`);
  }
}
ok('every kit sounds in every role', silentRoles.length === 0, silentRoles.join(' '));
ok('there are several kits to choose from', Object.keys(kitPeaks).length >= 6,
   Object.keys(kitPeaks).join(', '));

// The pitch-swept presets are the new mechanism, so they get their own check:
// a sweep that fails leaves a flat tone, which still passes a peak test.
const sweepWorks = await page.evaluate(async () => {
  const m = await import('../src/audio/instruments.js');
  const render = async (preset) => {
    const off = new OfflineAudioContext(1, 44100, 44100);
    const inst = new m.SynthInstrument({ preset, baseFreq: 440 });
    inst.play(off, off.destination, { semitone: 0, velocity: 1 });
    const buf = await off.startRendering();
    const d = buf.getChannelData(0);
    // Count zero crossings in the first and last part of the note: a rising
    // sweep crosses zero more often later than earlier.
    const cross = (from, to) => {
      let n = 0;
      for (let i = from + 1; i < to; i++) if (d[i - 1] < 0 !== d[i] < 0) n++;
      return n;
    };
    return { early: cross(200, 1800), late: cross(2600, 4200) };
  };
  return { drop: await render('drop'), bell: await render('bell') };
});
ok('the water drop really bends its pitch upward',
   sweepWorks.drop.late > sweepWorks.drop.early * 1.15,
   `early=${sweepWorks.drop.early} late=${sweepWorks.drop.late}`);
ok('a preset without a sweep holds its pitch',
   Math.abs(sweepWorks.bell.late - sweepWorks.bell.early) < sweepWorks.bell.early * 0.5,
   `early=${sweepWorks.bell.early} late=${sweepWorks.bell.late}`);

// --- live pipeline: events in, notes and pixels out ---------------------
const live = await page.evaluate(async () => {
  const son = window.son;
  const before = { played: son.audio.stats.played, received: son.stats.received };
  const canvas = son.sinks.find((s) => s.particles);
  for (let i = 0; i < 40; i++) {
    son.emit({ magnitude: Math.round(Math.exp(Math.random() * 9)) * (i % 3 ? 1 : -1), id: 'test-' + i });
  }
  await new Promise((r) => setTimeout(r, 300));
  return {
    received: son.stats.received - before.received,
    played: son.audio.stats.played - before.played,
    particles: canvas ? canvas.particles.length : -1,
    voices: son.pool.active,
    epm: son.eventsPerMinute,
  };
});
ok('events reach the engine', live.received === 40, 'received=' + live.received);
ok('notes were actually scheduled', live.played > 0, 'played=' + live.played);
ok('canvas drew the events', live.particles >= 40, 'particles=' + live.particles);
ok('voice pool stayed within its ceiling', live.voices <= 16, 'active=' + live.voices);

// Canvas must have non-background pixels, i.e. it really painted.
const painted = await page.evaluate(() => {
  const c = document.querySelector('#canvas');
  const ctx = c.getContext('2d');
  const { data } = ctx.getImageData(0, 0, c.width, Math.min(c.height, 400));
  let distinct = 0;
  for (let i = 0; i < data.length; i += 4 * 97) {
    if (data[i] > 60 || data[i + 1] > 60 || data[i + 2] > 70) distinct++;
  }
  return { distinct, w: c.width, h: c.height };
});
ok('canvas surface has painted pixels', painted.distinct > 5,
   `bright samples=${painted.distinct} size=${painted.w}x${painted.h}`);

// --- voice stealing under real load -------------------------------------
const flood = await page.evaluate(async () => {
  const son = window.son;
  const before = son.pool.stats.stolen + son.pool.stats.denied;
  for (let i = 0; i < 400; i++) son.emit({ magnitude: 1 + (i % 900), id: 'flood-' + i });
  await new Promise((r) => setTimeout(r, 200));
  return {
    limited: son.pool.stats.stolen + son.pool.stats.denied - before,
    active: son.pool.active,
  };
});
ok('polyphony is limited under flood', flood.limited > 0, 'stolen+denied=' + flood.limited);
ok('voice count stays bounded under flood', flood.active <= 16, 'active=' + flood.active);

// --- palette picker -----------------------------------------------------
const swatchCount = await page.locator('#palettes .sw').count();
ok('every palette has a swatch in the picker', swatchCount >= 8, swatchCount + ' swatches');

const groundOf = () =>
  page.evaluate(() => {
    const c = document.querySelector('#canvas');
    const d = c.getContext('2d').getImageData(2, 2, 1, 1).data;
    return [d[0], d[1], d[2]].join(',');
  });

const beforeGround = await groundOf();
await page.click('#palettes .sw[data-palette="daylight"]');
await page.waitForTimeout(120);
const afterGround = await groundOf();
ok('choosing a palette repaints the canvas ground', beforeGround !== afterGround,
   `${beforeGround} -> ${afterGround}`);
ok('daylight really is a light ground',
   Number(afterGround.split(',')[0]) > 200, afterGround);

const recoloured = await page.evaluate(() => {
  const sink = window.son.sinks.find((s) => s.particles);
  window.son.emit({ magnitude: 5000, id: 'palette-probe', category: 'anon' });
  const born = sink.particles[sink.particles.length - 1].color;
  sink.setPalette('ultraviolet');
  const after = sink.particles[sink.particles.length - 1].color;
  return { born, after, name: sink.paletteName };
});
ok('circles already on screen are recoloured by a palette change',
   recoloured.born !== recoloured.after, `${recoloured.born} -> ${recoloured.after}`);
ok('the sink reports the palette it is using', recoloured.name === 'ultraviolet', recoloured.name);

// The choice must survive a reload, and must not break when storage is denied.
await page.click('#palettes .sw[data-palette="bronze"]');
await page.waitForTimeout(100);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.son, null, { timeout: 15000 });
const restored = await page.evaluate(
  () => window.son.sinks.find((s) => s.particles).paletteName
);
ok('the palette choice survives a reload', restored === 'bronze', restored);

// The reload left a fresh, suspended AudioContext. Without this the recorder
// check below would capture silence and still pass on size alone.
await page.evaluate(() => window.son.unlock());
ok('audio unlocks again after the reload',
   (await page.evaluate(() => window.son.engine.ctx.state)) === 'running');

// --- changing instruments must not create a silent window ----------------
// Regression: swapping the kit before loading it left every note dropped for
// as long as the download took, which on a phone is seconds.
const swap = await page.evaluate(async () => {
  const son = window.son;
  await son.setKit('synth');
  const before = son.audio.stats.played;
  const pending = son.setKit('hatnote'); // deliberately not awaited
  for (let i = 0; i < 12; i++) son.emit({ magnitude: 500 * (i + 1), id: 'swap-' + i });
  await new Promise((r) => setTimeout(r, 200));
  const during = son.audio.stats.played - before;
  await pending;
  const mid = son.audio.stats.played;
  for (let i = 0; i < 12; i++) son.emit({ magnitude: 700 * (i + 1), id: 'swapped-' + i });
  await new Promise((r) => setTimeout(r, 200));
  return { during, after: son.audio.stats.played - mid };
});
ok('notes keep sounding while a new kit is loading', swap.during > 0, 'played=' + swap.during);
ok('notes still sound once the new kit is in', swap.after > 0, 'played=' + swap.after);

// --- the way out of the sandbox -----------------------------------------
// Without this a shared link is a dead end: no way to reach the project.
const homeHref = await page.getAttribute('#home', 'href');
const srcHref = await page.getAttribute('#source-link', 'href');
const REPO = 'https://github.com/Guillain-RDCDE/tintinnabulum';
ok('the title links back to the repository', homeHref === REPO, String(homeHref));
ok('there is a visible source link too', srcHref === REPO, String(srcHref));

// --- shape picker --------------------------------------------------------
const shapeCount = await page.locator('#shapes .sw').count();
ok('every shape has a swatch', shapeCount >= 8, shapeCount + ' shapes');
ok('the shape swatches are drawn, not empty', await page.evaluate(() => {
  const cv = document.querySelector('#shapes .sw canvas');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let lit = 0;
  for (let i = 3; i < d.length; i += 4 * 41) if (d[i] > 10) lit++;
  return lit > 5;
}));

// Draw one event of known identity, snapshot, change shape, redraw, compare.
// Same id and same delay, so only the geometry differs between the two.
const renderWith = async (shape) => {
  await page.click(`#shapes .sw[data-shape="${shape}"]`);
  return page.evaluate(async () => {
    const sink = window.son.sinks.find((s) => s.particles);
    sink.clear();
    window.son.emit({ magnitude: 90000, id: 'shape-probe' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = document.querySelector('#canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4 * 37) sum += d[i] + d[i + 1] + d[i + 2];
    return sum;
  });
};
const sigCircle = await renderWith('circle');
const sigStar = await renderWith('star');
const sigRing = await renderWith('ring');
ok('switching to a star changes what is drawn', sigCircle !== sigStar, `${sigCircle} vs ${sigStar}`);
ok('the hollow ring differs from both', sigRing !== sigCircle && sigRing !== sigStar, String(sigRing));
ok('the sink reports the shape in use',
   (await page.evaluate(() => window.son.sinks.find((s) => s.particles).shape)) === 'ring');

// --- scenes --------------------------------------------------------------
// Every scene must actually draw. A scene that throws, or quietly paints
// nothing, would leave a blank canvas while the audio carried on -- the visual
// twin of the silent-audio bug this project keeps running into.
const sceneNames = await page.evaluate(async () => {
  const m = await import('../src/visual/scenes.js');
  return m.SCENE_NAMES;
});
ok('several visualisations are available', sceneNames.length >= 6, sceneNames.join(', '));
ok('every scene is offered in the picker',
   (await page.locator('#scenes .card').count()) === sceneNames.length,
   (await page.locator('#scenes .card').count()) + ' cards');

const sceneErrors = [];
const blank = [];
const inkOf = () =>
  page.evaluate(() => {
    const c = document.querySelector('#canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const bg = [d[0], d[1], d[2]];
    let ink = 0;
    for (let i = 0; i < d.length; i += 4 * 29) {
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) ink++;
    }
    return ink;
  });

for (const name of sceneNames) {
  const before = consoleErrors.length;
  await page.evaluate((n) => {
    const sink = window.son.sinks.find((s) => s.particles);
    sink.clear();
    sink.setScene(n);
    for (let i = 0; i < 45; i++) {
      window.son.emit({ magnitude: Math.round(Math.exp(Math.random() * 9)), id: `scene-${n}-${i}` });
    }
  }, name);
  // Several frames: the moving scenes need time to travel before they mark.
  await page.waitForTimeout(450);
  const ink = await inkOf();
  if (ink < 8) blank.push(`${name}(${ink})`);
  if (consoleErrors.length > before) sceneErrors.push(name);
}
ok('every scene paints something', blank.length === 0, blank.join(' ') || 'all drew');
ok('no scene throws while drawing', sceneErrors.length === 0, sceneErrors.join(' '));

// Scenes size their own structures to the canvas, so a resize must not break
// them: the grid allocates arrays from the dimensions.
await page.evaluate(() => {
  const sink = window.son.sinks.find((s) => s.particles);
  sink.setScene('grid');
  for (let i = 0; i < 20; i++) window.son.emit({ magnitude: 500, id: 'grid-' + i });
});
await page.setViewportSize({ width: 700, height: 620 });
await page.waitForTimeout(300);
await page.evaluate(() => {
  for (let i = 0; i < 20; i++) window.son.emit({ magnitude: 900, id: 'grid-after-' + i });
});
await page.waitForTimeout(300);
ok('a scene survives the canvas being resized under it', (await inkOf()) > 8);
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(200);

// The extension point is the point: adding a visualisation must be adding one
// object, with no change to the engine.
const custom = await page.evaluate(async () => {
  const m = await import('../src/visual/scenes.js');
  m.registerScene('test-only', {
    label: 'Test',
    frame(ctx, api) {
      ctx.fillStyle = api.palette.alert;
      ctx.fillRect(10, 10, api.w - 20, api.h - 20);
    },
  });
  const sink = window.son.sinks.find((s) => s.particles);
  sink.setScene('test-only');
  return sink.sceneName;
});
ok('a scene can be registered from outside the library', custom === 'test-only', String(custom));
await page.waitForTimeout(200);
ok('the registered scene really draws', (await inkOf()) > 50);
await page.evaluate(() => window.son.sinks.find((s) => s.particles).setScene('bloom'));

// --- starry sky ----------------------------------------------------------
const emptyGround = async () =>
  page.evaluate(async () => {
    const sink = window.son.sinks.find((s) => s.particles);
    sink.clear();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = document.querySelector('#canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4 * 13) sum += d[i] + d[i + 1] + d[i + 2];
    return sum;
  });
const plainGround = await emptyGround();
await openMore('#more-look');
await page.check('#starfield');
const starryGround = await emptyGround();
// Not merely "different": the sky has to be visible, so require a real change
// on an otherwise empty canvas rather than a few stray pixels.
const starDelta = Math.abs(starryGround - plainGround) / plainGround;
ok('the starry sky is plainly visible on an empty canvas', starDelta > 0.004,
   `${(starDelta * 100).toFixed(2)}% change`);
ok('the sink records the starfield setting',
   (await page.evaluate(() => window.son.sinks.find((s) => s.particles).starfield)) === true);
await page.uncheck('#starfield');

// --- feed and language pickers ------------------------------------------
// The pickers are exercised, not the remote feeds: asserting on live Bitcoin
// or GitHub traffic would make this suite fail for reasons that have nothing
// to do with the code.
const feedCount = await page.locator('#feeds .card').count();
ok('several live feeds are offered', feedCount >= 6, feedCount + ' feeds');

await page.click('#feeds .card[data-feed="earthquakes"]');
ok('choosing a feed renames the start button',
   /earthquakes/i.test(await page.textContent('#start')),
   await page.textContent('#start'));
ok('choosing a feed explains what it is',
   (await page.textContent('#feed-note')).length > 40);
ok('the chosen feed is the one shown as chosen',
   (await page.getAttribute('#feeds .card[data-feed="earthquakes"]', 'aria-pressed')) === 'true');
ok('editions are hidden for a feed that has none',
   await page.locator('#langs-wrap').isHidden());

await page.click('#feeds .card[data-feed="wikipedia"]');
ok('editions come back for Wikipedia', await page.locator('#langs-wrap').isVisible());
ok('the ingest URL only appears for the ingest feed',
   await page.locator('#ingest-wrap').isHidden());

const langCount = await page.locator('#langs-grid .lang').count();
ok('every Wikipedia edition has a button', langCount >= 40, langCount + ' editions');
ok('English is selected by default',
   (await page.getAttribute('#langs-grid .lang[data-lang="en"]', 'aria-pressed')) === 'true');

// Flags are images, not emoji. Windows ships no country-flag glyphs, so an
// emoji-based picker renders as the bare letters "GB" for every visitor on a
// PC -- which is exactly how this was found. These checks therefore prove the
// images decoded, not merely that some text is present.
await page.waitForFunction(
  () => [...document.querySelectorAll('#langs-grid img.fl')].every((i) => i.complete),
  null,
  { timeout: 20000 }
);
const flagInfo = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#langs-grid .lang')];
  const imgs = btns.map((b) => b.querySelector('img.fl')).filter(Boolean);
  const names = btns.map((b) => b.querySelector('.nm').textContent.trim());
  return {
    total: btns.length,
    imgs: imgs.length,
    decoded: imgs.filter((i) => i.naturalWidth > 0 && i.naturalHeight > 0).length,
    distinctSrc: new Set(imgs.map((i) => i.getAttribute('src'))).size,
    distinctNames: new Set(names).size,
    named: names.every((n) => n.length > 0),
    titled: btns.every((b) => (b.getAttribute('title') || '').includes('—')),
  };
});
ok('every edition has a flag image', flagInfo.imgs === flagInfo.total,
   `${flagInfo.imgs}/${flagInfo.total}`);
ok('every flag image actually decoded, not a broken icon',
   flagInfo.decoded === flagInfo.total, `${flagInfo.decoded}/${flagInfo.total} decoded`);
ok('the flags are not all the same picture', flagInfo.distinctSrc >= 25,
   flagInfo.distinctSrc + ' distinct flags');
// Ten Indic editions necessarily share one flag, so the endonym is what tells
// them apart. If two ever collided, the picker would become ambiguous.
ok('no two editions are labelled the same', flagInfo.distinctNames === flagInfo.total,
   `${flagInfo.distinctNames}/${flagInfo.total} distinct`);
ok('every edition is labelled in its own language', flagInfo.named);
ok('hovering names the language in full', flagInfo.titled);

await openMore('#more-listen');
await page.click('#langs-grid .lang[data-lang="fr"]');
ok('clicking a flag updates the typed field: one setting, two ways in',
   (await page.inputValue('#langs')).split(',').includes('fr'),
   await page.inputValue('#langs'));
await page.fill('#langs', 'en,de,ja');
await page.dispatchEvent('#langs', 'change');
ok('typing codes updates the flags in turn',
   (await page.getAttribute('#langs-grid .lang[data-lang="ja"]', 'aria-pressed')) === 'true');
await page.click('#langs-grid .lang[data-lang="de"]');
await page.click('#langs-grid .lang[data-lang="ja"]');
await page.click('#langs-grid .lang[data-lang="en"]');
ok('deselecting everything falls back to English rather than nothing',
   (await page.inputValue('#langs')) === 'en', await page.inputValue('#langs'));

// The new source factories must at least build, start and stop cleanly.
const factories = await page.evaluate(async () => {
  const m = await import('../src/index.js');
  const out = {};
  for (const [key, make] of Object.entries({
    bitcoin: () => m.bitcoin(),
    coinbase: () => m.coinbase(),
    earthquakes: () => m.earthquakes(),
    bluesky: () => m.bluesky(),
    github: () => m.github(),
  })) {
    try {
      const s = make();
      out[key] = { name: s.name, hasStart: typeof s.start === 'function', hasStop: typeof s.stop === 'function' };
      s.stop();
    } catch (e) {
      out[key] = { error: e.message };
    }
  }
  return out;
});
ok('every new source builds and exposes the source interface',
   Object.values(factories).every((f) => f.hasStart && f.hasStop),
   JSON.stringify(factories));

// --- recorder -----------------------------------------------------------
await openMore('#more-sound');
const rec = await page.evaluate(async () => {
  const { Recorder } = await import('../src/audio/recorder-sink.js');
  if (!Recorder.supported) return { supported: false };
  const r = new Recorder(window.son.engine);
  r.start();
  for (let i = 0; i < 12; i++) window.son.emit({ magnitude: 400 * (i + 1), id: 'rec-' + i });
  await new Promise((res) => setTimeout(res, 700));
  const blob = await r.stop();
  return { supported: true, size: blob.size, type: blob.type };
});
if (rec.supported) {
  // An empty Opus container is about 300 bytes, so "non-empty" is not enough:
  // require a size that can only come from actually captured audio.
  ok('recorder captured real audio, not an empty container',
     rec.size > 2000, `${rec.size} bytes ${rec.type}`);
} else {
  ok('recorder reports unsupported cleanly', true, 'MediaRecorder absent in this build');
}

// --- ingest server -> browser, end to end -------------------------------
if (USE_LOCAL_SERVER) {
  await page.click('#feeds .card[data-feed="ingest"]');
  ok('the ingest URL field appears with the ingest feed',
     await page.locator('#ingest-wrap').isVisible());
  await page.fill('#ingest-url', BASE + '/events');
  if ((await page.getAttribute('#start', 'data-on')) === 'true') await page.click('#start');
  await page.click('#start');
  // Wait for the stream to be open rather than for a fixed delay: the connect
  // handler prepares audio first, and how long that takes is not this test's
  // business.
  await page.waitForFunction(
    () => window.son.sources.some((s) => s.status === 'open'),
    null,
    { timeout: 20000 }
  );
  const before = await page.evaluate(() => window.son.stats.received);
  await fetch(BASE + '/emit?magnitude=7777&id=from-curl&label=end-to-end');
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => ({
    received: window.son.stats.received,
    last: window.son.sinks.find((s) => s.particles)?.particles.slice(-1)[0]?.label,
  }));
  ok('event posted over HTTP reaches the browser', after.received > before,
     `+${after.received - before}`);
  ok('its label survived the round trip', after.last === 'end-to-end', String(after.last));
}

ok('every resource the page requests resolves', badResponses.length === 0,
   badResponses.slice(0, 4).join(' | '));
ok('no console errors on the page', consoleErrors.length === 0,
   consoleErrors.slice(0, 3).join(' | '));

// --- phone-sized, touch-driven ------------------------------------------
// The report that started this was "I see the circles and hear nothing on my
// phone", so the phone path is exercised rather than assumed.
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const mp = await mobile.newPage();
const mobileErrors = [];
mp.on('pageerror', (e) => mobileErrors.push(e.message));
await mp.goto(BASE + '/demo/', { waitUntil: 'networkidle' });
await mp.waitForFunction(() => window.son, null, { timeout: 15000 });

ok('phone: the essentials are on screen without digging',
   (await mp.locator('#feeds .card').count()) >= 6 && (await mp.locator('#kits .card').count()) >= 6);
ok('phone: the start button is reachable without scrolling sideways',
   await mp.locator('#start').isVisible());

const overflow = await mp.evaluate(() => ({
  doc: document.documentElement.scrollWidth,
  win: window.innerWidth,
}));
ok('phone: the page does not scroll sideways', overflow.doc <= overflow.win + 1,
   `${overflow.doc} vs ${overflow.win}`);

const tapTarget = await mp.locator('#start').boundingBox();
ok('phone: the start button is a comfortable tap target',
   tapTarget && tapTarget.height >= 44, tapTarget ? `${Math.round(tapTarget.height)}px tall` : 'missing');

await mp.tap('#start');
// Wait for the audio state to settle rather than for a fixed number of
// seconds: over a real connection the sample banks take as long as they take,
// and a hard-coded sleep only tests the network.
await mp
  .waitForFunction(
    () => /sound on|blocked|no instrument/i.test(document.querySelector('#audio-status').textContent),
    null,
    { timeout: 40000 }
  )
  .catch(() => {});
const mobileAudio = await mp.evaluate(() => ({
  state: window.son.engine.ctx.state,
  status: window.son.audioStatus,
  statusText: document.querySelector('#audio-status').textContent,
  running: document.querySelector('#start').dataset.on,
}));
ok('phone: tapping start unlocks the audio context',
   mobileAudio.state === 'running', mobileAudio.state);
ok('phone: the kit is usable after the tap',
   mobileAudio.status && mobileAudio.status.usable === true,
   JSON.stringify(mobileAudio.status && mobileAudio.status.problems));
ok('phone: audio state is stated on screen, never left silent',
   /Sound on/i.test(mobileAudio.statusText), mobileAudio.statusText);
ok('phone: the button reflects that it is running', mobileAudio.running === 'true');

const mobileSound = await mp.evaluate(async () => {
  const before = window.son.audio.stats.played;
  for (let i = 0; i < 20; i++) window.son.emit({ magnitude: 200 * (i + 1), id: 'phone-' + i });
  await new Promise((r) => setTimeout(r, 300));
  return window.son.audio.stats.played - before;
});
ok('phone: notes are actually scheduled', mobileSound > 0, 'played=' + mobileSound);
ok('phone: no page errors', mobileErrors.length === 0, mobileErrors.slice(0, 2).join(' | '));
await mobile.close();

await browser.close();
if (srv) srv.kill();
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall browser checks passed');
process.exit(fails ? 1 : 0);
