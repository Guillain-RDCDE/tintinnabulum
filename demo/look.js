// Everything under "Look": scenes, palettes, shapes, colour variety, the
// ceiling on what stays on screen.
//
// Split out of demo.js, which had grown to six hundred lines. The sections
// there share mutable state, so this is not a line-slice: the four things this
// needs from the page -- the renderer, the two repaint callbacks it cannot
// own, and a way to refresh the panel headers -- arrive as arguments. That is
// the whole coupling, and it is now visible in one signature instead of spread
// through a file.

import {
  PALETTES,
  swatchOf,
  SHAPES,
  drawShape,
  SCENES,
  previewScene,
} from '../src/index.js';
import { $, createPicker, fitCanvas, caption } from './dom.js';
import { store } from './store.js';

// How far each event's colour may stray from its category's. The wording says
// what the setting costs, not just what it does: at zero a colour identifies a
// category, and past that it stops being able to.
const RICHNESS_STEPS = [
  [0.001, 'off', 'Every event of a category is the exact same colour, so a colour identifies a category.'],
  [0.25, 'subtle', 'A slight spread, enough to tell one mark from the next where they overlap.'],
  [0.6, 'balanced', 'Each category reads as a family of shades. The default, and the best-looking on a busy feed.'],
  [1.01, 'wide', 'Shades range far enough to drift in hue. Handsome on a dense stream, no longer a colour code.'],
];

const SHAPE_CHOICES = [...Object.keys(SHAPES), 'mixed'];
const SHAPE_LABELS = {
  ...SHAPES,
  mixed: { label: 'Mixed', note: 'A shape per event, fixed by its identity.' },
};

/**
 * @param {object} io
 * @param {object}   io.canvas          the CanvasSink being driven
 * @param {Function} io.updateSummaries refresh the folded panel headers
 * @param {Function} io.paintKitArts    the Sound panel's cards follow the palette
 */
export function setupLook({ canvas, updateSummaries, paintKitArts }) {
  let richnessWord = 'balanced';

  // --- scenes -------------------------------------------------------------
  // Scenes are whole ways of drawing the same events. Shapes only apply to the
  // ones that draw a mark per event, so the shape picker follows the choice.
  function selectScene(name, persist = true) {
    if (!SCENES[name]) return;
    canvas.setScene(name);
    $('#scene-note').textContent = SCENES[name].note;
    scenePicker.mark(name);
    const usesShapes = name === 'bloom';
    $('#shapes').style.opacity = usesShapes ? '1' : '.4';
    $('#shapes').style.pointerEvents = usesShapes ? '' : 'none';
    $('#shapes-label').textContent = usesShapes ? 'Shapes' : 'Shapes — used by Bloom only';
    if (persist) store.set('scene', name);
  }

  // Each card carries a still drawn by the scene itself, against synthetic
  // events. A stored image would go stale the moment a palette changed; this
  // cannot disagree with what you are about to launch.
  function paintScenePreview(cv, name) {
    const { ctx, w, h } = fitCanvas(cv, { height: 84 });
    previewScene(ctx, name, {
      w,
      h,
      palette: PALETTES[canvas.paletteName].colors,
      shape: canvas.shape,
      richness: canvas.richness,
      depth: canvas.depth,
    });
  }

  const scenePicker = createPicker($('#scenes'), Object.entries(SCENES), {
    key: 'scene',
    className: 'card',
    title: (def) => def.note,
    render: (btn, def) => {
      btn.append(
        document.createElement('canvas'),
        caption(def.label, def.positional === false ? 'Composed view' : 'One mark per event')
      );
    },
    onPick: (name) => selectScene(name),
  });
  const repaintScenePreviews = () => scenePicker.repaint(paintScenePreview);

  // --- palettes -----------------------------------------------------------
  function selectPalette(name, persist = true) {
    canvas.setPalette(name);
    canvas.canvas.style.background = PALETTES[name].colors.background;
    $('#palette-note').textContent = PALETTES[name].note;
    palettePicker.mark(name);
    if (persist) store.set('palette', name);
    // The swatches and the stills are drawn in the palette's own colours, so
    // they follow the choice rather than lying about it.
    repaintShapeSwatches();
    repaintScenePreviews();
    paintKitArts();
  }

  const palettePicker = createPicker($('#palettes'), Object.entries(PALETTES), {
    key: 'palette',
    className: 'sw',
    title: (def) => def.note,
    render: (btn, def, name) => {
      const { background, dots } = swatchOf(name);
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.background = background;
      for (const colour of dots) {
        const dot = document.createElement('i');
        dot.style.background = colour;
        chip.append(dot);
      }
      const label = document.createElement('small');
      label.textContent = def.label;
      btn.append(chip, label);
    },
    onPick: (name) => selectPalette(name),
  });

  // --- shapes -------------------------------------------------------------
  // Swatches are drawn with the same drawShape() the canvas uses, so a preview
  // can never drift from the result.
  function selectShape(name, persist = true) {
    canvas.setShape(name);
    $('#shape-note').textContent = SHAPE_LABELS[name].note;
    shapePicker.mark(name);
    if (persist) store.set('shape', name);
  }

  function paintSwatch(cv, name) {
    const { ctx, w, h } = fitCanvas(cv, { height: 42, fallbackWidth: 76 });
    const colors = PALETTES[canvas.paletteName].colors;
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = colors.anon;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    drawShape(ctx, name, w / 2, h / 2, 13, -0.25, 0.4);
    ctx.fill(name === 'ring' ? 'evenodd' : 'nonzero');
  }

  const shapePicker = createPicker(
    $('#shapes'),
    SHAPE_CHOICES.map((name) => [name, SHAPE_LABELS[name]]),
    {
      key: 'shape',
      className: 'sw',
      title: (def) => def.note,
      render: (btn, def) => {
        const label = document.createElement('small');
        label.textContent = def.label;
        btn.append(document.createElement('canvas'), label);
      },
      onPick: (name) => selectShape(name),
    }
  );
  const repaintShapeSwatches = () => shapePicker.repaint(paintSwatch);

  // --- colour variety and the ceiling ------------------------------------
  function selectRichness(value, persist = true) {
    const v = Math.max(0, Math.min(1, value));
    canvas.setRichness(v);
    const [, word, note] = RICHNESS_STEPS.find(([edge]) => v < edge) || RICHNESS_STEPS[3];
    richnessWord = word;
    $('#richness-val').textContent = word;
    $('#richness-note').textContent = note;
    $('#richness').value = String(Math.round(v * 100));
    if (persist) store.set('richness', String(Math.round(v * 100)));
    updateSummaries();
    // The palette swatches and stills are drawn through the same renderer, so
    // they have to be redrawn or they would advertise the wrong setting.
    repaintShapeSwatches();
    repaintScenePreviews();
  }

  function selectBudget(n, persist = true) {
    canvas.setMaxParticles(n);
    $('#budget').value = String(canvas.maxParticles);
    $('#budget-val').textContent = String(canvas.maxParticles);
    if (persist) store.set('budget', String(canvas.maxParticles));
  }

  $('#richness').addEventListener('input', (e) => selectRichness(Number(e.target.value) / 100));
  $('#depth').addEventListener('change', (e) => {
    canvas.setDepth(e.target.checked);
    store.setFlag('depth', e.target.checked);
  });
  // On `change`, not `input`: applying it restarts the active scene's own
  // state, and doing that on every pixel of a drag would wipe the picture
  // continuously while you were still deciding where to put the slider.
  $('#budget').addEventListener('input', (e) => ($('#budget-val').textContent = e.target.value));
  $('#budget').addEventListener('change', (e) => selectBudget(Number(e.target.value)));
  $('#starfield').addEventListener('change', (e) => {
    canvas.setStarfield(e.target.checked);
    store.setFlag('starfield', e.target.checked);
  });
  $('#labels').addEventListener('change', (e) => (canvas.showLabels = e.target.checked));
  $('#hud').addEventListener('change', (e) => (canvas.showHud = e.target.checked));

  requestAnimationFrame(repaintScenePreviews);
  requestAnimationFrame(repaintShapeSwatches);

  return {
    selectScene, selectPalette, selectShape, selectRichness, selectBudget,
    repaintScenePreviews, repaintShapeSwatches,
    SHAPE_LABELS,
    get richnessWord() {
      return richnessWord;
    },
  };
}
