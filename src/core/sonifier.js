import { normalize } from './event.js';
import { Mapper } from './mapper.js';
import { VoicePool } from './voices.js';
import { AudioEngine } from '../audio/engine.js';
import { AudioSink } from '../audio/audio-sink.js';
import { hatnoteKit, synthKit } from '../audio/instruments.js';

// The facade. Sources push in, sinks read out, and the mapper sits in the
// middle deciding what each magnitude sounds like.

export class Sonifier {
  constructor(opts = {}) {
    this.mapper = opts.mapper || new Mapper(opts.mapping);
    this.engine = opts.engine || new AudioEngine({ volume: opts.volume ?? 0.7 });
    this.pool = opts.pool || new VoicePool(opts.voices);

    const kit =
      opts.kit === 'synth'
        ? synthKit()
        : opts.kit === 'hatnote' || opts.kit == null
        ? hatnoteKit(opts.sampleBaseUrl ? { baseUrl: opts.sampleBaseUrl } : {})
        : opts.kit;

    this.audio = new AudioSink(this.engine, {
      pool: this.pool,
      kit,
      byCategory: opts.byCategory,
    });

    this.sinks = [this.audio];
    this.sources = [];
    this.filters = [];
    this._listeners = [];
    this._times = [];
    this.stats = { received: 0, rejected: 0, dimmed: 0 };
  }

  // --- wiring -------------------------------------------------------------

  /** Add a sink: anything with handle(event). Started if it has start(). */
  use(sink) {
    if (!sink) return this;
    if (sink.start) sink.start();
    this.sinks.push(sink);
    return this;
  }

  /** Predicate returning false to silence an event (it is still drawn, dimmed). */
  filter(fn) {
    this.filters.push(fn);
    return this;
  }

  clearFilters() {
    this.filters.length = 0;
    return this;
  }

  /** Observe every normalized event, after mapping. */
  on(fn) {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  connect(source) {
    if (!source) return this;
    source.start((ev) => this.emit(ev));
    this.sources.push(source);
    return this;
  }

  disconnect(source) {
    if (source) {
      const i = this.sources.indexOf(source);
      if (i >= 0) this.sources.splice(i, 1);
      if (source.stop) source.stop();
      return this;
    }
    for (const s of this.sources) if (s.stop) s.stop();
    this.sources.length = 0;
    return this;
  }

  // --- lifecycle ----------------------------------------------------------

  /** Call from a click handler: resumes the AudioContext and loads samples. */
  async unlock() {
    const ok = await this.engine.unlock();
    await this.audio.load();
    return ok;
  }

  get locked() {
    return this.engine.locked;
  }

  async setKit(kit) {
    this.audio.setKit(typeof kit === 'string' ? (kit === 'synth' ? synthKit() : hatnoteKit()) : kit);
    if (!this.engine.locked) await this.audio.load();
    return this;
  }

  // --- the hot path -------------------------------------------------------

  emit(raw) {
    const ev = normalize(raw);
    if (!ev) {
      this.stats.rejected++;
      return null;
    }
    ev.map = this.mapper.map(ev.magnitude);

    for (const f of this.filters) {
      let keep = true;
      try {
        keep = f(ev);
      } catch (e) {
        console.warn('filter threw', e);
      }
      if (!keep) {
        ev.dimmed = true;
        break;
      }
    }
    if (ev.dimmed) this.stats.dimmed++;
    this.stats.received++;

    this._times.push(ev.ts);
    if (this._times.length > 4000) this._times.splice(0, this._times.length - 4000);

    for (const s of this.sinks) {
      try {
        if (s.handle) s.handle(ev);
      } catch (e) {
        console.error('sink failed', e);
      }
    }
    for (const l of this._listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error('listener failed', e);
      }
    }
    return ev;
  }

  get eventsPerMinute() {
    const cutoff = Date.now() - 60000;
    while (this._times.length && this._times[0] < cutoff) this._times.shift();
    return this._times.length;
  }

  get volume() {
    return this.engine.volume;
  }
  set volume(v) {
    this.engine.volume = v;
  }
  get muted() {
    return this.engine.muted;
  }
  set muted(v) {
    this.engine.muted = v;
  }

  destroy() {
    this.disconnect();
    this.pool.panic();
    for (const s of this.sinks) if (s.stop) s.stop();
    this.sinks.length = 0;
  }
}
