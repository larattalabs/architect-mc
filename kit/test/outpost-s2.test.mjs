// Slice S2 (docs/CONTRACT.md "Phase 6c slice S2"): the ice_outpost program on a synthetic ice-spike claim, and the kit fixes S2
// needed where W, T1, F1 and T2 meet (each with its broken variant):
//   - a keep set is a route obstacle at its kept columns, not its whole box (`_unsafe.keepBoxes`: T2's box rule, NO_ROUTE);
//   - a route's retaining column never stands on a kept column (`_unsafe.retainOnKept`: M1);
//   - the relief pass keeps the kept columns (`_unsafe.ignoreKeep`: M1);
//   - the route's grade quantum keeps every 8-cell window within floor(maxGrade * 8) (`_unsafe.coarseGrade`: M2:grade at 0.2);
//   - lightCover drafts a plan with side blobs as format 2 (`_format1`: the IR throws).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { FLAG_WATER, makeColumns, encodeColumns } from '../lib/region/pack.mjs';
import { region } from '../lib/region/program.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { VC, decodeArvx, encodeArvx } from '../lib/region/volume.mjs';
import { lightCover } from '../lib/region/light.mjs';
import { fixtureFor } from '../lib/region/fixtures.mjs';
import { windowGrade } from '../lib/region/passes/route.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = 64; // the land's top (snow-covered soil)

/**
 * A synthetic ice-spike claim W x D: land at G, frozen sea (water, ice at its top) where `sea(x, z)`, natural spikes (ICE from
 * the ground to G + h, the survey's ground at the spike's tip, as the plan survey reads a spike) and flat ice patches (one ICE
 * cell at the ground). Returns {survey (columns), volumeFor(box) -> volume input}.
 */
function iceWorld(W, D, { spikes = [], patches = [], sea = () => false, slope = null } = {}) {
  const c = makeColumns(0, 0, W, D, 1);
  const spikeAt = new Map(spikes.map(([x, z, h]) => [`${x},${z}`, h]));
  const patch = new Set(patches.map(([x, z]) => `${x},${z}`));
  const land = (x, z) => (slope ? slope(x, z) : G);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const i = x + z * W, k = `${x},${z}`;
    if (sea(x, z)) { c.ground[i] = 62; c.height[i] = 62; c.floor[i] = 52; c.flags[i] = FLAG_WATER; continue; }
    const g = land(x, z), h = spikeAt.get(k);
    c.ground[i] = h ? g + h : g; c.height[i] = c.ground[i]; c.floor[i] = c.ground[i];
  }
  const volumeFor = (box) => {
    const BW = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, BD = box.maxZ - box.minZ + 1;
    const cl = new Uint8Array(BW * H * BD);
    for (let x = 0; x < BW; x++) for (let z = 0; z < BD; z++) for (let y = 0; y < H; y++) {
      const X = box.minX + x, Z = box.minZ + z, Y = box.minY + y, k = `${X},${Z}`;
      let cls = VC.AIR;
      if (sea(X, Z)) cls = Y < 52 ? VC.ROCK : Y < 62 ? VC.WATER : Y === 62 ? VC.ICE : VC.AIR;
      else {
        const g = land(X, Z), h = spikeAt.get(k) ?? 0;
        if (Y < g - 3) cls = VC.ROCK;
        else if (Y < g) cls = VC.SOIL;
        else if (Y === g) cls = patch.has(k) ? VC.ICE : VC.SNOW;
        else if (h && Y <= g + h) cls = VC.ICE;
      }
      cl[(x * BD + z) * H + y] = cls;
    }
    const bytes = encodeArvx(box, cl), decoded = decodeArvx(bytes);
    return { sha: decoded.sha, box, bytes, decoded };
  };
  return { survey: c, volumeFor };
}

const claimOf = (W, D) => ({ minX: 0, minZ: 0, maxX: W - 1, maxZ: D - 1, minY: -64, maxY: 319 });

/** The two-plan flow: plan, read the volume it asks for, plan again with it. Returns {p, rep, vol}. */
async function plan2(opts, world) {
  const base = { programSource: 'x', survey: encodeColumns(world.survey), claim: claimOf(world.survey.width, world.survey.depth), seed: '11', ...opts };
  const p0 = await planRegion(base);
  const vols = (p0.needVolumes ?? []).map((b) => world.volumeFor(b));
  const p = await planRegion({ ...base, volumes: vols });
  const rep = checkRegion({ ir: p.ir, survey: encodeColumns(world.survey), blobs: (sha) => p.blobs.get(sha), volumes: vols.map((v) => v.decoded), meta: p.meta });
  return { p, rep, vols };
}
const keepBox = (W, D) => ({ minX: 0, minZ: 0, maxX: W - 1, maxZ: D - 1, minY: 40, maxY: 110 });
const findings = (rep, re) => rep.findings.filter((f) => re.test(f.rule));

// A wall of spikes across the claim at x 40..42 with a gap at z 32..34 and a land that steps by 1 (so the walk is graded columns,
// not a ground road): a route from the west to the east goes through the gap 3 wide, its footprint's edges beside the spikes'
// columns on each side (their retaining-column candidates).
const wallWorld = () => {
  const spikes = [];
  for (let z = 4; z < 60; z++) if (z < 32 || z > 34) for (const x of [40, 41, 42]) spikes.push([x, z, 14]);
  return iceWorld(80, 64, { spikes, slope: (x, z) => G + ((x * 7 + z * 3) % 5 === 0 ? 1 : 0) });
};
const routeProg = (unsafe = {}) => ({ id: 's2_route', passes: ['route'], default: (ctx) => {
  const r = region(ctx);
  r.stages(['ground']);
  r.keepNatural('ICE', keepBox(80, 64), { stage: 'ground' });
  r.pass('route', { nodes: { a: { at: [8, G + 1, 33] }, b: { at: [72, G + 1, 33] } }, edges: [{ id: 'ab', from: 'a', to: 'b' }], maxGrade: 0.25, _unsafe: unsafe });
  r.anchor('entrance', [8, G + 1, 33]); r.anchor('spawn', [8, G + 1, 33]);
  return r;
} });

test('S2: a keep set is a route obstacle at its kept columns (broken: the whole box gives NO_ROUTE)', async () => {
  const w = wallWorld();
  const { p, rep } = await plan2({ program: routeProg() }, w);
  const e = p.meta.route.edges[0];
  assert.ok(e.ok, `routed through the gap: ${e.failed}`);
  for (const [x, , z] of e.path) assert.ok(!(x >= 40 && x <= 42 && (z < 32 || z > 34)), `the walk keeps off the spikes (${x},${z})`);
  assert.equal(findings(rep, /^M1$/).length, 0, JSON.stringify(findings(rep, /^M1$/)));
  assert.equal(rep.metrics.keep.written, 0);
  const broken = await plan2({ program: routeProg({ keepBoxes: true }) }, w);
  assert.equal(broken.p.meta.route.edges[0].ok, false, 'the whole keep box blocks every column');
});

test('S2: no retaining column on a kept column (broken: retainOnKept writes into the spikes, M1)', async () => {
  const w = wallWorld();
  const { rep } = await plan2({ program: routeProg() }, w);
  assert.equal(rep.metrics.keep.written, 0);
  const broken = await plan2({ program: routeProg({ retainOnKept: true }) }, w);
  assert.ok(broken.rep.metrics.keep.written > 0, 'a retaining column beside the gap stands on a spike');
  assert.ok(findings(broken.rep, /^M1$/).length > 0);
});

test('S2: the relief keeps the kept columns, a wall to the blend (broken: ignoreKeep cuts a spike, M1)', async () => {
  // a pad 2 lower than the land with a spike and an ice patch inside the blend's radius
  const w = iceWorld(64, 64, { spikes: [[40, 30, 12], [41, 30, 12]], patches: [[30, 42], [31, 42]] });
  const prog = (unsafe) => ({ id: 's2_relief', passes: ['relief'], default: (ctx) => {
    const r = region(ctx);
    r.stages(['ground', 'lots']);
    r.keepNatural('ICE', keepBox(64, 64), { stage: 'ground' });
    const lot = r.part('pads', { stage: 'ground' }).lot('a', { at: [26, 26], size: [9, 9], floor: G - 1, stage: 'lots', pad: { edge: 'blend', maxCut: 4, maxFill: 4 } });
    r.pass('relief', { around: [lot], radius: 10, maxCut: 4, maxFill: 4, _unsafe: unsafe });
    r.anchor('entrance', [30, G, 25]); r.anchor('spawn', [30, G, 25]);
    return r;
  } });
  const { p, rep } = await plan2({ program: prog({}) }, w);
  assert.equal(rep.metrics.keep.written, 0, JSON.stringify(findings(rep, /^M1$/)));
  assert.ok(p.meta.passes?.length || p.ir.parts.some((q) => q.id === 'relief'), 'the relief ran');
  const broken = await plan2({ program: prog({ ignoreKeep: true }) }, w);
  assert.ok(broken.rep.metrics.keep.written > 0, 'without the keep the blend cuts the spike and fills over the patch');
});

test('S2: the route grade quantum keeps every 8-cell window within floor(maxGrade * 8) (broken: coarseGrade rises 2 at 0.2)', async () => {
  // a long rise of 1 in 6 (under 0.2 a cell, over 1 in 8): at the old 3/16 quantum the route follows the land and some windows rise 2
  const w = iceWorld(120, 40, { slope: (x) => G + Math.floor(x / 6) });
  const prog = (unsafe) => ({ id: 's2_grade', passes: ['route'], default: (ctx) => {
    const r = region(ctx);
    r.stages(['ground']);
    r.pass('route', { nodes: { a: { at: [6, G + 2, 20] }, b: { at: [112, G + 19, 20] } }, edges: [{ id: 'ab', from: 'a', to: 'b', width: 1 }], maxGrade: 0.2, stairs: false, _unsafe: unsafe });
    r.anchor('entrance', [6, G + 2, 20]); r.anchor('spawn', [6, G + 2, 20]);
    return r;
  } });
  const bad = (p) => p.meta.route.edges.filter((e) => e.ok).flatMap((e) => e.segments.filter((g) => g.kind === 'walk' && !g.shared).map((g) => windowGrade(e.path.slice(g.from, g.to + 1).map((q) => q[1]), 0.2).bad)).reduce((a, b) => a + b, 0);
  const { p, rep } = await plan2({ program: prog({}) }, w);
  assert.ok(p.meta.route.edges[0].ok, p.meta.route.edges[0].failed);
  assert.equal(bad(p), 0);
  assert.equal(findings(rep, /^M2:grade$/).length, 0);
  const broken = await plan2({ program: prog({ coarseGrade: true }) }, w);
  assert.ok(bad(broken.p) > 0, 'the old quantum rises 2 over some 8-cell window at 0.2');
  assert.ok(findings(broken.rep, /^M2:grade$/).length > 0);
  // at 0.25 both quanta are 4/16: the same route (no earlier plan moves)
  const at25 = (unsafe) => ({ ...prog(unsafe), default: (ctx) => { const r = region(ctx); r.stages(['ground']); r.pass('route', { nodes: { a: { at: [6, G + 2, 20] }, b: { at: [112, G + 19, 20] } }, edges: [{ id: 'ab', from: 'a', to: 'b', width: 1 }], maxGrade: 0.25, stairs: false, _unsafe: unsafe }); r.anchor('entrance', [6, G + 2, 20]); r.anchor('spawn', [6, G + 2, 20]); return r; } });
  const a = await plan2({ program: at25({}) }, w), b = await plan2({ program: at25({ coarseGrade: true }) }, w);
  assert.equal(a.p.irSha, b.p.irSha);
});

test('S2: lightCover over a plan with side blobs (a relief field, a frozen volume) drafts format 2 (broken: _format1 throws)', async () => {
  const w = iceWorld(64, 64, { spikes: [[50, 50, 10]] });
  const prog = (format1) => ({ id: 's2_light', passes: ['relief'], default: (ctx) => {
    const r = region(ctx);
    r.stages(['ground', 'props', 'lots']);
    r.keepNatural('ICE', keepBox(64, 64), { stage: 'ground' });
    const lot = r.part('pads', { stage: 'ground' }).lot('a', { at: [20, 20], size: [9, 9], stage: 'lots', pad: { edge: 'blend', maxCut: 4, maxFill: 4 } });
    r.pass('relief', { around: [lot], radius: 6 });
    r.anchor('entrance', [24, G + 1, 18]); r.anchor('spawn', [24, G + 1, 18]);
    if (r.needVolume(keepBox(64, 64))) lightCover(r, { fixture: fixtureFor('minecraft:soul_lantern', 'minecraft:spruce_fence'), stage: 'props', part: 'lamps', _format1: format1 });
    return r;
  } });
  const { p } = await plan2({ program: prog(false) }, w);
  assert.ok(p.ir.parts.some((q) => q.id === 'lamps'), 'lamps planned');
  await assert.rejects(() => plan2({ program: prog(true) }, w), /side blobs need format 2/);
});

test('S2: ice_outpost on a synthetic ice-spike claim: lots on the dry ice-free land, every lot routed, 0 kept cells written, no M1-M4, M17 0', async () => {
  // land in the west two thirds with natural spikes on a grid and ice patches, a frozen sea in the east third
  const spikes = [], patches = [];
  for (let x = 20; x < 100; x += 26) for (let z = 18; z < 140; z += 28) { spikes.push([x, z, 18], [x + 1, z, 16], [x, z + 1, 15]); patches.push([x + 6, z + 9]); }
  const w = iceWorld(150, 150, { spikes, patches, sea: (x) => x >= 110 });
  const prog = { programFile: path.join(KIT, 'regions', 'ice_outpost.mjs'), params: { minLots: 1 } };
  const { p, rep } = await plan2(prog, w);
  const o = p.meta.outpost;
  assert.ok(o.lots.length >= 6, `lots ${o.lots.length}: ${JSON.stringify(o.unplaced)}`);
  for (const l of o.lots) {
    assert.ok(l.at[0] + l.size[0] + 1 < 110, `${l.id} is on the land, off the frozen sea`);
    for (const [sx, sz] of spikes) assert.ok(!(sx >= l.at[0] - 1 && sx <= l.at[0] + l.size[0] && sz >= l.at[1] - 1 && sz <= l.at[1] + l.size[1]), `${l.id}'s footprint and apron hold no spike`);
  }
  assert.ok(p.meta.route.edges.every((e) => e.ok), JSON.stringify(p.meta.route.edges.map((e) => [e.id, e.failed])));
  assert.equal(rep.errors, 0, JSON.stringify(rep.findings.filter((f) => f.severity === 'error')));
  assert.equal(findings(rep, /^M[1-4]/).length, 0, JSON.stringify(findings(rep, /^M[1-4]/)));
  assert.equal(rep.metrics.keep.written, 0);
  assert.equal(rep.metrics.M17.melting, 0);
  assert.ok(rep.metrics.M5.share < 0.01, `M5 ${rep.metrics.M5.share} ${JSON.stringify(findings(rep, /^M5$/)[0]?.sample)} lamps ${JSON.stringify(o.lamps)}`);
  // the light: soul lanterns (10) even when the bible's light is a lantern (15: it would melt the ice)
  const bright = await plan2({ ...prog, roles: { light: 'minecraft:lantern' } }, w);
  assert.ok(bright.p.notes.some((n) => /melts ice over 10: soul lanterns instead/.test(n)));
  assert.equal(bright.rep.metrics.M17.melting, 0);
  // deterministic
  const again = await plan2(prog, w);
  assert.equal(again.p.irSha, p.irSha);
});
