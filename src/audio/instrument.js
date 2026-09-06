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
