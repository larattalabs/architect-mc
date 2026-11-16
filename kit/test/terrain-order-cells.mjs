// (8a TO) A test helper, not a test file: the staged terrain cells a committed plan fixture writes in survival, as the mod's targets
// would hold them (docs/CONTRACT.md "Phase 8a" §3; mod/src/test/.../TerrainOrderTest.java runs it with node). The fixture is planned in
// survival over its survey (flat, asks or a golden), its tiles evaluated stage by stage over the survey's world (surveyBase, with the
// frozen volumes), each cell passing its condition as buildVirtual's does; a cell that changes the world is one target cell when it is
// CLASS_STAGED, or (with a part prefix) when a part whose id starts with it wrote it (a terrace's or a crater's held cells, F3's trees,
// which RS bills: the order covers them too). Prints JSON: {states, groups, tiles, cells: [[x, y, z, after, before, group, tile]...]}
// (after/before index `states`; group indexes `groups`, a survival group, or the part with a prefix; tile indexes `tiles`, as
// "stage/set/key" in feed order). Usage: node kit/test/terrain-order-cells.mjs <fixture.json under fixtures/plan> [partPrefix]
import fs from 'node:fs';
import path from 'node:path';
import { compileIR, evalTile } from '../lib/realise.mjs';
import { unpack } from '../lib/region/pack.mjs';
import { CLASS_STAGED } from '../lib/region/survival.mjs';
import { Palette, surveyBase, windowOf } from '../lib/region/vworld.mjs';
import { asksSurvey, checkPlanVolumes, FIX, flatSurvey, goldenSurvey, stewardAnchors } from './plan-helpers.mjs';

export async function stagedCells(fx, prefix = null) {
  const s = fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? asksSurvey() : fx.on === 'flat' || !fx.on ? flatSurvey() : goldenSurvey(fx.on);
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: fx.volume ?? {}, survival: true });
  const ir = r.res.ir;
  const blobs = (sha) => r.res.blobs.get(sha) ?? null;
  const pal = new Palette();
  const sb = surveyBase(s.bytes, pal, (r.volumes ?? []).map((v) => v.decoded));
  const world = new Map();
  const get = (x, y, z) => world.get(`${x},${y},${z}`) ?? sb.base(x, y, z);
  const groups = [], gIdx = new Map(), tiles = [];
  const out = new Map();
  const opPart = compileIR(ir, { blobs }).ops.map((o) => ir.parts[o.part]?.id ?? '?');
  for (const stage of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles?.[stage]?.[set] ?? []) {
    const t = tiles.length;
    tiles.push(`${stage}/${set}/${key}`);
    const e = evalTile(ir, key, windowOf(s.bytes, key), { stage, set, blobs, cellOps: true });
    const all = unpack(e.payload).cells;
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      const idx = pal.of(c.state);
      const cur = get(c.x, c.y, c.z);
      let ok;
      switch (c.cond) {
        case 1: ok = pal.natural[cur] && !pal.air[cur] && !pal.fluid[cur] && pal.solid[cur]; break;
        case 2: ok = pal.air[cur] || pal.fluid[cur]; break;
        case 3: ok = world.has(`${c.x},${c.y},${c.z}`) || pal.natural[cur]; break;
        default: ok = pal.natural[cur];
      }
      if (!ok || cur === idx) continue;
      const k = `${c.x},${c.y},${c.z}`;
      world.set(k, idx);
      const part = opPart[e.cellOps[i]];
      const mine = prefix === null ? c.cls === CLASS_STAGED : part.startsWith(prefix);
      if (!mine) { out.delete(k); continue; }
      const g = prefix === null ? ir.survival?.groups?.[c.group] ?? '?' : part;
      if (!gIdx.has(g)) { gIdx.set(g, groups.length); groups.push(g); }
      const prev = out.get(k);
      out.set(k, [c.x, c.y, c.z, idx, prev ? prev[4] : cur, gIdx.get(g), t]);
    }
  }
  // a cell written back to its before is no target
  const cells = [...out.values()].filter((c) => c[3] !== c[4]);
  // the land around the targets: each face neighbour that is no target cell and is solid both before and after the region's writes
  const mineAt = new Set(cells.map((c) => `${c[0]},${c[1]},${c[2]}`));
  const solid = [], seen = new Set();
  for (const c of cells) for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const x = c[0] + dx, y = c[1] + dy, z = c[2] + dz, k = `${x},${y},${z}`;
    if (mineAt.has(k) || seen.has(k)) continue;
    seen.add(k);
    if (pal.solid[sb.base(x, y, z)] && pal.solid[get(x, y, z)]) solid.push([x, y, z]);
  }
  // the floating forms' declared anchors (M3): [x, y, z, group]
  const floating = [];
  for (const f of ir.floating ?? []) {
    const a = ir.anchors?.[f.anchor];
    if (!a) continue;
    for (const part of f.parts) {
      const g = prefix === null ? ir.survival?.groups?.[ir.survival?.parts?.[part] ?? -1] : part;
      if (g !== undefined && gIdx.has(g)) floating.push([a[0], a[1], a[2], gIdx.get(g)]);
    }
  }
  return { states: pal.states, groups, tiles, cells, solid, floating };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, process.argv[2]), 'utf8'));
  process.stdout.write(JSON.stringify(await stagedCells(fx, process.argv[3] || null)));
}
