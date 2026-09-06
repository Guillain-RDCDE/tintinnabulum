// Scenes that arrange events into a figure: a spiral, a dial, an orbit.

const TAU = Math.PI * 2;

export const STRUCTURE_SCENES = {
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

  polar: {
    label: 'Tree rings',
    positional: false,
    preview: { dt: 420, frames: 130 }, // a full turn takes a minute
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
        // Angular speed falls with radius, as it would in a real system. The
        // constant sets the pace: at 50 the innermost shell takes about eight
        // seconds to come round and the outermost the better part of a minute.
        // It was 900, which spun the inner orbits twice a second.
        const speed = 50 / (rad + 40);
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

  lissajous: {
    label: 'Lissajous',
    positional: false,
    note: 'Each event draws a figure whose two frequencies come from its size, so every value has its own curve.',
    frame(ctx, api) {
      const cx = api.w / 2;
      const cy = api.h / 2;
      const A = api.w * 0.4;
      const B = api.h * 0.4;
      ctx.lineWidth = 1.4;
      for (const p of api.particles) {
        const age = (api.now - p.born) / 1000;
        const fade = 1 - (api.now - p.born) / p.life;
        // Small integer ratios close on themselves; the size picks the pair.
        const a = 1 + Math.floor(p.pick * 4);
        const b = 1 + Math.floor((p.r / 90) * 5);
        const phase = p.rot;
        const span = Math.min(TAU, age * 2.2);
        ctx.globalAlpha = fade * 0.55;
        ctx.strokeStyle = p.color;
        ctx.beginPath();
        for (let t = 0; t <= span; t += 0.06) {
          const x = cx + Math.sin(a * t + phase) * A * (0.3 + (p.r / 90) * 0.7);
          const y = cy + Math.sin(b * t) * B * (0.3 + (p.r / 90) * 0.7);
          if (t === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    },
  },
};
