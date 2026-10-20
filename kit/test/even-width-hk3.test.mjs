// (housekeeping 3) The H batch's even-width rule beyond bridges: a rope bridge's deck and a tunnel's bore take an even width's extra
// column on the route's side (ropeGeom.mjs latOn: the route's footprint, region/passes/route.mjs footprintOf, puts it on +x / +z
// whichever way the path runs). Before, both used lateral(width) along rightOf(dir), so running +z or -x they stood one column off
// the walk that lands them, with no checker finding. fixtures/plan/even: each fixture runs both ways on both axes (its terrain
// transposed for the other axis) at its even widths; the deck's (the floor's) columns at the first and last row equal the walk
// footprint's there, the checker's rules are clean, and the movers cross.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stewardAnchors, checkPlanVolumes, flatSurvey, FIX } from './plan-helpers.mjs';
import { checkRegion, walkGraph, nodeReached } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { footprintOf } from '../lib/region/passes/route.mjs';

const fx = (re) => {
  const f = fs.readdirSync(path.join(FIX, 'even')).find((n) => re.test(n));
  return { name: f, ...JSON.parse(fs.readFileSync(path.join(FIX, 'even', f), 'utf8')) };
};

/** The fixture turned 90 degrees about its claim's origin (x - x0 <-> z - z0): its terrain and its anchors. */
function transposed(f) {
  const t = f.terrain, x0 = t.x0, z0 = t.z0;
  const terrain = { ...t, W: t.D, D: t.W, bands: t.bands.map((b) => ({ ...b, x0: x0 + (b.z0 - z0), x1: x0 + (b.z1 - z0), z0: z0 + (b.x0 - x0), z1: z0 + (b.x1 - x0) })) };
  const anchors = Object.fromEntries(Object.entries(f.anchors).map(([k, [x, y, z]]) => [k, [x0 + (z - z0), y, z0 + (x - x0)]]));
  return { terrain, anchors };
}

/** The four headings: the fixture's own and back, then transposed and back (the anchors swapped). */
function headings(f) {
  const [a, b] = f.plan.connectors[0].from.anchor ? [f.plan.connectors[0].from.anchor, f.plan.connectors[0].to.anchor] : [];
  const tr = transposed(f);
  const swap = (an) => ({ ...an, [a]: an[b], [b]: an[a] });
  return [
    { terrain: f.terrain, anchors: f.anchors },
    { terrain: f.terrain, anchors: swap(f.anchors) },
    { terrain: tr.terrain, anchors: tr.anchors },
    { terrain: tr.terrain, anchors: swap(tr.anchors) },
  ];
}

/** The lateral columns (x for a z run, z for an x run) of `cols` [[x, z]] on the row `i` cells along `dir` from `from`. */
function rowCols(cols, from, dir, i) {
  const [dx, dz] = dir, rx = from[0] + dx * i, rz = from[2] + dz * i;
  const on = cols.filter(([x, z]) => (dx ? x === rx : z === rz)).map(([x, z]) => (dx ? z : x));
  return [...new Set(on)].sort((p, q) => p - q);
}

async function run(f, h, width) {
  const s = flatSurvey(h.terrain);
  const plan = { ...f.plan, connectors: [{ ...f.plan.connectors[0], width }] };
  const r = await checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...h.anchors }, volume: {} });
  return { ...r, survey: s };
}

const walkFootprint = (r, width) => {
  const e = r.res.meta.route.edges.find((q) => q.ok);
  return footprintOf(e.path, width).map(([x, z]) => [x, z]);
};

test('a rope bridge of even width lands on its walk both ways on both axes (fixtures/plan/even/ew01): the deck on the footprint, M10:rope clean', async () => {
  const f = fx(/^ew01_/);
  const seen = new Set();
  for (const width of f.expect.widths) for (const h of headings(f)) {
    const r = await run(f, h, width);
    const a = r.check.parts.find((p) => p.part === f.expect.part);
    const rec = r.res.meta.ropes?.[0];
    const tag = `w${width} ${JSON.stringify(rec?.dir)}`;
    assert.equal(a.class, f.expect.class, `${tag}: ${JSON.stringify(a.reasons)}`);
    seen.add(`${rec.dir}`);
    const fp = walkFootprint(r, width), deck = rec.cells.map(([x, , z]) => [x, z]);
    for (const i of [1, rec.n]) assert.deepEqual(rowCols(deck, rec.from, rec.dir, i), rowCols(fp, rec.from, rec.dir, i), `${tag}: deck row ${i} on the walk's footprint`);
    // the landings' walk columns sit between the posts
    for (const end of ['near', 'far']) {
      const posts = rec.posts.filter((p) => p.end === end).map((p) => [p.x, p.z]);
      const at = end === 'near' ? 0 : rec.n + 1;
      const fpRow = rowCols(fp, rec.from, rec.dir, at), pr = rowCols(posts, rec.from, rec.dir, at);
      assert.deepEqual(pr, [fpRow[0] - 1, fpRow[fpRow.length - 1] + 1], `${tag}: the ${end} posts flank the walk`);
    }
    const rep = checkRegion({ ir: r.res.ir, survey: r.survey.bytes, blobs: r.res.blobs, meta: r.res.meta, volumes: [] });
    assert.deepEqual(rep.findings.filter((x) => /^M(3|6|8|10)(:|$)/.test(x.rule)).map((x) => `${x.rule} ${x.message}`), [], tag);
    const per = rep.metrics.ropes.per[0];
    assert.ok(per.ok && per.width === width, `${tag}: ${JSON.stringify(per)}`);
  }
  assert.equal(seen.size, 4, 'all four headings');
});

test('a tunnel of even width bores on its walk both ways on both axes (fixtures/plan/even/ew02): the floor on the footprint at both portals, M3/M4/M5/M6 clean, the movers through', async () => {
  const f = fx(/^ew02_/);
  const seen = new Set();
  for (const width of f.expect.widths) for (const h of headings(f)) {
    const r = await run(f, h, width);
    const a = r.check.parts.find((p) => p.part === f.expect.part);
    assert.equal(a.class, f.expect.class, `w${width}: ${JSON.stringify(a.reasons)}`);
    const rec = r.res.meta.tunnels[0];
    const dir = [Math.sign(rec.to[0] - rec.from[0]), Math.sign(rec.to[2] - rec.from[2])];
    const tag = `w${width} ${dir}`;
    seen.add(`${dir}`);
    const L = Math.abs(rec.to[0] - rec.from[0]) + Math.abs(rec.to[2] - rec.from[2]) - 1;
    const fp = walkFootprint(r, width), floor = rec.floor.map(([x, , z]) => [x, z]);
    for (const i of [1, L]) {
      const fl = rowCols(floor, rec.from, dir, i);
      assert.equal(fl.length, width, `${tag}: floor row ${i} is ${width} wide`);
      assert.deepEqual(fl, rowCols(fp, rec.from, dir, i), `${tag}: floor row ${i} on the walk's footprint`);
    }
    const rep = checkRegion({ ir: r.res.ir, survey: r.survey.bytes, blobs: r.res.blobs, meta: r.res.meta, volumes: r.volumes.map((v) => v.decoded) });
    assert.deepEqual(rep.findings.filter((x) => /^M(1|3|4|5|6|8)(:|$)/.test(x.rule)).map((x) => `${x.rule} ${x.message}`), [], tag);
    const vw = buildVirtual({ ir: r.res.ir, survey: r.survey.bytes, blobs: r.res.blobs, volumes: r.volumes.map((v) => v.decoded) }).vw;
    const g = walkGraph(vw, [[rec.from[0], rec.from[1] + 1, rec.from[2]]], { mover: 'player' });
    assert.ok(nodeReached(g, [rec.to[0], rec.to[1] + 1, rec.to[2]]), `${tag}: the player through the bore`);
  }
  assert.equal(seen.size, 4, 'all four headings');
});
