// Render the real visualiser to a PNG, offline.
//
// This exists so that pictures of the project are made by the project. The
// previous social preview was drawn by hand, and it drifted: it looked better
// than the thing it advertised, and it named a single data source the engine
// long ago outgrew. An image generated from src/ cannot do either.
//
// It drives the actual CanvasSink through the actual Mapper, in a real browser.
// Nothing here reimplements the visuals; if the output looks wrong, the visuals
// are wrong.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const SERVER = fileURLToPath(new URL('../server/ingest.mjs', import.meta.url));

export async function startServer(port) {
  const srv = spawn(process.execPath, [SERVER, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/src/index.js');
      if (r.ok) return { srv, base };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  srv.kill();
  throw new Error('static server did not start');
}

export async function launch() {
  // Same fallback as the test suite: a system Chrome if Playwright has no
  // browser of its own downloaded.
  try {
    return await chromium.launch({ headless: true, channel: 'chrome' });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

/**
 * @param {object} o
 * @param {number} o.width        CSS pixels
 * @param {number} o.height
 * @param {number} [o.scale]      device pixel ratio for the output
 * @param {string} [o.scene]      scene name
 * @param {string} [o.palette]    palette name
 * @param {string} [o.shape]      mark shape, or 'mixed'
 * @param {number} [o.richness]   0..1 per-event colour spread
 * @param {boolean} [o.depth]     gradient fills and additive halos
 * @param {number} [o.count]      events to feed in
 * @param {number} [o.settle]     ms of animation before the shot
 * @param {string} [o.seed]
 * @returns {Promise<Buffer>} PNG
 */
export async function renderPng(o) {
  const port = o.port || 8891;
  const { srv, base } = await startServer(port);
  const browser = await launch();
  try {
    const page = await browser.newPage({
      viewport: { width: o.width, height: o.height },
      deviceScaleFactor: o.scale || 2,
    });

    // A blank page on the server's origin, so bare module paths resolve.
    await page.route('**/render-harness.html', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<style>html,body{margin:0}canvas{display:block}</style><canvas id="c"></canvas>',
      })
    );
    await page.goto(base + '/render-harness.html');

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.evaluate(async (opt) => {
      const { CanvasSink } = await import('/src/visual/canvas-sink.js');
      const { Mapper } = await import('/src/core/mapper.js');
      const { normalize, rngFrom } = await import('/src/core/event.js');

      const cv = document.getElementById('c');
      cv.style.width = opt.width + 'px';
      cv.style.height = opt.height + 'px';

      const sink = new CanvasSink(cv, {
        palette: opt.palette,
        scene: opt.scene,
        shape: opt.shape,
        richness: opt.richness,
        depth: opt.depth,
        showLabels: false,
        showHud: false,
        life: opt.life,
        maxRadius: opt.maxRadius,
        starfield: opt.starfield,
        fillOpacity: opt.fillOpacity,
      });
      sink.start();

      const mapper = new Mapper({ mode: 'adaptive' });
      const rnd = rngFrom(opt.seed || 'preview');

      // A plausible mixture rather than one source: the engine is not about any
      // single feed, and an image of it should not suggest otherwise.
      const kinds = [
        { category: 'user', label: 'commit' },
        { category: 'anon', label: 'trade' },
        { category: 'bot', label: 'sensor' },
        { category: 'alert', label: 'alert' },
      ];

      for (let i = 0; i < opt.count; i++) {
        const k = kinds[Math.floor(rnd() * kinds.length)];
        // Heavy tail: a few large events among many small ones is what gives
        // the field its range of sizes.
        const magnitude = Math.round(Math.pow(rnd(), 3) * 9000) + 1;
        const ev = normalize({
          id: 'e' + i,
          magnitude,
          category: k.category,
          label: k.label,
          ts: Date.now(),
        });
        ev.map = mapper.map(magnitude);
        sink.handle(ev);
      }

      // Let the animation advance so rings and fades are mid-flight rather
      // than all at age zero.
      await new Promise((r) => setTimeout(r, opt.settle));
    }, {
      width: o.width,
      height: o.height,
      palette: o.palette || 'marine',
      scene: o.scene || 'bloom',
      shape: o.shape || 'circle',
      richness: o.richness ?? 0.45,
      depth: o.depth !== false,
      count: o.count ?? 90,
      settle: o.settle ?? 900,
      seed: o.seed,
      life: o.life ?? 60000,
      maxRadius: o.maxRadius ?? 90,
      starfield: Boolean(o.starfield),
      fillOpacity: o.fillOpacity ?? 0.5,
    });

    if (errors.length) throw new Error('page errors: ' + errors.join(' | '));

    const shot = await page.locator('#c').screenshot();
    return shot;
  } finally {
    await browser.close();
    srv.kill();
  }
}
