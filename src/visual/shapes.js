// Shapes for the marks the canvas draws.
//
// Each entry builds a path around (x, y) with an outer radius r and a rotation
// in radians. The caller has already issued beginPath(); filling or stroking is
// the caller's business, so the same path serves the mark and its shockwave.
//
// Rotation matters more than it sounds: without it every star points the same
// way and the canvas reads as wallpaper rather than a sky.

const TAU = Math.PI * 2;

function polygon(ctx, x, y, r, rot, sides) {
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * TAU - Math.PI / 2;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function starPath(ctx, x, y, r, rot, points, innerRatio) {
  const inner = r * innerRatio;
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : inner;
    const a = rot + (i / (points * 2)) * TAU - Math.PI / 2;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export const SHAPES = {
  circle: {
    label: 'Circle',
    note: 'The original mark. Area tracks the size of the event directly.',
    draw(ctx, x, y, r, rot) {
      ctx.arc(x, y, r, 0, TAU);
    },
  },

  star: {
    label: 'Star',
    note: 'Five points. A night sky rather than a bubble chart.',
    draw(ctx, x, y, r, rot) {
      starPath(ctx, x, y, r, rot, 5, 0.45);
    },
  },

  sparkle: {
    label: 'Sparkle',
    note: 'A four-pointed twinkle with concave sides, the classic glint.',
    draw(ctx, x, y, r, rot) {
      const c = r * 0.16; // pinch: the smaller, the sharper the rays
      for (let i = 0; i < 4; i++) {
        const a = rot + (i / 4) * TAU;
        const nx = x + Math.cos(a) * r;
        const ny = y + Math.sin(a) * r;
        const b = a + TAU / 8;
        const cx = x + Math.cos(b) * c;
        const cy = y + Math.sin(b) * c;
        if (i === 0) ctx.moveTo(nx, ny);
        else ctx.lineTo(nx, ny);
        ctx.quadraticCurveTo(cx, cy, x + Math.cos(a + TAU / 4) * r, y + Math.sin(a + TAU / 4) * r);
      }
      ctx.closePath();
    },
  },

  diamond: {
    label: 'Diamond',
    note: 'A square on its point. Calm, and very legible when small.',
    draw(ctx, x, y, r, rot) {
      polygon(ctx, x, y, r, rot, 4);
    },
  },

  hexagon: {
    label: 'Hexagon',
    note: 'Tiles densely without ever looking like a grid.',
    draw(ctx, x, y, r, rot) {
      polygon(ctx, x, y, r, rot, 6);
    },
  },

  burst: {
    label: 'Burst',
    note: 'Eight thin rays. Busy on its own, striking at low opacity.',
    draw(ctx, x, y, r, rot) {
      starPath(ctx, x, y, r, rot, 8, 0.22);
    },
  },

  ring: {
    label: 'Ring',
    note: 'Hollow, so crowded areas stay readable instead of merging.',
    draw(ctx, x, y, r, rot) {
      ctx.arc(x, y, r, 0, TAU);
      ctx.arc(x, y, Math.max(1, r * 0.58), 0, TAU, true); // counter-wound: an annulus
    },
  },

  petal: {
    label: 'Petal',
    note: 'Six rounded lobes. The softest of the set.',
    draw(ctx, x, y, r, rot) {
      const n = 6;
      for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * TAU;
        const nx = x + Math.cos(a) * r;
        const ny = y + Math.sin(a) * r;
        const b = a + TAU / (n * 2);
        const cx = x + Math.cos(b) * r * 1.25;
        const cy = y + Math.sin(b) * r * 1.25;
        const ex = x + Math.cos(a + TAU / n) * r;
        const ey = y + Math.sin(a + TAU / n) * r;
        if (i === 0) ctx.moveTo(nx, ny);
        ctx.quadraticCurveTo(cx, cy, ex, ey);
      }
      ctx.closePath();
    },
  },
};

export const SHAPE_NAMES = Object.keys(SHAPES);

/** Shapes that `mixed` draws from. Ring is left out: hollow reads oddly beside solids. */
export const MIXED_POOL = ['circle', 'star', 'sparkle', 'diamond', 'hexagon', 'petal'];

export const DEFAULT_SHAPE = 'circle';

/**
 * Builds the path for a mark. `pick` is a stable number in [0,1) derived from
 * the event id, so under 'mixed' a given article always draws as the same
 * shape, exactly as it always lands in the same place.
 */
export function drawShape(ctx, shape, x, y, r, rot = 0, pick = 0) {
  let name = shape;
  if (shape === 'mixed') {
    name = MIXED_POOL[Math.floor(pick * MIXED_POOL.length) % MIXED_POOL.length];
  }
  (SHAPES[name] || SHAPES[DEFAULT_SHAPE]).draw(ctx, x, y, r, rot);
}

/** True when the shape needs the even-odd rule to leave its hole open. */
export function isHollow(shape) {
  return shape === 'ring';
}
