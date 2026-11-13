// (7c US) Invert a built Blueprint upside down: y flips (row y goes to H - 1 - y), so a house built standing hangs by what was its
// floor. `bp.invert()` (kit.mjs) calls invertBlueprint. Every written cell, its block state (invertProps below), its part, the ports
// (up and down swap), the anchors and cameras (as points: y goes to H - y, the pitch negated) and the interior box are mapped; the
// floors then run from the ceiling down (the standing build's ground floor hangs first, under the ceiling).
//
// Vanilla has no vertical flip (BlockState.mirror and rotate are horizontal), so the state table is the kit's own: rules on property
// names and values, exact for every state that has a flipped twin; kit/test/us.test.mjs enumerates every state of every kit block.
//   half                 top <-> bottom (stairs, trapdoors); upper <-> lower (doors and two-high plants: the pair swaps with its cells,
//                        so the door stands the right way up again)
//   type                 top <-> bottom (slabs; double, a chest's single/left/right and a piston head's normal/sticky stay)
//   hanging              true <-> false (lanterns, the mangrove propagule)
//   face, attachment     floor <-> ceiling (buttons, levers, the grindstone; the bell)
//   facing               up <-> down (the six-way blocks: barrels, pistons, droppers, rods, amethyst, shulker boxes ...)
//   orientation          down_<dir> <-> up_<dir> (the crafter and the jigsaw facing up or down)
//   vertical_direction   up <-> down (pointed dripstone, sulfur spikes; the thickness stays: it is counted from the tip)
//   up, down             swapped on a block that has both (mushroom blocks, the chorus plant, glow lichen, resin clumps)
// A wall's `up` (its post) and the pane, fence and wall connections are recomputed by finalize(); every other property stays.
//
// No flipped twin (NO_FLIP, `flipOf(...).exact === false`): a state whose only vertical bearing stays the same way after the flip (a
// torch, carpet, rail, flower, sign, banner, candle, redstone wire or bed bears on the cell below and has no ceiling form; a hanging sign
// or pale hanging moss bears on the cell above and has no floor form), a hopper facing down (it never faces up), and a crafter or jigsaw
// whose front is horizontal with its top up (no `_down` twin). invertBlueprint refuses such a cell by default (the design adds it after
// the invert, on its new floor); `{ unflipped: 'keep' }` keeps them as they are.
import { BLOCKS, supportOf } from './blocks.mjs';

const UD = { up: 'down', down: 'up' };
const TB = { top: 'bottom', bottom: 'top', upper: 'lower', lower: 'upper' };
const FC = { floor: 'ceiling', ceiling: 'floor' };
const TF = { true: 'false', false: 'true' };

/** The property names invertProps may change. */
export const INVERT_KEYS = Object.freeze(['half', 'type', 'hanging', 'face', 'attachment', 'facing', 'orientation', 'vertical_direction', 'up', 'down']);

const base = (name) => String(name).replace(/^minecraft:/, '');
const domain = (name) => BLOCKS[name.includes(':') ? name : `minecraft:${name}`]?.props ?? null;
const inDomain = (dom, k, v) => !dom || !dom[k] || [...dom[k]].includes(v);

/**
 * A block state's properties flipped upside down (see the table above). `name` is the block id (minecraft:...), `props` its property
 * map (strings). Returns a new object; a value whose flip the block's domain lacks stays (flipOf says whether the result is exact).
 */
export function invertProps(name, props) {
  if (!props || !Object.keys(props).length) return { ...(props ?? {}) };
  const dom = domain(name);
  const out = { ...props };
  const put = (k, v) => { if (v !== undefined && inDomain(dom, k, v)) out[k] = v; };
  for (const [k, v] of Object.entries(props)) {
    if (k === 'half') put(k, TB[v]);
    else if (k === 'type' && (v === 'top' || v === 'bottom')) put(k, TB[v]);
    else if (k === 'hanging') put(k, TF[v]);
    else if (k === 'face' || k === 'attachment') put(k, FC[v]);
    else if (k === 'facing') put(k, UD[v]);
    else if (k === 'vertical_direction') put(k, UD[v]);
    else if (k === 'orientation') put(k, v.split('_').map((w, i) => (i === 0 ? UD[w] ?? w : w)).join('_'));
  }
  // the six-face booleans: swapped only on a block with both (a wall's lone `up` is its post, recomputed by finalize)
  if ('up' in props && 'down' in props) { out.up = props.down; out.down = props.up; }
  return out;
}

const vertical = (s) => (s ?? []).filter((v) => v[1] !== 0).map((v) => v[1]);

/**
 * `{props, exact}`: the flipped properties, and whether they are the state's exact upside-down twin (false: NO_FLIP above, the block
 * would bear the same way after the flip, or its flip is not in its domain).
 */
export function flipOf(name, props = {}) {
  const out = invertProps(name, props);
  const b = base(name);
  if (b === 'hopper' && props.facing === 'down') return { props: out, exact: false };
  if (typeof props.orientation === 'string' && props.orientation === out.orientation && /_(up|down)$/.test(props.orientation)) return { props: out, exact: false };
  // doors: the pair swaps halves with its cells, so each half bears as before (the lower on the floor); exact
  if (BLOCKS[name]?.family === 'door' || BLOCKS[`minecraft:${b}`]?.family === 'door') return { props: out, exact: true };
  const q = name.includes(':') ? name : `minecraft:${name}`;
  const before = vertical(supportOf({ name: q, props }));
  const after = vertical(supportOf({ name: q, props: out }));
  // a support on both sides (a growing plant, a speleothem) reads either way
  const oneWay = (v) => v.length > 0 && !(v.includes(1) && v.includes(-1));
  if (oneWay(before) && oneWay(after) && before.every((d) => after.includes(d))) return { props: out, exact: false };
  return { props: out, exact: true };
}

/**
 * Invert a Blueprint in place upside down (template coordinates; the origin stays). Call it after the design has written the part to
 * be flipped; write what must not flip (the site's attachments: ports, ladders, chains, spots, floor furniture) after it. A site-bound
 * design's keep cells are the site's and stay where they are (a flipped cell onto one throws); any other design's keep cells flip.
 * `unflipped`: 'refuse' (default: throws naming the cells with no flipped twin) or 'keep' (left as they are). Returns bp.
 */
export function invertBlueprint(bp, { unflipped = 'refuse' } = {}) {
  const H = bp.size.y;
  const flip = (k) => { const [x, y, z] = k.split(',').map(Number); return `${x},${H - 1 - y},${z}`; };
  const cells = new Map();
  const parts = new Map();
  const none = [];
  for (const [k, c] of bp.cells) {
    const f = flipOf(c.state.name, c.state.props);
    if (!f.exact) none.push(`${c.state.name} at ${k}`);
    const nk = flip(k);
    cells.set(nk, { ...c, state: { name: c.state.name, props: f.props } });
    const part = bp.cellPart.get(k);
    if (part) parts.set(nk, part);
  }
  if (none.length && unflipped !== 'keep') {
    throw new Error(`${bp.id}: invert: ${none.length} cell(s) have no upside-down state (${none.slice(0, 8).join('; ')}${none.length > 8 ? '; ...' : ''}): write them after bp.invert(), on the new floor`);
  }
  if (bp.site) {
    const hit = [...cells.keys()].filter((k) => bp.keepCells.has(k));
    if (hit.length) throw new Error(`${bp.id}: invert: ${hit.length} flipped cell(s) land on the site's keep cells (${hit.slice(0, 4).join('; ')})`);
  } else {
    bp.keepCells = new Set([...bp.keepCells].map(flip));
    bp.keepCritical = new Set([...bp.keepCritical].map(flip));
  }
  bp.cells = cells;
  bp.cellPart = parts;
  const r3 = (n) => { const v = Math.round(n * 1000) / 1000; return v === 0 ? 0 : v; };
  for (const a of Object.values(bp.anchors)) {
    a.y = r3(H - a.y);
    a.pitch = r3(-a.pitch);
  }
  bp.ports = bp.ports.map((p) => ({ ...p, y: H - 1 - p.y, facing: UD[p.facing] ?? p.facing }));
  if (bp.interiorBox) {
    const b = bp.interiorBox;
    bp.interiorBox = { ...b, minY: H - 1 - b.maxY, maxY: H - 1 - b.minY };
  }
  bp.inverted = !bp.inverted;
  return bp;
}
