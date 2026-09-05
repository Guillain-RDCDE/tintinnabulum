// Public surface.
export { Sonifier } from './core/sonifier.js';
export { normalize, unitPosition, rngFrom } from './core/event.js';
export { Mapper, SCALES, KEYS } from './core/mapper.js';
export { VoicePool } from './core/voices.js';

export { AudioEngine } from './audio/engine.js';
export { AudioSink } from './audio/audio-sink.js';
export { Recorder } from './audio/recorder-sink.js';
export {
  Instrument,
  SampleInstrument,
  SynthInstrument,
  SYNTH_PRESETS,
  hatnoteKit,
  synthKit,
  KITS,
  KIT_NAMES,
  makeKit,
} from './audio/instruments.js';

export { CanvasSink, DEFAULT_PALETTE } from './visual/canvas-sink.js';
export {
  SHAPES,
  SHAPE_NAMES,
  MIXED_POOL,
  DEFAULT_SHAPE,
  drawShape,
  isHollow,
} from './visual/shapes.js';
export {
  SCENES,
  SCENE_NAMES,
  DEFAULT_SCENE,
  registerScene,
  previewScene,
  noise2,
} from './visual/scenes.js';
export {
  PALETTES,
  PALETTE_KEYS,
  DEFAULT_PALETTE_NAME,
  resolvePalette,
  swatchOf,
} from './visual/palettes.js';

export {
  websocketSource,
  sseSource,
  pollSource,
  manualSource,
  randomSource,
  ingestSource,
  wikipedia,
  bitcoin,
  coinbase,
  earthquakes,
  bluesky,
  github,
  noaaAlerts,
  hackerNews,
  WIKIPEDIA_LANGS,
  WIKIPEDIA_LANGUAGES,
  WIKIPEDIA_FLAG_CC,
  WIKIMON_PORTS,
} from './sources/index.js';
