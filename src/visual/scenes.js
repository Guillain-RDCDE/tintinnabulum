// Scenes: pluggable ways of drawing the same stream of events.
//
// A scene is a plain object. Adding a visualisation means adding one entry
// here -- that is the whole extension point, and it is why this project does
// not need p5.js: p5 is a friendly wrapper over the Canvas 2D API that this
// file already uses directly, so importing it would cost a megabyte and the
// offline guarantee while buying no capability at all.
//
//   {
//     label, note,
//     init?(api)          once per start, resize or palette change
//     event?(p, api)      a particle was just born
//     frame(ctx, api)     draw one frame
//   }
//
// `api` carries { w, h, palette, particles, now, dt, shape, colorFor }.
// Every scene draws the same particle model, so hit-testing, lifetimes and
// the event contract stay in one place; a scene only decides what a moment of
// data looks like.
//
// The techniques below -- flow fields, phyllotaxis, grid perturbation,
// interference -- are the common vocabulary of generative art rather than
// anyone's invention. The grid scene is an explicit nod to Vera Molnár, whose
// work turned an ordered grid into a study of controlled disorder.

import { drawShape, isHollow } from './shapes.js';

const TAU = Math.PI * 2;

// --- a small value-noise field -------------------------------------------
// Enough for smooth flow without pulling in a noise library.

function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

export function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

// --- scenes ---------------------------------------------------------------

export const SCENES = {
  bloom: {
    label: 'Bloom',
    note: 'The original: each event opens once and fades, with a shockwave in its own shape.',
    frame(ctx, api) {
      for (const p of api.particles) {
        const age = api.now - p.born;
        const fade = 1 - age / p.life;

        if (p.ring && age < api.ringLife) {
          const t = Math.sqrt(age / api.ringLife);
          ctx.globalAlpha = (1 - t) * 0.35;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          drawShape(ctx, api.shape, p.x, p.y, p.r + 20 + t * 20, p.rot, p.pick);
          ctx.stroke();
        }

        ctx.globalAlpha = p.alpha0 * fade;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        drawShape(ctx, api.shape, p.x, p.y, p.r, p.rot, p.pick);
        ctx.fill(isHollow(api.shape) ? 'evenodd' : 'nonzero');
      }
    },
  },

  constellation: {
    label: 'Constellation',
    note: 'Events become stars and join to their neighbours. Bursts of activity draw themselves as clusters.',
    frame(ctx, api) {
      const ps = api.particles;
      const reach = Math.min(api.w, api.h) * 0.22;
      // Links first, so the stars sit on top of their own web.
      ctx.lineWidth = 1;
      for (let i = 0; i < ps.length; i++) {
        const a = ps[i];
        const fa = 1 - (api.now - a.born) / a.life;
        for (let j = i + 1; j < ps.length; j++) {
          const b = ps[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > reach * reach) continue;
          const fb = 1 - (api.now - b.born) / b.life;
          const near = 1 - Math.sqrt(d2) / reach;
          ctx.globalAlpha = near * fa * fb * 0.42;
          ctx.strokeStyle = a.color;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      for (const p of ps) {
        const fade = 1 - (api.now - p.born) / p.life;
        const r = Math.max(1.5, p.r * 0.22);
        ctx.globalAlpha = Math.min(1, fade * 1.2);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, TAU);
        ctx.fill();
      }
    },
  },

  flow: {
    label: 'Flow field',
    positional: false,
    note: 'Every event releases a mote into a slowly turning noise field, and it draws where it drifts.',
    init(api) {
      api.scene.trails = [];
      api.scene.seed = Math.random() * 1000;
    },
    event(p, api) {
      api.scene.trails.push({
        x: p.x,
        y: p.y,
        px: p.x,
        py: p.y,
        color: p.color,
        width: Math.max(0.8, p.r * 0.09),
        life: 1,
        speed: 18 + p.r * 0.5,
      });
      if (api.scene.trails.length > 500) api.scene.trails.splice(0, api.scene.trails.length - 500);
    },
    frame(ctx, api) {
      const s = api.scene;
      if (!s.trails) return;
      const t = api.now / 9000 + s.seed;
      const step = Math.min(0.05, api.dt / 1000);
      for (let i = s.trails.length - 1; i >= 0; i--) {
        const tr = s.trails[i];
        const angle = noise2(tr.x / 190 + t, tr.y / 190 - t) * TAU * 2;
        tr.px = tr.x;
        tr.py = tr.y;
        tr.x += Math.cos(angle) * tr.speed * step;
        tr.y += Math.sin(angle) * tr.speed * step;
        tr.life -= step * 0.14;
        if (
          tr.life <= 0 ||
          tr.x < -40 || tr.x > api.w + 40 || tr.y < -40 || tr.y > api.h + 40
        ) {
          s.trails.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = Math.min(0.8, tr.life);
        ctx.strokeStyle = tr.color;
        ctx.lineWidth = tr.width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tr.px, tr.py);
        ctx.lineTo(tr.x, tr.y);
        ctx.stroke();
      }
    },
  },

  ripples: {
    label: 'Ripples',
    note: 'Concentric wavefronts that cross and interfere. Pairs naturally with the Water kit.',
    frame(ctx, api) {
      ctx.lineWidth = 1.4;
      for (const p of api.particles) {
        const age = (api.now - p.born) / 1000;
        const fade = 1 - (api.now - p.born) / p.life;
        if (fade <= 0) continue;
        const lead = age * 110;
        for (let k = 0; k < 4; k++) {
          const r = lead - k * 26;
          if (r <= 1) continue;
          ctx.globalAlpha = Math.max(0, fade * 0.5 * (1 - k / 4) * Math.min(1, 60 / r));
          ctx.strokeStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, TAU);
          ctx.stroke();
        }
      }
    },
  },

  grid: {
    label: 'Grid',
    positional: false,
    note: 'An ordered grid that each event knocks out of true, settling back over time. After Vera Molnár.',
    init(api) {
      const cell = Math.max(34, Math.min(api.w, api.h) / 14);
      const cols = Math.max(1, Math.floor(api.w / cell));
      const rows = Math.max(1, Math.floor(api.h / cell));
      api.scene.cell = cell;
      api.scene.cols = cols;
      api.scene.rows = rows;
      api.scene.heat = new Float32Array(cols * rows);
      api.scene.turn = new Float32Array(cols * rows);
    },
    event(p, api) {
      const s = api.scene;
      if (!s.heat) return;
      const cx = Math.floor((p.x / api.w) * s.cols);
      const cy = Math.floor((p.y / api.h) * s.rows);
      const i = Math.max(0, Math.min(s.cols * s.rows - 1, cy * s.cols + cx));
      s.heat[i] = Math.min(1.6, s.heat[i] + 0.5 + p.r / 120);
      s.turn[i] += (Math.random() - 0.5) * 1.4;
      s.lastColor = p.color;
    },
    frame(ctx, api) {
      const s = api.scene;
      if (!s.heat) return;
      const decay = Math.min(0.06, api.dt / 1000) * 0.55;
      const w = api.w / s.cols;
      const h = api.h / s.rows;
      const side = Math.min(w, h) * 0.62;
      ctx.lineWidth = 1.2;
      for (let y = 0; y < s.rows; y++) {
        for (let x = 0; x < s.cols; x++) {
          const i = y * s.cols + x;
          s.heat[i] = Math.max(0, s.heat[i] - decay);
          s.turn[i] *= 1 - decay * 0.9;
          const heat = s.heat[i];
          const cx = (x + 0.5) * w;
          const cy = (y + 0.5) * h;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(s.turn[i]);
          ctx.globalAlpha = 0.12 + Math.min(0.8, heat * 0.6);
          ctx.strokeStyle = heat > 0.05 ? s.lastColor || api.palette.default : api.palette.default;
          ctx.strokeRect(-side / 2, -side / 2, side, side);
          if (heat > 0.55) {
            ctx.globalAlpha = Math.min(0.55, (heat - 0.55) * 0.9);
            ctx.fillStyle = ctx.strokeStyle;
            ctx.fillRect(-side / 2, -side / 2, side, side);
          }
          ctx.restore();
        }
      }
    },
  },

  spiral: {
    label: 'Spiral',
    positional: false,
    note: 'Events are laid on a golden-angle spiral in arrival order, so the sequence itself becomes the form.',
    init(api) {
      api.scene.n = 0;
      api.scene.seeds = [];
    },
    event(p, api) {
      const s = api.scene;
      s.seeds.push({ i: s.n++, born: p.born, color: p.color, r: p.r });
      if (s.seeds.length > 700) s.seeds.shift();
    },
    frame(ctx, api) {
      const s = api.scene;
      if (!s.seeds) return;
      const cx = api.w / 2;
      const cy = api.h / 2;
      const GOLDEN = Math.PI * (3 - Math.sqrt(5));
      const scale = Math.min(api.w, api.h) / 2 / Math.sqrt(Math.max(60, s.seeds.length));
      const base = s.seeds.length ? s.seeds[0].i : 0;
      for (const seed of s.seeds) {
        const k = seed.i - base;
        const a = k * GOLDEN + api.now / 24000;
        const rad = scale * Math.sqrt(k);
        const age = api.now - seed.born;
        const fade = Math.max(0, 1 - age / 30000);
        ctx.globalAlpha = 0.2 + fade * 0.7;
        ctx.fillStyle = seed.color;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, Math.max(1.5, seed.r * 0.13), 0, TAU);
        ctx.fill();
      }
    },
  },

  skyline: {
    label: 'Skyline',
    positional: false,
    note: 'A scrolling record: every event is a bar, height by size. The most literal reading of the data.',
    init(api) {
      api.scene.bars = [];
    },
    event(p, api) {
      api.scene.bars.push({ h: p.r, color: p.color, born: p.born });
      const max = Math.ceil(api.w / 6) + 8;
      if (api.scene.bars.length > max) api.scene.bars.splice(0, api.scene.bars.length - max);
    },
    frame(ctx, api) {
      const s = api.scene;
      if (!s.bars || !s.bars.length) return;
      const bw = 5;
      const gap = 1;
      const baseline = api.h * 0.82;
      let x = api.w - s.bars.length * (bw + gap);
      for (const b of s.bars) {
        const h = Math.max(2, b.h * 1.5);
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = b.color;
        ctx.fillRect(x, baseline - h, bw, h);
        x += bw + gap;
      }
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = api.palette.default;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, baseline + 0.5);
      ctx.lineTo(api.w, baseline + 0.5);
      ctx.stroke();
    },
  },
};

export const SCENE_NAMES = Object.keys(SCENES);
export const DEFAULT_SCENE = 'bloom';

/** Add your own. A scene needs only `frame`; `init` and `event` are optional. */
export function registerScene(name, def) {
  if (!def || typeof def.frame !== 'function') {
    throw new Error('a scene needs a frame(ctx, api) function');
  }
  SCENES[name] = { label: def.label || name, note: def.note || '', ...def };
  if (!SCENE_NAMES.includes(name)) SCENE_NAMES.push(name);
  return SCENES[name];
}
