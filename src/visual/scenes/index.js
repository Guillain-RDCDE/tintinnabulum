// The scene registry and its extension point.
//
// A scene is a plain object. Adding a visualisation means adding one entry to
// one of the family modules -- that is the whole extension point, and it is
// why this project does not need p5.js: p5 is a friendly wrapper over the
// Canvas 2D API these files already use directly, so importing it would cost
// a megabyte and the offline guarantee while buying no capability at all.
//
//   {
//     label, note, positional?, preview?,
//     init?(api)          once per start, resize or palette change
//     event?(p, api)      a particle was just born
//     frame(ctx, api)     draw one frame
//   }
//
// `api` carries { w, h, palette, particles, now, dt, shape, ringLife, scene }.
// Every scene draws the same particle model, so hit-testing, lifetimes and the
// event contract stay in one place; a scene only decides appearance.
//
// The techniques -- flow fields, phyllotaxis, grid perturbation, interference
// -- are the shared vocabulary of generative art rather than anyone's
// invention. The grid is an explicit nod to Vera Molnar, whose work turned an
// ordered grid into a study of controlled disorder.

import { shadeOf, lighten, lightnessOf } from '../color.js';
import { MARK_SCENES } from './marks.js';
import { FIELD_SCENES } from './fields.js';
import { STRUCTURE_SCENES } from './structures.js';
import { PHYSICAL_SCENES } from './physical.js';

export { noise2 } from './noise.js';

export const SCENES = {
  ...MARK_SCENES,
  ...FIELD_SCENES,
  ...STRUCTURE_SCENES,
  ...PHYSICAL_SCENES,
};

export const SCENE_NAMES = Object.keys(SCENES);
export const DEFAULT_SCENE = 'bloom';

/**
 * Draw a still preview of a scene onto a small canvas context.
 *
 * It runs the real scene against synthetic events and a simulated clock, so a
 * preview cannot drift from what the scene actually does -- a stored image
 * would be stale the moment a palette or a parameter changed. Motion-based
 * scenes need time to develop, hence the simulated frames rather than one.
 */
export function previewScene(
  ctx,
  name,
  // Roughly seven seconds of simulated time. Much less and the scenes that
  // need time to develop -- motes tracing a flow field, drops falling, a
  // polar sweep advancing -- show an almost empty card and undersell
  // themselves. dt stays modest so the physics-based scenes integrate the
  // same way they do live.
  {
    w, h, palette, shape = 'circle', frames = 110, dt = 62, seed = 7,
    // A card that showed flat marks while the canvas drew shaded ones would be
    // advertising the wrong product, so the preview takes the same two colour
    // settings and builds the same per-event shades and gradients.
    richness = 0.45,
    depth = true,
  } = {}
) {
  const scene = SCENES[name] || SCENES[DEFAULT_SCENE];
  // A scene may declare its own timescale: a polar sweep takes a minute to go
  // round, and drops live for under a second, so neither reads well at the
  // default rate.
  if (scene.preview) {
    frames = scene.preview.frames || frames;
    dt = scene.preview.dt || dt;
  }
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  const roles = ['user', 'anon', 'bot', 'user', 'anon'];
  const particles = [];
  const darkGround = lightnessOf(palette.background) < 0.5;
  const api = {
    w, h, palette, particles,
    now: 0,
    dt,
    shape,
    ringLife: 2200,
    scene: {},
    depth,
    richness,
    darkGround,
    // A card holds thirty-four events on a thumbnail, so the ceiling the live
    // canvas runs under is irrelevant here; cap() has a floor that keeps every
    // scene from starving at this size.
    budget: 200,
    colorFor: (c) => palette[c] || palette.default,
    // The same contract CanvasSink offers, including the per-particle cache:
    // a preview runs a hundred frames, and rebuilding a gradient for every
    // mark on every one of them is a hundred times the work for one picture.
    fill: (c, p) => {
      if (!depth) return p.color;
      if (p._grad) return p._grad;
      const g = c.createRadialGradient(
        p.x - p.r * 0.3, p.y - p.r * 0.34, p.r * 0.08,
        p.x, p.y, p.r * 1.1
      );
      g.addColorStop(0, lighten(p.color, 0.07));
      g.addColorStop(0.6, p.color);
      g.addColorStop(1, lighten(p.color, -0.05));
      p._grad = g;
      return g;
    },
  };

  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, w, h);
  if (scene.init) scene.init(api);

  const born = [];
  for (let i = 0; i < 34; i++) {
    const p = rnd() ** 1.7;
    const base = palette[roles[i % roles.length]] || palette.default;
    const tint = [rnd(), rnd(), rnd()];
    const color = shadeOf(base, tint, richness);
    const room = darkGround ? 1 - lightnessOf(color) : lightnessOf(color);
    born.push({
      // Births run right to the end: scenes whose marks are short-lived, like
      // falling drops, otherwise catch a quiet final frame and look empty.
      at: Math.floor(rnd() * (frames - 2)),
      p: {
        x: 8 + rnd() * (w - 16),
        y: 8 + rnd() * (h - 16),
        r: Math.max(2, Math.sqrt(p) * Math.min(w, h) * 0.34),
        rot: rnd() * Math.PI * 2,
        pick: rnd(),
        tint,
        base,
        color,
        rim: lighten(color, (darkGround ? 0.26 : -0.26) * Math.min(1, room * 1.6)),
        _grad: null,
        alpha0: 0.5,
        ring: true,
        label: '',
        url: '',
        life: 12000,
        category: roles[i % roles.length],
      },
    });
  }

  for (let f = 0; f < frames; f++) {
    api.now = f * api.dt;
    for (const b of born) {
      if (b.at !== f) continue;
      b.p.born = api.now;
      particles.push(b.p);
      if (scene.event) scene.event(b.p, api);
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      if (api.now - particles[i].born >= particles[i].life) particles.splice(i, 1);
    }
    ctx.save();
    try {
      scene.frame(ctx, api);
    } catch (e) {
      ctx.restore();
      return false;
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    // Only the last frame is kept, but the trailing ones must accumulate for
    // scenes that build up rather than redraw, so the ground is repainted
    // between frames exactly as the live canvas does.
    if (f < frames - 1) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = palette.background;
      ctx.fillRect(0, 0, w, h);
    }
  }
  return true;
}

/** Add your own. A scene needs only `frame`; `init` and `event` are optional. */
export function registerScene(name, def) {
  if (!def || typeof def.frame !== 'function') {
    throw new Error('a scene needs a frame(ctx, api) function');
  }
  SCENES[name] = { label: def.label || name, note: def.note || '', ...def };
  if (!SCENE_NAMES.includes(name)) SCENE_NAMES.push(name);
  return SCENES[name];
}
