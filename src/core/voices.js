// Polyphony allocator.
//
// The original dropped notes first-come-first-served once 15 were sounding,
// which turns to mush under load and silences the events that matter most.
// Here a note may steal the weakest sounding voice, so a burst of noise never
// masks the one big event in it.

const now = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export class VoicePool {
  constructor({ maxVoices = 16, maxPerSecond = 0, stealFade = 0.012 } = {}) {
    this.maxVoices = maxVoices;
    this.maxPerSecond = maxPerSecond; // 0 = unlimited
    this.stealFade = stealFade;
    this._active = [];
    this._tokens = null;
    this._last = 0;
    this.stats = { granted: 0, denied: 0, stolen: 0 };
  }

  get active() {
    return this._active.length;
  }

  _prune(t) {
    for (let i = this._active.length - 1; i >= 0; i--) {
      if (this._active[i].endsAt <= t) this._active.splice(i, 1);
    }
  }

  _token(t) {
    const rate = this.maxPerSecond;
    if (rate <= 0) return true;
    if (this._tokens == null) {
      this._tokens = rate;
      this._last = t;
    }
    this._tokens = Math.min(rate, this._tokens + ((t - this._last) / 1000) * rate);
    this._last = t;
    if (this._tokens < 1) return false;
    this._tokens -= 1;
    return true;
  }

  /**
   * Ask for a voice. Returns null when the note should be dropped, otherwise a
   * slot the caller must attach its stop function to.
   */
  request(salience = 0.5, t = now()) {
    this._prune(t);

    if (!this._token(t)) {
      this.stats.denied++;
      return null;
    }

    if (this._active.length >= this.maxVoices) {
      let weakest = null;
      let wi = -1;
      for (let i = 0; i < this._active.length; i++) {
        if (!weakest || this._active[i].salience < weakest.salience) {
          weakest = this._active[i];
          wi = i;
        }
      }
      if (!weakest || salience <= weakest.salience) {
        this.stats.denied++;
        return null;
      }
      try {
        if (weakest.stop) weakest.stop(this.stealFade);
      } catch (e) {
        /* a dying voice must never break the live one */
      }
      this._active.splice(wi, 1);
      this.stats.stolen++;
    }

    const slot = {
      salience,
      endsAt: t + 250,
      stop: null,
      attach(stopFn, durationMs) {
        slot.stop = stopFn;
        slot.endsAt = t + (durationMs > 0 ? durationMs : 250);
      },
      release() {
        const i = this._active.indexOf(slot);
        if (i >= 0) this._active.splice(i, 1);
      },
    };
    slot.release = slot.release.bind(this);
    this._active.push(slot);
    this.stats.granted++;
    return slot;
  }

  panic() {
    for (const v of this._active) {
      try {
        if (v.stop) v.stop(0.01);
      } catch (e) {}
    }
    this._active.length = 0;
  }
}
