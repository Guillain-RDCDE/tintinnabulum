// Records the master bus to a file. Not a sink in the event sense — it taps
// the audio graph — but it lives in the same lifecycle, so it is exposed the
// same way.

const CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export class Recorder {
  constructor(engine, { mimeType, timeslice = 1000 } = {}) {
    this.engine = engine;
    this.timeslice = timeslice;
    this.mimeType = mimeType || Recorder.bestMimeType();
    this._rec = null;
    this._chunks = [];
    this.startedAt = 0;
  }

  static get supported() {
    return typeof MediaRecorder !== 'undefined';
  }

  static bestMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    for (const t of CANDIDATES) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  get recording() {
    return Boolean(this._rec && this._rec.state === 'recording');
  }

  start() {
    if (this.recording) return this;
    if (!Recorder.supported) throw new Error('MediaRecorder is not available');
    const stream = this.engine.captureStream();
    this._chunks = [];
    this._rec = new MediaRecorder(stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    this._rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this._chunks.push(e.data);
    };
    this._rec.start(this.timeslice);
    this.startedAt = Date.now();
    return this;
  }

  /** @returns {Promise<Blob>} */
  stop() {
    return new Promise((resolve) => {
      if (!this._rec || this._rec.state === 'inactive') {
        resolve(new Blob(this._chunks, { type: this.mimeType || 'audio/webm' }));
        return;
      }
      this._rec.onstop = () => {
        resolve(new Blob(this._chunks, { type: this.mimeType || 'audio/webm' }));
      };
      this._rec.stop();
    });
  }

  async save(filename) {
    const blob = await this.stop();
    const ext = (this.mimeType.split('/')[1] || 'webm').split(';')[0];
    const name =
      filename || `tintinnabulum-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return blob;
  }
}
