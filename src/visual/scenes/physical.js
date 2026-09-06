// Scenes with something like physics: things that fall, pile up or scroll.

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
        rest: false,
      });
      if (api.scene.bits.length > 600) api.scene.bits.shift();
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
