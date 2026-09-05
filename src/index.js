// Public surface.
export { Sonifier } from './core/sonifier.js';
export { normalize, unitPosition, rngFrom } from './core/event.js';
export { Mapper, SCALES } from './core/mapper.js';
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
} from './audio/instruments.js';

export { CanvasSink, DEFAULT_PALETTE } from './visual/canvas-sink.js';

export {
  websocketSource,
  sseSource,
  pollSource,
  manualSource,
  randomSource,
  ingestSource,
  wikipedia,
  WIKIPEDIA_LANGS,
  WIKIMON_PORTS,
} from './sources/index.js';
