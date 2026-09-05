// A visual signature for each instrument kit.
//
// These replaced rendered waveforms, which were accurate and unreadable: an
// envelope tells you about attack and decay only if you already know how to
// read one, and twelve of them side by side look like twelve of the same
// thing. What a picker needs is recognition -- you should know which card is
// the water and which is the night without reading the label.
//
// Each motif is drawn from canvas primitives in the active palette, so it
// costs nothing to ship and follows the colours like everything else.

const TAU = Math.PI * 2;

/** Palette roles, named for what they do here rather than where they came from. */
function ink(palette) {
  return {
    bg: palette.background,
    bright: palette.user || palette.default,
    accent: palette.anon,
    deep: palette.bot,
    hot: palette.alert,
  };
}

const MOTIFS = {
  // A struck bell: the arcs are the ring spreading outward.
  hatnote(ctx, w, h, c) {
    const cx = w / 2;
    const cy = h * 0.72;
    ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      ctx.globalAlpha = 0.85 - i * 0.15;
      ctx.strokeStyle = i % 2 ? c.accent : c.bright;
      ctx.lineWidth = 2.2 - i * 0.25;
      ctx.beginPath();
      ctx.arc(cx, cy, h * (0.16 + i * 0.15), Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.bright;
    ctx.beginPath();
    ctx.arc(cx, cy - h * 0.06, 3.2, 0, TAU);
    ctx.fill();
  },

  // Generated rather than recorded: a clean wave and a perfect circle.
  synth(ctx, w, h, c) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const y = h / 2 + Math.sin((x / w) * TAU * 2) * h * 0.24;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = c.bright;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.5, h * 0.34, 0, TAU);
    ctx.stroke();
  },

  // A drop above the rings it is about to make.
  water(ctx, w, h, c) {
    const cx = w / 2;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(cx, h * 0.3, h * 0.11, 0, TAU);
    ctx.lineTo(cx, h * 0.08);
    ctx.closePath();
    ctx.fill();
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.55 - i * 0.14;
      ctx.strokeStyle = c.bright;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(cx, h * 0.78, w * (0.1 + i * 0.13), h * (0.05 + i * 0.05), 0, 0, TAU);
      ctx.stroke();
    }
  },

  // The comb of a music box: pinned tines of falling length.
  musicbox(ctx, w, h, c) {
    const n = 11;
    const gap = w / (n + 3);
    ctx.globalAlpha = 0.9;
    for (let i = 0; i < n; i++) {
      const x = gap * (i + 2);
      const len = h * (0.62 - i * 0.04);
      ctx.strokeStyle = i % 3 === 0 ? c.bright : c.accent;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(x, h * 0.2);
      ctx.lineTo(x, h * 0.2 + len);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = c.deep;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(gap, h * 0.2);
    ctx.lineTo(w - gap, h * 0.2);
    ctx.stroke();
  },

  // Tuned bars, longest for the lowest note.
  marimba(ctx, w, h, c) {
    const rows = 5;
    for (let i = 0; i < rows; i++) {
      const y = h * (0.18 + i * 0.16);
      const len = w * (0.78 - i * 0.11);
      ctx.globalAlpha = 0.9 - i * 0.08;
      ctx.fillStyle = i % 2 ? c.accent : c.bright;
      ctx.beginPath();
      ctx.roundRect(w * 0.11, y - 3.4, len, 6.8, 3.4);
      ctx.fill();
    }
  },

  // One big disc, ringing.
  gongs(ctx, w, h, c) {
    const cx = w / 2;
    const cy = h / 2;
    const r = h * 0.4;
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();
    for (let i = 0; i < 4; i++) {
      ctx.globalAlpha = 0.85 - i * 0.18;
      ctx.strokeStyle = i === 0 ? c.bright : c.accent;
      ctx.lineWidth = 1.8 - i * 0.3;
      ctx.beginPath();
      ctx.arc(cx, cy, r * (1 - i * 0.22), 0, TAU);
      ctx.stroke();
    }
  },

  // Thin, tall and brittle.
  glassy(ctx, w, h, c) {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const x = w * (0.12 + (i / (n - 1)) * 0.76);
      const top = h * (0.14 + (i % 3) * 0.11);
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = i % 2 ? c.bright : c.accent;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, h * 0.86);
      ctx.stroke();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = c.bright;
      ctx.beginPath();
      ctx.arc(x, top, 1.8, 0, TAU);
      ctx.fill();
    }
  },

  // Tubes hanging from a bar.
  chimes(ctx, w, h, c) {
    const n = 6;
    const gap = w / (n + 1);
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = c.deep;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w * 0.1, h * 0.16);
    ctx.lineTo(w * 0.9, h * 0.16);
    ctx.stroke();
    for (let i = 0; i < n; i++) {
      const x = gap * (i + 1);
      const len = h * (0.66 - Math.abs(i - (n - 1) / 2) * 0.09);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = i % 2 ? c.accent : c.bright;
      ctx.lineWidth = 3.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, h * 0.2);
      ctx.lineTo(x, h * 0.2 + len);
      ctx.stroke();
    }
  },

  // The dished face of a pan, with its note areas.
  steelpan(ctx, w, h, c) {
    const cx = w / 2;
    const cy = h / 2;
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.36, h * 0.38, 0, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = c.bright;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.36, h * 0.38, 0, 0, TAU);
    ctx.stroke();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU - Math.PI / 2;
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = i % 2 ? c.accent : c.bright;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(a) * w * 0.17, cy + Math.sin(a) * h * 0.17,
                  w * 0.07, h * 0.1, a, 0, TAU);
      ctx.stroke();
    }
  },

  // Parallel strings, one of them plucked.
  strings(ctx, w, h, c) {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const y = h * (0.2 + (i / (n - 1)) * 0.6);
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = i === 2 ? c.bright : c.accent;
      ctx.lineWidth = i === 2 ? 2 : 1.3;
      ctx.beginPath();
      ctx.moveTo(w * 0.08, y);
      if (i === 2) ctx.quadraticCurveTo(w * 0.5, y - h * 0.22, w * 0.92, y);
      else ctx.lineTo(w * 0.92, y);
      ctx.stroke();
    }
  },

  // Birds, and the rising line of a call.
  birds(ctx, w, h, c) {
    const wing = (x, y, s, col, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - s, y);
      ctx.quadraticCurveTo(x - s * 0.4, y - s * 0.75, x, y - s * 0.1);
      ctx.quadraticCurveTo(x + s * 0.4, y - s * 0.75, x + s, y);
      ctx.stroke();
    };
    wing(w * 0.26, h * 0.34, 11, c.bright, 0.95);
    wing(w * 0.52, h * 0.22, 8, c.accent, 0.85);
    wing(w * 0.74, h * 0.38, 6.5, c.bright, 0.7);
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = c.hot || c.accent;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(w * 0.14, h * 0.86);
    ctx.quadraticCurveTo(w * 0.45, h * 0.5, w * 0.55, h * 0.78);
    ctx.quadraticCurveTo(w * 0.68, h * 0.95, w * 0.88, h * 0.6);
    ctx.stroke();
  },

  // A crescent over a horizon, with the ticking of crickets along it.
  night(ctx, w, h, c) {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = c.bright;
    ctx.beginPath();
    ctx.arc(w * 0.74, h * 0.34, h * 0.2, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(w * 0.79, h * 0.28, h * 0.19, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = c.accent;
    for (let i = 0; i < 7; i++) {
      const x = w * (0.08 + i * 0.075);
      const y = h * (0.18 + ((i * 7) % 5) * 0.08);
      ctx.globalAlpha = 0.4 + ((i * 3) % 4) * 0.15;
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    for (let i = 0; i < 9; i++) {
      const x = w * (0.1 + i * 0.09);
      ctx.beginPath();
      ctx.moveTo(x, h * 0.84);
      ctx.lineTo(x, h * (0.84 - 0.06 - ((i * 5) % 3) * 0.05));
      ctx.stroke();
    }
  },
};

/** Anything without a motif of its own gets a plain, legible fallback. */
function fallback(ctx, w, h, c) {
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, h * (0.12 + i * 0.1), 0, TAU);
    ctx.stroke();
  }
}

export const KIT_ART_NAMES = Object.keys(MOTIFS);

/** Draw a kit's signature onto a context. Synchronous, and never throws. */
export function drawKitArt(ctx, kitName, { w, h, palette } = {}) {
  const c = ink(palette);
  ctx.save();
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, h);
  try {
    (MOTIFS[kitName] || fallback)(ctx, w, h, c);
  } catch (e) {
    ctx.restore();
    return false;
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  return true;
}
