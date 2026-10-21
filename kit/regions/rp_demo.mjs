// rp_demo: slice RP's fixture (docs/CONTRACT.md "RP as built"): one zone per realised-record code on a flat world, so a realise records
// each of them and the gate re-reads the world against the record. Not in the catalogue. On a claim of at least 120x48 with level
// ground at its centre; zones south-west of the centre (z from cz - 24), each 5x5 unless named:
//   noop    grass written over grass (IF_NATURAL): NOOP
//   cond    stone at the ground with IF_AIR_OR_FLUID (the grass is solid): COND
//   pad     an 11x11 stone-brick pad one over the ground, and polished andesite over its west 5 columns in the same part (the
//           andesite wins; the bricks are its losers in the writers)
//   held    stone one over the ground: the gate places a cell site there first (HELD)
//   build   stone at the ground and one over it: the gate places a player's cobblestone and torch first (BUILD, and the torch's
//           support BUILD_SUPPORT)
//   tree    air through the two cells over the ground around an oak the gate grows first (the trunk TREE, its leaves LEAF)
//   dep     coarse dirt at the ground under short grass the gate plants (DEPENDENT)
//   wet     air at the ground beside a water source the gate places (FLUID_EDGE)
//   top     (stage `top`) moss over the pad's north-west corner (a second writer of the pad's tile), and a dirt path lane (set path)
//   far     grass over grass in the next tile east (a tile with nothing to write: no entry)
// Deterministic: no randomness, ground read once at the centre.
import { region } from '../lib/region/program.mjs';

export const id = 'rp_demo';
export const catalogue = false;

const AUTO = -30000000;
export const params = {
  cx: { type: 'int', min: AUTO, max: 30000000, default: AUTO, label: 'Centre x' },
  cz: { type: 'int', min: AUTO, max: 30000000, default: AUTO, label: 'Centre z' },
};

/** Each zone's columns box [x0, z0, x1, z1] relative to the centre (the gate reads these). */
export const ZONES = Object.freeze({
  noop: [-24, -24, -20, -20],
  cond: [-18, -24, -14, -20],
  pad: [-24, -16, -14, -6],
  held: [-10, -24, -6, -20],
  build: [-4, -24, 0, -20],
  tree: [6, -22, 10, -18],
  dep: [14, -24, 18, -20],
  wet: [20, -24, 24, -20],
  top: [-24, -16, -19, -12],
  lane: [-24, -4, -14, -4],
});

/** The far zone's x: 4 into the next tile east of the zones' last column, or null when the claim ends first. */
export function farX(cx, claim) {
  const x = 64 * (Math.floor((cx + 30) / 64) + 1) + 4;
  return x + 4 <= claim.maxX ? x : null;
}

export default function rpDemo(ctx) {
  const { claim, survey, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 120 || D < 48) throw new Error(`rp_demo needs a claim of at least 120x48 (got ${W}x${D})`);
  const cx = P.cx === AUTO ? claim.minX + (W >> 1) : P.cx;
  const cz = P.cz === AUTO ? claim.minZ + (D >> 1) : P.cz;
  const r = region(ctx);
  r.stages(['ground', 'top']);
  const gy = survey.groundAt(cx, cz);
  const y0 = gy + 1;
  r.anchor('entrance', [cx, y0, cz]);
  r.anchor('spawn', [cx, y0, cz]);
  const box = (name, y0b, y1b, mat, out, mats) => {
    const [a, b, c, d] = ZONES[name];
    let i = mats.indexOf(mat);
    if (i < 0) { i = mats.length; mats.push(mat); }
    for (let x = cx + a; x <= cx + c; x++) for (let z = cz + b; z <= cz + d; z++) out.push(x, z, y0b, y1b, i);
  };
  const op = (part, name, y0b, y1b, mat, cond) => {
    const cols = [], mats = [];
    box(name, y0b, y1b, mat, cols, mats);
    part.columns({ abs: 0 }, { abs: 0 }, cols, mats, { cond });
  };
  const GRASS = 'minecraft:grass_block[snowy=false]';
  const base = r.part('rp_base', { stage: 'ground' });
  op(base, 'noop', gy, gy, GRASS, 0);
  op(base, 'cond', gy, gy, 'minecraft:stone', 2);
  op(base, 'pad', y0, y0, 'minecraft:stone_bricks', 0);
  {
    // the pad's west 5 columns again, later in the same part: andesite wins, the bricks are its losers
    const [a, b, , d] = ZONES.pad;
    const cols = [];
    for (let x = cx + a; x <= cx + a + 4; x++) for (let z = cz + b; z <= cz + d; z++) cols.push(x, z, y0, y0, 0);
    base.columns({ abs: 0 }, { abs: 0 }, cols, ['minecraft:polished_andesite'], { cond: 0 });
  }
  op(base, 'held', y0, y0, 'minecraft:stone', 0);
  op(base, 'build', gy, y0, 'minecraft:stone', 0);
  op(base, 'tree', y0, y0 + 1, 'minecraft:air', 0);
  op(base, 'dep', gy, gy, 'minecraft:coarse_dirt', 0);
  op(base, 'wet', gy, gy, 'minecraft:air', 0);
  const fx = farX(cx, claim);
  if (fx !== null) {
    const cols = [];
    for (let x = fx; x <= fx + 4; x++) for (let z = cz - 24; z <= cz - 20; z++) cols.push(x, z, gy, gy, 0);
    base.columns({ abs: 0 }, { abs: 0 }, cols, [GRASS], { cond: 0 });
  }
  op(r.part('rp_top', { stage: 'top' }), 'top', y0, y0, 'minecraft:moss_block', 3);
  {
    const cols = [];
    const [a, b, c] = ZONES.lane;
    for (let x = cx + a; x <= cx + c; x++) cols.push(x, cz + b, gy, gy, 0);
    r.part('rp_lane', { stage: 'top', set: 'path' }).columns({ abs: 0 }, { abs: 0 }, cols, ['minecraft:dirt_path'], { cond: 0, walk: true });
  }
  return r;
}
