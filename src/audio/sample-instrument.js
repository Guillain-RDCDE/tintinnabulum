// Recorded banks, resampled to a continuous pitch.

import { Instrument } from './instrument.js';

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
