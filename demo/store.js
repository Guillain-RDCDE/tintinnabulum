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

  flag(key) {
    return this.get(key) === '1';
  },

  setFlag(key, on) {
    this.set(key, on ? '1' : '0');
  },
};
