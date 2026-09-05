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
    this._loaded = null;
    this._loading = null;
    this.failures = [];
  }

  /**
   * Loads the bank, tolerating individual failures.
   *
   * This used to be a Promise.all, which meant one failed request out of
   * fifty-seven left the whole instrument permanently silent -- and silent is
   * exactly how it failed, with the visuals carrying on regardless. On a phone,
   * one flaky request out of fifty-seven is close to expected. A missing note
   * now simply drops out of the bank and its neighbour is resampled to cover
   * the gap.
   */
  async load(ctx) {
    if (this._buffers) return this;
    if (!this._loading) {
      const ext = pickExtension(this.exts);
      this.failures = [];
      this._loading = Promise.all(
        this.files.map(async (f) => {
          try {
            const res = await fetch(this.baseUrl + f + '.' + ext);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await ctx.decodeAudioData(await res.arrayBuffer());
          } catch (e) {
            this.failures.push(`${f}.${ext}: ${e.message}`);
            return null;
          }
        })
      ).then((bufs) => {
        this._buffers = bufs;
        this._loaded = bufs.reduce((acc, b, i) => (b ? (acc.push(i), acc) : acc), []);
        return this;
      });
    }
    return this._loading;
  }

  get ready() {
    return Boolean(this._loaded && this._loaded.length);
  }

  /** Fraction of the bank that actually loaded, 0 to 1. */
  get coverage() {
    return this._loaded && this.files.length ? this._loaded.length / this.files.length : 0;
  }

  _nearestLoaded(want) {
    let best = this._loaded[0];
    let bestD = Math.abs(best - want);
    for (const i of this._loaded) {
      const d = Math.abs(i - want);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  play(ctx, dest, { semitone = 0, velocity = 1, when = 0 } = {}) {
    if (!this.ready) return null;
    let idx;
    let rate = 1;
    if (this.step === 0) {
      // Unpitched bank (one-shots): pick a variation at random.
      idx = this._loaded[Math.floor(Math.random() * this._loaded.length)];
    } else {
      const rel = (semitone - this.baseSemitone) / this.step;
      const want = Math.max(0, Math.min(this.files.length - 1, Math.round(rel)));
      idx = this._nearestLoaded(want); // a gap in the bank is covered by its neighbour
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

// `sweep` bends the pitch: the oscillator starts at `sweep` times the target
// frequency and arrives at it over `sweepTime`. It is what separates a water
// drop from a beep -- the rising "plink" is entirely in that bend.
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

  // A falling drop rings *upward* as the cavity closes: the pitch rises fast
  // and the whole thing is over in a fifth of a second.
  drop: {
    engine: 'sub', wave: 'sine', attack: 0.001, decay: 0.22,
    cutoff: 4000, cutoffDecay: 0.1, q: 1, sweep: 0.45, sweepTime: 0.07,
  },
  // Deeper, slower, with a longer tail: the same gesture in a bigger space.
  well: {
    engine: 'sub', wave: 'sine', attack: 0.002, decay: 0.55,
    cutoff: 2200, cutoffDecay: 0.2, q: 2, sweep: 0.35, sweepTime: 0.14,
  },
  // Struck wood: a short burst through a narrow band, no tail at all.
  wood: {
    engine: 'sub', wave: 'triangle', attack: 0.001, decay: 0.13,
    cutoff: 2600, cutoffDecay: 0.05, q: 9, sweep: 1.6, sweepTime: 0.015,
  },
  // Tuned bars: an FM ratio near 4 is what makes a marimba read as wooden
  // rather than metallic.
  marimba: { engine: 'fm', wave: 'sine', ratio: 3.98, index: 90, indexDecay: 0.07, attack: 0.002, decay: 0.75 },
  // Plucked metal tines, bright and short.
  musicbox: { engine: 'fm', wave: 'sine', ratio: 3.02, index: 210, indexDecay: 0.09, attack: 0.001, decay: 1.1 },
  kalimba: { engine: 'fm', wave: 'triangle', ratio: 2.03, index: 60, indexDecay: 0.12, attack: 0.002, decay: 0.9 },
  // Big, slow, and deliberately inharmonic so it never settles on a pitch.
  gong: { engine: 'fm', wave: 'sine', ratio: 1.73, index: 480, indexDecay: 1.2, attack: 0.01, decay: 4.2 },

  // A tube rather than a bar: a high odd ratio and a long tail.
  chime: { engine: 'fm', wave: 'sine', ratio: 5.41, index: 260, indexDecay: 0.5, attack: 0.004, decay: 3.4 },
  // Struck oil drum: a low-order ratio keeps the partials nearly harmonic,
  // which is why a steel pan sings where a gong clangs.
  steelpan: { engine: 'fm', wave: 'sine', ratio: 2.5, index: 150, indexDecay: 0.18, attack: 0.003, decay: 1.3 },
  // Plucked gut: bright attack, quick fall, no metallic ring at all.
  harp: { engine: 'sub', wave: 'sawtooth', attack: 0.002, decay: 1.0, cutoff: 3200, cutoffDecay: 0.4, q: 2 },
  // Weight underneath everything else.
  bass: { engine: 'sub', wave: 'triangle', attack: 0.004, decay: 0.9, cutoff: 700, cutoffDecay: 0.3, q: 3 },

  // --- the natural world ---
  // Birdsong is mostly two things: a fast pitch bend and a fast wobble on top
  // of it. `vibrato` supplies the wobble, `sweep` the bend.
  chirp: {
    engine: 'sub', wave: 'sine', attack: 0.004, decay: 0.16,
    cutoff: 6000, cutoffDecay: 0.1, q: 1,
    sweep: 0.62, sweepTime: 0.05, vibrato: { rate: 26, depth: 0.05 },
    octave: 24, // birds sit far above the rest of the range
  },
  warble: {
    engine: 'sub', wave: 'sine', attack: 0.006, decay: 0.34,
    cutoff: 5200, cutoffDecay: 0.24, q: 1,
    sweep: 1.35, sweepTime: 0.09, vibrato: { rate: 15, depth: 0.09 },
    octave: 19,
  },
  // Low, breathy and slow: the counterweight to the small birds.
  owl: {
    engine: 'sub', wave: 'sine', attack: 0.05, decay: 0.55,
    cutoff: 900, cutoffDecay: 0.4, q: 4,
    sweep: 1.1, sweepTime: 0.18, vibrato: { rate: 5, depth: 0.02 },
    octave: -12,
  },
  // A dry, buzzing tick, very high and very short.
  cricket: {
    engine: 'sub', wave: 'square', attack: 0.001, decay: 0.05,
    cutoff: 9000, cutoffDecay: 0.03, q: 12,
    vibrato: { rate: 70, depth: 0.06 },
    octave: 31,
  },
  // Air rather than pitch: a wide, slow swell.
  breeze: {
    engine: 'sub', wave: 'sawtooth', attack: 0.5, decay: 2.6,
    cutoff: 520, cutoffDecay: 2.0, q: 1, detune: 14, octave: -7,
  },
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
    // `octave` shifts a preset's whole register: birds belong far above the
    // range the mapper works in, an owl far below it.
    const freq = this.baseFreq * Math.pow(2, (semitone + (p.octave || 0)) / 12);
    const peak = Math.max(0.0002, velocity * this.gain);
    const decay = p.decay;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(peak, t0 + p.attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + p.attack + decay);
    amp.connect(dest);

    const nodes = [];
    const tail = t0 + p.attack + decay + 0.05;

    // Pitch envelope. Starting away from the target and arriving at it is what
    // turns a beep into a drop or a knock; without it those presets are just
    // short sine tones.
    const bend = (param, target) => {
      if (!p.sweep || p.sweep === 1) {
        param.value = target;
        return;
      }
      param.setValueAtTime(Math.max(1, target * p.sweep), t0);
      param.exponentialRampToValueAtTime(Math.max(1, target), t0 + (p.sweepTime || 0.05));
    };

    // Vibrato: an LFO added onto the frequency in hertz. Depth is a fraction
    // of the note, so the wobble stays proportional across the register.
    const addVibrato = (param) => {
      if (!p.vibrato) return;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = p.vibrato.rate;
      const depth = ctx.createGain();
      depth.gain.value = freq * p.vibrato.depth;
      lfo.connect(depth).connect(param);
      nodes.push(lfo);
    };

    if (p.engine === 'fm') {
      const car = ctx.createOscillator();
      car.type = p.wave;
      bend(car.frequency, freq);
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
      addVibrato(car.frequency);
    } else {
      const osc = ctx.createOscillator();
      osc.type = p.wave;
      bend(osc.frequency, freq);
      addVibrato(osc.frequency);
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
        bend(osc2.frequency, freq);
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

/** Shorthand for a kit made of three presets. */
function trio(addP, subP, accentP, o = {}) {
  return () => ({
    add: new SynthInstrument({ name: addP, preset: addP, baseFreq: o.baseFreq }),
    sub: new SynthInstrument({ name: subP, preset: subP, baseFreq: o.baseFreq }),
    accent: new SynthInstrument({ name: accentP, preset: accentP, baseFreq: 130.81, gain: 0.3 }),
  });
}

/**
 * Named kits for a picker. Every one but `hatnote` is pure synthesis: no audio
 * files, nothing to download, nothing to license, and it works offline.
 */
export const KITS = {
  hatnote: {
    label: 'Bells',
    note: 'The recorded celesta and clavichord. The original sound of the project.',
    make: () => hatnoteKit(),
    sampled: true,
  },
  synth: {
    label: 'Synth bell',
    note: 'An FM bell and a plucked string, generated rather than recorded.',
    make: () => synthKit(),
  },
  water: {
    label: 'Water',
    note: 'Drops in a cavity. The rising pitch is what makes it read as water rather than a beep.',
    make: trio('drop', 'wood', 'well'),
  },
  musicbox: {
    label: 'Music box',
    note: 'Plucked metal tines, bright and short, with a kalimba underneath.',
    make: trio('musicbox', 'kalimba', 'glass'),
  },
  marimba: {
    label: 'Marimba',
    note: 'Tuned wooden bars. Warm, and the least tiring over a long session.',
    make: trio('marimba', 'wood', 'kalimba'),
  },
  gongs: {
    label: 'Gongs',
    note: 'Large and slow, deliberately inharmonic. Best with a sparse feed.',
    make: trio('gong', 'glass', 'gong', { baseFreq: 130.81 }),
  },
  glassy: {
    label: 'Glass',
    note: 'Long, clear and ringing. Turns a busy feed into a wash.',
    make: trio('glass', 'blip', 'pad'),
  },
  chimes: {
    label: 'Wind chimes',
    note: 'Tubes rather than bars, with a long tail. Best on a slow feed.',
    make: trio('chime', 'harp', 'glass'),
  },
  steelpan: {
    label: 'Steel pan',
    note: 'Nearly harmonic partials, so it sings where a gong clangs.',
    make: trio('steelpan', 'wood', 'gong'),
  },
  strings: {
    label: 'Plucked strings',
    note: 'Harp above, deep pizzicato below. The warmest of the set.',
    make: trio('harp', 'bass', 'pad'),
  },
  birds: {
    label: 'Dawn chorus',
    note: 'Chirps and warbles high above the register, with an owl underneath. Busy feeds turn into a hedgerow.',
    make: trio('chirp', 'warble', 'owl'),
  },
  night: {
    label: 'Night',
    note: 'Crickets ticking over a low owl, with the wind for the rare events. Sparse feeds suit it best.',
    make: trio('cricket', 'owl', 'breeze'),
  },
};

export const KIT_NAMES = Object.keys(KITS);

/** Build a kit by name; unknown names fall back to synthesis. */
export function makeKit(name) {
  return (KITS[name] || KITS.synth).make();
}

/**
 * Draw a kit's own waveform onto a canvas context.
 *
 * The shape is rendered from the instrument itself rather than decorated by
 * hand, so a card cannot promise a sound it does not make: the attack, the
 * decay and the character of the timbre are all visible in the envelope. It
 * needs a browser for OfflineAudioContext, and returns false where there is
 * none rather than throwing.
 */
export async function renderKitWaveform(ctx, kitName, { w, h, palette, seconds = 2.4 } = {}) {
  if (typeof OfflineAudioContext === 'undefined') return false;
  const rate = 22050; // plenty for an envelope, and a quarter of the work
  try {
    const kit = makeKit(kitName);
    const off = new OfflineAudioContext(1, Math.ceil(rate * seconds), rate);
    // A sampled kit would otherwise decode fifty-seven files just to draw a
    // thumbnail, which is slow enough to stall the page. Three notes from the
    // same bank give the same envelope for a fiftieth of the work.
    const parts = [kit.add, kit.sub, kit.add].filter(Boolean).map((inst) => {
      if (!Array.isArray(inst.files) || inst.files.length <= 4) return inst;
      const mid = Math.floor(inst.files.length / 2);
      return new SampleInstrument({
        name: inst.name,
        baseUrl: inst.baseUrl,
        exts: inst.exts,
        step: inst.step,
        gain: inst.gain,
        baseSemitone: inst.baseSemitone,
        files: [inst.files[1], inst.files[mid], inst.files[inst.files.length - 2]],
      });
    });
    await Promise.all([...new Set(parts)].map((i) => (i.load ? i.load(off) : null)));
    // Three strikes at different pitches: one note shows an envelope, several
    // show how the instrument behaves across its range.
    [[6, 0.05], [17, 0.75], [1, 1.45]].forEach(([semitone, at], k) => {
      const inst = parts[k % parts.length];
      if (inst) inst.play(off, off.destination, { semitone, velocity: 1, when: at });
    });
    const buf = await off.startRendering();
    const d = buf.getChannelData(0);

    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, w, h);

    const mid = h / 2;
    const per = Math.max(1, Math.floor(d.length / w));
    let peak = 0;
    for (let i = 0; i < d.length; i += 7) peak = Math.max(peak, Math.abs(d[i]));
    if (peak <= 0) return false;
    const scale = (h / 2 - 3) / peak;

    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let x = 0; x < w; x++) {
      let hi = 0;
      const from = x * per;
      for (let i = from; i < from + per && i < d.length; i++) {
        const v = Math.abs(d[i]);
        if (v > hi) hi = v;
      }
      ctx.lineTo(x, mid - hi * scale);
    }
    for (let x = w - 1; x >= 0; x--) {
      let hi = 0;
      const from = x * per;
      for (let i = from; i < from + per && i < d.length; i++) {
        const v = Math.abs(d[i]);
        if (v > hi) hi = v;
      }
      ctx.lineTo(x, mid + hi * scale);
    }
    ctx.closePath();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = palette.anon;
    ctx.fill();

    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = palette.default;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(w, mid + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return true;
  } catch (e) {
    return false;
  }
}
