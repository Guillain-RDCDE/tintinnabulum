// Scenes with something like physics: things that fall, pile up or scroll.
//
// Each scene keeps a copy of the colour an event was born with, so it also
// keeps `rim`, the lifted edge tone the renderer derived alongside it. Depth
// means different things here: a disc wants an outline, a falling drop wants a
// bright head, a filled profile wants a gradient. What it never means is the
// same three lines pasted into every scene.

import { cap } from './budget.js';

const TAU = Math.PI * 2;

export const PHYSICAL_SCENES = {
  rain: {
    label: 'Rain',
    positional: false,
    preview: { dt: 28, frames: 150 }, // drops live under a second
    note: 'Events fall, gather speed and break on the surface. The natural partner to the Water kit.',
    init(api) {
      api.scene.drops = [];
      api.scene.splashes = [];
    },
    event(p, api) {
      api.scene.drops.push({
        x: p.x, y: -10, v: 60 + p.r * 2.2,
        r: Math.max(1.2, p.r * 0.08), color: p.color, rim: p.rim,
      });
      if (api.scene.drops.length > cap(api, 0.5)) api.scene.drops.shift();
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
        // The leading end catches the light. A falling drop is read by its
        // head, not by the whole streak, and this costs one short segment.
        if (api.depth && d.y < surface) {
          ctx.globalAlpha = 0.95;
          ctx.strokeStyle = d.rim || d.color;
          ctx.beginPath();
          ctx.moveTo(d.x, Math.max(prev, d.y - d.r * 3));
          ctx.lineTo(d.x, d.y);
          ctx.stroke();
        }
        if (d.y >= surface) {
          // Splashes expire by age rather than by count, which is fine at any
          // ordinary rate and not fine at all during a burst: a thousand drops
          // landing inside one second are a thousand ellipses a frame until
          // they time out.
          if (s.splashes.length < cap(api, 0.35)) {
            s.splashes.push({ x: d.x, born: api.now, color: d.color, r: d.r });
          }
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

  pile: {
    label: 'Pile',
    positional: false,
    note: 'Events fall, bounce and settle into a heap, so the sheer volume of what has happened becomes visible.',
    init(api) {
      api.scene.bits = [];
    },
    event(p, api) {
      api.scene.bits.push({
        x: p.x,
        y: -8,
        vx: (Math.random() - 0.5) * 40,
        vy: 0,
        r: Math.max(2.5, p.r * 0.16),
        color: p.color,
        rim: p.rim,
        rest: false,
      });
      if (api.scene.bits.length > cap(api, 0.75)) api.scene.bits.shift();
    },
    frame(ctx, api) {
      const s = api.scene;
      if (!s.bits) return;
      const step = Math.min(0.04, api.dt / 1000);
      const floor = api.h - 6;
      for (const b of s.bits) {
        if (!b.rest) {
          b.vy += 1500 * step;
          b.x += b.vx * step;
          b.y += b.vy * step;
          if (b.x < b.r || b.x > api.w - b.r) b.vx *= -0.6;
          if (b.y >= floor - b.r) {
            b.y = floor - b.r;
            b.vy *= -0.32;
            b.vx *= 0.7;
            // Once it has stopped bouncing, freeze it: a settled heap should
            // stay put rather than jitter for ever.
            if (Math.abs(b.vy) < 26) b.rest = true;
          }
        }
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fill();
        // A heap of same-coloured discs with no edges is one shape. The
        // outline is what makes it a heap of things. No gradient: these move,
        // so one could not be cached, and six hundred a frame is not free.
        if (api.depth && b.r > 3) {
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = b.rim || b.color;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
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
      s.lastRim = p.rim;
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
      // One gradient a frame, not one per mark, so the profile can have depth
      // for the price of a single object: lit along the ridge, dark in the mass
      // below it.
      if (api.depth) {
        let peak = 0;
        for (let i = 0; i < s.cols; i++) if (s.ridge[i] > peak) peak = s.ridge[i];
        const g = ctx.createLinearGradient(0, base - Math.max(12, peak), 0, base);
        g.addColorStop(0, s.lastRim || s.lastColor || api.palette.default);
        g.addColorStop(1, s.lastColor || api.palette.default);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = s.lastColor || api.palette.default;
      }
      ctx.fill();
      // The outline uses the palette's brightest role, so the profile stays
      // legible even when the fill sits close to the ground colour.
      ctx.globalAlpha = 1;
      ctx.strokeStyle = api.palette.default;
      ctx.lineWidth = 2;
      ctx.stroke();
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
      api.scene.bars.push({ h: p.r, color: p.color, rim: p.rim, born: p.born });
      // The screen already limits this one -- a bar is six pixels wide -- but
      // the budget must still be able to lower it on a machine that is
      // struggling, so it is the smaller of the two.
      const max = Math.min(Math.ceil(api.w / 6) + 8, cap(api, 1));
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
        // A lit cap, which is all a five-pixel bar has room for: it separates
        // neighbouring bars of similar height without a gradient nobody could
        // see across five pixels anyway.
        if (api.depth) {
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = b.rim || b.color;
          ctx.fillRect(x, baseline - h, bw, Math.min(2, h));
        }
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
