import { rngFrom } from '../core/event.js';
import { PALETTES, DEFAULT_PALETTE_NAME, resolvePalette } from './palettes.js';
import { SHAPES, DEFAULT_SHAPE } from './shapes.js';
import { SCENES, DEFAULT_SCENE } from './scenes/index.js';

// Canvas 2D rewrite of the original D3 v3 visuals.
//
// D3 v3 is unmaintained and the APIs this project used (.attr({}) with an
// object, .each('end', fn)) were removed in v4, so a migration was a rewrite
// either way. Canvas also survives the event rates SVG chokes on: one node per
// circle plus a transition per circle is thousands of DOM mutations a minute.

export { PALETTES, DEFAULT_PALETTE_NAME, resolvePalette } from './palettes.js';
export { SHAPES, SHAPE_NAMES, DEFAULT_SHAPE } from './shapes.js';
export { SCENES, SCENE_NAMES, DEFAULT_SCENE, registerScene } from './scenes/index.js';

/** The default colours, kept as a named export for convenience. */
export const DEFAULT_PALETTE = resolvePalette(DEFAULT_PALETTE_NAME);

export class CanvasSink {
  constructor(canvas, opts = {}) {
    this.canvas = typeof canvas === 'string' ? document.querySelector(canvas) : canvas;
    if (!this.canvas) throw new Error('CanvasSink: canvas not found');
    this.ctx = this.canvas.getContext('2d');
    this.paletteName =
      typeof opts.palette === 'string' && PALETTES[opts.palette]
        ? opts.palette
        : DEFAULT_PALETTE_NAME;
    this.palette = resolvePalette(opts.palette || DEFAULT_PALETTE_NAME);

    this.life = opts.life ?? 12000; // ms a circle stays visible
    this.ringLife = opts.ringLife ?? 2200;
    this.maxRadius = opts.maxRadius ?? 90;
    this.minRadius = opts.minRadius ?? 3;
    this.fillOpacity = opts.fillOpacity ?? 0.5;
    this.dimOpacity = opts.dimOpacity ?? 0.15;
    this.labelLife = opts.labelLife ?? 3000;
    this.showLabels = opts.showLabels !== false;
    this.showHud = opts.showHud !== false;
    this.maxParticles = opts.maxParticles ?? 800;
    this.margin = opts.margin ?? 8;

    this.shape =
      SHAPES[opts.shape] || opts.shape === 'mixed' ? opts.shape : DEFAULT_SHAPE;
    // (SHAPES[name] covers the named shapes; 'mixed' is the per-event variant.)
    this.starfield = Boolean(opts.starfield);
    this.starCount = opts.starCount ?? 140;
    this._stars = null;

    this.sceneName = SCENES[opts.scene] ? opts.scene : DEFAULT_SCENE;
    this._scene = {}; // scratch space owned by the active scene
    this._lastFrame = 0;

    this.particles = [];
    this.banners = [];
    this._recent = []; // timestamps, for the rate readout
    this._hover = null;
    this._running = false;
    this._raf = 0;
    this._dpr = 1;

    this._onResize = this._onResize.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onClick = this._onClick.bind(this);
    this._frame = this._frame.bind(this);
  }

  start() {
    if (this._running) return this;
    this._running = true;
    window.addEventListener('resize', this._onResize);
    this.canvas.addEventListener('mousemove', this._onMove);
    this.canvas.addEventListener('click', this._onClick);
    this.canvas.addEventListener('mouseleave', () => (this._hover = null));
    this._onResize();
    this._raf = requestAnimationFrame(this._frame);
    return this;
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    this.canvas.removeEventListener('mousemove', this._onMove);
    this.canvas.removeEventListener('click', this._onClick);
    return this;
  }

  clear() {
    this.particles.length = 0;
    this.banners.length = 0;
    return this;
  }

  _onResize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this._dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Keep existing particles where their id says they belong.
    for (const p of this.particles) this._place(p);
    this._stars = null; // rebuilt against the new size
    this._initScene(); // scenes size their own structures to the canvas
  }

  _place(p) {
    const pad = p.r + this.margin;
    p.x = pad + p.u * Math.max(1, this.w - pad * 2);
    p.y = pad + p.v * Math.max(1, this.h - pad * 2);
  }

  colorFor(ev) {
    return this.palette[ev.category] || this.palette.default;
  }

  /** The surface handed to the active scene each frame. */
  _sceneApi(now = 0) {
    return {
      w: this.w,
      h: this.h,
      palette: this.palette,
      particles: this.particles,
      shape: this.shape,
      ringLife: this.ringLife,
      now,
      dt: this._dt || 16,
      scene: this._scene,
    };
  }

  _initScene() {
    this._scene = {};
    const scene = SCENES[this.sceneName];
    if (scene && scene.init) {
      try {
        scene.init(this._sceneApi(this._lastFrame));
      } catch (e) {
        console.error('scene "' + this.sceneName + '" failed to start', e);
      }
    }
  }

  /**
   * Switch visualisation at runtime. Scenes share the event model and only
   * decide what a moment of data looks like, so nothing else changes.
   */
  setScene(name) {
    if (!SCENES[name]) return this;
    this.sceneName = name;
    this._initScene();
    return this;
  }

  /** Switch the mark shape at runtime. 'mixed' varies it per event id. */
  setShape(name) {
    if (SHAPES[name] || name === 'mixed') this.shape = name;
    return this;
  }

  /** Faint fixed stars behind the marks. Deterministic, so they never crawl. */
  setStarfield(on) {
    this.starfield = Boolean(on);
    return this;
  }

  _buildStars() {
    const r = rngFrom('tintinnabulum-starfield');
    this._stars = Array.from({ length: this.starCount }, () => ({
      u: r(),
      v: r(),
      r: 0.4 + r() * 1.3,
      phase: r() * Math.PI * 2,
      speed: 0.4 + r() * 0.9,
    }));
  }

  /**
   * Switch palette at runtime. Marks already on screen are recoloured from the
   * category they were born with, so a change takes effect immediately instead
   * of waiting for the canvas to turn over.
   */
  setPalette(nameOrColors) {
    this.palette = resolvePalette(nameOrColors);
    this.paletteName =
      typeof nameOrColors === 'string' && PALETTES[nameOrColors]
        ? nameOrColors
        : this.paletteName;
    for (const p of this.particles) {
      p.color = this.palette[p.category] || this.palette.default;
    }
    return this;
  }

  handle(ev) {
    if (!ev.map) return;
    const now = performance.now();
    this._recent.push(ev.ts);

    const r = Math.max(this.minRadius, Math.sqrt(ev.map.p) * this.maxRadius);
    // One stream per id: position, then rotation, then the shape draw. Stable,
    // so a repeat event returns identical in every respect.
    const rnd = rngFrom(ev.id);
    const u = rnd();
    const v = rnd();
    const rot = rnd() * Math.PI * 2;
    const pick = rnd();
    const p = {
      u,
      v,
      rot,
      pick,
      r,
      x: 0,
      y: 0,
      born: now,
      life: this.life,
      category: ev.category,
      color: this.colorFor(ev),
      alpha0: ev.dimmed ? this.dimOpacity : this.fillOpacity,
      label: ev.label || '',
      url: ev.url || '',
      ring: !ev.dimmed,
    };
    this._place(p);
    this.particles.push(p);
    if (this.particles.length > this.maxParticles) {
      this.particles.splice(0, this.particles.length - this.maxParticles);
    }

    const scene = SCENES[this.sceneName];
    if (scene && scene.event) {
      try {
        scene.event(p, this._sceneApi(now));
      } catch (e) {
        console.error('scene "' + this.sceneName + '" failed on an event', e);
      }
    }

    if (ev.accent && !ev.dimmed) {
      this.banners.push({ born: now, text: ev.label || 'New event', url: ev.url || '' });
    }
  }

  _pointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  hitTest(x, y) {
    // Scenes that do not draw marks at their particle's position cannot be
    // meaningfully clicked: the thing under the cursor is not that event.
    const scene = SCENES[this.sceneName];
    if (scene && scene.positional === false) return null;
    // Topmost (most recent) first.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const dx = x - p.x;
      const dy = y - p.y;
      if (dx * dx + dy * dy <= p.r * p.r) return p;
    }
    return null;
  }

  _onMove(e) {
    const { x, y } = this._pointer(e);
    this._hover = this.hitTest(x, y);
    this.canvas.style.cursor = this._hover && this._hover.url ? 'pointer' : 'default';
  }

  _onClick(e) {
    const { x, y } = this._pointer(e);
    const hit = this.hitTest(x, y);
    if (hit && hit.url) window.open(hit.url, '_blank', 'noopener');
  }

  _frame(now) {
    if (!this._running) return;
    const ctx = this.ctx;
    // Capture the gap before advancing the clock: the scenes integrate motion
    // against it, and a zero dt freezes everything that moves.
    this._dt = this._lastFrame ? Math.min(100, now - this._lastFrame) : 16;
    this._lastFrame = now;

    ctx.fillStyle = this.palette.background;
    ctx.fillRect(0, 0, this.w, this.h);

    if (this.starfield) {
      if (!this._stars) this._buildStars();
      ctx.fillStyle = this.palette.text;
      for (const s of this._stars) {
        // Slow, per-star phase so the sky breathes instead of blinking together.
        const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((now / 1000) * s.speed + s.phase));
        const x = s.u * this.w;
        const y = s.v * this.h;
        ctx.globalAlpha = 0.55 * tw;
        ctx.beginPath();
        ctx.arc(x, y, s.r, 0, Math.PI * 2);
        ctx.fill();
        // The brightest few get a soft halo, which is what stops the field
        // reading as evenly scattered dust.
        if (s.r > 1.35) {
          ctx.globalAlpha = 0.14 * tw;
          ctx.beginPath();
          ctx.arc(x, y, s.r * 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Lifetimes are managed here, not in the scenes: every scene shares one
    // event model, and only decides what a moment of data looks like.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      if (now - this.particles[i].born >= this.particles[i].life) this.particles.splice(i, 1);
    }

    const scene = SCENES[this.sceneName] || SCENES[DEFAULT_SCENE];
    const api = this._sceneApi(now);
    ctx.save();
    try {
      scene.frame(ctx, api);
    } catch (e) {
      console.error('scene "' + this.sceneName + '" failed', e);
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // Labels only where the marks actually sit at their particle's position.
    if (scene.positional !== false) {
      for (const p of this.particles) {
        const age = now - p.born;
        const hovered = this._hover === p;
        if (p.label && (hovered || (this.showLabels && age < this.labelLife && p.ring))) {
          const a = hovered ? 1 : Math.min(1, 2 - (age / this.labelLife) * 2);
          if (a > 0) this._label(p.x, p.y - p.r - 6, p.label, a);
        }
      }
    }

    for (let i = this.banners.length - 1; i >= 0; i--) {
      const b = this.banners[i];
      const age = now - b.born;
      if (age >= 7000) {
        this.banners.splice(i, 1);
        continue;
      }
      const a = age < 500 ? age / 500 : age > 5000 ? Math.max(0, 1 - (age - 5000) / 2000) : 1;
      ctx.globalAlpha = a;
      ctx.fillStyle = this.palette.banner;
      ctx.fillRect(0, 0, this.w, 36);
      ctx.fillStyle = this.palette.text;
      ctx.font = '15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(b.text, this.w / 2, 24);
      break; // one banner at a time
    }

    if (this.showHud) this._hud(ctx);

    ctx.globalAlpha = 1;
    this._raf = requestAnimationFrame(this._frame);
  }

  _label(x, y, text, alpha) {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    // The original faked this with an 8-way CSS text-shadow; a stroke is the
    // same effect for a fraction of the work.
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.palette.background;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = this.palette.text;
    ctx.fillText(text, x, y);
  }

  _hud(ctx) {
    const cutoff = Date.now() - 60000;
    while (this._recent.length && this._recent[0] < cutoff) this._recent.shift();
    const label = this._recent.length + ' events per minute';
    ctx.globalAlpha = 1;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const w = ctx.measureText(label).width + 16;
    ctx.fillStyle = this.palette.hud;
    ctx.fillRect(0, this.h - 25, w, 25);
    ctx.fillStyle = this.palette.text;
    ctx.fillText(label, 8, this.h - 8);
  }
}
