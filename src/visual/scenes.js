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
  orbits: {
    label: 'Orbits',
    positional: false,
    note: 'Each event is captured into an orbit, small ones fast and close, large ones slow and wide.',
    frame(ctx, api) {
      const cx = api.w / 2;
      const cy = api.h / 2;
      const maxR = Math.min(api.w, api.h) * 0.46;
      for (const p of api.particles) {
        const age = api.now - p.born;
        const fade = 1 - age / p.life;
        // Radius from size, and angular speed falling with radius, so the
        // field separates into shells the way a real system would.
        const rad = 24 + (p.r / 90) * maxR;
        const speed = 900 / (rad + 40);
        const a = p.pick * TAU + (age / 1000) * speed;
        const x = cx + Math.cos(a) * rad;
        const y = cy + Math.sin(a) * rad * 0.62; // a shallow tilt reads as depth

        ctx.globalAlpha = fade * 0.16;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rad, rad * 0.62, 0, 0, TAU);
        ctx.stroke();

        ctx.globalAlpha = Math.min(1, fade * 1.3);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2, p.r * 0.12), 0, TAU);
        ctx.fill();
      }
    },
  },

  rain: {
    label: 'Rain',
    positional: false,
    note: 'Events fall, gather speed and break on the surface. The natural partner to the Water kit.',
    init(api) {
      api.scene.drops = [];
      api.scene.splashes = [];
    },
    event(p, api) {
      api.scene.drops.push({ x: p.x, y: -10, v: 60 + p.r * 2.2, r: Math.max(1.2, p.r * 0.08), color: p.color });
      if (api.scene.drops.length > 400) api.scene.drops.shift();
    },
    frame(ctx, api) {
      const s = api.scene;
      if (!s.drops) return;
      const step = Math.min(0.05, api.dt / 1000);
      const surface = api.h * 0.86;
      for (let i = s.drops.length - 1; i >= 0; i--) {
        const d = s.drops[i];
        d.v += 900 * step; // gravity, so the fall accelerates rather than drifts
        const prev = d.y;
        d.y += d.v * step;
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = d.color;
        ctx.lineWidth = d.r;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(d.x, prev);
        ctx.lineTo(d.x, Math.min(d.y, surface));
        ctx.stroke();
        if (d.y >= surface) {
          s.splashes.push({ x: d.x, born: api.now, color: d.color, r: d.r });
          s.drops.splice(i, 1);
        }
      }
      for (let i = s.splashes.length - 1; i >= 0; i--) {
        const sp = s.splashes[i];
        const age = (api.now - sp.born) / 1000;
        if (age > 1.1) {
          s.splashes.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = Math.max(0, 0.5 * (1 - age / 1.1));
        ctx.strokeStyle = sp.color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(sp.x, surface, age * 90, age * 16, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = api.palette.default;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, surface + 0.5);
      ctx.lineTo(api.w, surface + 0.5);
      ctx.stroke();
    },
  },

  truchet: {
    label: 'Truchet',
    positional: false,
    note: 'Quarter-arc tiles that flip as events land, so unbroken curves wander across the whole field.',
    init(api) {
      // Larger tiles: at sixteen across the curves read as texture rather than
      // as the continuous lines that are the whole point of a Truchet field.
      const cell = Math.max(44, Math.min(api.w, api.h) / 9);
      const cols = Math.max(1, Math.ceil(api.w / cell));
      const rows = Math.max(1, Math.ceil(api.h / cell));
      api.scene.cols = cols;
      api.scene.rows = rows;
      api.scene.flip = new Uint8Array(cols * rows);
      api.scene.heat = new Float32Array(cols * rows);
      for (let i = 0; i < cols * rows; i++) api.scene.flip[i] = Math.random() < 0.5 ? 1 : 0;
    },
    event(p, api) {
      const s = api.scene;
      if (!s.flip) return;
      const cx = Math.min(s.cols - 1, Math.floor((p.x / api.w) * s.cols));
      const cy = Math.min(s.rows - 1, Math.floor((p.y / api.h) * s.rows));
      const i = Math.max(0, cy * s.cols + cx);
      s.flip[i] ^= 1;
      s.heat[i] = 1;
      s.lastColor = p.color;
    },
    frame(ctx, api) {
      const s = api.scene;
      if (!s.flip) return;
      const w = api.w / s.cols;
      const h = api.h / s.rows;
      const decay = Math.min(0.05, api.dt / 1000) * 0.5;
      ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.16);
      ctx.lineCap = 'butt';
      for (let y = 0; y < s.rows; y++) {
        for (let x = 0; x < s.cols; x++) {
          const i = y * s.cols + x;
          s.heat[i] = Math.max(0, s.heat[i] - decay);
          const x0 = x * w;
          const y0 = y * h;
          ctx.globalAlpha = 0.5 + s.heat[i] * 0.5;
          ctx.strokeStyle = s.heat[i] > 0.05 ? s.lastColor || api.palette.default : api.palette.default;
          ctx.beginPath();
          if (s.flip[i]) {
            ctx.arc(x0, y0, w / 2, 0, Math.PI / 2);
            ctx.moveTo(x0 + w, y0 + h);
            ctx.arc(x0 + w, y0 + h, w / 2, Math.PI, Math.PI * 1.5);
          } else {
            ctx.arc(x0 + w, y0, w / 2, Math.PI / 2, Math.PI);
            ctx.moveTo(x0, y0 + h);
            ctx.arc(x0, y0 + h, w / 2, Math.PI * 1.5, TAU);
          }
          ctx.stroke();
        }
      }
    },
  },

  polar: {
    label: 'Tree rings',
    positional: false,
    note: 'A clock face: arrival sets the angle, size sets the distance out. History accumulates as rings.',
    init(api) {
      api.scene.marks = [];
      api.scene.t0 = 0;
    },
    event(p, api) {
      const s = api.scene;
      if (!s.t0) s.t0 = api.now;
      s.marks.push({ born: api.now, r: p.r, color: p.color });
      if (s.marks.length > 900) s.marks.shift();
    },
    frame(ctx, api) {
      const s = api.scene;
      if (!s.marks) return;
      const cx = api.w / 2;
      const cy = api.h / 2;
      const maxR = Math.min(api.w, api.h) * 0.46;
      const PERIOD = 60000; // one full turn a minute, so the sweep is legible
      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = api.palette.default;
      ctx.lineWidth = 1;
      for (const frac of [0.33, 0.66, 1]) {
        ctx.beginPath();
        ctx.arc(cx, cy, maxR * frac, 0, TAU);
        ctx.stroke();
      }
      for (const m of s.marks) {
        const a = ((m.born - s.t0) / PERIOD) * TAU - Math.PI / 2;
        const rad = 18 + (m.r / 90) * (maxR - 18);
        const fade = Math.max(0.15, 1 - (api.now - m.born) / 90000);
        ctx.globalAlpha = fade * 0.85;
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, Math.max(1.5, m.r * 0.09), 0, TAU);
        ctx.fill();
      }
    },
  },

  terrain: {
    label: 'Terrain',
    positional: false,
    note: 'A ridgeline pushed up by each event and scrolling away, leaving the profile of what has happened.',
    init(api) {
      // Coarser columns and a fast scroll, so the visible width is a few
      // seconds of history that fills straight away rather than a thin pile
      // creeping in from the right edge.
      api.scene.cols = Math.max(40, Math.floor(api.w / 9));
      api.scene.ridge = new Float32Array(api.scene.cols);
      api.scene.shift = 0;
      api.scene.speed = api.scene.cols / 12; // columns per second
    },
    event(p, api) {
      const s = api.scene;
      if (!s.ridge) return;
      const at = s.cols - 1;
      const lift = Math.min(api.h * 0.42, p.r * 1.9);
      // Spread the push over a few columns so the ridge reads as a hill.
      for (let d = -4; d <= 4; d++) {
        const i = at + d;
        if (i < 0 || i >= s.cols) continue;
        s.ridge[i] = Math.max(s.ridge[i], lift * (1 - Math.abs(d) / 5));
      }
      s.lastColor = p.color;
    },
    frame(ctx, api) {
      const s = api.scene;
      if (!s.ridge) return;
      s.shift += (api.dt / 1000) * (s.speed || 12);
      while (s.shift >= 1) {
        s.ridge.copyWithin(0, 1);
        s.ridge[s.cols - 1] = 0;
        s.shift -= 1;
      }
      // A gentle settle, so a very busy feed cannot push every column to the
      // ceiling and turn the ridgeline into a filled slab -- but slow enough
      // that a peak survives its journey across the screen, which is the
      // whole point of keeping a profile of what happened.
      const relax = 1 - Math.min(0.3, (api.dt / 1000) * 0.07);
      for (let i = 0; i < s.cols; i++) s.ridge[i] *= relax;
      const base = api.h * 0.9;
      const step = api.w / (s.cols - 1);
      ctx.beginPath();
      ctx.moveTo(0, base);
      for (let i = 0; i < s.cols; i++) ctx.lineTo(i * step, base - s.ridge[i]);
      ctx.lineTo(api.w, base);
      ctx.closePath();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = s.lastColor || api.palette.default;
      ctx.fill();
      // The outline uses the palette's brightest role, so the profile stays
      // legible even when the fill sits close to the ground colour.
      ctx.globalAlpha = 1;
      ctx.strokeStyle = api.palette.default;
      ctx.lineWidth = 2;
      ctx.stroke();
    },
  },

  radar: {
    label: 'Radar',
    note: 'A sweep that lights each event as it passes, so the field is read once a turn.',
    init(api) {
      api.scene.angle = 0;
    },
    frame(ctx, api) {
      const s = api.scene;
      const cx = api.w / 2;
      const cy = api.h / 2;
      const reach = Math.hypot(api.w, api.h) / 2;
      s.angle = (s.angle + (api.dt / 1000) * 1.1) % TAU;

      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = api.palette.default;
      ctx.lineWidth = 1;
      for (const frac of [0.33, 0.66, 1]) {
        ctx.beginPath();
        ctx.arc(cx, cy, reach * frac * 0.7, 0, TAU);
        ctx.stroke();
      }

      // A wedge trailing the beam, not a hairline: a single stroke at low
      // opacity simply disappears against a dark ground.
      const tip = { x: cx + Math.cos(s.angle) * reach, y: cy + Math.sin(s.angle) * reach };
      const wedge = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
      wedge.addColorStop(0, api.palette.default);
      wedge.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = wedge;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, reach, s.angle - 0.55, s.angle);
      ctx.closePath();
      ctx.fill();

      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = api.palette.default;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();

      for (const p of api.particles) {
        const fade = 1 - (api.now - p.born) / p.life;
        // How long since the beam last crossed this point, as a fraction of a turn.
        let behind = s.angle - Math.atan2(p.y - cy, p.x - cx);
        behind = ((behind % TAU) + TAU) % TAU;
        const lit = Math.max(0, 1 - behind / (TAU * 0.75));
        ctx.globalAlpha = fade * (0.28 + lit * 0.72);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(2.5, p.r * 0.22), 0, TAU);
        ctx.fill();
      }
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
