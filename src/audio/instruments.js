// Instruments are pluggable. Implement load() + play() and the engine will use it.
//
//   play(ctx, dest, { semitone, velocity, when }) -> { duration, stop(fadeSeconds) }
//
// `semitone` is a relative offset, not an absolute pitch: 0 is the instrument's
// own bottom note. That keeps the mapper independent of any tuning choice.

export class Instrument {
  constructor(name = 'instrument') {
    this.name = name;
  }
  // eslint-disable-next-line no-unused-vars
  async load(ctx) {
    return this;
  }
  // eslint-disable-next-line no-unused-vars
  play(ctx, dest, opts) {
    throw new Error(this.name + ': play() not implemented');
  }
}

// --- sample bank ----------------------------------------------------------
// The original was locked to 27 fixed pitches because it simply played back
// one file per note. Resampling through playbackRate gives continuous pitch
// from the same files, including below and above the recorded range.

const MIME = {
  ogg: 'audio/ogg; codecs="vorbis"',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  webm: 'audio/webm',
};

function pickExtension(exts) {
  if (typeof document === 'undefined') return exts[exts.length - 1];
  const probe = document.createElement('audio');
  for (const e of exts) {
    if (probe.canPlayType && probe.canPlayType(MIME[e] || '') !== '') return e;
  }
  return exts[exts.length - 1];
}

export class SampleInstrument extends Instrument {
  /**
   * @param {Object} o
   * @param {string} o.baseUrl   Directory holding the samples.
   * @param {string[]} o.files   File names without extension, in ascending pitch.
   * @param {string[]} o.exts    Candidate extensions, best first.
   * @param {number} o.step      Semitones between consecutive samples.
   * @param {number} o.gain      Instrument trim.
   */
  constructor({
    name = 'samples',
    baseUrl = '',
    files = [],
    exts = ['ogg', 'mp3'],
    step = 1,
    baseSemitone = 0,
    gain = 1,
    maxStretch = 12, // never resample further than this, to keep it musical
  } = {}) {
    super(name);
    Object.assign(this, { baseUrl, files, exts, step, baseSemitone, gain, maxStretch });
    this._buffers = null;
    this._loading = null;
  }

  async load(ctx) {
    if (this._buffers) return this;
    if (!this._loading) {
      const ext = pickExtension(this.exts);
      this._loading = Promise.all(
        this.files.map(async (f) => {
          const res = await fetch(this.baseUrl + f + '.' + ext);
          if (!res.ok) throw new Error(`${this.name}: cannot load ${f}.${ext} (${res.status})`);
          return ctx.decodeAudioData(await res.arrayBuffer());
        })
      ).then((bufs) => {
        this._buffers = bufs;
        return this;
      });
    }
    return this._loading;
  }

  get ready() {
    return Boolean(this._buffers && this._buffers.length);
  }

  play(ctx, dest, { semitone = 0, velocity = 1, when = 0 } = {}) {
    if (!this.ready) return null;
    const n = this._buffers.length;
    let idx;
    let rate = 1;
    if (this.step === 0) {
      // Unpitched bank (one-shots): pick a variation at random.
      idx = Math.floor(Math.random() * n);
    } else {
      const rel = (semitone - this.baseSemitone) / this.step;
      idx = Math.max(0, Math.min(n - 1, Math.round(rel)));
      let offset = (rel - idx) * this.step; // semitones of resampling
      offset = Math.max(-this.maxStretch, Math.min(this.maxStretch, offset));
      rate = Math.pow(2, offset / 12);
    }

    const src = ctx.createBufferSource();
    src.buffer = this._buffers[idx];
    src.playbackRate.value = rate;

    const amp = ctx.createGain();
    amp.gain.value = Math.max(0.0001, velocity * this.gain);
    src.connect(amp).connect(dest);

    const t0 = when || ctx.currentTime;
    src.start(t0);
    const duration = src.buffer.duration / rate;

    return {
      duration: duration * 1000,
      stop(fade = 0.02) {
        const t = ctx.currentTime;
        try {
          amp.gain.cancelScheduledValues(t);
          amp.gain.setValueAtTime(amp.gain.value, t);
          amp.gain.linearRampToValueAtTime(0.0001, t + fade);
          src.stop(t + fade + 0.01);
        } catch (e) {}
      },
    };
  }
}

// --- synthesis ------------------------------------------------------------

export const SYNTH_PRESETS = {
  // FM with an inharmonic ratio: the classic struck-metal timbre.
  bell: { engine: 'fm', wave: 'sine', ratio: 3.51, index: 320, indexDecay: 0.2, attack: 0.002, decay: 1.8 },
  glass: { engine: 'fm', wave: 'sine', ratio: 2.01, index: 140, indexDecay: 0.35, attack: 0.004, decay: 2.6 },
  clang: { engine: 'fm', wave: 'triangle', ratio: 5.13, index: 600, indexDecay: 0.12, attack: 0.001, decay: 1.1 },
  // Filtered saw with a fast decay: reads as a plucked string.
  pluck: { engine: 'sub', wave: 'sawtooth', attack: 0.001, decay: 0.42, cutoff: 2400, cutoffDecay: 0.14, q: 5 },
  woody: { engine: 'sub', wave: 'square', attack: 0.001, decay: 0.22, cutoff: 1600, cutoffDecay: 0.08, q: 2 },
  blip: { engine: 'sub', wave: 'triangle', attack: 0.001, decay: 0.12, cutoff: 5000, cutoffDecay: 0.06, q: 1 },
  pad: { engine: 'sub', wave: 'sawtooth', attack: 0.6, decay: 3.2, cutoff: 900, cutoffDecay: 2.4, q: 3, detune: 8 },
};

export class SynthInstrument extends Instrument {
  constructor({ name = 'synth', preset = 'bell', baseFreq = 261.63, gain = 0.35, ...overrides } = {}) {
    super(name);
    const base = typeof preset === 'string' ? SYNTH_PRESETS[preset] : preset;
    if (!base) throw new Error('Unknown synth preset: ' + preset);
    this.params = { ...base, ...overrides };
    this.baseFreq = baseFreq;
    this.gain = gain;
  }

  play(ctx, dest, { semitone = 0, velocity = 1, when = 0 } = {}) {
    const p = this.params;
    const t0 = when || ctx.currentTime;
    const freq = this.baseFreq * Math.pow(2, semitone / 12);
    const peak = Math.max(0.0002, velocity * this.gain);
    const decay = p.decay;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(peak, t0 + p.attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + p.attack + decay);
    amp.connect(dest);

    const nodes = [];
    const tail = t0 + p.attack + decay + 0.05;

    if (p.engine === 'fm') {
      const car = ctx.createOscillator();
      car.type = p.wave;
      car.frequency.value = freq;
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = freq * p.ratio;
      const modGain = ctx.createGain();
      const index = p.index * (0.4 + 0.6 * velocity) * (freq / this.baseFreq);
      modGain.gain.setValueAtTime(Math.max(1, index), t0);
      modGain.gain.exponentialRampToValueAtTime(1, t0 + p.indexDecay);
      mod.connect(modGain).connect(car.frequency);
      car.connect(amp);
      nodes.push(car, mod);
    } else {
      const osc = ctx.createOscillator();
      osc.type = p.wave;
      osc.frequency.value = freq;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.Q.value = p.q;
      filt.frequency.setValueAtTime(Math.min(18000, p.cutoff + freq * 2), t0);
      filt.frequency.exponentialRampToValueAtTime(Math.max(120, freq), t0 + p.cutoffDecay);
      osc.connect(filt).connect(amp);
      nodes.push(osc);
      if (p.detune) {
        const osc2 = ctx.createOscillator();
        osc2.type = p.wave;
        osc2.frequency.value = freq;
        osc2.detune.value = p.detune;
        osc2.connect(filt);
        nodes.push(osc2);
      }
    }

    for (const n of nodes) {
      n.start(t0);
      n.stop(tail);
    }

    return {
      duration: (p.attack + decay) * 1000,
      stop(fade = 0.02) {
        const t = ctx.currentTime;
        try {
          amp.gain.cancelScheduledValues(t);
          amp.gain.setValueAtTime(Math.max(0.0001, amp.gain.value), t);
          amp.gain.exponentialRampToValueAtTime(0.0001, t + fade);
          for (const n of nodes) n.stop(t + fade + 0.01);
        } catch (e) {}
      },
    };
  }
}

// --- ready-made kits ------------------------------------------------------

// Resolved from this module's own location rather than the site root, so the
// sample banks are found wherever the project is mounted -- a local server, a
// GitHub Pages project subpath, or a subdirectory of a larger site.
export const DEFAULT_SOUND_URL = new URL('../../sounds/', import.meta.url).href;

/** The original Hatnote sound: celesta for additions, clavichord for removals. */
export function hatnoteKit({ baseUrl = DEFAULT_SOUND_URL, count = 27 } = {}) {
  const files = [];
  for (let i = 1; i <= count; i++) files.push('c' + String(i).padStart(3, '0'));
  return {
    add: new SampleInstrument({ name: 'celesta', baseUrl: baseUrl + 'celesta/', files, gain: 0.9 }),
    sub: new SampleInstrument({ name: 'clav', baseUrl: baseUrl + 'clav/', files, gain: 0.9 }),
    accent: new SampleInstrument({
      name: 'swell',
      baseUrl: baseUrl + 'swells/',
      files: ['swell1', 'swell2', 'swell3'],
      step: 0, // pick at random rather than by pitch
      gain: 1,
    }),
  };
}

/** Dependency-free equivalent, no audio files at all. */
export function synthKit(opts = {}) {
  return {
    add: new SynthInstrument({ name: 'bell', preset: 'bell', ...opts.add }),
    sub: new SynthInstrument({ name: 'pluck', preset: 'pluck', ...opts.sub }),
    accent: new SynthInstrument({
      name: 'swell',
      preset: 'pad',
      baseFreq: 130.81,
      gain: 0.3,
      ...opts.accent,
    }),
  };
}
