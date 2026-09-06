// Per-viewer conveniences only.
//
// Storage can be unavailable -- a private window, blocked site data, a browser
// set to refuse it -- and reading or writing it can throw outright. None of
// that is worth breaking a page over, so every access is guarded and a missing
// value simply means "use the default".

const PREFIX = 't:';

export const store = {
  get(key) {
    try {
      return localStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },

  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, String(value));
    } catch {
      /* the choice still applies for this session */
    }
  },

  /** Read a value, falling back unless it is one of the allowed keys. */
  pick(key, allowed, fallback) {
    const v = this.get(key);
    return v !== null && Object.prototype.hasOwnProperty.call(allowed, v) ? v : fallback;
  },

  /**
   * A number within bounds, or the fallback when absent or unparseable.
   *
   * The absent case has to be tested before converting, not after: Number(null)
   * is 0, and 0 is perfectly finite, so a "is it a number?" check accepts a
   * missing key as a stored zero. That silently defaulted the colour-variety
   * setting to off for every first-time viewer.
   */
  number(key, fallback, min = -Infinity, max = Infinity) {
    const raw = this.get(key);
    if (raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  },

  /**
   * A stored boolean. The fallback matters: a setting that defaults to on
   * cannot be read as "'1' or else false", or it would arrive off for every
   * viewer who has never touched it.
   */
  flag(key, fallback = false) {
    const v = this.get(key);
    return v === null ? fallback : v === '1';
  },

  setFlag(key, on) {
    this.set(key, on ? '1' : '0');
  },
};
