// A style bible's component library (docs/CONTRACT.md phase 4b, R3): `components.mjs` exports functions
// `(bp, at, opts)` that place a small part with the bible's roles (bp.p, bp.p.roles). Every design in a group imports
// it (`import * as C from '../../bible/components.mjs'`) and uses it for those elements, so separately generated
// buildings share their windows, door surrounds, lantern posts, roof trim and chimneys.
//
// Rules for a components module:
//   - no imports (it is copied between scratch dirs, the bible folder and library entries); everything it needs comes
//     through `bp`: the Blueprint helpers (bp.set, bp.fill, bp.window, bp.stairs, bp.slab, bp.lantern, ...), the
//     palette `bp.p` with the roles `bp.p.roles`, and the direction helpers `bp.kit` ({ DIR, OPPOSITE, CW, CCW, cellsOf })
//   - the minimum set REQUIRED_COMPONENTS, plus any the bible adds
//   - optional `export const meta = { <name>: { slot, label? } }`: where the test frame places a component the frame does
//     not know (slot: wall | door | ground | roof | side; default ground)
//
// `at` (design coordinates), per component:
//   window         { x, y, z, facing, width, height }  the bottom-middle cell of the opening in the wall plane; facing = out
//   door_surround  { x, y, z, facing }                 the door's lower cell (the door is already there: keep it)
//   lantern_post   { x, y, z, facing }                 the feet cell on the ground where the post stands
//   roof_trim      { x, y, z, facing, length }         the first eave cell of a roof edge, running `length` cells to +x
//                                                       (or +z for an east/west edge); facing = out from the roof
//   chimney        { x, y, z, facing, top }            the column's foot cell (floor row) outside a wall, up to row `top`
//   (other)        by its slot: as window (wall), door_surround (door), lantern_post (ground), roof_trim (roof), chimney (side)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Blueprint } from './kit.mjs';
import { checkBlueprint } from './check.mjs';
import { buildScene, renderIso } from './render.mjs';
import { plain } from './nbt.mjs';
import { encodePng } from './png.mjs';

export const REQUIRED_COMPONENTS = ['window', 'door_surround', 'lantern_post', 'roof_trim', 'chimney'];
export const SLOTS = ['wall', 'door', 'ground', 'roof', 'side'];
const SLOT_OF = { window: 'wall', door_surround: 'door', lantern_post: 'ground', roof_trim: 'roof', chimney: 'side' };
const NAME = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Load a components module. Returns { components: Map(name -> fn), meta, errors } (errors: the module imports
 * something, does not load, lacks a required component, ...).
 */
export async function loadComponents(file) {
  const errors = [];
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { components: new Map(), meta: {}, errors: [`cannot read ${file}: ${e.message}`] };
  }
  // no imports: the module is copied between folders, so a relative import would break
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (/(^|[;\s])import\s*[\w{*'"]/m.test(stripped) || /\bimport\s*\(/.test(stripped) || /\brequire\s*\(/.test(stripped)) {
    errors.push('components.mjs must not import anything: use bp (its helpers), bp.p / bp.p.roles (materials) and bp.kit (DIR, OPPOSITE, CW, CCW, cellsOf)');
    return { components: new Map(), meta: {}, errors };
  }
  let mod;
  try {
    const st = fs.statSync(file);
    mod = await import(`${pathToFileURL(file).href}?v=${st.mtimeMs}-${st.size}`);
  } catch (e) {
    return { components: new Map(), meta: {}, errors: [`components.mjs does not load: ${e.message}`] };
  }
  const components = new Map();
  for (const [k, v] of Object.entries(mod)) {
    if (k === 'meta' || k === 'default') continue;
    if (typeof v !== 'function') continue;
    if (!NAME.test(k)) { errors.push(`component '${k}': names must match ${NAME}`); continue; }
    components.set(k, v);
  }
  const meta = mod.meta && typeof mod.meta === 'object' ? mod.meta : {};
  for (const [k, m] of Object.entries(meta)) {
    if (!components.has(k)) errors.push(`meta.${k}: no such component`);
    else if (m?.slot !== undefined && !SLOTS.includes(m.slot)) errors.push(`meta.${k}.slot must be one of ${SLOTS.join(', ')}`);
  }
  const missing = REQUIRED_COMPONENTS.filter((n) => !components.has(n));
  if (missing.length) errors.push(`components.mjs lacks ${missing.join(', ')} (every bible has ${REQUIRED_COMPONENTS.join(', ')})`);
  return { components, meta, errors };
}

/** Where a component goes in the test frame. */
export function slotOf(name, meta = {}) {
  return meta[name]?.slot ?? SLOT_OF[name] ?? 'ground';
}

// the frame (design coordinates): walls x 0..X, z 0..Z, rows 1..4 on a floor row 0, ceiling row 5, gable roof over
// -1..X+1 / -1..Z+1 with eaves on row 5 and the ridge on row RIDGE; the door in the middle of the south (front) wall
const X = 8;
const Z = 6;
const D = 4;
const RIDGE = 5 + Math.floor((Z + 2) / 2);
const MARGIN = 5;

/** The `at` the frame passes a component in a slot (see the header). */
export function frameAt(slot) {
  switch (slot) {
    case 'wall': return { x: 2, y: 2, z: Z, facing: 'south', width: 1, height: 2 };
    case 'door': return { x: D, y: 1, z: Z, facing: 'south' };
    case 'roof': return { x: -1, y: 5, z: Z + 1, facing: 'south', length: X + 3 };
    case 'side': return { x: X + 1, y: 0, z: Math.floor(Z / 2), facing: 'east', top: RIDGE + 1 };
    case 'ground':
    default: return { x: 1, y: 1, z: Z + 3, facing: 'south' };
  }
}

/**
 * The test frame: a small closed house in the palette's roles (walls, a lit room, a door, a gable roof) with
 * `entrance` / `spawn` anchors, parts `walls` and `roof`, and optionally one component placed in its slot (as part
 * `<name>`). The template is cropped to the blocks' extent. Throws what the component throws.
 */
export function buildFrame(p, component) {
  const S = 2 * MARGIN;
  const bp = new Blueprint({
    id: component ? `frame_${component.name}` : 'frame', name: component ? `Component ${component.name}` : 'Test frame', type: 'custom', tags: ['component'],
    size: [X + 1 + S, RIDGE + 1 + MARGIN + 6, Z + 1 + S], origin: [MARGIN, 0, MARGIN], palette: p, interior: [1, 1, 1, X - 1, 4, Z - 1],
    approach: { length: 3, width: 3 },
  });
  bp.part('walls', () => {
    bp.room([0, 0, 0, X, 5, Z], { wall: p.wall, floor: p.floor, ceiling: p.floor, corners: p.frame });
    bp.door(D, 1, Z, 'south');
    bp.ceilingLights(1, 1, X - 1, Z - 1, 4);
  });
  bp.part('roof', () => bp.roofGable(-1, -1, X + 1, Z + 1, 5, { ridge: 'x', pitch: 1, gable: p.wall, gableInset: 1, gableFrom: 6 }));
  if (component) {
    const at = frameAt(component.slot);
    bp.part(component.name, () => component.fn(bp, { ...at }, {}));
  }
  bp.spot('entrance', D, Z + 1, 180);
  bp.spot('spawn', D, Z + 3, 180);
  return fitToExtent(bp);
}

/** Shrink a Blueprint's template to the extent of its written cells (moves the cells, anchors, interior and parts). */
export function fitToExtent(bp) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const k of bp.cells.keys()) {
    const v = k.split(',').map(Number);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], v[i]); max[i] = Math.max(max[i], v[i]); }
  }
  if (!bp.cells.size) return bp;
  const [dx, dy, dz] = min;
  const shift = (k) => { const [x, y, z] = k.split(',').map(Number); return `${x - dx},${y - dy},${z - dz}`; };
  bp.cells = new Map([...bp.cells].map(([k, c]) => [shift(k), c]));
  bp.cellPart = new Map([...bp.cellPart].map(([k, n]) => [shift(k), n]));
  for (const a of Object.values(bp.anchors)) { a.x -= dx; a.y -= dy; a.z -= dz; }
  if (bp.interiorBox) {
    const w = bp.interiorBox;
    bp.interiorBox = { minX: w.minX - dx, minY: w.minY - dy, minZ: w.minZ - dz, maxX: w.maxX - dx, maxY: w.maxY - dy, maxZ: w.maxZ - dz };
  }
  bp.ox -= dx; bp.oy -= dy; bp.oz -= dz;
  bp.groundY -= dy;
  bp.size = { x: max[0] - dx + 1, y: max[1] - dy + 1, z: max[2] - dz + 1 };
  return bp;
}

/** A swatch of the roles: a short wall sample (foundation plinth, wall with an alt panel, frame posts, trim band, glass,
 * a roof course, a lantern, the path in front). */
export function buildSwatch(p) {
  const bp = new Blueprint({ id: 'swatch', type: 'custom', size: [9, 8, 4], palette: p, approach: false });
  bp.fill([0, 0, 1, 8, 0, 2], p.foundation);
  bp.fill([0, 1, 2, 8, 4, 2], p.wall);
  bp.fill([3, 2, 2, 5, 3, 2], p.plaster);
  for (const x of [0, 8]) bp.fill([x, 1, 2, x, 4, 2], p.frame);
  bp.fill([0, 5, 2, 8, 5, 2], p.stoneTrim);
  bp.set(4, 2, 2, p.pane);
  for (let x = 0; x <= 8; x++) bp.set(x, 6, 2, p.roofStairs, { facing: 'north', half: 'bottom', shape: 'straight' });
  for (let x = 0; x <= 8; x++) bp.set(x, 6, 3, p.roofBlock);
  bp.fill([0, 0, 0, 8, 0, 0], p.path);
  bp.set(1, 1, 1, p.floor);
  bp.lantern(1, 2, 1, false);
  bp.set(7, 1, 1, p.accentPlanks);
  return fitToExtent(bp);
}

/**
 * Check every component of a module in its own test frame (the frame passes the checker on its own; a component's
 * frame must too: errors fail the component, warnings are reported). Returns { ok, errors, warnings, components:
 * [{ name, slot, ok, errors, warnings }], frames: [{ name, bp }] }.
 */
export async function checkComponents(file, p) {
  const loaded = await loadComponents(file);
  const out = { ok: false, errors: [...loaded.errors], warnings: [], components: [], frames: [] };
  const base = checkBlueprint(buildFrame(p));
  if (!base.ok) out.errors.push(`the test frame itself does not pass with this palette: ${base.errors.join('; ')}`);
  for (const [name, fn] of loaded.components) {
    const slot = slotOf(name, loaded.meta);
    const r = { name, slot, ok: false, errors: [], warnings: [] };
    let bp;
    try {
      bp = buildFrame(p, { name, slot, fn });
    } catch (e) {
      r.errors.push(`${name} threw: ${e.message}`);
    }
    if (bp) {
      const c = checkBlueprint(bp);
      r.errors.push(...c.errors);
      // only what the component adds (the bare frame has no warnings)
      r.warnings.push(...c.warnings.filter((w) => !base.warnings.includes(w)));
      out.frames.push({ name, bp });
    }
    r.ok = r.errors.length === 0;
    out.components.push(r);
  }
  for (const r of out.components) {
    for (const e of r.errors) out.errors.push(`${r.name}: ${e}`);
    for (const w of r.warnings) out.warnings.push(`${r.name}: ${w}`);
  }
  out.ok = out.errors.length === 0 && loaded.components.size > 0;
  return out;
}

const BG = [236, 232, 224];

/** Render the sample sheet: the swatch first, then each component's frame, in a grid; returns the PNG bytes. */
export function renderSheet(tiles, { columns = 3, tileWidth = 420 } = {}) {
  const imgs = tiles.map((bp) => {
    const scene = buildScene(plain(bp.toStructure()), { front: bp.front });
    return renderIso(scene, { width: tileWidth, bg: BG });
  });
  const tw = Math.max(...imgs.map((i) => i.width));
  const th = Math.max(...imgs.map((i) => i.height));
  const gap = 8;
  const cols = Math.min(columns, imgs.length);
  const rows = Math.ceil(imgs.length / cols);
  const W = cols * tw + (cols + 1) * gap;
  const H = rows * th + (rows + 1) * gap;
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { d[i * 4] = 205; d[i * 4 + 1] = 200; d[i * 4 + 2] = 190; d[i * 4 + 3] = 255; }
  imgs.forEach((img, i) => {
    const cx = gap + (i % cols) * (tw + gap) + Math.floor((tw - img.width) / 2);
    const cy = gap + Math.floor(i / cols) * (th + gap) + Math.floor((th - img.height) / 2);
    for (let y = 0; y < img.height; y++) {
      const src = y * img.width * 4;
      const dst = ((cy + y) * W + cx) * 4;
      d.set(img.data.subarray(src, src + img.width * 4), dst);
    }
  });
  return encodePng(W, H, d);
}
