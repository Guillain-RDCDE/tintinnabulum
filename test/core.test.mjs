// Pure-logic checks. No browser needed: nothing here touches AudioContext or
// canvas, which is the point of keeping those behind sinks.
import { normalize, unitPosition } from '../src/core/event.js';
import { Mapper } from '../src/core/mapper.js';
import { VoicePool } from '../src/core/voices.js';
import {
  PALETTES,
  PALETTE_KEYS,
  DEFAULT_PALETTE_NAME,
  resolvePalette,
  swatchOf,
} from '../src/visual/palettes.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) {
    fails++;
    console.log('FAIL  ' + name + (extra ? '  ' + extra : ''));
  } else console.log('ok    ' + name + (extra ? '  ' + extra : ''));
};

// --- the event contract ---
ok('number shorthand', normalize(42).magnitude === 42);
ok('negative magnitude implies polarity', normalize(-30).polarity === -1 && normalize(-30).magnitude === 30);
ok('explicit polarity wins', normalize({ magnitude: -30, polarity: 1 }).polarity === 1);
ok('non-numeric magnitude rejected', normalize({ magnitude: 'abc' }) === null);
ok('NaN rejected', normalize({ magnitude: NaN }) === null);
ok('null rejected', normalize(null) === null);
ok('zero is a valid magnitude', normalize(0) && normalize(0).magnitude === 0);
ok('defaults applied', normalize(1).category === 'default' && normalize(1).accent === false);

// --- deterministic positioning ---
const a = unitPosition('Paris');
const b = unitPosition('Paris');
const c = unitPosition('Lyon');
ok('same id lands in the same place', a.u === b.u && a.v === b.v);
ok('different ids land apart', a.u !== c.u);
ok('position stays in the unit square', a.u >= 0 && a.u < 1 && a.v >= 0 && a.v < 1);

// --- the headline claim: the mapper calibrates itself ---
const spread = (mapper, samples) => {
  const out = samples.map((m) => mapper.map(m).semitone);
  return { min: Math.min(...out), max: Math.max(...out) };
};

const wiki = new Mapper({ mode: 'adaptive', range: 27 });
const wikiMags = Array.from({ length: 400 }, () => Math.round(Math.exp(Math.random() * 9)));
wikiMags.forEach((m) => wiki.map(m));
const wr = spread(wiki, wikiMags.slice(0, 200));

const latency = new Mapper({ mode: 'adaptive', range: 27 });
const latMags = Array.from({ length: 400 }, () => 40 + Math.random() * 20); // narrow band, tiny values
latMags.forEach((m) => latency.map(m));
const lr = spread(latency, latMags.slice(0, 200));

ok('adaptive spans the range on wiki-like data', wr.max - wr.min > 18, JSON.stringify(wr));
ok('adaptive spans the range on a foreign domain', lr.max - lr.min > 18, JSON.stringify(lr));

// A fixed log curve tuned for one domain collapses on another. This is the
// whole reason the adaptive mode exists.
const logm = new Mapper({ mode: 'log', domain: [1, 100000], range: 27 });
const lg = spread(logm, latMags.slice(0, 200));
ok('fixed log mapping collapses off-domain (expected)', lg.max - lg.min < 6, JSON.stringify(lg));

// --- pitch direction ---
const inv = new Mapper({ mode: 'log', invert: true, range: 27, warmup: 1e9 });
ok('inverted: big event = low note', inv.map(90000).semitone < inv.map(5).semitone);
const noinv = new Mapper({ mode: 'log', invert: false, range: 27, warmup: 1e9 });
ok('not inverted: big event = high note', noinv.map(90000).semitone > noinv.map(5).semitone);

// --- scale quantization ---
const pent = new Mapper({ scale: 'pentatonic', mode: 'log', range: 36, warmup: 1e9 });
const degrees = new Set();
for (let i = 1; i < 5000; i += 7) degrees.add((((pent.map(i).semitone % 12) + 12) % 12));
ok(
  'pentatonic output never leaves the scale',
  [...degrees].every((d) => [0, 2, 4, 7, 9].includes(d)),
  [...degrees].sort((x, y) => x - y).join(',')
);

// --- voice allocation ---
const pool = new VoicePool({ maxVoices: 3 });
const t = 1000;
const s1 = pool.request(0.1, t);
const s2 = pool.request(0.2, t);
const s3 = pool.request(0.3, t);
[s1, s2, s3].forEach((s, i) => s && s.attach(() => {}, 5000 + i));
ok('grants up to maxVoices', Boolean(s1 && s2 && s3) && pool.active === 3);
ok('a weak note is refused when full', pool.request(0.05, t) === null);

let stoppedWeakest = false;
s1.stop = () => {
  stoppedWeakest = true;
};
const strong = pool.request(0.9, t);
ok('a strong note steals the weakest voice', strong !== null && stoppedWeakest);
ok('capacity is respected after a steal', pool.active === 3, 'active=' + pool.active);
ok('expired voices are reclaimed', (() => { pool.request(0.5, t + 60000); return pool.active <= 3; })());

const rl = new VoicePool({ maxVoices: 100, maxPerSecond: 10 });
let granted = 0;
for (let i = 0; i < 50; i++) if (rl.request(0.5, 2000)) granted++;
ok('token bucket caps a burst', granted <= 11, 'granted=' + granted);

// --- palettes: complete, and actually legible ---------------------------
// A palette can be pretty and still unusable. These checks measure it rather
// than trusting the eye: WCAG relative luminance, with the circle colours
// composited over their own background at the 0.5 fill opacity the canvas uses.

const hex = (c) => {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const srgbToLin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const lum = (rgb) => {
  const [r, g, b] = rgb.map(srgbToLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const over = (fg, bg, alpha) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));

// WCAG contrast is luminance only. That is the right measure for text on a
// background, but the wrong one for "can you tell these two circles apart":
// deep cyan and magenta are unmistakable yet share a luminance band. Category
// separation is therefore measured as perceptual distance in CIELAB (CIE76).
const toLab = (rgb) => {
  const [r, g, b] = rgb.map(srgbToLin);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
};
const deltaE = (a, b) => {
  const la = toLab(a);
  const lb = toLab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
};

const names = Object.keys(PALETTES);
ok('palettes are defined', names.length >= 8, names.length + ' palettes');
ok('the default palette exists', Boolean(PALETTES[DEFAULT_PALETTE_NAME]), DEFAULT_PALETTE_NAME);

let structureOk = true;
let parseOk = true;
for (const n of names) {
  const c = PALETTES[n].colors;
  if (!PALETTE_KEYS.every((k) => typeof c[k] === 'string' && c[k])) {
    structureOk = false;
    console.log('   missing keys in ' + n);
  }
  for (const k of ['background', 'default', 'user', 'anon', 'bot', 'alert', 'text']) {
    if (!hex(c[k])) {
      parseOk = false;
      console.log(`   ${n}.${k} is not a plain hex colour: ${c[k]}`);
    }
  }
  if (!/^rgba?\(/.test(c.banner) || !/^rgba?\(/.test(c.hud)) {
    parseOk = false;
    console.log('   banner/hud must be rgba() in ' + n);
  }
  if (!PALETTES[n].label || !PALETTES[n].note) {
    structureOk = false;
    console.log('   missing label/note in ' + n);
  }
}
ok('every palette defines every key', structureOk);
ok('every colour parses', parseOk);

let worstText = { ratio: Infinity, name: '' };
let worstCircle = { ratio: Infinity, name: '' };
let worstPair = { ratio: Infinity, name: '' };
let worstMono = { ratio: Infinity, name: '' };
for (const n of names) {
  const c = PALETTES[n].colors;
  const bg = hex(c.background);

  const t = contrast(hex(c.text), bg);
  if (t < worstText.ratio) worstText = { ratio: t, name: n };

  const cats = ['user', 'anon', 'bot', 'alert'];
  const composited = cats.map((k) => over(hex(c[k]), bg, 0.5));
  for (const comp of composited) {
    const r = contrast(comp, bg);
    if (r < worstCircle.ratio) worstCircle = { ratio: r, name: n };
  }
  for (let i = 0; i < composited.length; i++) {
    for (let j = i + 1; j < composited.length; j++) {
      const pair = `${n} ${cats[i]}/${cats[j]}`;
      if (n === 'monochrome') {
        // Greyscale by design: perceptual distance cannot apply, so this one
        // palette is held to a luminance floor -- which is exactly what it
        // promises, that colour vision is never required.
        const r = contrast(composited[i], composited[j]);
        if (r < worstMono.ratio) worstMono = { ratio: r, name: pair };
      } else {
        const d = deltaE(composited[i], composited[j]);
        if (d < worstPair.ratio) worstPair = { ratio: d, name: pair };
      }
    }
  }
}
ok('label text is legible on every background (WCAG AA, 4.5)',
   worstText.ratio >= 4.5, `worst ${worstText.name} = ${worstText.ratio.toFixed(2)}`);
ok('circles stand out from their background at 50% fill',
   worstCircle.ratio >= 1.4, `worst ${worstCircle.name} = ${worstCircle.ratio.toFixed(2)}`);
ok('colour palettes keep their categories perceptually apart (CIELAB dE >= 22)',
   worstPair.ratio >= 22, `closest ${worstPair.name} = dE ${worstPair.ratio.toFixed(1)}`);
ok('monochrome separates categories by lightness alone (>= 1.35)',
   worstMono.ratio >= 1.35, `closest ${worstMono.name} = ${worstMono.ratio.toFixed(3)}`);

ok('resolvePalette fills gaps from the default',
   resolvePalette({ anon: '#123456' }).background === PALETTES[DEFAULT_PALETTE_NAME].colors.background);
ok('resolvePalette honours the override', resolvePalette({ anon: '#123456' }).anon === '#123456');
ok('an unknown palette name falls back rather than throwing',
   resolvePalette('does-not-exist').background === PALETTES[DEFAULT_PALETTE_NAME].colors.background);
const sw = swatchOf('bronze');
ok('swatchOf returns a ground and four dots',
   Boolean(sw.background) && sw.dots.length === 4 && sw.dots.every(Boolean));

// --- shapes -------------------------------------------------------------
// Exercised against a recording stub rather than a real canvas: what matters
// here is that every shape emits a path of the right size, which is checkable
// without a browser. A shape that silently draws nothing must fail.

const { SHAPES, SHAPE_NAMES, MIXED_POOL, DEFAULT_SHAPE, drawShape, isHollow } = await import(
  '../src/visual/shapes.js'
);

function recorder() {
  const pts = [];
  let ops = 0;
  const push = (x, y) => pts.push([x, y]);
  return {
    pts,
    get ops() {
      return ops;
    },
    moveTo(x, y) { ops++; push(x, y); },
    lineTo(x, y) { ops++; push(x, y); },
    quadraticCurveTo(cx, cy, x, y) { ops++; push(cx, cy); push(x, y); },
    arc(x, y, r) { ops++; push(x - r, y); push(x + r, y); push(x, y - r); push(x, y + r); },
    closePath() {},
  };
}

ok('shape registry is populated', SHAPE_NAMES.length >= 6, SHAPE_NAMES.length + ' shapes');
ok('the default shape exists', Boolean(SHAPES[DEFAULT_SHAPE]), DEFAULT_SHAPE);
ok('mixed draws only from registered shapes',
   MIXED_POOL.every((n) => SHAPES[n]), MIXED_POOL.join(','));

let shapeStructure = true;
let emptyShape = '';
let oversized = '';
for (const name of SHAPE_NAMES) {
  const s = SHAPES[name];
  if (!s.label || !s.note || typeof s.draw !== 'function') {
    shapeStructure = false;
    console.log('   incomplete shape: ' + name);
  }
  const ctx = recorder();
  drawShape(ctx, name, 100, 100, 20, 0.3, 0.5);
  if (ctx.ops < 1 || ctx.pts.length < 3) emptyShape = name;
  for (const [x, y] of ctx.pts) {
    if (Math.hypot(x - 100, y - 100) > 20 * 1.45) oversized = `${name} (${Math.round(Math.hypot(x - 100, y - 100))})`;
  }
}
ok('every shape declares a label, a note and a draw function', shapeStructure);
ok('every shape actually emits a path', !emptyShape, emptyShape || 'all draw');
ok('no shape overruns its radius', !oversized, oversized || 'all within bounds');

const c1 = recorder();
drawShape(c1, 'nonexistent-shape', 10, 10, 5);
ok('an unknown shape falls back rather than throwing', c1.ops > 0);

const mixA = recorder();
const mixB = recorder();
drawShape(mixA, 'mixed', 50, 50, 10, 0, 0.31);
drawShape(mixB, 'mixed', 50, 50, 10, 0, 0.31);
ok('mixed is deterministic for a given event',
   JSON.stringify(mixA.pts) === JSON.stringify(mixB.pts));
const mixC = recorder();
drawShape(mixC, 'mixed', 50, 50, 10, 0, 0.87);
ok('mixed does vary across events', JSON.stringify(mixA.pts) !== JSON.stringify(mixC.pts));

ok('rotation actually rotates the path', (() => {
  const a = recorder();
  const b = recorder();
  drawShape(a, 'star', 0, 0, 10, 0);
  drawShape(b, 'star', 0, 0, 10, 1.1);
  return JSON.stringify(a.pts) !== JSON.stringify(b.pts);
})());

ok('ring is the hollow one', isHollow('ring') && !isHollow('circle'));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall core checks passed');
process.exit(fails ? 1 : 0);
