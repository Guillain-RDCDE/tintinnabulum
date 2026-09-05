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
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('response', (r) => {
  if (r.status() >= 400) badResponses.push(r.status() + ' ' + r.url());
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

// --- recorder -----------------------------------------------------------
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
  ok('recorder produced a non-empty file', rec.size > 0, `${rec.size} bytes ${rec.type}`);
} else {
  ok('recorder reports unsupported cleanly', true, 'MediaRecorder absent in this build');
}

// --- ingest server -> browser, end to end -------------------------------
if (USE_LOCAL_SERVER) {
  await page.selectOption('#source', 'ingest');
  await page.fill('#ingest-url', BASE + '/events');
  await page.click('#connect');
  await page.waitForTimeout(600);
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

await browser.close();
if (srv) srv.kill();
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall browser checks passed');
process.exit(fails ? 1 : 0);
