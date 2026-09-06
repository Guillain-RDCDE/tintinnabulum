// Two synthesis engines, driven entirely by the preset table.

import { Instrument } from './instrument.js';
import { SYNTH_PRESETS } from './presets.js';

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
