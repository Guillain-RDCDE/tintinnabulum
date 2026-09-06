// Ready-made {add, sub, accent} sets, and the registry behind the picker.

import { SampleInstrument } from './sample-instrument.js';
import { SynthInstrument } from './synth-instrument.js';


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
