// Colour palettes for the canvas.
//
// Each palette must define every key below. `background` is the canvas ground;
// `text` is used for labels, which are stroked with `background` so they stay
// legible over any circle. The category keys colour the circles: `default` is
// the fallback for a category nobody defined, so a custom category always gets
// a visible colour rather than disappearing.
//
// Palettes are pure data. Adding one is adding an entry here.

export const PALETTE_KEYS = [
  'background', 'default', 'user', 'anon', 'bot', 'alert', 'text', 'banner', 'hud',
];

export const PALETTES = {
  nocturne: {
    label: 'Nocturne',
    note: 'The original: slate blue, night-time, high contrast.',
    colors: {
      background: '#1c2733',
      default: '#ffffff',
      user: '#ffffff',
      anon: '#2ecc71',
      bot: '#9b59b6',
      alert: '#e67e22',
      text: '#ffffff',
      banner: 'rgba(41, 128, 185, 0.85)',
      hud: 'rgba(41, 128, 185, 0.50)',
    },
  },

  bronze: {
    label: 'Bronze',
    note: 'Brass and copper. The colour of the bells the project is named after.',
    colors: {
      background: '#14100c',
      default: '#f2e2c4',
      user: '#f2e2c4',
      anon: '#d9a441',
      bot: '#8a4a26',
      alert: '#ff4d2e',
      text: '#f6ecdc',
      banner: 'rgba(176, 106, 59, 0.85)',
      hud: 'rgba(176, 106, 59, 0.50)',
    },
  },

  aurora: {
    label: 'Aurora',
    note: 'Mint and violet over deep teal. Cold and luminous.',
    colors: {
      background: '#071a1c',
      default: '#d7fff4',
      user: '#d7fff4',
      anon: '#35e0a1',
      bot: '#7b6cf6',
      alert: '#ff7ab6',
      text: '#eafff9',
      banner: 'rgba(53, 224, 161, 0.75)',
      hud: 'rgba(53, 224, 161, 0.45)',
    },
  },

  ember: {
    label: 'Ember',
    note: 'Banked fire. Warm, dim, easy at night.',
    colors: {
      background: '#1a0f0b',
      default: '#ffd9a8',
      user: '#ffd9a8',
      anon: '#ff8c42',
      bot: '#a8302c',
      alert: '#ffc300',
      text: '#fff1e0',
      banner: 'rgba(201, 69, 63, 0.85)',
      hud: 'rgba(201, 69, 63, 0.50)',
    },
  },

  ultraviolet: {
    label: 'Ultraviolet',
    note: 'Magenta and cyan on near-black. The loudest one here.',
    colors: {
      background: '#0d0518',
      default: '#f0e6ff',
      user: '#f0e6ff',
      anon: '#0891b2',
      bot: '#c026d3',
      alert: '#fbbf24',
      text: '#f5ecff',
      banner: 'rgba(192, 38, 211, 0.80)',
      hud: 'rgba(192, 38, 211, 0.50)',
    },
  },

  blueprint: {
    label: 'Blueprint',
    note: 'Technical drawing. Calm, and the most readable at a glance.',
    colors: {
      background: '#0b1f33',
      default: '#f1f5f9',
      user: '#f1f5f9',
      anon: '#38bdf8',
      bot: '#818cf8',
      alert: '#f59e0b',
      text: '#eaf3ff',
      banner: 'rgba(56, 189, 248, 0.75)',
      hud: 'rgba(56, 189, 248, 0.45)',
    },
  },

  sakura: {
    label: 'Sakura',
    note: 'Blossom and lilac on plum. Soft without losing contrast.',
    colors: {
      background: '#1b1020',
      default: '#fdf7fb',
      user: '#fdf7fb',
      anon: '#ff9ec7',
      bot: '#8b5cf6',
      alert: '#ffd166',
      text: '#fff0f6',
      banner: 'rgba(255, 158, 199, 0.75)',
      hud: 'rgba(255, 158, 199, 0.45)',
    },
  },

  daylight: {
    label: 'Daylight',
    note: 'Ink on paper. The one to use for screenshots and projectors.',
    colors: {
      background: '#f4f1ea',
      default: '#2f3a45',
      user: '#2f3a45',
      anon: '#12805f',
      bot: '#7c3aed',
      alert: '#dc2626',
      text: '#1c2733',
      banner: 'rgba(47, 58, 69, 0.85)',
      hud: 'rgba(47, 58, 69, 0.45)',
    },
  },

  monochrome: {
    label: 'Monochrome',
    note: 'Categories separated by lightness alone, so colour vision is never required.',
    colors: {
      background: '#101214',
      default: '#c9c9c9',
      user: '#c9c9c9',
      anon: '#8a8a8a',
      bot: '#585858',
      alert: '#ffffff',
      text: '#fafafa',
      banner: 'rgba(120, 120, 120, 0.80)',
      hud: 'rgba(120, 120, 120, 0.45)',
    },
  },
};

export const DEFAULT_PALETTE_NAME = 'nocturne';

/** Accepts a palette name or a colours object; always returns a full set. */
export function resolvePalette(nameOrColors) {
  if (nameOrColors && typeof nameOrColors === 'object') {
    return { ...PALETTES[DEFAULT_PALETTE_NAME].colors, ...nameOrColors };
  }
  const entry = PALETTES[nameOrColors] || PALETTES[DEFAULT_PALETTE_NAME];
  return { ...entry.colors };
}

/** The few colours a picker needs to show for a palette, ground first. */
export function swatchOf(name) {
  const c = resolvePalette(name);
  return { background: c.background, dots: [c.user, c.anon, c.bot, c.alert] };
}
