// (fast checks P2, docs/FAST-CHECKS.md "Precondition for every REPLACE row (the realised == virtual guard)") The in-game cell diff of
// the realised world against the plan's virtual world, counted per writer kind (kit/lib/lint/writers.mjs). The lints check the virtual
// world; this row is what proves the real writers produced it, so it stays at the slice tier, one per writer kind:
//   tools/scenarios.mjs (every scenario run: ground, relief, street, route, forms, lots, props, scatter), gate6ct3a.mjs ingame (bridges:
//   beam, arch), gate6ct3b.mjs ingame (tunnels), gate7ak1b.mjs ingame (rope, slab decks), gate7ak1.mjs ingame (walls, its own row).
//
// Every written cell outside the lot boxes (a lot is its child's) is compared; the plan's state must match by name and by every
// property the plan names (the world lists every property; the rest are defaults or neighbour-dependent: fence connections, stair
// shape, snowy grass). Classes of a differing cell, as gate6cp0/gate7ak1 had them:
//   kept   the realised cell holds what it held before the realise (the op's condition skipped it: a cell the survey can't see)
//   road   a 4e ground road's cell (4e follows the realised ground at realise; within 2 of the centre line)
//   plant  the plan wrote a plant or a snow layer and the world holds air (the world's own plant breaking, as F2's 2 ferns)
//   grass  dirt written, grass_block found or the reverse (vanilla's grass spread and decay by random tick: the vanilla-update table)
//   fluid  air written, a fluid or a fluid's product found (water, lava, cobblestone, stone, obsidian): a natural fluid flowed into a
//          cleared cell (M4's subject; recorded here)
//   child  the row under a lot box (floorY - 1) inside its footprint: a realised lot entry lays its own foundation there; or a path
//          block within 8 columns of a lot's entrance (the entry's own approach path, 4e's PATH join)
//   differ anything else: the writer did not write what the plan says.
// The gate: `differ` 0 for every kind on a flat variant; on a natural one `differ` 0 too, with kept / road / plant recorded.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'kit');
const imp = (rel) => import(pathToFileURL(path.join(KIT, rel)).href);

const parse = (st) => { const m = /^([^[]+)(?:\[(.*)\])?$/.exec(st); return { name: m[1], props: Object.fromEntries((m[2] ? m[2].split(',') : []).map((kv) => kv.split('='))) }; };
export const sameState = (want, got) => { if (want === got) return true; const a = parse(want), c = parse(got); return a.name === c.name && Object.entries(a.props).every(([k, v]) => c.props[k] === v); };
const APPROACH = /^minecraft:(dirt_path|gravel|cobblestone|stone_bricks|oak_planks|spruce_planks)$/;
const LIGHT = /^minecraft:(lantern|soul_lantern|copper_lantern|torch|soul_torch|copper_torch|end_rod|glowstone|sea_lantern|shroomlight|[a-z]+_froglight)(\[|$)/;
const GRASS = new Set(['minecraft:dirt', 'minecraft:grass_block']);
const FLUIDISH = /^minecraft:(water|lava|cobblestone|stone|obsidian|basalt|bubble_column)$/;
const PLANT = /(^minecraft:(short_grass|tall_grass|fern|large_fern|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sweet_berry_bush|dead_bush|snow|leaf_litter|pink_petals|wildflowers|bush|firefly_bush|short_dry_grass|tall_dry_grass|.*_sapling|.*_mushroom|moss_carpet)$)/;

/**
 * `planDir`: the plan's dir (ir.json, survey.bin, meta.json, blobs/); `afterFile`/`beforeFile`: ARWD dumps of the realised box.
 * Options: `lots: false` to compare inside lot boxes too (no lot entries realised). -> {written, differ, kept, road, plant, child, grass, fluid, share,
 * first, byKind: {kind: {written, differ, kept, road, plant, sub: {form: written}}}}.
 */
export async function realisedVsVirtual(planDir, afterFile, beforeFile = null, { lots = true } = {}) {
  const { loadPlanDir, virtualOf } = await imp('lib/lint/vworld-fixtures.mjs');
  const { writerKinds } = await imp('lib/lint/writers.mjs');
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const { centreCells } = await imp('lib/region/geom.mjs');
  const F = loadPlanDir(planDir);
  const { vw } = virtualOf(F);
  const d = await decodeArwd(fs.readFileSync(afterFile));
  const pre = beforeFile ? await decodeArwd(fs.readFileSync(beforeFile)) : null;
  const b = d.box;
  const lotBoxes = lots ? (F.ir.lots ?? []).map((l) => l.box) : [];
  const inLot = (x, y, z) => lotBoxes.some((l) => x >= l.minX && x <= l.maxX && y >= l.minY && y <= l.maxY && z >= l.minZ && z <= l.maxZ);
  const underLot = (x, y, z) => lotBoxes.some((l) => x >= l.minX && x <= l.maxX && y === l.minY - 1 && z >= l.minZ && z <= l.maxZ);
  const { lotEntrance } = await imp('lib/region/check.mjs');
  const entrances = lots ? (F.ir.lots ?? []).map((l) => lotEntrance(l)).filter((e) => Array.isArray(e) && e.length === 3) : [];
  const nearEntrance = (x, z) => entrances.some((e) => Math.max(Math.abs(e[0] - x), Math.abs(e[2] - z)) <= 8);
  const roadCols = new Set();
  for (const r of F.ir.roads ?? []) for (const c of centreCells(r.points.map((q) => [q[0], q[2]])).cells) for (let dx = -2 - (r.width >> 1); dx <= 2 + (r.width >> 1); dx++) for (let dz = -2 - (r.width >> 1); dz <= 2 + (r.width >> 1); dz++) roadCols.add(`${c.x + dx},${c.z + dz}`);
  const kindOf = writerKinds(F.ir, F.meta);
  const tot = { written: 0, differ: 0, kept: 0, road: 0, plant: 0, child: 0, grass: 0, fluid: 0 };
  const byKind = {};
  const first = [];
  vw.eachWritten((x, y, z, idx, f, part) => {
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ || inLot(x, y, z)) return;
    const { kind, sub } = kindOf(x, y, z, part);
    const k = (byKind[kind] ??= { written: 0, differ: 0, kept: 0, road: 0, plant: 0, child: 0, grass: 0, fluid: 0, sub: {} });
    k.written++; tot.written++;
    if (sub) k.sub[sub] = (k.sub[sub] ?? 0) + 1;
    const want = vw.pal.states[idx], got = d.palette[d.cells[d.at(x, y, z)]];
    if (sameState(want, got)) return;
    let cls = 'differ';
    if (pre && pre.palette[pre.cells[pre.at(x, y, z)]] === got) cls = 'kept';
    else if (roadCols.has(`${x},${z}`)) cls = 'road';
    else if (underLot(x, y, z) || (APPROACH.test(parse(got).name) && nearEntrance(x, z))) cls = 'child';
    else if (GRASS.has(parse(want).name) && GRASS.has(parse(got).name)) cls = 'grass';
    else if (/^minecraft:(air|cave_air)$/.test(want) && FLUIDISH.test(parse(got).name)) cls = 'fluid';
    else if (PLANT.test(parse(want).name) && /^minecraft:(air|cave_air)$/.test(got)) cls = 'plant';
    k[cls]++; tot[cls]++;
    if (cls === 'differ' && first.length < 12) first.push({ pos: [x, y, z], kind, part: F.ir.parts[part]?.id ?? null, want, got });
  });
  // the 4e street lanterns (the mod lays them at realise; kit/lib/lint/roads.mjs models them for the lints): the model's light cells
  // against the realised world's light blocks outside the lot boxes that the plan itself did not write. Both ways: a post the model
  // places that the world lacks, and one the world holds that the model doesn't, differ.
  const { layRoadLanterns } = await imp('lib/lint/roads.mjs');
  const planEmit = new Set();
  vw.eachWritten((x, y, z, idx) => { if (vw.pal.emit[idx] > 0) planEmit.add(`${x},${y},${z}`); });
  const lant = layRoadLanterns(vw, F.ir);
  const model = new Set(lant.lights.map(([x, y, z]) => `${x},${y},${z}`));
  const real = new Set();
  if ((F.ir.roads ?? []).some((r) => r.lanterns)) {
    for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) {
      if (!roadCols.has(`${x},${z}`)) continue;
      for (let y = b.minY; y <= b.maxY; y++) {
        const s = d.palette[d.cells[d.at(x, y, z)]];
        if (!LIGHT.test(s) || inLot(x, y, z) || planEmit.has(`${x},${y},${z}`)) continue;
        real.add(`${x},${y},${z}`);
      }
    }
  }
  const lanterns = { model: model.size, realised: real.size, modelOnly: [...model].filter((k) => !real.has(k)), realisedOnly: [...real].filter((k) => !model.has(k)) };
  lanterns.differ = lanterns.modelOnly.length + lanterns.realisedOnly.length;
  tot.differ += lanterns.differ;
  if (lanterns.differ && first.length < 12) first.push({ lanterns: { modelOnly: lanterns.modelOnly.slice(0, 4), realisedOnly: lanterns.realisedOnly.slice(0, 4) } });
  return { ...tot, share: tot.written ? tot.differ / tot.written : 0, first, byKind, lanterns };
}

export const CLASSES = ['kept', 'road', 'plant', 'child', 'grass', 'fluid'];

/** One line per kind for a gate log: `kind written/differ (kept k, road r, plant p)`. */
export function describeRealised(r) {
  return (r.lanterns?.model || r.lanterns?.realised ? `street lanterns model ${r.lanterns.model} / realised ${r.lanterns.realised} (${r.lanterns.differ} differ); ` : '') + Object.entries(r.byKind).sort().map(([k, v]) => `${k} ${v.written}/${v.differ}${CLASSES.some((c) => v[c]) ? ` (${CLASSES.filter((c) => v[c]).map((c) => `${c} ${v[c]}`).join(', ')})` : ''}${Object.keys(v.sub).length ? ` [${Object.entries(v.sub).map(([s, n]) => `${s} ${n}`).join(', ')}]` : ''}`).join('; ');
}

/**
 * The SMOKE row's verdict: every kind's `differ` 0 (`kinds`: the kinds this run must have written, at least one cell each). `strict`
 * (a flat preset world, nothing built by commands): only `child` may differ, since on flat ground a `road` difference means vworld's
 * 4e road model left RoadPlan's walkway (as on a curve) and `kept`/`grass`/`fluid`/`plant` have no natural cell to come from.
 */
export function realisedOk(r, kinds = [], { strict = false } = {}) {
  const missing = kinds.filter((k) => !(r.byKind[k]?.written > 0));
  const loose = strict ? CLASSES.filter((c) => c !== 'child').reduce((a, c) => a + (r[c] ?? 0), 0) : 0;
  return { pass: r.differ === 0 && loose === 0 && missing.length === 0 && r.written > 0, missing, loose };
}
