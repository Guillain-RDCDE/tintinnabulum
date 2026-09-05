// The normalized event contract.
//
// Everything that reaches the engine goes through normalize(). The only
// required field is `magnitude`; everything else has a sane default. If it can
// be reduced to (magnitude, polarity, id), it can be sonified.

let _auto = 0;

/**
 * @typedef {Object} SonificationEvent
 * @property {number}  magnitude  Absolute size of the event. Drives pitch and radius.
 * @property {-1|0|1}  polarity   Instrument selection: +1 bell, -1 pluck, 0 neutral.
 * @property {string}  id         Stable identity: seeds the on-screen position.
 * @property {string}  category   Free-form bucket: colour and instrument override.
 * @property {boolean} accent     Rare, notable event: triggers the swell + banner.
 * @property {string}  label      Human-readable text.
 * @property {string}  url        Opened when the on-screen circle is clicked.
 * @property {number}  ts         Epoch ms.
 * @property {string}  source     Name of the source that produced it.
 * @property {*}       data       Untouched original payload.
 */

export function normalize(raw, now = Date.now()) {
  if (raw == null) return null;
  if (typeof raw === 'number') raw = { magnitude: raw };
  if (typeof raw !== 'object') return null;

  const signed = Number(raw.magnitude);
  if (!Number.isFinite(signed)) return null;

  // A signed magnitude carries its own polarity unless one is given explicitly.
  const polarity =
    raw.polarity == null ? Math.sign(signed) : Math.sign(Number(raw.polarity)) || 0;

  return {
    magnitude: Math.abs(signed),
    polarity,
    id: raw.id != null && raw.id !== '' ? String(raw.id) : 'auto:' + ++_auto,
    category: raw.category != null && raw.category !== '' ? String(raw.category) : 'default',
    accent: Boolean(raw.accent),
    label: raw.label != null ? String(raw.label) : '',
    url: raw.url != null ? String(raw.url) : '',
    ts: Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : now,
    source: raw.source != null ? String(raw.source) : '',
    data: raw.data !== undefined ? raw.data : null,
    dimmed: false, // set by filters: shown, but not heard
    map: null,     // filled by the Mapper
  };
}

// --- deterministic positioning -------------------------------------------
// An event's place on screen is derived from its id, so the same article (or
// the same endpoint, or the same sensor) always lands in the same spot. Edit
// wars become a pulse in one place. This replaces the seedrandom dependency.

function seedFrom(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export function rngFrom(str) {
  let a = seedFrom(String(str))();
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable point in the unit square for a given id. */
export function unitPosition(id) {
  const r = rngFrom(id);
  return { u: r(), v: r() };
}
