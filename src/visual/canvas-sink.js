import { unitPosition } from '../core/event.js';

// Canvas 2D rewrite of the original D3 v3 visuals.
//
// D3 v3 is unmaintained and the APIs this project used (.attr({}) with an
// object, .each('end', fn)) were removed in v4, so a migration was a rewrite
// either way. Canvas also survives the event rates SVG chokes on: one node per
// circle plus a transition per circle is thousands of DOM mutations a minute.

export const DEFAULT_PALETTE = {
  background: '#1c2733',
  default: '#ffffff',
  user: '#ffffff',
  anon: '#2ecc71',
  bot: '#9b59b6',
  alert: '#e67e22',
  text: '#ffffff',
  banner: 'rgba(41, 128, 185, 0.85)',
  hud: 'rgba(41, 128, 185, 0.5)',
};

export class CanvasSink {
  constructor(canvas, opts = {}) {
    this.canvas = typeof canvas === 'string' ? document.querySelector(canvas) : canvas;
    if (!this.canvas) throw new Error('CanvasSink: canvas not found');
    this.ctx = this.canvas.getContext('2d');
    this.palette = { ...DEFAULT_PALETTE, ...(opts.palette || {}) };

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
  }

  _place(p) {
    const pad = p.r + this.margin;
    p.x = pad + p.u * Math.max(1, this.w - pad * 2);
    p.y = pad + p.v * Math.max(1, this.h - pad * 2);
  }

  colorFor(ev) {
    return this.palette[ev.category] || this.palette.default;
  }

  handle(ev) {
    if (!ev.map) return;
    const now = performance.now();
    this._recent.push(ev.ts);

    const r = Math.max(this.minRadius, Math.sqrt(ev.map.p) * this.maxRadius);
    const { u, v } = unitPosition(ev.id);
    const p = {
      u,
      v,
      r,
      x: 0,
      y: 0,
      born: now,
      life: this.life,
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

    if (ev.accent && !ev.dimmed) {
      this.banners.push({ born: now, text: ev.label || 'New event', url: ev.url || '' });
    }
  }

  _pointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  hitTest(x, y) {
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

    ctx.fillStyle = this.palette.background;
    ctx.fillRect(0, 0, this.w, this.h);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const age = now - p.born;
      if (age >= p.life) {
        this.particles.splice(i, 1);
        continue;
      }
      const fade = 1 - age / p.life;

      // Shockwave ring, as in the original.
      if (p.ring && age < this.ringLife) {
        const t = Math.sqrt(age / this.ringLife); // ease-out
        ctx.globalAlpha = (1 - t) * 0.35;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 20 + t * 20, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.globalAlpha = p.alpha0 * fade;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();

      const hovered = this._hover === p;
      if (p.label && (hovered || (this.showLabels && age < this.labelLife && p.ring))) {
        const a = hovered ? 1 : Math.min(1, 2 - (age / this.labelLife) * 2);
        if (a > 0) this._label(p.x, p.y - p.r - 6, p.label, a);
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
