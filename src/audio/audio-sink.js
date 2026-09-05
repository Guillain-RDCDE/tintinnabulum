import { VoicePool } from '../core/voices.js';

// Turns mapped events into sound. Instrument choice is: category override
// first, then polarity. Accents bypass the voice pool entirely, because a rare
// notable event should never be dropped by a burst of ordinary ones.

export class AudioSink {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.pool = opts.pool || new VoicePool();
    this.kit = opts.kit || {}; // { add, sub, neutral, accent }
    this.byCategory = opts.byCategory || {}; // { bot: Instrument, ... }
    this.enabled = opts.enabled !== false;
    this.stats = { played: 0, dropped: 0 };
  }

  setKit(kit) {
    this.kit = kit;
    return this;
  }

  /** Every distinct instrument currently reachable. */
  instruments() {
    const seen = new Set();
    for (const src of [this.kit, this.byCategory]) {
      for (const k of Object.keys(src || {})) {
        if (src[k]) seen.add(src[k]);
      }
    }
    return [...seen];
  }

  async load() {
    const ctx = this.engine.ctx;
    await Promise.all(this.instruments().map((i) => i.load(ctx)));
    return this;
  }

  pick(ev) {
    if (this.byCategory[ev.category]) return this.byCategory[ev.category];
    if (ev.polarity < 0) return this.kit.sub || this.kit.add;
    if (ev.polarity > 0) return this.kit.add;
    return this.kit.neutral || this.kit.add;
  }

  handle(ev) {
    if (!this.enabled || ev.dimmed || !ev.map) return false;
    const ctx = this.engine.ctx;
    const dest = this.engine.destination;

    if (ev.accent && this.kit.accent) {
      try {
        this.kit.accent.play(ctx, dest, { semitone: ev.map.semitone, velocity: 1 });
      } catch (e) {
        console.warn('accent failed', e);
      }
    }

    const inst = this.pick(ev);
    if (!inst) return false;

    const slot = this.pool.request(ev.map.salience);
    if (!slot) {
      this.stats.dropped++;
      return false;
    }

    let voice = null;
    try {
      voice = inst.play(ctx, dest, {
        semitone: ev.map.semitone,
        velocity: ev.map.velocity,
      });
    } catch (e) {
      console.warn('instrument failed', e);
    }

    if (!voice) {
      slot.release();
      this.stats.dropped++;
      return false;
    }

    slot.attach(voice.stop, voice.duration);
    this.stats.played++;
    return true;
  }
}
