// (WL) A ring wall's named lots when its zone is adjusted (docs/CONTRACT.md "Slice GM" §18): Steward's castle_town re-check (artifact
// bab6956c, 0.52.0 / kit 0.48.0), where the stockpile's crates at the claim centre moved the castle zone near the claim's edge and the
// ring with its lots on it (band 10) left the claim. The zone is placed again the ring's reach in from the claim's margin and the
// towers and the gatehouse (its portcullis) stand on the line; when the zone has no such place the lots go back to it, each with K1's
// join deviation, and the gatehouse's mechanism with deviation mechanism {why: off_wall}, never a silent plain gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX } from './plan-helpers.mjs';
import { run, part } from './plan-p0-shared.mjs';
import { lotReach, lotBand } from '../lib/connectors/wallLots.mjs';

const fx = () => JSON.parse(fs.readFileSync(path.join(FIX, 'k3', 'w01_recheck_protected.json'), 'utf8'));
const LOTS = ['tower_1', 'tower_2', 'tower_3', 'tower_4', 'gatehouse_1'];
const wallLots = (r) => r.res.meta.walls.find((w) => w.id === 'curtain_wall')?.lots ?? [];
const hard = (f) => ({ ...f, plan: { ...f.plan, zones: f.plan.zones.map((z) => ({ ...z, tolerance: { ...(z.tolerance ?? {}), size: { max: 10, hard: true } } })) } });

test('lotReach: the band, the deepest lot\'s outer half, its apron', () => {
  const sp = (id) => ({ g: { size: [17, 15] }, t: { size: [13, 11] } }[id]);
  const named = [{ lot: 't', at: 'corner' }, { lot: 'g', at: 'gate' }];
  assert.equal(lotBand(named, sp), 10);
  // the gatehouse 15 deep on the band's middle (c 0 at thickness 2): 7 out, then the apron
  assert.equal(lotReach(named, sp, 2), 10 + 0 + 7 + 1);
  assert.equal(lotReach([{ lot: 't', at: 'corner' }], sp, 2), 9 + 6 + 1);
  assert.equal(lotReach([{ lot: 'x', at: 'gate' }], sp, 2), null);
  // a ring whose own min is past the band reaches from there; thickness 3 centres the band (c 1)
  assert.equal(lotReach(named, sp, 2, 20), 20 + 0 + 7 + 1);
  assert.equal(lotReach(named, sp, 3), 10 + 1 + 7 + 1);
});

for (const survival of [true, false]) {
  test(`the re-check with the stockpile protected (${survival ? 'survival' : 'creative'}): the zone placed in from the margin, every named lot on the line, the portcullis kept`, async () => {
    const f = fx();
    const r = await run(f, { survival });
    assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts.map((a) => [a.part, a.class, a.reasons])));
    const z = part(r, 'castle'), w = part(r, 'curtain_wall');
    assert.ok(z.notes.some((n) => /^placed 18 in from the claim's margin: its wall's ring and the lots on it need the room$/.test(n)), JSON.stringify(z.notes));
    const zr = z.geometry.rect;
    for (const p of f.protected) assert.ok(p.rect[2] < zr[0] || p.rect[0] > zr[2] || p.rect[3] < zr[1] || p.rect[1] > zr[3], 'the zone stays off the crates');
    assert.deepEqual(wallLots(r).map((q) => q.lot).sort(), [...LOTS].sort(), 'every named lot on the line');
    assert.ok(!(w.deviations ?? []).some((d) => d.what === 'join' || d.what === 'mechanism'), JSON.stringify(w.deviations));
    const gates = w.geometry.gates;
    assert.deepEqual(gates.map((g) => [g.id, g.auto]), [['gatehouse_1_passage', false]], 'the gatehouse is the only gate (no auto gate)');
    const gh = w.geometry.wallLots.find((q) => q.lot === 'gatehouse_1');
    assert.equal(gh.passage?.mechanism?.kind, 'portcullis');
    // the lots carry onWall (the artifact: Steward binds by it)
    for (const id of LOTS) assert.equal(r.artifact.lots.find((l) => l.id === id)?.onWall?.wall, 'curtain_wall', `${id}: onWall`);
  });
}

test('the same plan unprotected (Steward\'s first check, b8c817ca): unchanged, no inset', async () => {
  const f = { ...fx(), protected: [] };
  const r = await run(f, { survival: true });
  const z = part(r, 'castle');
  assert.deepEqual(z.geometry.rect, [20654, 44954, 20749, 45049], 'the artifact\'s rect');
  assert.ok(!(z.notes ?? []).some((n) => /in from the claim's margin/.test(n)));
  assert.equal(wallLots(r).length, 5);
});

test('cannot re-site (the zone\'s size held hard at 10): the lots go back explicitly, the mechanism off the wall', async () => {
  const r = await run(hard(fx()), { survival: true });
  assert.equal(r.check.overall, 'READY');
  const w = part(r, 'curtain_wall');
  assert.equal(w.class, 'adjusted');
  assert.equal(wallLots(r).length, 0);
  // each named lot a join deviation; the gatehouse's portcullis a mechanism deviation naming the lot
  assert.deepEqual((w.deviations ?? []).filter((d) => d.what === 'join').map((d) => d.lot).sort(), [...LOTS].sort());
  assert.deepEqual((w.deviations ?? []).filter((d) => d.what === 'mechanism'), [{ what: 'mechanism', kind: 'portcullis', lot: 'gatehouse_1', why: 'off_wall' }]);
  // the notes name the real cause: the ring refused with its lots on it, then no place for the zone the ring's reach in
  const why = /its wall curtain_wall found no ring with the lots on it \(refused: no clear ring round part castle at offsets 10\.\.12 on its n side \(out of claim \d+\)\), and its zone castle found no place 18 in from the claim's margin/;
  assert.ok(w.notes.some((n) => /^gate_lot: gatehouse_1 stands \d+ from the wall, beside it \(it fits nowhere on the line: /.test(n) && why.test(n)), JSON.stringify(w.notes));
  assert.ok(w.notes.some((n) => /^gatehouse_1: not on the wall's line \(.*\), so no portcullis is built or billed; the wall's gates are plain$/.test(n) && why.test(n)), JSON.stringify(w.notes));
  assert.ok(!w.notes.some((n) => /placed no line for it/.test(n)), 'not the old wording');
});

test('the re-check is deterministic: 3 checks of each case give one answer set and one artifact sha', async () => {
  for (const f of [fx(), hard(fx())]) {
    const rs = [await run(f, { survival: true }), await run(f, { survival: true }), await run(f, { survival: true })];
    assert.ok(rs.every((x) => x.artifactSha && x.artifactSha === rs[0].artifactSha), 'one artifact sha');
    assert.ok(rs.every((x) => JSON.stringify(x.check.parts) === JSON.stringify(rs[0].check.parts)), 'one answer set');
  }
});

// ((GM-b, CONTRACT GM §17) a K1 swing gate on the same wall, 3 thick: placed again on the adjusted ring with its swing, re-sited or not;
// a wall that finds no ring at all leaves the gate blocked (the artifact's dropped), never a silent wooden door)
const swing = (f, edit = () => {}) => {
  const g = JSON.parse(JSON.stringify(f));
  g.plan.connectors[0].thickness = 3;
  g.plan.connectors.push({ id: 'east_gate', kind: 'gate', at: { anchor: 'claim_e' }, mech: 'swing' });
  edit(g);
  return g;
};

test('GM-b: a swing gate on the wall whose zone the re-check moved keeps its swing (re-sited and cannot-re-site)', async () => {
  for (const [name, f] of [['re-sited', swing(fx())], ['back to the zone', swing(hard(fx()))]]) {
    const r = await run(f, { survival: true });
    assert.equal(r.check.overall, 'READY', name);
    const g = part(r, 'east_gate'), w = part(r, 'curtain_wall');
    assert.equal(g.class, 'fits', `${name}: ${JSON.stringify(g.deviations)}`);
    assert.equal(g.geometry.wall, 'curtain_wall');
    assert.equal(g.geometry.mechanism?.kind, 'swing', name);
    assert.ok(w.geometry.gates.some((q) => q.id === 'east_gate'), `${name}: on the ring`);
    assert.deepEqual((r.res.ir.gateMechanisms ?? []).map((q) => q.gate), ['east_gate'], name);
    if (name === 're-sited') assert.equal(wallLots(r).length, 5);
    else assert.ok(w.deviations.some((d) => d.what === 'mechanism' && d.lot === 'gatehouse_1' && d.why === 'off_wall'));
  }
});

test('GM-b: a wall that finds no ring at all: the swing gate is blocked by it, both in the artifact\'s dropped', async () => {
  const f = swing(fx(), (g) => { g.plan.connectors[0].where.around.ring = [60, 61]; g.plan.connectors[0].required = false; });
  const r = await run(f, { survival: true });
  assert.equal(part(r, 'curtain_wall').class, 'refused');
  assert.equal(part(r, 'east_gate').class, 'blocked');
  assert.deepEqual(r.artifact.dropped.map((d) => [d.part, d.class]).sort(), [['curtain_wall', 'refused'], ['east_gate', 'blocked']]);
  assert.equal(r.res.ir.gateMechanisms, undefined);
});
