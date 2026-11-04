// (7a GM-a) A gate mechanism in a K3 gatehouse lot (docs/CONTRACT.md "Slice GM" §4-§9 as amended by §12-§15): the materials from the
// plan's roles, the mechanism's cells in the gatehouse (gmCircuit's layouts, settled), the reserved envelope, the sensor's rungs, the
// write data the realise reads, the brief lines and the artifact record. Pure; the realise (Java, RegionsImpl.mechanismItem) picks the
// rung at bind from the bound design (§15 item 2) and writes the cells.
//
//   gmMatsOf(roles)                          the mechanism's blocks from the roles (§3): structure, leaf (slide), bar (portcullis),
//                                            button, plate; every one traced to a role, else the functional fallback (iron bars)
//   mechanismPlan(kind, {depth, mats})       the local cells: base (written in every case), rungs (one per roof row 10..depth+7: the
//                                            run up to the sensor and the structure block on the unused rungs below the roof), the
//                                            envelope (every cell any state or rung touches), the moved cells per state, the triggers
//   gmBrief(kind, depth)                     the gatehouse's brief lines (§4, §5, §15 items 1 and 6), word for word for Steward
//   gmRecord(kind, rest, {lot frame, world}) the onWall.passage.mechanism record (§5) and the IR's write data
//   GM_KINDS, gmKindOf(v)                    the kinds; the lenient reading of params.mechanism / params.gate_mech on a wall
import { gateLayout, settleLayout, swingCells, gmToWorld, gmBoxFits, GM_BOX_MIN } from './gmCircuit.mjs';
import { shapeOf } from './style.mjs';
import { bomOf } from './bom.mjs';

const W = 'minecraft:';
export const GM_KINDS = Object.freeze(['portcullis', 'slide', 'swing']);
/** The lowest roof row a day-driven gate senses from, and the highest for a box `depth` deep (§15 item 1: rungs for rows 10..depth+7). */
export const GM_ROOF_MIN = 10;
export const gmRoofMax = (depth) => depth + 7;

/**
 * The lenient reading (§5: `params.mechanism` and `params.gate_mech` on a wall, when `lots` is absent): a kind name, or `redstone`,
 * `piston` or `true` for the default portcullis; anything else is no mechanism.
 */
export function gmKindOf(v) {
  if (GM_KINDS.includes(v)) return v;
  if (v === true || v === 'redstone' || v === 'piston') return 'portcullis';
  return null;
}

const base = (s) => String(s ?? '').replace(/\[.*$/, '');
// (a block the circuit can stand on and carry power through: a full, opaque, solid, non-gravity block with no block entity; and one a
// piston can push for a slide leaf. Names, from the 26.3 tables' classes: glass, ice, leaves, light blocks and gravity blocks are out)
const NOT_FULL = /(glass|ice$|leaves|slab|stairs|_wall$|fence|pane|bars|door|trapdoor|button|plate|carpet|lantern|torch|lamp|glowstone|sea_lantern|shroomlight|froglight|redstone_block|observer|piston|tnt|slime|honey|soul_sand|soul_soil|mud$|farmland|dirt_path|snow|scaffolding|chain|ladder|vine|sign|banner|bed$|chest|barrel|furnace|smoker|hopper|dropper|dispenser|spawner|beehive|bee_nest|beacon|shulker|crafter|lectern|jukebox|note_block|anvil|cauldron|bell|campfire|grindstone|loom|cartography|fletching|smithing|stonecutter|enchanting|composter|brewing|cactus|chorus|bamboo$|sculk_sensor|sculk_catalyst|sculk_shrieker|leaves|moss_carpet|air$|water$|lava$)/;
const GRAVITY = /(^minecraft:(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$|concrete_powder)/;
const IMMOVABLE = /(obsidian|crying_obsidian|respawn_anchor|bedrock|reinforced_deepslate|end_portal_frame|ender_chest)/;
export const gmFullOk = (b) => !!b && !NOT_FULL.test(base(b)) && !GRAVITY.test(base(b));
export const gmMovable = (b) => gmFullOk(b) && !IMMOVABLE.test(base(b));

/**
 * §3: the mechanism's blocks from the plan's resolved roles. `structure` (the mullion, the lining, the logic block, the sleepers): the
 * structure role's full block, else trim, else foundation, else the first other role with one; `leaf` (a slide's leaves): the same chain's
 * first block a piston moves; `bar` (the portcullis leaves): the rail role's fence, else its wall block, else iron_bars (functional); the
 * button and plate: the first role with that shape (structure, trim, foundation, rail, floor), else stone's. Each pick traces to a role
 * (S-THEME); `stone_bricks` stands in only for a plan with no full-block role at all (the lint names it).
 */
export function gmMatsOf(roles = {}) {
  const chain = ['structure', 'trim', 'foundation', ...Object.keys(roles).filter((r) => !['structure', 'trim', 'foundation'].includes(r)).sort()];
  const blocks = chain.map((r) => base(roles[r])).filter(Boolean);
  const structure = blocks.find(gmFullOk) ?? `${W}stone_bricks`;
  const leaf = blocks.find(gmMovable) ?? structure;
  const rail = base(roles.rail);
  const bar = (rail && (/_fence$/.test(rail) ? rail : shapeOf(rail, 'fence'))) || (rail && (/_wall$/.test(rail) ? rail : shapeOf(rail, 'wall'))) || `${W}iron_bars`;
  const shaped = (sh, fb) => { for (const r of ['structure', 'trim', 'foundation', 'rail', 'floor', 'path']) { const v = roles[r] && shapeOf(base(roles[r]), sh); if (v) return v; } return fb; };
  return { structure, leaf, bar, button: shaped('button', `${W}stone_button`), plate: shaped('pressure_plate', `${W}stone_pressure_plate`) };
}

const k3 = (u, d, r) => `${u},${d},${r}`;
const CONNECTS = /(fence|_wall$|iron_bars|pane)$/;
/**
 * A bar, fence or wall leaf's connection properties as the 26.3 server settles them (the realise writes with no shape update): toward a
 * leaf of its kind or a full block (the layout's, or a design cell beside the layout, assumed solid: the lint's `outside: 'solid'`), not
 * toward air, a lever, dust or a trapdoor.
 */
function connected(state, at, u, d, r) {
  const name = base(state);
  if (!CONNECTS.test(name)) return state;
  const side = (du, dd) => {
    const n = at(u + du, d + dd, r);
    if (n === undefined) return true; // a design cell: the design's walls
    const nb = base(n);
    if (/air$|lever|redstone_wire|trapdoor|repeater|comparator|torch|daylight/.test(nb)) return false;
    return true;
  };
  const e = side(1, 0), w = side(-1, 0), s = side(0, 1), n = side(0, -1);
  if (/_wall$/.test(name)) { const v = (b) => (b ? 'low' : 'none'); return `${name}[east=${v(e)},north=${v(n)},south=${v(s)},up=true,waterlogged=false,west=${v(w)}]`; }
  return `${name}[east=${e},north=${n},south=${s},waterlogged=false,west=${w}]`;
}

/** §7 item 2's order: structure (with the observers: one is the S repeater's floor), pistons, leaves, wire and diodes, triggers last. */
export function gmRank(state) {
  if (/lever|daylight|button|pressure_plate/.test(state)) return 5;
  if (/wire|repeater|comparator|torch/.test(state)) return 3;
  if (/bars|fence|_wall\[|_wall$|iron_door/.test(state)) return 2;
  if (/piston/.test(state)) return 1;
  return 0;
}

/** A layout's settled states (settleLayout's redstone parts; the rest as gateLayout writes them, the leaves' connections settled). */
function settledMap(lay) {
  const s = settleLayout(lay);
  const m = new Map();
  for (const c of lay.cells.values()) m.set(k3(c.u, c.d, c.r), s.get(k3(c.u, c.d, c.r)) ?? c.state);
  const at = (u, d, r) => m.get(k3(u, d, r));
  for (const [key, st] of m) { const [u, d, r] = key.split(',').map(Number); m.set(key, connected(st, at, u, d, r)); }
  return m;
}

/**
 * The mechanism of a gatehouse box `depth` deep (§14 item 1's minimum is 7), in gmCircuit's local frame. For portcullis and slide:
 *   base   [[u, d, r, state]] in write order: every cell the gate writes whatever the roof (the leaves, feed, detectors, logic block)
 *   rungs  [{roof, sensor: [u, d, r], cells: [[u, d, r, state]]}] for roof rows 10..depth+7: the run up to that rung (its dust, blocks,
 *          cut cells and the inverted sensor) and the structure block on every unused rung cell below that roof (§15 item 2); the rung
 *          cells at or above the roof are not written (the design's)
 *   levers the levers-only fallback (§15 item 3): no sensor block, no run; the S input unpowered
 * The swing (§2) has no rung: base only. `envelope`: every cell any of them writes, plus the closed state's (all within the layout).
 * `states`: the moved cells, open and closed. `triggers` in the local frame.
 */
export function mechanismPlan(kind, { depth, mats } = {}) {
  if (!GM_KINDS.includes(kind)) throw new Error(`mechanismPlan: unknown kind ${kind}`);
  const M = mats ?? gmMatsOf({});
  if (kind === 'swing') {
    const cells = [...swingCells({ structure: M.structure, bar: M.bar, button: M.button, plate: M.plate }).values()];
    const m = new Map(cells.map(([u, d, r, s]) => [k3(u, d, r), s]));
    const at = (u, d, r) => m.get(k3(u, d, r));
    const fixed = cells.map(([u, d, r, s]) => [u, d, r, connected(s, at, u, d, r)]).sort((a, b) => gmRank(a[3]) - gmRank(b[3]));
    return { kind, rest: 'closed', dayDriven: false, depth, structure: M.structure, base: fixed, rungs: [], levers: [], envelope: cells.map(([u, d, r]) => [u, d, r]),
      states: { closed: [[-1, 1, 0], [-1, 1, 1], [1, 1, 0], [1, 1, 1]], open: [[-1, 1, 0], [-1, 1, 1], [1, 1, 0], [1, 1, 1]] },
      triggers: [{ kind: 'button', at: [0, 0, 1], side: 'front', who: 'player' }, { kind: 'lever', at: [0, 2, 1], side: 'back', who: 'player' }, { kind: 'plate', at: [-1, 2, 0], side: 'back', who: 'anyone' }] };
  }
  // (slideCells writes a slide's leaf in the structure block: it is set to the movable leaf below)
  const lmS = { structure: M.structure, bar: M.bar };
  const roofs = [];
  for (let R = GM_ROOF_MIN; R <= gmRoofMax(depth); R++) roofs.push(R);
  const per = roofs.map((R) => {
    const lay = gateLayout(kind, { depth, roof: R, mats: lmS });
    const m = settledMap(lay);
    if (kind === 'slide' && M.leaf !== M.structure) for (const s of [-1, 1]) for (let r = 0; r <= 2; r++) m.set(k3(2 * s, 1, r), M.leaf);
    return { R, m, sensor: lay.sensor };
  });
  // base: the cells every roof writes alike; the rung cells: the rest
  const all = new Set(per.flatMap((p) => [...p.m.keys()]));
  const baseKeys = [...all].filter((key) => per.every((p) => p.m.get(key) === per[0].m.get(key)));
  const rungKeys = [...all].filter((key) => !baseKeys.includes(key));
  const cell = (key, st) => [...key.split(',').map(Number), st];
  const order = (a, b) => gmRank(a[3]) - gmRank(b[3]) || a[2] - b[2] || a[1] - b[1] || a[0] - b[0];
  const baseCells = baseKeys.map((key) => cell(key, per[0].m.get(key))).sort(order);
  const rungs = per.map((p) => {
    const cells = [];
    for (const key of rungKeys) {
      const [u, d, r] = key.split(',').map(Number);
      if (p.m.has(key)) cells.push(cell(key, p.m.get(key)));
      else if (r < p.R) cells.push([u, d, r, M.structure]);
    }
    return { roof: p.R, sensor: p.sensor, cells: cells.sort(order) };
  });
  const lane = (u) => [0, 1, 2].map((r) => [u, 1, r]);
  return { kind, rest: 'open', dayDriven: true, depth, structure: M.structure, base: baseCells, rungs, levers: [], envelope: [...all].map((key) => key.split(',').map(Number)),
    rungKeys: rungKeys.map((key) => key.split(',').map(Number)),
    states: { open: [...lane(-2), ...lane(2)], closed: [...lane(-1), ...lane(1), ...lane(-2), ...lane(2)] },
    triggers: [{ kind: 'lever', at: [-1, 0, 2], side: 'front', who: 'player' }, { kind: 'lever', at: [1, depth - 1, 2], side: 'back', who: 'player' }, { kind: 'daylight', at: per[0].sensor, rungs: per.map((p) => p.sensor), side: 'roof', who: 'sky' }] };
}

/**
 * (7a GM-a2, §16 item 1) The mechanism's provisional bill: what the realise can write once the rung is picked at bind (exact then), as a
 * range over every case. `cells` [lo, hi]: its non-air cells; `bom` {min, max}: per item, the least and the most any case takes (C26's
 * rules, kit/lib/connectors/bom.mjs, the same as the mod's SurvivalItems); `rare`: §8's raw items for planning. The cases: levers-only (the base), each rung R with no roof
 * fill, each rung R with every unwritten rung cell at or above R filled with the structure block (§16 item 3's upper bound). A swing has
 * one case. Pure.
 */
export function gmCost(plan) {
  const nonAir = (cells) => cells.filter((c) => !/(^|:)(cave_|void_)?air$/.test(base(c[3]))).length;
  const cases = [plan.base];
  for (const g of plan.rungs ?? []) {
    cases.push([...plan.base, ...g.cells]);
    const left = (plan.rungKeys?.length ?? 0) - g.cells.length;
    cases.push([...plan.base, ...g.cells, ...Array.from({ length: Math.max(0, left) }, () => [0, 0, 0, plan.structure])]);
  }
  const boms = cases.map((c) => bomOf(c.map((x) => x[3])));
  const items = [...new Set(boms.flatMap((b) => Object.keys(b)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const min = {}, max = {};
  for (const i of items) {
    const v = boms.map((b) => b[i] ?? 0);
    if (Math.min(...v) > 0) min[i] = Math.min(...v);
    max[i] = Math.max(...v);
  }
  const n = cases.map(nonAir);
  // (§8 "Rare items": the raw items the crafted parts need, at most, so a stockpile can plan: a slime ball per sticky piston, nether quartz
  // per comparator and observer and 3 per daylight sensor)
  const rare = {};
  if (max['minecraft:sticky_piston']) rare['minecraft:slime_ball'] = max['minecraft:sticky_piston'];
  const q = (max['minecraft:comparator'] ?? 0) + (max['minecraft:observer'] ?? 0) + 3 * (max['minecraft:daylight_detector'] ?? 0);
  if (q) rare['minecraft:quartz'] = q;
  return { cells: [Math.min(...n), Math.max(...n)], bom: { min, max }, ...(Object.keys(rare).length ? { rare } : {}) };
}

/**
 * The gatehouse's brief lines for a mechanism (§4 and §5 word for word, §15 items 1 and 6): Steward passes them on with the lot's brief.
 * `depth`: the box's depth through the wall (the roof cap is depth + 7 rows over the passage floor).
 */
export function gmBrief(kind, depth) {
  const out = ['keep 4 clear cells above the passage lintel for the winch room'];
  if (kind === 'swing') return out;
  out.push('give a sky-exposed roof or crenel cell for the daylight sensor');
  out.push('keep 5 cells of jamb a side of the passage clear of ladders and stairs');
  out.push('leave the reserved staircase from the gate up to the roof empty or solid, with no redstone, light source or opening on it');
  out.push(`keep the roof over the gate's logic block (the 13 columns centred on the passage, from 1 to ${depth - 2} cells in from the front face) at or below row ${gmRoofMax(depth)} above the passage floor so the gate can sense the sky; towers elsewhere on the lot may rise higher`);
  return out;
}

/** Runs [x, z, y0, y1] of cells [[x, y, z]] (a column's consecutive ys joined), flat, in (x, z, y) order (wallLots' flatRuns). */
export function flatRunsOf(cells) {
  const s = [...cells].sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
  const out = [];
  for (const [x, y, z] of s) {
    const L = out.length;
    if (L && out[L - 4] === x && out[L - 3] === z && out[L - 1] === y - 1) out[L - 1] = y; else if (!(L && out[L - 4] === x && out[L - 3] === z && y >= out[L - 2] && y <= out[L - 1])) out.push(x, z, y, y);
  }
  return out;
}

/**
 * The passage's mechanism (§5): the artifact record and the IR's write data, in the world. `at`: gmToWorld's placement (the passage's centre
 * column on the front face row, floorY, the passage's facing); `toFrame(x, y, z)` -> [u, y, v] the lot frame. Returns {record, write}:
 *   record {kind, rest, width: 3, dayDriven, cells, lotCells, triggers: [{kind, at, side, who}], states: {open, closed}, brief, cost}
 *          (cost: gmCost's provisional range, exact at bind: §16 item 1)
 *   write  {palette: [state], base: [x, y, z, i, ...], rungs: [{roof, sensor: [x, y, z], beside: [x, y, z, x, y, z] (the roof cells
 *          either side of the sensor across the passage: the bind rule), cells: [x, y, z, i, ...]}], fill: i (the roof fill's
 *          palette index, §16 item 3; the sliding kinds only)}  (realise order)
 */
export function gmRecord(plan, rest, at, toFrame) {
  const W3 = (c) => gmToWorld(c, at);
  const env = plan.envelope.map((c) => W3([...c, null]).slice(0, 3));
  const pal = [], pi = new Map();
  const idx = (s) => { let i = pi.get(s); if (i === undefined) { i = pal.length; pal.push(s); pi.set(s, i); } return i; };
  const flat = (cells) => cells.flatMap((c) => { const [x, y, z, s] = W3(c); return [x, y, z, idx(s)]; });
  const write = { palette: pal, base: flat(plan.base), rungs: plan.rungs.map((g) => ({ roof: g.roof, sensor: W3([...g.sensor, null]).slice(0, 3), beside: [-1, 1].flatMap((du) => W3([g.sensor[0] + du, g.sensor[1], g.sensor[2], null]).slice(0, 3)), cells: flat(g.cells) })) };
  // ((7a GM-a2, §16 item 3) the roof fill's block: the structure role's, which the realise writes on a rung cell at or above the bound
  // roof that the design left empty with the design's roof beside it across the passage)
  if (plan.rungs.length) write.fill = idx(plan.structure);
  const tw = (c) => W3([...c, null]).slice(0, 3);
  const triggers = plan.triggers.map((t) => ({ kind: t.kind, at: tw(t.at), ...(t.rungs ? { rungs: t.rungs.map(tw) } : {}), side: t.side, who: t.who }));
  const record = {
    kind: plan.kind, rest, width: 3, dayDriven: plan.dayDriven,
    cells: flatRunsOf(env), lotCells: flatRunsOf(env.map(([x, y, z]) => toFrame(x, y, z))),
    triggers, states: { open: flatRunsOf(plan.states.open.map(tw)), closed: flatRunsOf(plan.states.closed.map(tw)) },
    ...(plan.rungKeys ? { rungs: flatRunsOf(plan.rungKeys.map(tw)) } : {}),
    brief: gmBrief(plan.kind, plan.depth),
    cost: gmCost(plan),
  };
  return { record, write };
}

export { gmBoxFits, GM_BOX_MIN };

// ------------------------------------------------------------------ (GM-b) the K1 swing gate (CONTRACT GM §17)

/** (GM-b, §17 item 3) The swing's size: exactly 3 wide, 3 high (2 door rows and the transom) and 3 deep. */
export const K1_SWING = Object.freeze({ width: 3, height: 3, depth: 3 });

/**
 * (GM-b, §17 item 3) A K1 wall gate's swing, in gmCircuit's local frame (u across the opening, d in from the wall's outer face, r up from
 * the gate's floor row): swingCells (two iron doors, the mullion, the transom; the button outside on d 0, the lever and plate inside on
 * d 2), plus the structure block over the transom in the door plane on every row of a gate `height` over 3 (the opening above the
 * transom sealed), and over the mullion on the arch's middle row (`arch`: K1's arch frame leaves the cell over a 3-wide gate's middle
 * column open). Everything else of the opening (the lanes in front of and behind the doors) is the wall's. Pure.
 */
export function k1SwingPlan(mats, { height = K1_SWING.height, arch = false } = {}) {
  const p = mechanismPlan('swing', { depth: K1_SWING.depth, mats });
  const extra = [];
  for (let r = K1_SWING.height; r < height; r++) for (const u of [-1, 0, 1]) extra.push([u, 1, r, p.structure]);
  if (arch) extra.push([0, 1, Math.max(height, K1_SWING.height), p.structure]);
  // (the transom's connections as the server settles them: toward the mullion and the jambs, not toward the open lanes in front of and
  // behind it, which are the opening's air in a K1 wall)
  const all = [...extra, ...p.base];
  const m = new Map(all.map(([u, d, r, st]) => [k3(u, d, r), st]));
  const at = (u, d, r) => m.get(k3(u, d, r)) ?? ((d === 0 || d === 2) && Math.abs(u) <= 1 && r >= 0 && r < Math.max(height, K1_SWING.height) ? 'minecraft:air' : undefined);
  const base = all.map(([u, d, r, st]) => [u, d, r, connected(st, at, u, d, r)]).sort((a, b) => gmRank(a[3]) - gmRank(b[3]));
  return { ...p, height, base, envelope: [...extra.map(([u, d, r]) => [u, d, r]), ...p.envelope] };
}

/**
 * (GM-b, §17 items 3 and 4) The K1 swing gate's record and write data in the world. `at`: gmToWorld's placement (the opening's middle
 * column on the wall's outer face, the gate's first clear row, the outward facing). Returns {record, write}:
 *   record {kind: swing, rest: closed, width: 3, height, dayDriven: false, who: player, movers: [player], cells, triggers, states, cost}
 *          (cells: the written cells as flat runs [x, z, y0, y1]; cost: gmCost's, one case, exact at plan time)
 *   write  {palette: [state], base: [x, y, z, i, ...]}  (realise order; the region's mech:<gate> cells item, GateMech's base)
 */
export function k1SwingRecord(plan, at) {
  const W3 = (c) => gmToWorld(c, at);
  const pal = [], pi = new Map();
  const idx = (s) => { let i = pi.get(s); if (i === undefined) { i = pal.length; pal.push(s); pi.set(s, i); } return i; };
  const base = plan.base.flatMap((c) => { const [x, y, z, s] = W3(c); return [x, y, z, idx(s)]; });
  const tw = (c) => W3([...c, null]).slice(0, 3);
  const record = {
    kind: 'swing', rest: 'closed', width: K1_SWING.width, height: plan.height, dayDriven: false, who: 'player', movers: ['player'],
    cells: flatRunsOf(plan.envelope.map(tw)),
    triggers: plan.triggers.map((t) => ({ kind: t.kind, at: tw(t.at), side: t.side, who: t.who })),
    states: { open: flatRunsOf(plan.states.open.map(tw)), closed: flatRunsOf(plan.states.closed.map(tw)) },
    cost: gmCost(plan),
  };
  return { record, write: { palette: pal, base } };
}
