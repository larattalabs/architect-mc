// (7c TC, docs/CONTRACT.md "Phase 7c" §3 row 7, "Slice TC as built") The template catalogue on the kit side: the scenario programs
// (S1 floating_islands, S2 ice_outpost, S3 terraced_monastery, S5 s5_treehouses, S6 s6_cave_city, S7 flat_village) listed in the pick
// catalogue (tools/region.mjs catalogue) with their claim ranges, pickable params only and `needs.affordances` in AF's kinds; the land
// fixtures re-built byte for byte; the needs met by the sculpted land and not by plains or the natural windows; a picked flat village
// with no lot list; a picked cave city that finds the sculpted hall from the land.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AFFORDANCE_KINDS, analyseVolume } from '../lib/region/affordances.mjs';
import { decodeArvx, VC } from '../lib/region/volume.mjs';
import { LANDS, FIXTURES, buildLand } from './tc-land.mjs';
import { makeLand, applySculpt, plan2 } from './sb-world.mjs';
import { caveLayout } from '../regions/s6_cave_city.mjs';
import { DEFAULT_LOTS } from '../regions/flat_village.mjs';

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(KIT, '..');
const catalogue = () => JSON.parse(execFileSync(process.execPath, [path.join(KIT, 'tools', 'region.mjs'), 'catalogue', '--json'], { encoding: 'utf8' })).programs;
const SCENARIOS = { s1_floating_islands: 'floating_islands', s2_ice_spikes: 'ice_outpost', s3_monastery: 'terraced_monastery', s5_treehouses: 's5_treehouses', s6_cave_city: 's6_cave_city', s7_flat_village: 'flat_village' };
const scenario = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', `${f}.json`), 'utf8'));

/** A land's affordances against a catalogue entry's needs (the sidecar's missingLand, here in plain JS for the kit's own check). */
function unmet(prog, list) {
  const out = [];
  for (const [kind, v] of Object.entries(prog.needs?.affordances ?? {})) {
    const n = typeof v === 'number' ? { count: v, min: {} } : { count: v.count ?? 1, min: v.min ?? {} };
    const got = list.filter((a) => a.kind === kind && Object.entries(n.min).every(([m, f]) => a.metrics[m] >= f)).length;
    if (got < n.count) out.push(`${kind} ${got}/${n.count}`);
  }
  return out;
}
const landOf = (name) => analyseVolume(decodeArvx(zlib.gunzipSync(fs.readFileSync(new URL(`${name}.bin`, FIXTURES)))));
const afWindow = (name) => { let b = fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'af', `${name}.bin`)); try { b = zlib.gunzipSync(b); } catch { /* raw */ } return analyseVolume(decodeArvx(b)); };

test('the catalogue lists the six scenario programs with claim ranges holding their scenarios, keywords, and only pickable params', () => {
  const progs = catalogue();
  const ids = progs.map((p) => p.id);
  for (const [f, id] of Object.entries(SCENARIOS)) {
    const p = progs.find((x) => x.id === id);
    assert.ok(p, `${id} (${f}) is listed`);
    assert.ok(p.description.length > 80 && p.keywords?.length >= 5, `${id}: a description and keywords`);
    const [w, d] = scenario(f).needs.size;
    assert.ok(p.claim.min[0] <= Math.min(w, d) && p.claim.min[1] <= Math.max(w, d) && p.claim.max[0] >= Math.min(w, d) && p.claim.max[1] >= Math.max(w, d), `${id}'s claim range holds ${f}'s ${w}x${d}`);
  }
  // the 6b programs stay, every program has keywords; S4 has no program
  for (const id of ['crater_works', 'rift_city', 'sky_isle', 'walled_hill']) assert.ok(ids.includes(id));
  assert.ok(progs.every((p) => p.keywords?.length));
  assert.equal(ids.length, 10);
  // the params a pick can't set are left out; an enum's options go through (6b passed `values`, which no program declares)
  const by = Object.fromEntries(progs.map((p) => [p.id, p]));
  assert.equal(by.flat_village.params.lots, undefined);
  assert.deepEqual(by.flat_village.params.houses, { type: 'int', min: 4, max: 10, default: 8 });
  assert.deepEqual(by.s5_treehouses.params, {});
  assert.deepEqual(by.s6_cave_city.params, {});
  assert.equal(by.terraced_monastery.params.unsafe, undefined);
  assert.deepEqual(by.sky_isle.params.support.options, ['pillars', 'taper']);
  assert.deepEqual(by.terraced_monastery.params.retain.options, ['wall', 'blend']);
});

test('needs.affordances name AF kinds, counts within AF\'s cap of 16; only S5 and S6 need land features (their land is scenario setup)', () => {
  const progs = catalogue();
  const needing = progs.filter((p) => p.needs?.affordances).map((p) => p.id);
  assert.deepEqual(needing, ['s5_treehouses', 's6_cave_city']);
  for (const p of progs) for (const [k, v] of Object.entries(p.needs?.affordances ?? {})) {
    assert.ok(AFFORDANCE_KINDS.includes(k), `${p.id}: ${k} is an AF kind`);
    const n = typeof v === 'number' ? v : v.count;
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 16, `${p.id}: ${k} count ${n}`);
  }
  assert.deepEqual(progs.find((p) => p.id === 's5_treehouses').needs.affordances, { trunk: { count: 6, min: { height: 24 } } });
  assert.deepEqual(progs.find((p) => p.id === 's6_cave_city').needs.affordances, { cave: { count: 1, min: { floorArea: 400, ceiling: 6 } } });
});

test('the land fixtures re-build byte for byte (deterministic) and lands.json records them', async () => {
  const index = JSON.parse(fs.readFileSync(new URL('lands.json', FIXTURES), 'utf8')).lands;
  for (const name of Object.keys(LANDS)) {
    const l = await buildLand(name);
    assert.ok(Buffer.from(l.gz).equals(fs.readFileSync(new URL(`${name}.bin`, FIXTURES))), `${name}.bin`);
    assert.equal(index[name].sha, l.sha);
    assert.deepEqual(index[name].kinds, l.kinds);
  }
});

test('the needs hold on the sculpted land only: S5 over its grove, S6 over its cavern; not over plains, the bare hill or the natural S5 window', () => {
  const progs = catalogue();
  const s5 = progs.find((p) => p.id === 's5_treehouses'), s6 = progs.find((p) => p.id === 's6_cave_city');
  assert.deepEqual(unmet(s5, landOf('s5_grove')), []);
  assert.deepEqual(unmet(s6, landOf('s6_cavern')), []);
  assert.deepEqual(unmet(s5, landOf('plains')), ['trunk 0/6']);
  assert.deepEqual(unmet(s6, landOf('plains')), ['cave 0/1']);
  assert.deepEqual(unmet(s6, landOf('s6_hill')), ['cave 0/1']);
  assert.deepEqual(unmet(s5, landOf('s6_cavern')), ['trunk 0/6']);
  assert.deepEqual(unmet(s6, landOf('s5_grove')), ['cave 0/1']);
  // AF's natural windows (cut in game, 64x64): S5's forest has one 12-tall trunk, so no fit
  assert.deepEqual(unmet(s5, afWindow('s5_treehouses')), ['trunk 0/6']);
  // recorded, not tuned: S6's natural mountain window has a large natural cave (floor 1298, ceiling 38), so the needs hold there; the
  // program still plans its hall at the claim's middle (SB: a natural cave is not used), so this land passes the pick's check only
  assert.deepEqual(unmet(s6, afWindow('s6_cave_city')), []);
});

test('a picked flat village with no lot list lays `houses` of the default lots (8 by default, S7\'s); the resolved params leave houses out at its default', async () => {
  const land = makeLand({ claim: { minX: 0, minZ: 0, maxX: 111, maxZ: 111 }, minY: 40, maxY: 120, groundAt: () => 64 });
  const a = await plan2(land, 'flat_village', { params: {} });
  assert.deepEqual(a.ir.lots.map((l) => l.id), DEFAULT_LOTS.slice(0, 8).map((l) => l.id));
  assert.equal('houses' in a.ir.params, false);
  assert.deepEqual(a.ir.params.lots, []);
  const b = await plan2(land, 'flat_village', { params: { houses: 4 } });
  assert.deepEqual(b.ir.lots.map((l) => l.id), ['hall_1', 'trading_hall_1', 'cottage_1', 'cottage_2']);
  assert.equal(b.ir.params.houses, 4);
});

test('a picked cave city (no floorY) finds the sculpted hall from the land: the same lots as the sculpt\'s floor, also when the sculpt went deeper', async () => {
  const S6 = LANDS.s6_cavern.spec;
  const g = LANDS.s6_cavern.groundAt;
  const land = makeLand({ claim: S6.claim, minY: S6.minY, maxY: S6.maxY, groundAt: g });
  const L0 = caveLayout(S6.claim, g);
  // water in the lots' rock at the higher candidate floors: the sculpt picks a deeper floor than the old auto guess
  for (const l of L0.lots) for (let y = L0.floorY - 4; y <= L0.floorY + 12; y++) land.set(l.box[0] + 3, y, l.box[2] + 3, VC.WATER);
  const sculpt = await plan2(land, 's6_cavern_sculpt');
  applySculpt(land, sculpt);
  assert.ok(sculpt.meta.sb.floorY < L0.floorY, `the sculpt went deeper (${sculpt.meta.sb.floorY} < ${L0.floorY})`);
  const given = await plan2(land, 's6_cave_city', { params: { floorY: sculpt.meta.sb.floorY } });
  const auto = await plan2(land, 's6_cave_city', { params: {} });
  assert.equal(auto.meta.sb.floorY, sculpt.meta.sb.floorY);
  assert.deepEqual(auto.ir.lots, given.ir.lots);
  assert.deepEqual(auto.ir.parts, given.ir.parts);
  // no hall in the land (the bare hill): the old auto floor, the lots planned there (a pick never lands on it: no cave)
  const bare = makeLand({ claim: S6.claim, minY: S6.minY, maxY: S6.maxY, groundAt: g });
  const none = await plan2(bare, 's6_cave_city', { params: {} });
  assert.equal(none.meta.sb.floorY, L0.floorY);
  assert.equal(none.ir.lots.length, 7);
});
