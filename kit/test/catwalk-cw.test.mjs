// (7a CW) Catwalks along a face (docs/CONTRACT.md "Phase 7a slice CW" §2-§8, gate item 1): the geometry (lanes on the walk's
// footprint on every heading and face, the face, the drop, head room, brackets and struts), the run search (route row 10) on both
// faces, every refusal fixture with its evidence and NO_GAP's `path` wouldFit re-checked alone, M10:catwalk clean on v7a_cw_cliff and
// on each broken variant (noBrackets, noRails, wideDeck), M5/M6/M8/M3 on the plan, the KC row (a catwalk past a waterfall's basin:
// M25:clear 0), the wire shapes (siteplan catwalks[], the graph edge's crossing, cost.bom exact), survival's order, determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, flatSurvey } from './plan-helpers.mjs';
import { run, svOf, part } from './plan-p0-shared.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { CATWALK, bracketIndices, catwalkLanes, checkCatwalk, runCost } from '../lib/connectors/catwalkGeom.mjs';
import { footprintOf, routePass } from '../lib/region/passes/route.mjs';
import { decodeColumns } from '../lib/region/pack.mjs';
import { rightOf } from '../lib/connectors/ropeGeom.mjs';
import { sitePlan } from '../lib/region/siteplan.mjs';
import { bomOf } from '../lib/connectors/bom.mjs';
import * as hooks from '../lib/connectors/catwalk.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';

const fx = (dir, name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(FIX, dir, name), 'utf8')) });
const checkOf = (f, r) => { const s = svOf(f); return checkRegion({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, volumes: (r.volumes ?? []).map((v) => v.decoded) }); };

/** A land over a grid of column tops (`g(x, z)`): solid at or under the top, air over it. */
const gridLand = (g, { water = () => false, blocked = () => false } = {}) => ({
  groundAt: g, topAt: g, waterAt: water, blocked, classAt: (x, y, z) => (y > g(x, z) ? 'AIR' : y >= g(x, z) - 3 ? 'SOIL' : 'ROCK'),
});

test('geometry: the lanes are the walk footprint on every heading, the face just outside it on either side, the outer edge width from it', () => {
  for (const width of [1, 2]) for (const dir of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const side of ['left', 'right']) {
    const L = catwalkLanes(width, dir, side), [rx, rz] = rightOf(dir);
    // a straight walk of 5 cells along dir: the footprint row across cell 2 is exactly the lanes
    const cells = Array.from({ length: 5 }, (_, i) => [100 + dir[0] * i, 64, 200 + dir[1] * i]);
    const fp = new Set(footprintOf(cells, width).map(([x, z]) => `${x},${z}`));
    const row = (v) => `${100 + dir[0] * 2 + rx * v},${200 + dir[1] * 2 + rz * v}`;
    for (const v of L.lanes) assert.ok(fp.has(row(v)), `w${width} ${dir} ${side}: lane ${v} on the footprint`);
    assert.ok(!fp.has(row(L.face)) && !fp.has(row(L.bed)), `w${width} ${dir} ${side}: face and bed outside the footprint`);
    assert.equal(Math.abs(L.face - L.lanes[L.lanes.length - 1]), width, 'the outer lane is width from the face');
    assert.ok(L.lanes[0] === L.inner, "the inner lane first");
    assert.ok(L.lanes[L.lanes.length - 1] === L.outer, "the outer lane last");
    // the face is on the named hand: right = rightOf(dir)
    assert.deepEqual(L.toward, side === 'right' ? [rx + 0, rz + 0] : [-rx + 0, -rz + 0]);
  }
  assert.deepEqual(bracketIndices(16), [1, 5, 9, 13, 16]);
  assert.deepEqual(bracketIndices(3), [1, 3]);
  assert.deepEqual(bracketIndices(9), [1, 5, 9]);
  assert.equal(runCost(16), 200 + 25 * 16 + 20 * 5);
});

test('geometry: §2\'s checks in order (NO_GAP, ANCHOR, HEADROOM, SPAN, WATER, PROTECTED), brackets on land, struts within 2', () => {
  // a cliff north of z 0 (top 84), the deck at 72 along z 0..1 heading +x, the face left; the ground under the deck g(x, z)
  const under = (gx) => gridLand((x, z) => (z < 0 ? 84 : gx(x, z)));
  const a = [0, 72, 0], dir = [1, 0];
  assert.equal(checkCatwalk(under(() => 72), a, dir, 8, 'left', 2).code, 'NO_GAP');
  const ok = checkCatwalk(under(() => 64), a, dir, 8, 'left', 2);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(ok.brackets.map((b) => [b.i, b.land]), [[1, false], [5, false], [8, false]]);
  assert.deepEqual(ok.struts, []);
  // the face on the right is open air: ANCHOR {why: face}
  const anch = checkCatwalk(under(() => 64), a, dir, 8, 'right', 2);
  assert.equal(anch.code, 'ANCHOR');
  assert.equal(anch.evidence.why, 'face');
  // the land under the outer lane 3 below: a strut of 1 (y - 2) on it; 2 below: the bracket on the land's top? no: 2 below is y - 2 solid, no strut
  const s3 = checkCatwalk(under((x, z) => (z === 1 ? 69 : 64)), a, dir, 8, 'left', 2);
  assert.ok(s3.ok);
  assert.deepEqual(s3.struts.map((q) => [q[1], q[2]]), [[70, 70], [70, 70], [70, 70]]);
  const s4 = checkCatwalk(under((x, z) => (z === 1 ? 68 : 64)), a, dir, 8, 'left', 2);
  assert.deepEqual(s4.struts.map((q) => [q[1], q[2]]), [[69, 70], [69, 70], [69, 70]]);
  const s5 = checkCatwalk(under((x, z) => (z === 1 ? 67 : 64)), a, dir, 8, 'left', 2);
  assert.deepEqual(s5.struts, [], 'land more than 2 under the bracket: no strut');
  // the land at y - 1 under the outer lane carries the deck: no bracket written there (still a support)
  const land = checkCatwalk(under((x, z) => (z === 1 && x === 1 ? 71 : 64)), a, dir, 8, 'left', 2);
  assert.deepEqual(land.brackets.map((b) => [b.i, b.land]), [[1, true], [5, false], [8, false]]);
  // the deck meets the land (a lane's ground at y): HEADROOM; then SPAN, WATER, PROTECTED in order
  assert.equal(checkCatwalk(under((x, z) => (z === 0 && x === 3 ? 72 : 64)), a, dir, 8, 'left', 2).code, 'HEADROOM');
  assert.equal(checkCatwalk(under(() => 64), a, dir, 33, 'left', 2).code, 'SPAN');
  assert.equal(checkCatwalk(under(() => 64), a, dir, 2, 'left', 2).code, 'SPAN');
  const wet = gridLand((x, z) => (z < 0 ? 84 : 60), { water: (x, z) => z >= 0 });
  assert.equal(checkCatwalk(wet, a, dir, 8, 'left', 2).code, 'WATER');
  const prot = gridLand((x, z) => (z < 0 ? 84 : 64), { blocked: (x, z) => z === 2 && x === 4 });
  assert.equal(checkCatwalk(prot, a, dir, 8, 'left', 2).code, 'PROTECTED', 'the rail bed column is written');
  // an overhang 1 over the deck (y + 1 solid over a lane): HEADROOM with the cell
  const over = { ...under(() => 64), classAt: (x, y, z) => (z < 0 ? (y <= 84 ? 'ROCK' : 'AIR') : z === 1 && y === 73 && x === 2 ? 'ROCK' : y > 64 ? 'AIR' : 'SOIL') };
  const hr = checkCatwalk(over, a, dir, 8, 'left', 2);
  assert.equal(hr.code, 'HEADROOM');
  assert.deepEqual(hr.evidence.cells[0].at, [2, 73, 1]);
});

/** The fixture's terrain mirrored north-south about the claim (the cliff to the south). */
function mirrored(f) {
  const t = f.terrain, z0 = t.z0, zz = (z) => z0 + (t.D - 1) - (z - z0);
  return { terrain: { ...t, bands: t.bands.map((b) => ({ ...b, z0: zz(b.z1), z1: zz(b.z0) })) }, anchors: Object.fromEntries(Object.entries(f.anchors).map(([k, [x, y, z]]) => [k, [x, y, zz(z)]])), protected: (f.protected ?? []).map((p) => ({ ...p, rect: [p.rect[0], zz(p.rect[3]), p.rect[2], zz(p.rect[1])] })) };
}

test('the run search (route row 10): the face on the left, then on the right; exactly one run on a catwalk edge; off without spans', () => {
  const f = fx('valid', 'v7a_cw_cliff.json');
  for (const [tag, g] of [['north', f], ['south', { ...f, ...mirrored(f) }]]) {
    const c = decodeColumns(flatSurvey(g.terrain).bytes);
    const ko = (g.protected ?? []).map((p) => p.rect);
    const edge = { id: 'e', from: { at: g.anchors.west_shelf }, to: { at: g.anchors.east_shelf }, width: 2, movers: ['player', 'villager'], spans: ['catwalk'], once: 'catwalk', approach: 16, t7: { catwalk: { width: 2 } } };
    const e = routePass(c, [], { edges: [edge], keepOut: ko }).data.edges[0];
    assert.ok(e.ok, `${tag}: ${e.failed} ${e.note}`);
    const runs = e.segments.filter((s) => s.kind === 'catwalk');
    assert.equal(runs.length, 1, `${tag}: exactly one run`);
    assert.equal(runs[0].side, tag === 'north' ? 'left' : 'right', `${tag}: heading east, the cliff ${tag} is on the ${tag === 'north' ? 'left' : 'right'}`);
    assert.equal(runs[0].n, 16);
    assert.deepEqual(e.catwalks.map((q) => q.n), [16]);
    // without spans the row is off: the edge walks (or fails) as T2's
    const plain = routePass(c, [], { edges: [{ ...edge, spans: undefined, once: undefined, t7: undefined }], keepOut: ko }).data.edges[0];
    assert.ok(!(plain.segments ?? []).some((s) => s.kind === 'catwalk'));
  }
});

test('v7a_cw_cliff: fits; M10:catwalk, M8, M6, M5 and M3 clean on the virtual world; the crossing, the graph edge, the BOM exact, the siteplan row', async () => {
  const f = fx('valid', 'v7a_cw_cliff.json');
  const r = await run(f);
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts));
  const a = part(r, 'cliff_walk');
  assert.equal(a.class, 'fits');
  assert.deepEqual(a.geometry.catwalks.map((q) => [q.n, q.side, q.width, q.brackets]), [[16, 'left', 2, 5]]);
  assert.deepEqual(a.geometry.catwalks[0].crossing, { type: 'catwalk', length: 16, brackets: 5 });
  assert.ok(r.res.ir.graph.edges.some((e) => e.type === 'catwalk' && e.crossing?.length === 16 && e.crossing.brackets === 5), 'the graph edge is typed catwalk with its crossing');
  const rep = checkOf(f, r);
  const per = rep.metrics.catwalks.per;
  assert.equal(per.length, 1);
  assert.ok(per[0].ok, JSON.stringify(per[0]));
  assert.deepEqual([per[0].level, per[0].cells, per[0].railed, per[0].headroom, per[0].outerMax, per[0].faceWritten], [32, 32, 16, 16, 2, 0]);
  assert.equal(rep.metrics.M5catwalk.darkSpawnable, 0);
  assert.ok(!rep.findings.some((x) => /^M(3|6|10)(:|$)/.test(x.rule) || x.rule === 'M8'), rep.findings.map((x) => `${x.rule} ${x.message}`).join('; '));
  // the kit movers across both ways
  for (const e of rep.metrics.route.edges) assert.ok(e.player && e.villager !== false, JSON.stringify(e));
  // the BOM: exactly the states the run wrote (deck and beds, rails, brackets, lamps)
  const m = r.res.meta.catwalks[0];
  const { vw } = buildVirtual({ ir: r.res.ir, survey: svOf(f).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null });
  const pi = r.res.ir.parts.findIndex((q) => q.id === m.part);
  const states = [];
  vw.eachWritten((x, y, z, idx, fl, p) => { if (p === pi) states.push(vw.pal.states[idx]); });
  assert.deepEqual(a.cost.bom, bomOf(states));
  assert.deepEqual(m.bom, a.cost.bom);
  assert.equal(states.length, 32 + 16 + 16 + 5 + m.lamps.length);
  // the face never written
  for (const [x, y, z] of m.faceCells) assert.equal(vw.get(x, y, z), vw.base(x, y, z), `face ${x},${y},${z}`);
  // siteplan/1 catwalks[] (counts)
  const sp = sitePlan({ ir: r.res.ir, meta: r.res.meta });
  assert.deepEqual(sp.catwalks, [{ id: m.id, part: m.part, cells: 32, brackets: 5 }]);
});

test('the refusals: NO_GAP (with a path wouldFit that fits alone), ANCHOR on sand, HEADROOM, SPAN 33, MOVER; each with its evidence', async () => {
  const want = { 'r01_no_gap.json': 'NO_GAP', 'r02_anchor_sand.json': 'ANCHOR', 'r03_headroom.json': 'HEADROOM', 'r04_span_33.json': 'SPAN', 'r05_mover.json': 'MOVER' };
  for (const [name, code] of Object.entries(want)) {
    const f = fx('cw', name);
    const r = await run(f);
    const a = part(r, 'cliff_walk');
    assert.equal(a.class, 'refused', name);
    assert.equal(a.reasons[0].code, code, `${name}: ${JSON.stringify(a.reasons)}`);
    assert.ok(a.reasons[0].evidence, name);
    if (code === 'ANCHOR') { assert.equal(a.reasons[0].evidence.why, 'face'); assert.ok(a.reasons[0].evidence.columns.some((q) => q.class === 'LOOSE'), 'the sand named'); }
    if (code === 'HEADROOM') assert.ok(a.reasons[0].evidence.cells.some((q) => q.why === 'overhang'));
    if (code === 'SPAN') { assert.ok(a.reasons[0].evidence.span > CATWALK.runMax); assert.equal(a.reasons[0].evidence.max, 32); }
    if (code === 'MOVER') assert.equal(a.reasons[0].evidence.minWidth, 2);
    assert.equal((r.res.meta.catwalks ?? []).length, 0, `${name}: a refused part writes nothing`);
    if (code === 'NO_GAP') {
      assert.equal(a.wouldFit?.[0]?.fragment?.kind, 'path');
      // re-checked alone: the fragment as its own plan fits
      const alone = await run({ ...f, plan: { schemaVersion: 'plan/0', connectors: [a.wouldFit[0].fragment] } });
      assert.equal(part(alone, 'cliff_walk').class, 'fits', JSON.stringify(part(alone, 'cliff_walk')));
    }
  }
});

test('M10:catwalk on the broken variants (noBrackets, noRails, wideDeck 3 from the face)', async () => {
  const want = { 'u01_no_brackets.json': /brackets more than 4 apart/, 'u02_no_rails.json': /without a rail on the open edge/, 'u03_wide_deck.json': /outer edge stands 3 from the face/ };
  for (const [name, re] of Object.entries(want)) {
    const f = fx('cw', name);
    const r = await run(f);
    assert.equal(part(r, 'cliff_walk').class, 'fits', `${name}: the plan check never refuses an unsafe part`);
    const rep = checkOf(f, r);
    const m10 = rep.findings.filter((x) => x.rule === 'M10:catwalk');
    assert.ok(m10.some((x) => re.test(x.message)), `${name}: ${m10.map((x) => x.message).join('; ')}`);
    assert.ok(!rep.metrics.catwalks.per[0].ok);
  }
});

test('KC (§5, item 6): a catwalk past a waterfall\'s basin fits, kept clear: M25:clear 0, no cell on a body\'s hard set', async () => {
  const f = fx('cw', 'k01_past_falls.json');
  const r = await run(f);
  assert.equal(part(r, 'cliff_walk').class, 'fits', JSON.stringify(part(r, 'cliff_walk')));
  assert.equal(part(r, 'falls').class, 'fits', JSON.stringify(part(r, 'falls')));
  assert.ok((r.res.meta.waters ?? []).some((w) => w.kind === 'waterfall'));
  const rep = checkOf(f, r);
  assert.ok(!rep.findings.some((x) => /^M25/.test(x.rule)), rep.findings.filter((x) => /^M25/.test(x.rule)).map((x) => x.message).join('; '));
  assert.ok(rep.metrics.catwalks.per[0].ok);
});

test('survival (§6): nothing free, every cell paid, targets; the brackets and struts lie under the deck cells they carry (bottom up)', async () => {
  const s = hooks.survival({}, { kind: 'catwalk' });
  assert.deepEqual(s.free, []);
  assert.equal(s.path, 'targets');
  const r = await run(fx('valid', 'v7a_cw_cliff.json'));
  const m = r.res.meta.catwalks[0];
  for (const [x, y, z] of m.bracketCells) assert.ok(m.deckCells.some((q) => q[0] === x && q[2] === z && q[1] === y + 1), 'a bracket under a deck cell');
});

test('determinism: three checks give identical answers and artifact shas', async () => {
  const f = fx('valid', 'v7a_cw_cliff.json');
  const rs = [await run(f), await run(f), await run(f)];
  assert.ok(rs.every((r) => JSON.stringify(r.check) === JSON.stringify(rs[0].check)));
  assert.ok(rs.every((r) => r.artifactSha === rs[0].artifactSha));
});
