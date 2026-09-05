// magnitude -> musical position.
//
// The original code carried a constant tuned to the byte-size distribution of
// Wikipedia edits. That makes it useless for any other source. The `adaptive`
// mode here observes a rolling window of real magnitudes and places each new
// one at its percentile rank, so an unknown data source self-calibrates within
// a few seconds. `log` and `linear` remain available when the domain is known.

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  pentatonic: [0, 2, 4, 7, 9],
  'pentatonic-minor': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  'whole-tone': [0, 2, 4, 6, 8, 10],
  octatonic: [0, 2, 3, 5, 6, 8, 9, 11],
  // Japanese modes: very few degrees, so almost anything sounds deliberate.
  hirajoshi: [0, 2, 3, 7, 8],
  'in-sen': [0, 1, 5, 7, 10],
  kumoi: [0, 2, 3, 7, 9],
  // Wide, open intervals rather than steps.
  fourths: [0, 5, 10],
  fifths: [0, 7],
  octaves: [0],
};

/** Note names for a key selector, in semitones from C. */
export const KEYS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export class Mapper {
  constructor(opts = {}) {
    this.mode = opts.mode || 'adaptive'; // 'adaptive' | 'log' | 'linear'
    this.windowSize = opts.window ?? 500;
    this.range = opts.range ?? 27; // span in semitones
    this.root = opts.root ?? 0;
    this.invert = opts.invert !== false; // big event = low note, as in the original
    this.domain = opts.domain || [1, 100000]; // used by log/linear
    this.warmup = opts.warmup ?? 16; // events before adaptive kicks in
    this.jitter = opts.jitter ?? 0; // semitones of random fuzz
    this.velocityCurve = opts.velocityCurve || ((p) => 0.55 + 0.45 * p);
    this.setScale(opts.scale || 'chromatic');
    this._hist = [];
  }

  setScale(scale) {
    const degrees = Array.isArray(scale) ? scale.slice() : SCALES[scale];
    if (!degrees || !degrees.length) throw new Error('Unknown scale: ' + scale);
    this.scale = degrees.slice().sort((a, b) => a - b);
    this.scaleName = Array.isArray(scale) ? 'custom' : scale;
    return this;
  }

  reset() {
    this._hist.length = 0;
    return this;
  }

  observe(m) {
    this._hist.push(m);
    if (this._hist.length > this.windowSize) this._hist.shift();
  }

  /** Where this magnitude sits in [0,1] relative to the rest. */
  position(m) {
    if (this.mode === 'adaptive' && this._hist.length >= this.warmup) {
      let below = 0;
      let equal = 0;
      for (let i = 0; i < this._hist.length; i++) {
        const v = this._hist[i];
        if (v < m) below++;
        else if (v === m) equal++;
      }
      return clamp01((below + equal * 0.5) / this._hist.length);
    }
    const [a, b] = this.domain;
    if (this.mode === 'linear') return clamp01((m - a) / (b - a || 1));
    const lo = Math.log(Math.max(a, 0) + 1);
    const hi = Math.log(Math.max(b, 0) + 1);
    return clamp01((Math.log(Math.max(m, 0) + 1) - lo) / (hi - lo || 1));
  }

  /** Snap a semitone offset onto the active scale. */
  quantize(semis) {
    const oct = Math.floor(semis / 12);
    const rem = semis - oct * 12;
    let best = this.scale[0];
    let bestD = Infinity;
    for (const d of this.scale) {
      const dist = Math.abs(d - rem);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    // The octave above may be closer than any degree below it.
    if (12 - rem < bestD) return (oct + 1) * 12;
    return oct * 12 + best;
  }

  map(m) {
    const p = this.position(m); // computed before observing, so it never ranks against itself
    this.observe(m);
    const q = this.invert ? 1 - p : p;
    let semis = q * this.range;
    if (this.jitter) semis += (Math.random() * 2 - 1) * this.jitter;
    semis = Math.max(0, Math.min(this.range, semis));
    return {
      p,
      semitone: this.root + this.quantize(semis),
      velocity: clamp01(this.velocityCurve(p)),
      salience: p, // priority when voices are scarce
    };
  }
}
