// (7a FB) M16 flood behaviour (docs/CONTRACT.md "Phase 7a slice FB" §1, §3 item 1): the rule on synthetic bodies (a 1-thick rim over a
// lower path found, 2-thick not, a door counts 1, a sunk pond not, a lot box beside a thin rim), and on committed plans through the
// checker (a warning only; v7a_lf_cliff's two-door airlock clean; a plan without a body carries no M16 metrics).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Palette, VWorld, F_WRITTEN } from '../lib/region/vworld.mjs';
import { FLOOD, floodRule } from '../lib/region/checkFluids.mjs';
import { RULES, checkRegion } from '../lib/region/check.mjs';

const CLAIM = { minX: 0, minZ: 0, maxX: 47, maxZ: 47, minY: -64, maxY: 319 };
/** A flat world: stone to y 63, air over it; `put` writes cells. */
function world() {
  const pal = new Palette();
  const stone = pal.of('minecraft:stone'), air = pal.of('minecraft:air');
  const vw = new VWorld({ claim: CLAIM, palette: pal, base: (x, y) => (y <= 63 ? stone : air), colTop: () => 63 });
  const put = (x, y, z, s) => vw.set(x, y, z, pal.of(s), F_WRITTEN, 0);
  return { vw, put };
}
const box = (x0, y0, z0, x1, y1, z1) => { const o = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) o.push([x, y, z]); return o; };
/** A raised basin: water x/z 10..12, y 64..65 (level 65) on the stone, a rim `t` thick of `rim` round it at y 64..65. */
function basin(t = 1, rim = 'minecraft:stone_bricks') {
  const W = world();
  const cells = box(10, 64, 10, 12, 65, 12);
  for (const c of cells) W.put(...c, 'minecraft:water');
  const shell = [];
  for (const [x, y, z] of box(10 - t, 64, 10 - t, 12 + t, 65, 12 + t)) if (x < 10 || x > 12 || z < 10 || z > 12) { W.put(x, y, z, rim); shell.push([x, y, z]); }
  return { ...W, body: { id: 'b', irPart: 'pond', level: 65, cells, shell }, shell };
}
const feet = (...cs) => cs.flat();

test('M16: a 1-thick rim over a lower path is found, naming the body, the walk cells and the barrier cells', () => {
  const { vw, body } = basin(1);
  const r = floodRule({ vw, bodies: [body], walk: feet([14, 64, 11], [14, 64, 12], [20, 64, 11]) });
  assert.equal(r.found.length, 1);
  const f = r.found[0];
  assert.equal(f.body, 'b');
  assert.equal(f.walk, 2); // (20, 64, 11) is beyond the reach
  assert.deepEqual(f.cells, [[14, 64, 11], [14, 64, 12]]);
  assert.deepEqual(f.barrier.map(String).sort(), ['13,64,11', '13,64,12']);
  assert.equal(r.metrics.thick, 2);
});

test('M16: a 2-thick rim is not found; a walk cell at or over the surface never is', () => {
  const { vw, body } = basin(2);
  assert.equal(floodRule({ vw, bodies: [body], walk: feet([15, 64, 11], [15, 65, 11]) }).found.length, 0);
  const one = basin(1);
  assert.equal(floodRule({ vw: one.vw, bodies: [one.body], walk: feet([14, 65, 11], [14, 66, 11]) }).found.length, 0, 'at the surface (y 65) and over it');
});

test('M16: a door counts 1 (a door in a 1-thick rim is found; a door behind a block is 2)', () => {
  const one = basin(1);
  one.put(13, 64, 11, 'minecraft:oak_door[half=lower,facing=east]');
  one.put(13, 65, 11, 'minecraft:oak_door[half=upper,facing=east]');
  const r = floodRule({ vw: one.vw, bodies: [one.body], walk: feet([14, 64, 11]) });
  assert.equal(r.found.length, 1);
  assert.deepEqual(r.found[0].barrier, [[13, 64, 11]]);
  const two = basin(2);
  two.put(14, 64, 11, 'minecraft:iron_door[half=lower,facing=east]');
  two.put(14, 65, 11, 'minecraft:iron_door[half=upper,facing=east]');
  assert.equal(floodRule({ vw: two.vw, bodies: [two.body], walk: feet([15, 64, 11]) }).found.length, 0, 'block + door: 2');
  // a pane and bars count 1 as well
  for (const s of ['minecraft:glass_pane', 'minecraft:iron_bars']) {
    const p = basin(1);
    p.put(13, 64, 11, s);
    assert.equal(floodRule({ vw: p.vw, bodies: [p.body], walk: feet([14, 64, 11]) }).found.length, 1, s);
  }
});

test('M16: a sunk pond passes (nothing walkable under its surface within 2 of its shell)', () => {
  const W = world();
  const cells = box(10, 61, 10, 14, 63, 14);
  for (const c of cells) W.put(...c, 'minecraft:water');
  // the walk round it stands on the ground (feet y 64, over the surface y 63); a cellar 6 off is beyond the reach
  for (const c of box(20, 61, 12, 21, 62, 12)) W.put(...c, 'minecraft:air');
  const r = floodRule({ vw: W.vw, bodies: [{ id: 'p', irPart: 'pond', level: 63, cells, shell: [] }], walk: feet([15, 64, 12], [9, 64, 12], [20, 61, 12]) });
  assert.equal(r.found.length, 0);
  assert.equal(r.metrics.bodies[0].walk, 0);
});

test('M16: a lot box cell beside a thin rim is found (reached, never crossed); a cell of a body is no target', () => {
  const { vw, body } = basin(1);
  vw.addLot({ id: 'house', box: { minX: 14, minY: 64, minZ: 10, maxX: 18, maxY: 70, maxZ: 12 } });
  const r = floodRule({ vw, bodies: [body], walk: [] });
  assert.equal(r.found.length, 1);
  assert.deepEqual(r.found[0].lots, ['house']);
  assert.ok(r.found[0].lot >= 3 && r.found[0].cells.every(([x]) => x === 14), 'only the box face: never crossed');
  // a walk cell that is a shell cell of a body (a rim walked over the top is not under the surface; one inside the rim set is no target)
  const t = basin(1);
  assert.equal(floodRule({ vw: t.vw, bodies: [t.body], walk: feet([13, 64, 11]) }).found.length, 0);
});

test('M16 is a warning, last in RULES; a plan without a fluid body has no M16 metrics', async () => {
  assert.equal(RULES[RULES.length - 1], 'M16');
  assert.equal(FLOOD.thick, 2);
  const { checkPlanVolumes, fixture } = await helpers();
  const lf = await checkPlanVolumes(...fixture('valid/v7a_lf_cliff.json'));
  const rep = checkOf(lf);
  assert.ok(rep.metrics.M16, 'v7a_lf_cliff: M16 measured');
  assert.equal(rep.findings.filter((f) => f.rule === 'M16').length, 0, "v7a_lf_cliff: the airlock's two doors pass");
  const v56 = checkOf(await checkPlanVolumes(...fixture('valid/v56_fountain_fed.json')));
  const m16 = v56.findings.filter((f) => f.rule === 'M16');
  assert.ok(m16.length >= 1 && m16.every((f) => f.severity === 'warning' && f.stage === 'fluids'), 'v56: a warning');
  assert.equal(v56.errors, v56.findings.filter((f) => f.severity === 'error').length);
  const dry = checkOf(await checkPlanVolumes(...fixture('valid/v01_lots_near_stone.json')));
  assert.equal(dry.metrics.M16, undefined);
  assert.ok(!dry.findings.some((f) => f.rule === 'M16'));
});

let H = null;
async function helpers() {
  if (H) return H;
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await import('./plan-helpers.mjs');
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'plan');
  const fixture = (name) => {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const s = fx.terrain ? h.flatSurvey(fx.terrain) : fx.on === 'flat' ? h.flatSurvey() : fx.on ? h.goldenSurvey(fx.on) : h.flatSurvey();
    const style = typeof fx.style === 'string' ? h.fixtureStyle(fx) : fx.style ?? null;
    return [fx.plan ?? fx.answer?.plan, { volume: fx.volume ?? {}, survey: s.bytes, claim: s.claim, anchors: { ...h.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], keepOut: fx.keepOut ?? [], ...(style ? { style } : {}) }];
  };
  H = { checkPlanVolumes: async (plan, o) => ({ ...(await h.checkPlanVolumes(plan, o)), survey: o.survey }), fixture };
  return H;
}
function checkOf(r) {
  const ir = r.res.ir ?? JSON.parse(r.res.irJson);
  return checkRegion({ ir, survey: r.survey, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: (r.volumes ?? []).map((v) => v.decoded ?? v), meta: r.res.meta, prefix: false });
}
