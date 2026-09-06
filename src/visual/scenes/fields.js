// Scenes that treat the canvas as a field the events disturb.

import { noise2 } from './noise.js';
import { cap } from './budget.js';

const TAU = Math.PI * 2;

export const FIELD_SCENES = {
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
        rim: p.rim,
        // The path so far. The canvas is cleared every frame, so a trail that
        // only drew the segment since the last frame left a dash rather than
        // the track it had travelled.
        pts: [p.x, p.y],
        color: p.color,
        width: Math.max(0.8, p.r * 0.09),
        life: 1,
        speed: 18 + p.r * 0.5,
      });
      const capT = cap(api, 0.6);
      if (api.scene.trails.length > capT) api.scene.trails.splice(0, api.scene.trails.length - capT);
    },
    frame(ctx, api) {
      const s = api.scene;
      if (!s.trails) return;
      const t = api.now / 9000 + s.seed;
      const step = Math.min(0.05, api.dt / 1000);
      for (let i = s.trails.length - 1; i >= 0; i--) {
        const tr = s.trails[i];
        const angle = noise2(tr.x / 190 + t, tr.y / 190 - t) * TAU * 2;
        tr.x += Math.cos(angle) * tr.speed * step;
        tr.y += Math.sin(angle) * tr.speed * step;
        tr.pts.push(tr.x, tr.y);
        if (tr.pts.length > 120) tr.pts.splice(0, tr.pts.length - 120);
        tr.life -= step * 0.14;
        if (
          tr.life <= 0 ||
          tr.x < -40 || tr.x > api.w + 40 || tr.y < -40 || tr.y > api.h + 40
        ) {
          s.trails.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = Math.min(0.85, tr.life);
        ctx.strokeStyle = tr.color;
        ctx.lineWidth = tr.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(tr.pts[0], tr.pts[1]);
        for (let k = 2; k < tr.pts.length; k += 2) ctx.lineTo(tr.pts[k], tr.pts[k + 1]);
        ctx.stroke();
        // The head only, never the whole trail. Five hundred trails of sixty
        // points each is thirty thousand segments a frame already; drawing a
        // highlight over all of them would double that for a gleam nobody sees
        // on the tail. The mote is where the eye is anyway.
        if (api.depth && tr.pts.length >= 8) {
          const n = tr.pts.length;
          ctx.globalAlpha = Math.min(0.95, tr.life * 1.2);
          ctx.strokeStyle = tr.rim || tr.color;
          ctx.lineWidth = tr.width * 0.7;
          ctx.beginPath();
          ctx.moveTo(tr.pts[n - 8], tr.pts[n - 7]);
          for (let k = n - 6; k < n; k += 2) ctx.lineTo(tr.pts[k], tr.pts[k + 1]);
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
      s.lastRim = p.rim;
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
            // A lit top and left edge on the hottest cells, so a struck square
            // looks raised out of the grid rather than merely tinted.
            if (api.depth) {
              ctx.globalAlpha = Math.min(0.8, (heat - 0.55) * 1.4);
              ctx.fillStyle = s.lastRim || ctx.strokeStyle;
              ctx.fillRect(-side / 2, -side / 2, side, 1.5);
              ctx.fillRect(-side / 2, -side / 2, 1.5, side);
            }
          }
          ctx.restore();
        }
      }
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
      s.lastRim = p.rim;
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
          // The ribbons are several pixels wide, so they can carry a core.
          // The path is still current after stroking, so this is a second
          // stroke and not a second path -- and only on cells an event has
          // just touched, which is a handful of the field at any moment.
          if (api.depth && s.heat[i] > 0.05) {
            const wide = ctx.lineWidth;
            ctx.globalAlpha = s.heat[i] * 0.8;
            ctx.strokeStyle = s.lastRim || ctx.strokeStyle;
            ctx.lineWidth = wide * 0.34;
            ctx.stroke();
            ctx.lineWidth = wide;
          }
        }
      }
    },
  },

  threads: {
    label: 'Threads',
    positional: false,
    note: 'Level threads pushed aside by each event, weaving a fabric out of where things happened.',
    init(api) {
      const rows = Math.max(6, Math.floor(api.h / 26));
      const cols = Math.max(30, Math.floor(api.w / 8));
      api.scene.rows = rows;
      api.scene.cols = cols;
      api.scene.off = Array.from({ length: rows }, () => new Float32Array(cols));
      api.scene.tint = new Array(rows).fill(null);
      api.scene.rims = new Array(rows).fill(null);
    },
    event(p, api) {
      const s = api.scene;
      if (!s.off) return;
      const row = Math.min(s.rows - 1, Math.max(0, Math.floor((p.y / api.h) * s.rows)));
      const at = Math.min(s.cols - 1, Math.max(0, Math.floor((p.x / api.w) * s.cols)));
      const push = Math.min(api.h / s.rows, p.r * 0.5) * (Math.random() < 0.5 ? -1 : 1);
      const width = 6;
      for (let d = -width; d <= width; d++) {
        const i = at + d;
        if (i < 0 || i >= s.cols) continue;
        // A raised cosine, so the thread bends rather than kinks.
        s.off[row][i] += push * 0.5 * (1 + Math.cos((Math.PI * d) / width));
      }
      s.tint[row] = p.color;
      if (s.rims) s.rims[row] = p.rim;
    },
    frame(ctx, api) {
      const s = api.scene;
      if (!s.off) return;
      const relax = 1 - Math.min(0.4, (api.dt / 1000) * 0.25);
      const gap = api.h / (s.rows + 1);
      const step = api.w / (s.cols - 1);
      ctx.lineWidth = 1.6;
      for (let r = 0; r < s.rows; r++) {
        const y0 = gap * (r + 1);
        const line = s.off[r];
        // A thread no event has touched is drawn dim. It used to share the
        // full opacity of the disturbed ones in the fallback colour, which is
        // a near-white in almost every palette, so the rows nothing had
        // happened in were the loudest things on screen.
        const touched = Boolean(s.tint[r]);
        ctx.globalAlpha = touched ? 0.75 : 0.22;
        ctx.strokeStyle = s.tint[r] || api.palette.default;
        ctx.beginPath();
        for (let i = 0; i < s.cols; i++) {
          line[i] *= relax;
          const x = i * step;
          const y = y0 + line[i];
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        // Twenty threads, not five hundred, so a second pass is affordable
        // here where it was not for the flow field. It has to be a second
        // path, not the same one under a transform: Canvas 2D fixes each
        // segment in the transform current when it was added, so translating
        // afterwards moves nothing. The one-pixel lift is what makes the weave
        // read as thread rather than as wire.
        if (api.depth && touched) {
          ctx.globalAlpha = 0.4;
          ctx.strokeStyle = (s.rims && s.rims[r]) || s.tint[r] || api.palette.default;
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          for (let i = 0; i < s.cols; i++) {
            const x = i * step;
            const y = y0 + line[i] - 1;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
          ctx.lineWidth = 1.6;
        }
      }
    },
  },

  nebula: {
    label: 'Nebula',
    positional: false,
    note: 'Soft glows added on top of one another, so busy moments burn bright and quiet ones stay dim.',
    frame(ctx, api) {
      // Additive blending: overlapping events accumulate rather than occlude,
      // which is what makes density read as brightness.
      ctx.globalCompositeOperation = 'lighter';
      for (const p of api.particles) {
        const age = api.now - p.born;
        const fade = 1 - age / p.life;
        const rad = Math.max(18, p.r * 1.8) * (0.6 + (1 - fade) * 0.8);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        g.addColorStop(0, p.color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        // Additive light accumulates fast: a modest per-glow alpha keeps
        // individual events legible instead of merging into one wash.
        ctx.globalAlpha = fade * 0.2;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    },
  },
};
