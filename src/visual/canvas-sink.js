import { rngFrom } from '../core/event.js';
import { PALETTES, DEFAULT_PALETTE_NAME, resolvePalette } from './palettes.js';
import { shadeOf, lighten, lightnessOf } from './color.js';
import { SHAPES, DEFAULT_SHAPE } from './shapes.js';
import { SCENES, DEFAULT_SCENE } from './scenes/index.js';

// Canvas 2D rewrite of the original D3 v3 visuals.
//
// D3 v3 is unmaintained and the APIs this project used (.attr({}) with an
// object, .each('end', fn)) were removed in v4, so a migration was a rewrite
// either way. Canvas also survives the event rates SVG chokes on: one node per
// circle plus a transition per circle is thousands of DOM mutations a minute.

export { PALETTES, DEFAULT_PALETTE_NAME, resolvePalette } from './palettes.js';
export { shadeOf, lighten, lightnessOf, parseColor } from './color.js';
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

    // How far each event's colour may wander from its category's. At 0 every
    // event of a category is the same ink, which is the behaviour colour-coded
    // reading needs; above that a category becomes a family of shades, which is
    // what gives a dense field any depth at all. See color.js.
    this.richness = opts.richness ?? 0.45;
    // Gradient fills and an additive halo. Cheap on a dark ground, wrong on a
    // light one, so it follows the palette unless asked otherwise.
    this.depth = opts.depth !== false;
    this._darkGround = lightnessOf(this.palette.background) < 0.5;

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
    p._grad = null; // a gradient is tied to the coordinates it was built at
  }

  /** The category's own colour, before any per-event variation. */
  baseColorFor(category) {
    return this.palette[category] || this.palette.default;
  }

  colorFor(ev) {
    return this.baseColorFor(ev.category);
  }

  /**
   * A radial gradient standing in for the flat fill, cached on the particle.
   *
   * Building one per mark per frame would be some fifty thousand gradients a
   * second at a full canvas. Nothing about a mark's gradient changes once it is
   * placed, so it is built once and dropped whenever position or colour does
   * change -- on resize, and on a palette or richness change.
   */
  fillFor(ctx, p) {
    if (!this.depth) return p.color;
    if (p._grad) return p._grad;
    // Deliberately shallow. A strong highlight turns every mark into a glass
    // bead, which is a look, but not this one: the point is to keep a large
    // disc from reading as one dead area of colour, not to render spheres.
    const g = ctx.createRadialGradient(
      p.x - p.r * 0.3, p.y - p.r * 0.34, p.r * 0.08,
      p.x, p.y, p.r * 1.1
    );
    g.addColorStop(0, lighten(p.color, 0.07));
    g.addColorStop(0.6, p.color);
    g.addColorStop(1, lighten(p.color, -0.05));
    p._grad = g;
    return g;
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
      depth: this.depth,
      richness: this.richness,
      darkGround: this._darkGround,
      // The ceiling scenes size their own collections against. Several keep
      // arrays of their own -- drops, trails, seeds, bars -- and those used to
      // carry hard-coded caps of their own, so raising the limit governed the
      // marks and nothing else.
      budget: this.maxParticles,
      // Scenes ask for a fill rather than reading p.color, so the gradient and
      // its caching stay here instead of being copied into every scene.
      fill: (ctx, p) => this.fillFor(ctx, p),
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
    this._darkGround = lightnessOf(this.palette.background) < 0.5;
    this._recolor();
    return this;
  }

  /**
   * How far each event strays from its category's colour, 0 to 1.
   *
   * 0 is the old behaviour and the honest setting when colour carries meaning:
   * every bot is the same colour, so a bot can be picked out. Above that the
   * screen gains depth at the cost of that certainty, which is the right trade
   * for watching a flow rather than auditing it.
   */
  setRichness(value) {
    this.richness = Math.max(0, Math.min(1, Number(value) || 0));
    this._recolor();
    return this;
  }

  /**
   * The ceiling on how much is kept on screen at once.
   *
   * A burst of data must cost frames, never the tab. Every collection the
   * renderer or a scene keeps is bounded by this one number, so a machine that
   * struggles can be given a smaller budget and a fast one a larger. Scenes
   * hold their own arrays, and lowering the ceiling cannot retroactively shrink
   * what they have already built, so their state is restarted.
   */
  setMaxParticles(n) {
    const next = Math.max(50, Math.min(20000, Math.round(Number(n) || 0)));
    if (next === this.maxParticles) return this;
    this.maxParticles = next;
    if (this.particles.length > next) this.particles.splice(0, this.particles.length - next);
    this._initScene();
    return this;
  }

  /** Gradient fills and additive halos. Off restores flat marks. */
  setDepth(on) {
    this.depth = Boolean(on);
    for (const p of this.particles) p._grad = null;
    return this;
  }

  /**
   * Give one mark its shade and its rim.
   *
   * The rim moves away from the ground rather than towards a fixed colour: on
   * a dark palette it lifts, on paper it darkens. A rim that always lightened
   * would vanish on Daylight, which is the palette most likely to be projected.
   */
  _shade(p) {
    p.color = shadeOf(p.base, p.tint || [0.5, 0.5, 0.5], this.richness);
    // Away from the ground, but less for an already-light mark: lightening a
    // near-white by a fixed step just draws a white ring around it.
    const room = this._darkGround ? 1 - lightnessOf(p.color) : lightnessOf(p.color);
    p.rim = lighten(p.color, (this._darkGround ? 0.26 : -0.26) * Math.min(1, room * 1.6));
    p._grad = null;
  }

  /** Re-derive every mark's shade from the colour it was born with. */
  _recolor() {
    for (const p of this.particles) {
      p.base = this.baseColorFor(p.category);
      this._shade(p);
    }
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
    // Drawn from the same stream, so the shade is as stable as the position:
    // the same event always looks the same, and a palette change re-derives it
    // rather than reshuffling the screen.
    const tint = [rnd(), rnd(), rnd()];
    const base = this.colorFor(ev);
    const p = {
      u,
      v,
      rot,
      pick,
      tint,
      r,
      x: 0,
      y: 0,
      born: now,
      life: this.life,
      category: ev.category,
      base,
      color: '',
      rim: '',
      _grad: null,
      alpha0: ev.dimmed ? this.dimOpacity : this.fillOpacity,
      label: ev.label || '',
      url: ev.url || '',
      ring: !ev.dimmed,
    };
    this._shade(p);
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

    // Expiry first, drawing second. These used to be the same loop, walking
    // newest-first and breaking as soon as it had drawn one -- so on any feed
    // with a steady trickle of accent events the newest banner was always
    // fresh, the loop broke immediately, and every older banner behind it was
    // never looked at again. The array grew for as long as the page ran.
    while (this.banners.length && now - this.banners[0].born >= 7000) this.banners.shift();
    if (this.banners.length > 32) this.banners.splice(0, this.banners.length - 32);

    for (let i = this.banners.length - 1; i >= 0; i--) {
      const b = this.banners[i];
      const age = now - b.born;
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

    // Unconditionally: this list was trimmed inside _hud(), so turning the rate
    // counter off left it growing by one entry per event for the life of the
    // page. On a firehose that is a hundred thousand an hour.
    this._trimRecent();
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

  /** Drop event timestamps older than the minute the rate counter reports on. */
  _trimRecent() {
    const cutoff = Date.now() - 60000;
    while (this._recent.length && this._recent[0] < cutoff) this._recent.shift();
    // A source may hand over timestamps that are not in order, or not real
    // clock times at all, in which case the cutoff above never fires. The rate
    // readout covers a minute, so more than this many entries cannot inform it.
    if (this._recent.length > 60000) this._recent.splice(0, this._recent.length - 60000);
  }

  _hud(ctx) {
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
