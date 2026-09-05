// AudioContext ownership, master gain, and the autoplay unlock.
//
// Autoplay policy is not an edge case: no sound exists until a user gesture
// resumes the context. The original hid this behind a Chrome version sniff.
// Here it is part of the public API — call unlock() from a click handler.

export class AudioEngine {
  constructor({ volume = 0.7, latencyHint = 'interactive' } = {}) {
    this._volume = volume;
    this._muted = false;
    this._latencyHint = latencyHint;
    this._ctx = null;
    this._master = null;
    this._capture = null;
  }

  get ctx() {
    if (!this._ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is not available in this browser');
      this._ctx = new AC({ latencyHint: this._latencyHint });
      this._master = this._ctx.createGain();
      this._master.gain.value = this._muted ? 0 : this._volume;
      this._master.connect(this._ctx.destination);
    }
    return this._ctx;
  }

  /** Node that instruments should connect to. */
  get destination() {
    this.ctx;
    return this._master;
  }

  get locked() {
    return this.ctx.state !== 'running';
  }

  /** Must be called from inside a user gesture. Resolves true when audible. */
  async unlock() {
    const ctx = this.ctx;

    // iOS routes Web Audio through the "ambient" session by default, which the
    // hardware ring/silent switch mutes -- the page looks alive and plays
    // nothing. Declaring playback intent opts out of that. Safari 16.4+; the
    // guard keeps every other browser unaffected.
    try {
      if (typeof navigator !== 'undefined' && navigator.audioSession) {
        navigator.audioSession.type = 'playback';
      }
    } catch (e) {
      /* not supported here; nothing is lost */
    }

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (e) {
        return false;
      }
    }

    // Mobile browsers suspend the context whenever the tab is backgrounded,
    // and do not always resume it on return.
    if (!this._watchingVisibility && typeof document !== 'undefined') {
      this._watchingVisibility = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this._ctx && this._ctx.state === 'suspended') {
          this._ctx.resume().catch(() => {});
        }
      });
    }
    // iOS additionally wants a buffer actually started during the gesture.
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch (e) {}
    return ctx.state === 'running';
  }

  get volume() {
    return this._volume;
  }

  set volume(v) {
    this._volume = Math.max(0, Math.min(1, Number(v) || 0));
    if (this._master && !this._muted) {
      const t = this._ctx.currentTime;
      this._master.gain.cancelScheduledValues(t);
      this._master.gain.setTargetAtTime(this._volume, t, 0.02);
    }
  }

  get muted() {
    return this._muted;
  }

  set muted(on) {
    this._muted = Boolean(on);
    if (this._master) {
      const t = this._ctx.currentTime;
      this._master.gain.cancelScheduledValues(t);
      this._master.gain.setTargetAtTime(this._muted ? 0 : this._volume, t, 0.02);
    }
  }

  /** MediaStream carrying the master bus, for MediaRecorder. */
  captureStream() {
    if (!this._capture) {
      this._capture = this.ctx.createMediaStreamDestination();
      this.destination.connect(this._capture);
    }
    return this._capture.stream;
  }
}
