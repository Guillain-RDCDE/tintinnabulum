// Scenes that draw one mark per event, at the event's own position.

import { drawShape, isHollow } from '../shapes.js';

const TAU = Math.PI * 2;

export const MARK_SCENES = {
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
