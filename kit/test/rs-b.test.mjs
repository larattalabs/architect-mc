// 6c RS-b (docs/CONTRACT.md "Phase 6c slice RS" §6.4, §7.2; HANDOFF-RS "The split"): a tunnel in survival is one construction target per
// tile, its lining and its carve together (the mod builds it ring by ring along `ir.survival.bores`); a creative plan's tunnel is unchanged
// (the lining in the routes stage, before the carve's stage).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evalTile } from '../lib/realise.mjs';
import { unpack } from '../lib/region/pack.mjs';
import { windowFromSurvey } from '../lib/region/survey.mjs';
import { CLASS_FREE } from '../lib/region/survival.mjs';
import { FIX, checkPlanVolumes, fixtureStyle, flatSurvey, stewardAnchors } from './plan-helpers.mjs';

const RS = path.join(FIX, 'rs');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(RS, `${n}.json`), 'utf8'));
async function check(fx, survival) {
  const s = flatSurvey(fx.terrain ?? {});
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, style: fixtureStyle(fx), volume: fx.volume ?? {}, survival });
  return { ...r, survey: s };
}
/** Per stage, the tile cells of a group: {stage: {key: [{x, y, z, state, cls}]}}. */
function cellsOf(r, group) {
  const ir = r.res.ir, out = {};
  const blobs = (sha) => r.res.blobs?.get?.(sha) ?? null;
  for (const st of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles[st][set]) {
    const u = unpack(evalTile(ir, key, windowFromSurvey(r.survey.bytes, key), { stage: st, set, blobs }).payload);
    for (const c of u.cells) {
      const g = c.group === undefined ? null : ir.survival?.groups[c.group];
      if (group === null || g === group) ((out[st] ??= {})[key] ??= []).push(c);
    }
  }
  return out;
}

test('RS-b: rs04 in survival: the whole tunnel in its lining\'s stage with the route\'s approach (one target per tile), `bores` names its group, start, heading and box', async () => {
  const r = await check(fixture('rs04_tunnel'), true);
  const ir = r.res.ir;
  assert.deepEqual(ir.survival.groups, ['bore']);
  assert.equal(ir.survival.bores.length, 1);
  const b = ir.survival.bores[0];
  assert.equal(b.group, 'bore');
  assert.deepEqual(b.dir, [1, 0]);
  assert.equal(b.box.length, 6);
  assert.ok(b.box[0] <= 1104 && b.box[3] >= 1149, `the box spans the bore: ${b.box}`);
  assert.ok(!ir.parts.some((p) => p.id.endsWith('_lining')), 'no separate lining part in survival');
  assert.equal(ir.parts.find((p) => p.id === 'links_t0').stage, 'routes', 'the tunnel in the routes stage in survival');
  const c = cellsOf(r, 'bore');
  assert.deepEqual(Object.keys(c), ['routes'], 'every cell of the part in one stage');
  assert.deepEqual(Object.keys(c.routes), ['17,32'], 'one tile: one target');
  // the routes stage holds the approach, the lining (paid cobblestone over and beside the carve), the carve (held air) and the portals
  const links = Object.values(c.routes ?? {}).flat();
  const carve = links.filter((x) => /air$/.test(x.state));
  const lining = links.filter((x) => x.state === 'minecraft:cobblestone');
  assert.ok(carve.length > 300 && lining.length > 200, `carve ${carve.length}, lining ${lining.length}`);
  assert.ok(links.every((x) => x.cls !== CLASS_FREE), 'every cell of the bore\'s part held or paid');
  // every carve cell under the sand band has its roof in the same stage (the target orders it before the carve)
  const at = new Set(links.map((x) => `${x.x},${x.y},${x.z}`));
  const roofed = carve.filter((x) => x.y === 68 && x.x >= 1112 && x.x <= 1138);
  assert.ok(roofed.length > 0 && roofed.every((x) => at.has(`${x.x},${x.y + 1},${x.z}`)), 'the sand band\'s roof lies in the carve\'s target');
  // the whole part's bill unchanged by the move (the same cells)
  const a = r.check.parts.find((x) => x.part === 'bore');
  assert.equal(a.cost.survival.bom['minecraft:cobblestone'], 368);
});

test('RS-b: rs04 in creative: unchanged (the lining part in routes, no survival member)', async () => {
  const r = await check(fixture('rs04_tunnel'), false);
  const ir = r.res.ir;
  assert.equal(ir.survival, undefined);
  const lp = ir.parts.find((p) => p.id.endsWith('_lining'));
  assert.ok(lp, 'the lining part');
  assert.equal(lp.stage, 'routes');
  assert.equal(ir.parts.find((p) => p.id === 'links_t0').stage, 'links');
});

test('RS-b: a survival plan with no tunnel carries no `bores`', async () => {
  const r = await check(fixture('rs02_walled'), true);
  assert.equal(r.res.ir.survival.bores, undefined);
});

test('RS-b (N-RS-4): rs08\'s ice cap in survival: free (no ice in the part\'s survival bill, the cap a fluid op\'s cells), the shell paid', async () => {
  const fx = fixture('rs08_ice');
  const s = flatSurvey(fx.terrain);
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...fx.anchors }, volume: {}, biomes: fx.biomes, survival: true });
  const a = r.check.parts.find((x) => x.part === 'pond');
  assert.equal(a.class, 'fits');
  const b = r.res.meta.waters[0];
  assert.ok(b.ice > 0, `the pond is capped (${b.ice})`);
  assert.equal(a.cost.survival.bom['minecraft:ice'] ?? 0, 0, 'the cap is free: no ice on the survival bill');
  assert.ok(Object.keys(a.cost.survival.bom).length > 0, 'its built edge (the shell) paid');
  assert.equal(r.check.cost.bom['minecraft:ice'] ?? 0, 0, 'nor on the plan\'s');
  // the cap's cells: in the fluids stage, class free (the fluids gate writes them with the sources)
  const ice = Object.values(cellsOf({ ...r, survey: s }, null).fluids ?? {}).flat().filter((c) => c.state === 'minecraft:ice');
  assert.equal(ice.length, b.ice);
  assert.ok(ice.every((c) => c.cls === CLASS_FREE));
  // in creative the cap is billed as before (bodyBom's ice per cap cell)
  const c = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...fx.anchors }, volume: {}, biomes: fx.biomes });
  assert.equal(c.check.parts.find((x) => x.part === 'pond').cost.bom['minecraft:ice'], b.ice);
});
