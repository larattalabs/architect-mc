// Offline structure renderer: vanilla structure template (26.3: palette {id, properties}, blocks {pos, state, nbt?})
// -> RGBA pictures, no game needed. Three views, drawn from the generated texture colours (colors.mjs) and the
// block families (blocks.mjs):
//   iso     isometric voxel picture from the front-left (three face shades, painter's algorithm)
//   top     top-down, highest non-air block, light height shading
//   front   front elevation, nearest block along the depth axis
// Coordinates inside the renderer are "local": x east, y up, z south, rotated so the building's `front`
// (sidecar) faces south (+z). The iso camera sits south-west of the building, so the front face shows on the
// right and the west (left) side face on the left. Ported from AgentCraft (MIT, see LICENSE).
import { COLORS } from './colors.mjs';
import { BLOCKS, emissionOf } from './blocks.mjs';

const DIRS = ['north', 'east', 'south', 'west'];
const rotDir = (d, k) => (DIRS.includes(d) ? DIRS[(DIRS.indexOf(d) + k + 4) % 4] : d);

/** Quarter-turns (clockwise from above) that bring `front` to south. */
export function turnsForFront(front) {
  return { south: 0, east: 1, north: 2, west: 3 }[front] ?? 0;
}

const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const WARM = hexToRgb('#ffc766');

// keyword -> colour for blocks without a texture colour, first match wins
const KEYWORDS = [
  [/glass|ice/, '#a9d6ee', 0.38], [/leaves|moss|grass|azalea|fern|vine/, '#4f8a38'], [/brick/, '#965f4e'], [/terracotta|clay/, '#9a5b3f'],
  [/copper/, '#c06f50'], [/dark_oak|spruce/, '#4a331b'], [/birch|pale|oak|wood|plank|log/, '#a2824e'], [/sand/, '#dccf9b'],
  [/snow|quartz|white|calcite/, '#ece8e0'], [/deepslate|blackstone|obsidian|black/, '#2c2c32'], [/stone|andesite|diorite|granite|tuff|concrete|gray/, '#858582'],
  [/iron|metal|core/, '#c8c8c8'], [/gold/, '#f1c640'],
];

/**
 * Colour and alpha of a block: { color (side), top, alpha, emissive }. Unknown blocks (no texture colour) get a colour
 * from keywords in their name and are added to `unknown`.
 */
export function resolveMaterial(id, props = {}, unknown = null) {
  const name = id.replace(/^minecraft:/, '');
  const e = COLORS[name];
  const emissive = emissionOf({ name: id, props }) > 0;
  if (e) {
    const [t, s, a] = typeof e === 'string' ? [e, e, 1] : [e[0], e[1], e[2] ?? 1];
    return { color: hexToRgb(s), top: hexToRgb(t), alpha: a, emissive };
  }
  if (unknown) unknown.add(id);
  for (const [re, hex, a] of KEYWORDS) if (re.test(name)) return { color: hexToRgb(hex), top: hexToRgb(hex), alpha: a ?? 1, emissive };
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const c = [96 + (h & 0x3f), 96 + ((h >> 6) & 0x3f), 96 + ((h >> 12) & 0x3f)];
  return { color: c, top: c, alpha: 1, emissive };
}

// ---------------------------------------------------------------- scene

/**
 * @param {object} structure plain parsed NBT root ({size, palette, blocks})
 * @param {{front?:string, unknown?:Set<string>}} [opts]
 */
export function buildScene(structure, opts = {}) {
  const k = turnsForFront(opts.front ?? 'south');
  const [sx, sy, sz] = structure.size;
  const swap = k % 2 === 1;
  const W = swap ? sz : sx, D = swap ? sx : sz, H = sy;
  const specs = structure.palette.map((p) => {
    const props = { ...(p.properties ?? p.Properties ?? {}) };
    if (k) { // rotate every direction-valued property
      if (props.facing) props.facing = rotDir(props.facing, k);
      const conn = DIRS.map((d) => props[d]);
      if (DIRS.every((d) => d in props)) DIRS.forEach((d, i) => { props[rotDir(d, k)] = conn[i]; });
      if (swap && (props.axis === 'x' || props.axis === 'z')) props.axis = props.axis === 'x' ? 'z' : 'x';
    }
    return makeSpec(p.id ?? p.Name, props, opts.unknown);
  });
  const grid = new Int16Array(W * H * D).fill(-1);
  const at = (x, y, z) => (y * D + z) * W + x;
  /** structure-space (x,z) -> local (x,z) after the front-to-south turn */
  const rot = (px, pz) => {
    let x = px, z = pz, cd = sz;
    for (let i = 0, cw = sx; i < k; i++) { [x, z] = [cd - 1 - z, x]; [cw, cd] = [cd, cw]; }
    return [x, z];
  };
  for (const b of structure.blocks) {
    const [px, y, pz] = b.pos;
    const [x, z] = rot(px, pz);
    if (specs[b.state].invisible) continue;
    grid[at(x, y, z)] = b.state;
  }
  return { W, H, D, grid, specs, at, rot, front: opts.front ?? 'south' };
}
// ---------------------------------------------------------------- block shapes

const U = [0, 0, 0, 1, 1, 1];
/** A plate against the side of the cell opposite `facing` (doors, ladders, wall signs; thickness t). */
function plate(facing, t) {
  return facing === 'south' ? [0, 0, 0, 1, 1, t] : facing === 'north' ? [0, 0, 1 - t, 1, 1, 1] : facing === 'east' ? [0, 0, 0, t, 1, 1] : [1 - t, 0, 0, 1, 1, 1];
}
/** A small box against the wall behind `facing` (wall torches, buttons), vertical range y0..y1, depth t. */
function onWall(facing, w0, w1, y0, y1, t) {
  return facing === 'north' ? [w0, y0, 1 - t, w1, y1, 1] : facing === 'south' ? [w0, y0, 0, w1, y1, t] : facing === 'west' ? [1 - t, y0, w0, 1, y1, w1] : [0, y0, w0, t, y1, w1];
}

/** Spec: { boxes: [{b:[x0,y0,z0,x1,y1,z1], mat?}], mat, opaque, invisible } */
function makeSpec(id, props, unknown) {
  const info = BLOCKS[id];
  const fam = info?.family ?? 'block';
  if (fam === 'air') return { mat: { color: [0, 0, 0], top: [0, 0, 0], alpha: 0 }, opaque: false, invisible: true, boxes: [], name: id };
  const mat = resolveMaterial(id, props, unknown);
  const warm = { ...mat, color: WARM, top: WARM, alpha: 1, emissive: true };
  const spec = { mat, opaque: false, invisible: false, boxes: [{ b: U }], name: id };
  const box = (b, m) => ({ b, mat: m });
  const f = props.facing ?? 'north';
  switch (fam) {
    case 'air': spec.invisible = true; break;
    case 'liquid': spec.boxes = [box([0, 0, 0, 1, 0.875, 1])]; break;
    case 'slab': {
      const t = props.type ?? 'bottom';
      spec.boxes = [box(t === 'double' ? U : t === 'top' ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1])];
      spec.opaque = t === 'double' && mat.alpha >= 1;
      break;
    }
    case 'stairs': {
      const top = props.half === 'top';
      const base = top ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1];
      const y0 = top ? 0 : 0.5, y1 = top ? 0.5 : 1;
      const back = f === 'east' ? [0.5, y0, 0, 1, y1, 1] : f === 'west' ? [0, y0, 0, 0.5, y1, 1] : f === 'south' ? [0, y0, 0.5, 1, y1, 1] : [0, y0, 0, 1, y1, 0.5];
      spec.boxes = [box(base), box(back)];
      break;
    }
    case 'carpet': case 'pressure_plate': case 'rail': case 'redstone_wire': spec.boxes = [box([0.02, 0, 0.02, 0.98, 1 / 16, 0.98])]; break;
    case 'pane': case 'fence': case 'wall': {
      const thick = fam === 'pane' ? [0.4375, 0.5625] : fam === 'fence' ? [0.375, 0.625] : [0.25, 0.75];
      const [a, c] = thick;
      const arm = fam === 'pane' ? [a, c] : [0.4375, 0.5625];
      const h = fam === 'fence' ? 1 : fam === 'wall' ? 0.875 : 1;
      spec.boxes = [box([a, 0, a, c, 1, c])];
      const on = (d) => props[d] === 'true' || props[d] === 'low' || props[d] === 'tall';
      if (on('north')) spec.boxes.push(box([arm[0], 0.1, 0, arm[1], h, a]));
      if (on('south')) spec.boxes.push(box([arm[0], 0.1, c, arm[1], h, 1]));
      if (on('east')) spec.boxes.push(box([c, 0.1, arm[0], 1, h, arm[1]]));
      if (on('west')) spec.boxes.push(box([0, 0.1, arm[0], a, h, arm[1]]));
      break;
    }
    case 'door': {
      const open = props.open === 'true';
      const hingeRight = props.hinge === 'right';
      const d = open ? (hingeRight ? rotDir(f, -1) : rotDir(f, 1)) : f;
      spec.boxes = [box(plate(d, 0.1875))];
      break;
    }
    case 'trapdoor': {
      if (props.open === 'true') spec.boxes = [box(plate(f, 0.1875))];
      else spec.boxes = [box(props.half === 'top' ? [0, 0.8125, 0, 1, 1, 1] : [0, 0, 0, 1, 0.1875, 1])];
      break;
    }
    case 'fence_gate': {
      const alongX = f === 'north' || f === 'south';
      spec.boxes = props.open === 'true' ? [box(alongX ? [0, 0.3, 0.4375, 0.125, 1, 0.5625] : [0.4375, 0.3, 0, 0.5625, 1, 0.125])]
        : [box(alongX ? [0, 0.3, 0.4375, 1, 1, 0.5625] : [0.4375, 0.3, 0, 0.5625, 1, 1])];
      break;
    }
    case 'ladder': case 'wall_sign': case 'wall_banner': spec.boxes = [box(plate(f, 0.0625))]; break;
    case 'button': case 'lever': {
      const face = props.face ?? 'wall';
      const n = f === 'north' || f === 'south';
      const [u0, u1] = [0.3125, 0.6875];
      spec.boxes = [box(face === 'floor' ? (n ? [u0, 0, 0.375, u1, 0.125, 0.625] : [0.375, 0, u0, 0.625, 0.125, u1])
        : face === 'ceiling' ? (n ? [u0, 0.875, 0.375, u1, 1, 0.625] : [0.375, 0.875, u0, 0.625, 1, u1])
        : onWall(f, u0, u1, 0.375, 0.625, 0.125))];
      break;
    }
    case 'torch': spec.boxes = [box([0.4375, 0, 0.4375, 0.5625, 0.6, 0.5625]), box([0.42, 0.6, 0.42, 0.58, 0.72, 0.58], warm)]; break;
    case 'wall_torch': spec.boxes = [box(onWall(f, 0.4375, 0.5625, 0.2, 0.75, 0.3)), box(onWall(f, 0.42, 0.58, 0.75, 0.88, 0.32), warm)]; break;
    case 'lantern': spec.boxes = [box(props.hanging === 'true' ? [0.3125, 0.0625, 0.3125, 0.6875, 0.5, 0.6875] : [0.3125, 0, 0.3125, 0.6875, 0.4375, 0.6875], mat.emissive ? warm : mat)]; break;
    case 'candle': spec.boxes = [box([0.4, 0, 0.4, 0.6, 0.4, 0.6], props.lit === 'true' ? warm : mat)]; break;
    case 'flower_pot': spec.boxes = [box([0.31, 0, 0.31, 0.69, 0.375, 0.69], { color: hexToRgb('#a85a3c'), top: hexToRgb('#6b3a24'), alpha: 1 }), box([0.25, 0.375, 0.25, 0.75, 0.8, 0.75], { color: hexToRgb('#3f8f3a'), top: hexToRgb('#3f8f3a'), alpha: 1 })]; break;
    case 'bed': {
      const top = 0.5625;
      spec.boxes = [box([0, 0, 0, 1, top, 1])];
      if (props.part === 'head') {
        const [p0, p1] = [0.08, 0.5];
        const b = f === 'south' ? [0.1, top, 1 - p1, 0.9, top + 0.12, 1 - p0] : f === 'north' ? [0.1, top, p0, 0.9, top + 0.12, p1]
          : f === 'east' ? [1 - p1, top, 0.1, 1 - p0, top + 0.12, 0.9] : [p0, top, 0.1, p1, top + 0.12, 0.9];
        spec.boxes.push(box(b, { color: hexToRgb('#f2f0ea'), top: hexToRgb('#f2f0ea'), alpha: 1 }));
      }
      break;
    }
    case 'rod': case 'chain': {
      const ax = props.axis ?? (f === 'up' || f === 'down' ? 'y' : f === 'east' || f === 'west' ? 'x' : f === 'north' || f === 'south' ? 'z' : 'y');
      const [a, c] = [0.4375, 0.5625];
      spec.boxes = [box(ax === 'y' ? [a, 0, a, c, 1, c] : ax === 'x' ? [0, a, a, 1, c, c] : [a, a, 0, c, c, 1])];
      break;
    }
    case 'sign': case 'banner': case 'skull': spec.boxes = [box([0.3, 0, 0.3, 0.7, 0.8, 0.7])]; break;
    case 'plant': case 'double_plant': case 'growing_plant': case 'ceiling_plant': case 'multiface': case 'wall_fan': case 'cocoa': case 'wall_hook':
      spec.boxes = [box([0.2, 0, 0.2, 0.8, 0.8, 0.8], { ...mat, alpha: Math.min(mat.alpha, 0.9) })];
      break;
    case 'snow_layer': spec.boxes = [box([0, 0, 0, 1, 0.125 * Number(props.layers ?? 1), 1])]; break;
    case 'fire': spec.boxes = [box([0.1, 0, 0.1, 0.9, 0.8, 0.9], warm)]; break;
    default: {
      if (id === 'minecraft:campfire' || id === 'minecraft:soul_campfire') {
        spec.boxes = [box([0, 0, 0, 1, 0.4375, 1]), ...(props.lit === 'true' ? [box([0.25, 0.4375, 0.25, 0.75, 0.9, 0.75], warm)] : [])];
        break;
      }
      const c = info?.collision ?? 'full';
      if (c === 'full') { spec.opaque = mat.alpha >= 1; break; }
      if (c === 'none' || c === 'low') { spec.boxes = [box([0.3, 0, 0.3, 0.7, c === 'low' ? 0.1 : 0.5, 0.7])]; break; }
      const h = info?.h ?? 1;
      spec.boxes = [box(h >= 0.9 ? [0, 0, 0, 1, h, 1] : [0.0625, 0, 0.0625, 0.9375, Math.max(0.2, Math.min(1, h)), 0.9375])];
    }
  }
  return spec;
}

// ---------------------------------------------------------------- raster

class Canvas {
  constructor(w, h, bg) {
    this.w = w; this.h = h;
    this.d = new Uint8ClampedArray(w * h * 4);
    if (bg === 'transparent') return;
    for (let y = 0; y < h; y++) {
      const t = y / Math.max(1, h - 1);
      const c = bg ?? [lerp(226, 192, t), lerp(231, 201, t), lerp(238, 214, t)];
      for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; this.d[o] = c[0]; this.d[o + 1] = c[1]; this.d[o + 2] = c[2]; this.d[o + 3] = 255; }
    }
  }
  blend(o, r, g, b, a) {
    const d = this.d;
    if (a >= 1) { d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255; return; }
    const da = d[o + 3] / 255, oa = a + da * (1 - a);
    if (oa <= 0) return;
    d[o] = (r * a + d[o] * da * (1 - a)) / oa; d[o + 1] = (g * a + d[o + 1] * da * (1 - a)) / oa; d[o + 2] = (b * a + d[o + 2] * da * (1 - a)) / oa; d[o + 3] = oa * 255;
  }
  rect(x0, y0, x1, y1, r, g, b, a = 1) {
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0)); x1 = Math.min(this.w, Math.round(x1)); y1 = Math.min(this.h, Math.round(y1));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.blend((y * this.w + x) * 4, r, g, b, a);
  }
  /** Fill the parallelogram P + u*A + v*B, u,v in [0,1). `fx(u,v)` may return a colour multiplier / override. */
  quad(px, py, ax, ay, bx, by, col, alpha, edge) {
    const det = ax * by - ay * bx;
    if (Math.abs(det) < 1e-9) return;
    const xs = [px, px + ax, px + bx, px + ax + bx], ys = [py, py + ay, py + by, py + ay + by];
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(this.w - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(this.h - 1, Math.ceil(Math.max(...ys)));
    const eps = alpha >= 1 ? 0.004 : 0;
    const inv = 1 / det;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - py;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - px;
        const u = (dx * by - dy * bx) * inv, v = (ax * dy - ay * dx) * inv;
        if (u < -eps || u >= 1 + eps || v < -eps || v >= 1 + eps) continue;
        let r = col[0], g = col[1], b = col[2];
        if (edge) {
          const m = edge(u, v);
          if (m) { if (m.c) { r = m.c[0]; g = m.c[1]; b = m.c[2]; } else { r *= m; g *= m; b *= m; } }
        }
        this.blend((y * this.w + x) * 4, r, g, b, alpha);
      }
    }
  }
}
const lerp = (a, b, t) => a + (b - a) * t;
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function hash3(x, y, z, f) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + f * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const SHADE = { top: 1.0, south: 0.84, west: 0.64 };

// ---------------------------------------------------------------- iso

/**
 * @param {ReturnType<typeof buildScene>} scene
 * @param {{width?:number, maxY?:number, cut?:Function, bg?:any}} [opts]
 *   maxY: rows with y > maxY are not drawn (cutaway). hide(x,y,z): true to skip a cell.
 */
export function renderIso(scene, opts = {}) {
  const { W, H, D, grid, specs, at } = scene;
  const maxY = Math.min(H - 1, opts.maxY ?? H - 1);
  const Hv = maxY + 1;
  const pad = 14;
  const target = opts.width ?? 1200;
  const tw = Math.min(26, (target - 2 * pad) / (W + D));
  const th = tw * 1.1;
  const width = Math.ceil((W + D) * tw + 2 * pad);
  const height = Math.ceil((W + D) * tw / 2 + Hv * th + 2 * pad);
  const cv = new Canvas(width, height, opts.bg);
  const ox = pad, oy = pad + W * tw / 2 + Hv * th;
  const P = (x, y, z) => [ox + (x + z) * tw, oy + (z - x) * tw / 2 - y * th];
  const fine = tw >= 12;
  const hide = opts.hide;

  const opaqueAt = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= W || z >= D) return false;
    if (y > maxY) return false;
    const s = grid[at(x, y, z)];
    return s >= 0 && specs[s].opaque && !(hide && hide(x, y, z));
  };

  for (let x = W - 1; x >= 0; x--) {
    for (let z = 0; z < D; z++) {
      for (let y = 0; y <= maxY; y++) {
        const si = grid[at(x, y, z)];
        if (si < 0) continue;
        if (hide && hide(x, y, z)) continue;
        const spec = specs[si];
        const full = spec.opaque;
        const cullTop = full && opaqueAt(x, y + 1, z), cullS = full && opaqueAt(x, y, z + 1), cullW = full && opaqueAt(x - 1, y, z);
        if (cullTop && cullS && cullW) continue;
        const sameGlass = spec.mat.shape === 'cube' && spec.mat.alpha < 1;
        for (const bx of spec.boxes) {
          const m = bx.mat ?? spec.mat;
          const [a0, b0, c0, a1, b1, c1] = bx.b;
          const X0 = x + a0, X1 = x + a1, Y0 = y + b0, Y1 = y + b1, Z0 = z + c0, Z1 = z + c1;
          const tint = 0.95 + 0.1 * hash3(x, y, z, 1);
          const emissive = m.emissive;
          const paint = (face, col) => {
            const s = emissive ? 1 : SHADE[face];
            const k = emissive ? 1 : tint;
            return [clamp255(col[0] * s * k), clamp255(col[1] * s * k), clamp255(col[2] * s * k)];
          };
          const edgeFn = (face, fr) => {
            const bc = m.border;
            const e = fine ? 0.07 : 0;
            if (!bc && !e) return null;
            return (u, v) => {
              if (bc) {
                const w = 0.16;
                const f = fr ?? { u0: true, u1: true, v0: true, v1: true };
                if ((f.u0 && u < w) || (f.u1 && u > 1 - w) || (f.v0 && v < w) || (f.v1 && v > 1 - w)) { const s = emissive ? 1 : SHADE[face]; return { c: [bc[0] * s, bc[1] * s, bc[2] * s] }; }
              }
              return e && (u < e || v < e || u > 1 - e || v > 1 - e) ? 0.86 : 0;
            };
          };
          const unitCube = bx.b === U;
          // top (+y)
          if (!(unitCube && cullTop) && !(sameGlass && unitCube && sameGlassAt(grid, at, W, D, x, y + 1, z, si))) {
            const [p0x, p0y] = P(X0, Y1, Z0), [p1x, p1y] = P(X1, Y1, Z0), [p2x, p2y] = P(X0, Y1, Z1);
            cv.quad(p0x, p0y, p1x - p0x, p1y - p0y, p2x - p0x, p2y - p0y, paint('top', m.top ?? m.color), m.alpha, edgeFn('top', null));
          }
          // south (+z), drawn to the right
          if (!(unitCube && cullS) && !(sameGlass && unitCube && sameGlassAt(grid, at, W, D, x, y, z + 1, si))) {
            const [p0x, p0y] = P(X0, Y1, Z1), [p1x, p1y] = P(X1, Y1, Z1), [p2x, p2y] = P(X0, Y0, Z1);
            const fr = bx.panelFacing === 'south' ? bx.frame : bx.panelFacing ? { u0: false, u1: false, v0: false, v1: false } : null;
            cv.quad(p0x, p0y, p1x - p0x, p1y - p0y, p2x - p0x, p2y - p0y, paint('south', m.color), m.alpha, edgeFn('south', fr));
          }
          // west (-x), drawn to the left
          if (!(unitCube && cullW) && !(sameGlass && unitCube && sameGlassAt(grid, at, W, D, x - 1, y, z, si))) {
            const [p0x, p0y] = P(X0, Y1, Z0), [p1x, p1y] = P(X0, Y1, Z1), [p2x, p2y] = P(X0, Y0, Z0);
            const fr = bx.panelFacing === 'west' ? bx.frame : bx.panelFacing ? { u0: false, u1: false, v0: false, v1: false } : null;
            cv.quad(p0x, p0y, p1x - p0x, p1y - p0y, p2x - p0x, p2y - p0y, paint('west', m.color), m.alpha, edgeFn('west', fr));
          }
        }
      }
    }
  }
  return { width, height, data: cv.d, tw };
}
function sameGlassAt(grid, at, W, D, x, y, z, si) {
  if (x < 0 || y < 0 || z < 0 || x >= W || z >= D || y >= grid.length / (W * D)) return false;
  return grid[at(x, y, z)] === si;
}

// ---------------------------------------------------------------- top

export function renderTop(scene, opts = {}) {
  const { W, H, D, grid, specs, at } = scene;
  const target = opts.width ?? 1000;
  const s = Math.max(4, Math.min(28, Math.floor(target / Math.max(W, D))));
  const pad = 10;
  const cv = new Canvas(W * s + 2 * pad, D * s + 2 * pad, opts.bg);
  const topY = new Int16Array(W * D).fill(-1);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    for (let y = H - 1; y >= 0; y--) {
      const si = grid[at(x, y, z)];
      if (si >= 0 && !specs[si].invisible) { topY[z * W + x] = y; break; }
    }
  }
  const heightOf = (x, z) => (x < 0 || z < 0 || x >= W || z >= D ? -1 : topY[z * W + x]);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    let y = topY[z * W + x];
    if (y < 0) continue;
    // see through glass to what is below
    const layers = [];
    let yy = y;
    for (; yy >= 0; yy--) {
      const si = grid[at(x, yy, z)];
      if (si < 0 || specs[si].invisible) continue;
      layers.push(si);
      if (specs[si].mat.alpha >= 1) break;
    }
    const nw = (heightOf(x - 1, z) + heightOf(x, z - 1)) / 2;
    const rel = Math.max(-3, Math.min(3, y - (nw < 0 ? y : nw)));
    const shade = (0.6 + 0.42 * (y / Math.max(1, H - 1))) + 0.05 * rel;
    for (let i = layers.length - 1; i >= 0; i--) {
      const m = specs[layers[i]].mat;
      const k = m.emissive ? 1 : shade;
      const tc = m.top ?? m.color;
      const c = [clamp255(tc[0] * k), clamp255(tc[1] * k), clamp255(tc[2] * k)];
      const x0 = pad + x * s, y0 = pad + z * s;
      cv.rect(x0, y0, x0 + s, y0 + s, c[0], c[1], c[2], m.alpha);
      if (i === 0 && s >= 8) { cv.rect(x0, y0, x0 + s, y0 + 1, 0, 0, 0, 0.1); cv.rect(x0, y0, x0 + 1, y0 + s, 0, 0, 0, 0.1); }
    }
  }
  return { width: cv.w, height: cv.h, data: cv.d, scale: s };
}

// ---------------------------------------------------------------- front

export function renderFront(scene, opts = {}) {
  const { W, H, D, grid, specs, at } = scene;
  const target = opts.width ?? 1000;
  const s = Math.max(4, Math.min(28, Math.floor(target / Math.max(W, 1))));
  const pad = 10;
  const cv = new Canvas(W * s + 2 * pad, H * s + 2 * pad, opts.bg);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const layers = [];
    for (let z = D - 1; z >= 0; z--) {
      const si = grid[at(x, y, z)];
      if (si < 0 || specs[si].invisible) continue;
      layers.push([si, z]);
      if (specs[si].mat.alpha >= 1) break;
    }
    for (let i = layers.length - 1; i >= 0; i--) {
      const [si, z] = layers[i];
      const m = specs[si].mat;
      const depth = (D - 1 - z) / Math.max(1, D - 1);
      const k = m.emissive ? 1 : 0.95 - 0.28 * depth;
      const x0 = pad + x * s, y0 = pad + (H - 1 - y) * s;
      cv.rect(x0, y0, x0 + s, y0 + s, clamp255(m.color[0] * k), clamp255(m.color[1] * k), clamp255(m.color[2] * k), m.alpha);
      if (i === 0 && s >= 8) { cv.rect(x0, y0, x0 + s, y0 + 1, 0, 0, 0, 0.1); cv.rect(x0, y0, x0 + 1, y0 + s, 0, 0, 0, 0.1); }
    }
  }
  return { width: cv.w, height: cv.h, data: cv.d, scale: s };
}

