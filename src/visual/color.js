// Perceptual colour, so that varying a mark does not distort it.
//
// The renderer used to paint every event of a category in one flat colour: a
// palette offers four, so a busy screen carried four. Giving each event its own
// shade is what separates a field of marks from a wall of one colour.
//
// The variation happens in OKLab rather than HSL because HSL's "lightness" is
// not lightness. Darkening #39b7a8 in HSL swings it towards green, and a screen
// of supposedly one category then reads as several. OKLab is built so that a
// step of equal size looks equal wherever it is taken, which is exactly the
// property needed here: vary the shade, keep the identity.
//
// Matrices are Björn Ottosson's, from the original OKLab description.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Parse '#rgb', '#rrggbb' or 'rgba(r, g, b, a)'. Returns 0-255 with alpha. */
export function parseColor(input) {
  if (typeof input !== 'string') return { r: 255, g: 255, b: 255, a: 1 };
  const s = input.trim();

  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16),
        a: 1,
      };
    }
    if (h.length === 6) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1,
      };
    }
  }

  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(',').map((v) => parseFloat(v));
    return {
      r: clamp(parts[0] || 0, 0, 255),
      g: clamp(parts[1] || 0, 0, 255),
      b: clamp(parts[2] || 0, 0, 255),
      a: parts.length > 3 ? clamp(parts[3], 0, 1) : 1,
    };
  }

  return { r: 255, g: 255, b: 255, a: 1 };
}

const toLinear = (c) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

const fromLinear = (x) => {
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return clamp(Math.round(c * 255), 0, 255);
};

/** sRGB (0-255) to OKLab. */
export function rgbToOklab({ r, g, b }) {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** OKLab to linear-light sRGB, unclipped, so gamut can be tested. */
function oklabToLinear({ L, a, b }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLab back to sRGB (0-255), clipped into gamut. */
export function oklabToRgb(lab) {
  const [r, g, b] = oklabToLinear(lab);
  return { r: fromLinear(r), g: fromLinear(g), b: fromLinear(b) };
}

const EPS = 1e-4;
const inGamut = ([r, g, b]) =>
  r >= -EPS && r <= 1 + EPS && g >= -EPS && g <= 1 + EPS && b >= -EPS && b <= 1 + EPS;

/** OKLab in polar form: lightness, chroma, hue in radians. */
export function toOklch(lab) {
  return {
    L: lab.L,
    C: Math.hypot(lab.a, lab.b),
    h: Math.atan2(lab.b, lab.a),
  };
}

/**
 * OKLCH to sRGB, reducing chroma until the colour actually fits.
 *
 * Clipping each channel independently is what turns an out-of-gamut dark red
 * into rgb(1, 0, 0): the channels are clipped by different amounts, so both the
 * hue and the lightness are lost. Nearly every palette has at least one colour
 * close enough to an edge for this to happen once chroma is raised -- Papyrus's
 * near-black ink collapsed exactly this way. Backing the chroma off keeps the
 * hue and the lightness, which are the two things worth keeping.
 */
export function fromOklch({ L, C, h }) {
  const at = (c) => ({ L, a: Math.cos(h) * c, b: Math.sin(h) * c });
  if (C <= 0 || inGamut(oklabToLinear(at(C)))) return oklabToRgb(at(C));

  let lo = 0;
  let hi = C;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinear(at(mid)))) lo = mid;
    else hi = mid;
  }
  return oklabToRgb(at(lo));
}

export const toCss = ({ r, g, b }, alpha = 1) =>
  alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;

/**
 * A deterministic shade of `base`, drawn from three numbers in 0..1.
 *
 * `richness` scales how far the shade may wander: 0 reproduces the base colour
 * exactly, which is what Monochrome and anyone relying on category-by-colour
 * needs, and 1 spreads hue far enough that one category reads as a family
 * rather than a single ink. Lightness always varies a little even at low
 * richness, because that alone is most of what gives a field its depth.
 *
 * Hue drift is deliberately the last thing to grow. Spreading hue early is how
 * a visualisation turns into confetti, and it is not what makes a dense field
 * look good: depth comes from lightness, and only then from colour.
 */
export function shadeOf(base, [t1, t2, t3], richness = 0.45) {
  const k = clamp(richness, 0, 1);
  if (k <= 0) return base;

  const { r, g, b, a } = parseColor(base);
  const c = toOklch(rgbToOklab({ r, g, b }));

  const signed = (t) => t * 2 - 1;

  // Lightness carries the depth, so it varies from the start.
  const L = clamp(c.L + signed(t1) * (0.05 + 0.13 * k), 0.06, 0.97);
  // Chroma follows, keeping the darker shades from going muddy.
  const C = Math.max(0, c.C * (1 + signed(t2) * (0.12 + 0.38 * k)));
  // Hue moves last and least: k^2 keeps it near zero until richness is high.
  const h = c.h + signed(t3) * (k * k * 0.85);

  return toCss(fromOklch({ L, C, h }), a);
}

/**
 * A lighter version of a colour, for the highlight side of a gradient.
 * Raising L in OKLab lightens without the wash-out of blending towards white.
 */
export function lighten(base, amount = 0.14) {
  const { r, g, b, a } = parseColor(base);
  const c = toOklch(rgbToOklab({ r, g, b }));
  return toCss(fromOklch({ ...c, L: clamp(c.L + amount, 0, 1) }), a);
}

/** Perceived lightness, 0..1. Used to decide if a palette's ground is dark. */
export function lightnessOf(base) {
  const { r, g, b } = parseColor(base);
  return rgbToOklab({ r, g, b }).L;
}
