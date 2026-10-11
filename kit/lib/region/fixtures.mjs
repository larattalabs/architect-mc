// Lamp fixtures (docs/CONTRACT.md "Phase 6c slice W", Coordinator addition (Noah, 2026-10-11): bible-styled lamps, part of
// 7a §8.3 pulled forward). The bible's `light` role picks the fixture for every lamp a village places: the apron and batter
// lamps (light.mjs lightCover), the street, lane and square lamps (props.mjs) and the 4e street lanterns (the IR road's `lamp`).
// Each fixture is a short deterministic block stack standing on one floor cell; the post is the bible's `rail` role (a fence in
// its wood, oak by default). The light level is the light block's own emission (blocks.mjs), never a second table.
//
//   lantern_post         a fence post with a lantern on it (the default; a bible with no `light` role keeps it)
//   soul_lantern_post    the same with a soul lantern (light 10)
//   torch_post           a fence post with a torch (or a soul torch) on it (14, soul 10)
//   end_rod              an end rod standing on the floor (14)
//   bollard              a full-block light on a fence post: sea lantern, glowstone, shroomlight, froglights (15)
//   hanging_lantern      a post-and-arm gibbet: 3 posts, an arm one cell out at the top, a hanging lantern under the arm (15)
import { emissionOf, familyOf, info, normalize, qualify } from '../blocks.mjs';

export const FIXTURES = ['lantern_post', 'soul_lantern_post', 'torch_post', 'end_rod', 'bollard', 'hanging_lantern'];
const DIRS = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east' };
/** A fence (or wall, pane) state with one more side connected, when the block has that property. */
const joined = (s, dir) => {
  const p = parse(s);
  if (!(dir in (info(p.name)?.props ?? {}))) return s;
  return state(p.name, { ...p.props, [dir]: info(p.name).props[dir].includes('true') ? 'true' : p.props[dir] });
};
export const ARM_DIRS = ['north', 'east', 'south', 'west'];

const parse = (s) => {
  const i = s.indexOf('[');
  if (i < 0) return { name: qualify(s), props: {} };
  const props = {};
  for (const kv of s.slice(i + 1, -1).split(',')) { const [k, v] = kv.split('='); props[k] = v; }
  return { name: qualify(s.slice(0, i)), props };
};
const state = (name, props = {}) => {
  const st = normalize(name, props);
  const keys = Object.keys(st.props ?? {}).sort();
  return keys.length ? `${st.name}[${keys.map((k) => `${k}=${st.props[k]}`).join(',')}]` : st.name;
};

/** The light level of a block state string (its own emission; 0 for a non-emitter). */
export function lightLevel(s) {
  const p = parse(s);
  return info(p.name) ? emissionOf(normalize(p.name, p.props)) : 0;
}

/**
 * The fixture for a bible's `light` role and `rail` role: `{kind, light: state, post: state, level, height}`. A lantern written
 * hanging (`[hanging=true]`) picks the gibbet; a torch or soul torch the torch post; an end rod the rod; a full-block emitter
 * the bollard; a soul lantern its post; anything else (or no light role) the lantern post.
 */
export function fixtureFor(lightRole, railRole = 'minecraft:oak_fence') {
  const lp = parse(lightRole || 'minecraft:lantern');
  const post = state(info(parse(railRole).name) ? parse(railRole).name : 'minecraft:oak_fence');
  const fam = info(lp.name) ? familyOf(lp.name) : null;
  const full = info(lp.name)?.collision === 'full';
  let kind, light;
  if ((fam === 'lantern') && lp.props.hanging === 'true') { kind = 'hanging_lantern'; light = state(lp.name, { hanging: 'true', waterlogged: 'false' }); }
  else if (fam === 'torch' || fam === 'wall_torch') { kind = 'torch_post'; light = state(lp.name.replace('_wall_torch', '_torch').replace('minecraft:wall_torch', 'minecraft:torch')); }
  else if (lp.name === 'minecraft:end_rod') { kind = 'end_rod'; light = state(lp.name, { facing: 'up' }); }
  else if (full && lightLevel(lp.name) > 0) { kind = 'bollard'; light = state(lp.name); } // (a redstone lamp needs power: the lantern post)
  else if (fam === 'lantern') { kind = lp.name === 'minecraft:soul_lantern' ? 'soul_lantern_post' : 'lantern_post'; light = state(lp.name, { hanging: 'false', waterlogged: 'false' }); }
  else { kind = 'lantern_post'; light = state('minecraft:lantern', { hanging: 'false', waterlogged: 'false' }); }
  const level = lightLevel(light);
  const height = kind === 'hanging_lantern' ? 3 : kind === 'end_rod' ? 1 : 2;
  return Object.freeze({ kind, light, post, level, height });
}

/** The default fixture (a lantern on an oak fence post): what 4e's road lanterns are without a `lamp` member. */
export const DEFAULT_FIXTURE = fixtureFor('minecraft:lantern', 'minecraft:oak_fence');

/**
 * A fixture's cells standing on the floor cell under (x, y, z) (y = the feet cell: the first cell above the floor), as
 * `[[x, y, z, state]...]`, the light cell `[x, y, z]`, and its footprint columns `[[x, z]...]` (the gibbet's arm column too).
 * `arm`: the gibbet's arm direction (north, east, south, west).
 */
export function fixtureCells(f, [x, y, z], { arm = 'north' } = {}) {
  const cells = [];
  let lightAt;
  if (f.kind === 'end_rod') {
    cells.push([x, y, z, f.light]);
    lightAt = [x, y, z];
  } else if (f.kind === 'hanging_lantern') {
    const [dx, dz] = DIRS[arm];
    cells.push([x, y, z, f.post], [x, y + 1, z, f.post], [x, y + 2, z, joined(f.post, arm)], [x + dx, y + 2, z + dz, joined(f.post, OPP[arm])], [x + dx, y + 1, z + dz, f.light]);
    lightAt = [x + dx, y + 1, z + dz];
  } else {
    cells.push([x, y, z, f.post], [x, y + 1, z, f.light]);
    lightAt = [x, y + 1, z];
  }
  const foot = [...new Set(cells.map((c) => `${c[0]},${c[2]}`))].map((k) => k.split(',').map(Number));
  return { cells, lightAt, foot };
}

/**
 * The 4e road's lamp (the IR road member `lamp`), when it differs from 4e's own fence-and-lantern: the stack as
 * `[[along, dy, state]...]` (along: cells along the road's travel; dy 0 = the post's foot cell, the feet row), written for a
 * road travelling east (the mod rotates the offsets and the states to the road's own travel), and the spacing
 * scaled to the fixture's light (`every` = 12 at light 15, floor(12 * level / 15) below; `first` = every / 2). Null for the
 * default fixture, so a road with the default lamp has the IR it had (no new member).
 */
export function roadLamp(f) {
  if (f.kind === DEFAULT_FIXTURE.kind && f.light === DEFAULT_FIXTURE.light && f.post === DEFAULT_FIXTURE.post) return null;
  const every = Math.max(4, Math.floor((12 * f.level) / 15));
  const cells = f.kind === 'end_rod' ? [[0, 0, f.light]]
    : f.kind === 'hanging_lantern' ? [[0, 0, f.post], [0, 1, f.post], [0, 2, joined(f.post, 'east')], [1, 2, joined(f.post, 'west')], [1, 1, f.light]]
      : [[0, 0, f.post], [0, 1, f.light]];
  return { cells, light: cells.findIndex((c) => c[2] === f.light), every, first: every / 2 };
}
