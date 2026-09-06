// Regenerate .github/social-preview.png from the engine itself.
//
//   node tools/make-social-preview.mjs
//
// The artwork band is a real CanvasSink, fed through the real Mapper, in a real
// browser. Nothing here draws a circle by hand. Two things follow from that:
// the picture cannot flatter the product, and it cannot go stale while the
// visuals change underneath it.
//
// The card also names no single data source. An earlier version ended on
// "Wikipedia edits", which was true of where the idea came from and wrong about
// what the engine does.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, launch } from './render.mjs';

const OUT = fileURLToPath(new URL('../.github/social-preview.png', import.meta.url));

const W = 1280;
const H = 640;
const BAND = 336; // where the artwork stops and the card begins
const BAR = 22; // the gold rule down the left edge

const COPY = {
  title: 'Tintinnabulum',
  tagline: 'Turn any stream of events into sound.',
  examples: 'Latencies, trades, commits, quakes, sensors — heard, not read.',
  url: 'github.com/Guillain-RDCDE/tintinnabulum',
};

const { srv, base } = await startServer(8892);
const browser = await launch();

try {
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.route('**/social-harness.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body:
        '<style>html,body{margin:0;background:#14100c}canvas{display:block}' +
        '#art{position:absolute;left:-4000px;top:0}</style>' +
        `<canvas id="art"></canvas><canvas id="out" width="${W}" height="${H}"></canvas>`,
    })
  );
  await page.goto(base + '/social-harness.html');

  await page.evaluate(async (o) => {
    const { CanvasSink } = await import('/src/visual/canvas-sink.js');
    const { Mapper } = await import('/src/core/mapper.js');
    const { normalize, rngFrom } = await import('/src/core/event.js');

    // 1. The artwork, drawn by the engine on its own canvas.
    const art = document.getElementById('art');
    art.style.width = o.artW + 'px';
    art.style.height = o.band + 'px';

    const sink = new CanvasSink(art, {
      palette: 'bronze',
      scene: 'bloom',
      shape: 'circle',
      richness: 0.5,
      depth: true,
      showLabels: false,
      showHud: false,
      life: 120000,
      maxRadius: 96,
      fillOpacity: 0.66,
    });
    sink.start();

    const mapper = new Mapper({ mode: 'adaptive' });
    const rnd = rngFrom(o.seed);
    const kinds = ['user', 'anon', 'bot', 'alert'];
    for (let i = 0; i < o.count; i++) {
      const magnitude = Math.round(Math.pow(rnd(), 2.6) * 9000) + 1;
      const ev = normalize({
        id: 'social-' + i,
        magnitude,
        category: kinds[Math.floor(rnd() * kinds.length)],
        ts: Date.now(),
      });
      ev.map = mapper.map(magnitude);
      sink.handle(ev);
    }
    await new Promise((r) => setTimeout(r, 700));
    sink.stop();

    // 2. The card, with the artwork composited into its band.
    const out = document.getElementById('out');
    const ctx = out.getContext('2d');
    ctx.fillStyle = o.ground;
    ctx.fillRect(0, 0, o.w, o.h);
    ctx.drawImage(art, o.bar, 0, o.artW, o.band);

    // The band ends on a fade rather than a cut, so the artwork sits on the
    // card instead of being pasted onto it.
    const fade = ctx.createLinearGradient(0, o.band - 90, 0, o.band);
    fade.addColorStop(0, 'rgba(20, 16, 12, 0)');
    fade.addColorStop(1, o.ground);
    ctx.fillStyle = fade;
    ctx.fillRect(o.bar, o.band - 90, o.w - o.bar, 90);

    ctx.fillStyle = o.gold;
    ctx.fillRect(0, 0, o.bar, o.h);

    const stack = '"Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = o.ink;
    ctx.font = '700 78px ' + stack;
    ctx.fillText(o.title, 70, 430);

    ctx.fillStyle = o.gold;
    ctx.font = '400 31px ' + stack;
    ctx.fillText(o.tagline, 72, 489);

    ctx.fillStyle = o.muted;
    ctx.font = '400 25px ' + stack;
    ctx.fillText(o.examples, 72, 537);
    ctx.fillText(o.url, 72, 601);
  }, {
    w: W,
    h: H,
    band: BAND,
    bar: BAR,
    artW: W - BAR,
    count: 120,
    seed: 'tintinnabulum-social-2',
    ground: '#14100c',
    gold: '#e8b44a',
    ink: '#fdf6e8',
    muted: '#9a9186',
    ...COPY,
  });

  if (errors.length) throw new Error('page errors: ' + errors.join(' | '));

  const png = await page.locator('#out').screenshot();
  fs.writeFileSync(OUT, png);
  console.log(`wrote ${OUT}  (${png.length} bytes)`);
} finally {
  await browser.close();
  srv.kill();
}
