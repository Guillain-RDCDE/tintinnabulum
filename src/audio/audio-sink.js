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
    // bpm 0 means free time: notes sound the instant their event arrives.
    this.tempo = { bpm: 0, division: 8, ...(opts.tempo || {}) };
    this.stats = { played: 0, dropped: 0 };
  }

  /**
   * Snap note onsets to a tempo grid.
   *
   * Events arrive whenever the world produces them, which is by definition
   * arrhythmic. Holding each note until the next subdivision turns the same
   * stream into something metrical -- the single biggest change available to
   * how musical this sounds. A note waits at most one subdivision, so at a
   * slow tempo the picture leads the sound slightly; that is the trade.
   */
  setTempo(bpm, division = this.tempo.division) {
    this.tempo = { bpm: Math.max(0, Number(bpm) || 0), division: Number(division) || 8 };
    return this;
  }

  _onset(ctx) {
    const { bpm, division } = this.tempo;
    if (!bpm) return 0; // 0 tells the instrument to start immediately
    const step = (60 / bpm) * (4 / division);
    // The small guard keeps us from ever scheduling a beat already gone by.
    return Math.ceil((ctx.currentTime + 0.004) / step) * step;
  }

  setKit(kit) {
    this.kit = kit;
    return this;
  }

  /**
   * Loads a kit and only then makes it the active one.
   *
   * Assigning first leaves a window -- seconds, on a phone -- in which the new
   * instruments have no buffers yet, so every note is silently dropped. The
   * outgoing kit keeps playing until the new one can actually sound, and an
   * unusable kit is not swapped in at all.
   */
  async loadKit(kit) {
    const ctx = this.engine.ctx;
    const list = [...new Set(Object.values(kit).filter(Boolean))];
    const problems = [];
    await Promise.all(
      list.map(async (i) => {
        try {
          await i.load(ctx);
        } catch (e) {
          problems.push(`${i.name}: ${e.message}`);
        }
        if (i.failures && i.failures.length) {
          problems.push(`${i.name}: ${i.failures.length} sample(s) unavailable`);
        }
      })
    );
    const playable = list.filter((i) => i.ready !== false);
    const status = {
      ok: playable.length === list.length && problems.length === 0,
      usable: playable.length > 0,
      instruments: list.length,
      playable: playable.length,
      problems,
    };
    if (status.usable) {
      this.kit = kit;
      this.status = status;
    }
    return status;
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

  /**
   * Loads every instrument, tolerating failures, and reports what happened.
   * A kit that cannot load must say so: failing silently here is how a page
   * ends up drawing circles and playing nothing.
   */
  async load() {
    const ctx = this.engine.ctx;
    const list = this.instruments();
    const problems = [];
    await Promise.all(
      list.map(async (i) => {
        try {
          await i.load(ctx);
        } catch (e) {
          problems.push(`${i.name}: ${e.message}`);
        }
        if (i.failures && i.failures.length) {
          problems.push(`${i.name}: ${i.failures.length} sample(s) unavailable`);
        }
      })
    );
    const playable = list.filter((i) => i.ready !== false);
    this.status = {
      ok: playable.length === list.length && problems.length === 0,
      usable: playable.length > 0,
      instruments: list.length,
      playable: playable.length,
      problems,
    };
    return this.status;
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

    const when = this._onset(ctx);

    if (ev.accent && this.kit.accent) {
      try {
        this.kit.accent.play(ctx, dest, { semitone: ev.map.semitone, velocity: 1, when });
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
        when,
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
