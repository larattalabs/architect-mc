// (6c H) Slice H-b's items of the H gate (tools/gate6ch.mjs): wet structures: wet piers, harbour walls, quays, the street fallback with
// wet piers (docs/CONTRACT.md "Phase 6c slice H" §14 items 5, 8, 9 for wet structures, 11's re-answered fixtures, 19's wet shots). H-b
// owns this file. Each step name (unit, ingame, crash, probe, natural, cold, look) maps to a list of items {name, run(ctx)}, run after
// H-core's in that step; ctx = {L (tools/lib/run6b.mjs), OUT, KIT, imp (a kit module), json, root, check, log}.
//
//   unit     hb-kit         the kit's H-b tests (h-wet: wetColumn, the wet piers, v46-v48 and the hb_ fixtures through the two-plan
//                           flow, the broken variants, determinism, no `until` H in kit/), T3a's and K1a's plan tests (r06/r07 re-answered,
//                           r06b and k1a_r01 WATER deep)
//            hb-unchanged   item 11: every committed valid/, K1 and T3 fixture without an H part plans as on origin/main but exactly the
//                           named re-answers (t3a/r06_water_arch, t3a/r07_water_rope, refused/k1a_r01_wall_water)
//            hb-asks        §13: no recorded part of the 59 asks takes a wet fallback, and none answers WATER with `until`
//   ingame   hb-flat        items 5, 8, 9 on a flat world (headless, exact rules): a lake made with /fill (natural water to the survey),
//                           a beam on wet piers across it, a quay on its shore and a harbour wall (the claim's edge ring through the
//                           lake) through Regions.checkPlan (the two-plan flow) and realiseApproved; re-read from the world (piers 2
//                           into the bed, no air or waterlogged state under the surface, the quay's deck solid to the bed, its steps,
//                           M5 on the deck, the wall's closure and height over the surface); vanilla villagers across the beam and
//                           onto the quay both ways; Regions.remove: E-flat 0 with fluid cells compared by state
//   natural  hb-natural     S3 (headless, exact rules): a quay on the water, and S3's river under a forced beam (it fits on wet
//                           piers where the river is shallow enough, else WATER deep, no `until`, recorded); E-normal: 0 unclassified,
//                           0 gravity, no classified mismatch within 6 of a wet write but growth or grazed at an unwritten cell
//   cold     hb-cold        S7's rejected frozen site 2026101102 (headless, exact rules): a beam on wet piers through the frozen river
//                           (the ice and the water under it replaced), villagers across, the undo exact (the ice restored)
//   look     hb-look        item 19 (client, recorded not judged): wet piers, a harbour wall and a quay in three bibles
//
// Run H-b's items on their own: `node tools/gate6chb.mjs <step> [item ...]` (the same context; the verifier's re-runs of the undo
// and villager items: ingame, natural, cold). Through `node tools/gate6ch.mjs <step>` they run after H-core's and H-a's items.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const OWNER = 'test:hb';
const FLAT = 'G6B Flat Base', BASE = 'G6B Seed Base', FROZEN_SEED = '2026101102';
const FLAT0 = [6400, 6600]; // the flat claim's corner (96 x 96)
const FROZEN_CLAIM = [4168, 1480, 4279, 1591];
const EXPECTED_CHANGES = ['refused/k1a_r01_wall_water.json', 't3a/r06_water_arch.json', 't3a/r07_water_rope.json'];
const LOOK_BIBLES = [null, 'g7ak1_infernal', 'g7ak1_coastal'];
const j = (o) => JSON.stringify(o).replaceAll(' ', '');

function nodeTest(root, files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}

// ------------------------------------------------------------------ unit

async function hbKit(ctx) {
  const r = nodeTest(ctx.root, ['kit/test/h-wet.test.mjs', 'kit/test/plan-t3a.test.mjs', 'kit/test/bridge-t3a.test.mjs', 'kit/test/plan-k1a.test.mjs']);
  ctx.check(r.code === 0 && r.fail === 0 && r.pass >= 30, `items 1, 8, 11 (kit, H-b): wetColumn, the wet piers, v46 quay, v47 wet beam, v48 harbour wall and the hb_ fixtures through the two-plan flow, the checker clean on each, the broken variants caught (M25:wet), determinism, no until H in kit/; T3a's and K1a's plan tests (r06/r07 fit on wet piers, r06b and k1a_r01 WATER deep): ${r.pass} pass, ${r.fail} fail`, r.failing);
  return r;
}

async function hbUnchanged(ctx) {
  const { unchanged } = await import('./gate6ch-core.mjs');
  const u = await unchanged(ctx.root);
  const differ = u.differ.map(([k]) => k).sort();
  ctx.check(u.n >= 40 && differ.join() === [...EXPECTED_CHANGES].sort().join(), `item 11 (H-b): ${u.same} of ${u.n} committed valid/, K1 and T3 fixtures without an H part plan as on origin/main ${u.mainHead.slice(0, 10)}; the ones that differ are exactly the named re-answers (${differ.join(', ') || 'none'})`, u.differ);
  return { same: u.same, n: u.n, differ };
}

async function hbAsks(ctx) {
  const H = await import(path.join(ctx.KIT, 'test', 'plan-helpers.mjs'));
  const dir = path.join(ctx.KIT, 'test', 'fixtures', 'plan', 'asks');
  const s = H.asksSurvey();
  const out = { plans: 0, wet: [], water: [] };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json').sort()) {
    const plan = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).answer.plan;
    const r = await H.checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: H.stewardAnchors(s.claim), volume: {} });
    out.plans++;
    if ((r.first.res.meta?.wet ?? []).length) out.wet.push(f);
    for (const a of r.check.parts) if (a.reasons?.some((q) => q.code === 'WATER' || q.until === 'H')) out.water.push(`${f}/${a.part}: ${a.reasons.map((q) => `${q.code}${q.until ? ` until ${q.until}` : ''}`).join(', ')}`);
  }
  ctx.check(out.plans >= 59 && !out.water.some((w) => / until H$/.test(w)), `§13 (H-b): over the ${out.plans} recorded plans no answer carries until H; recorded parts answering WATER: ${out.water.length ? out.water.join('; ') : 'none'}; parts taking the wet fallback: ${out.wet.length ? out.wet.join(', ') : 'none'} (expected none: no recorded wall, street, road or path refused WATER before)`);
  return out;
}

// ------------------------------------------------------------------ in game: helpers

const surveyOf = async (ctx, claim, tag) => {
  const { L, OUT } = ctx;
  const file = path.join(OUT, `hb-${tag}-survey.bin`);
  await L.call('dev.region.survey', { claim, surveyLoad: 'bounded:256', file }, 600_000);
  const { surveyApi } = await ctx.imp('lib/region/survey.mjs');
  const bytes = fs.readFileSync(file);
  return { S: surveyApi(bytes, { minX: claim[0], minZ: claim[1], maxX: claim[2], maxZ: claim[3], minY: -64, maxY: 319 }), bytes };
};

/**
 * The straight crossings of the claim's water a beam needs a pier in: the dry search refuses them WATER (a pier needed in water), the
 * wet one stands piers there (waterDepth 8). Best first: the fewest wet cells, then the shortest, then the claim's centre. Returns
 * [{a, b, dir, n, rise, wet, deep?}] (a, b: anchors 8 past the landings on the line), and the deepest-only candidates for the record.
 */
async function wetCrossings(ctx, S, claim) {
  const { checkBridge, surveyLand } = await ctx.imp('lib/connectors/bridgeGeom.mjs');
  const m = 10;
  const land = surveyLand(S, { blocked: (x, z) => x < claim[0] + m || z < claim[1] + m || x > claim[2] - m || z > claim[3] - m });
  const ok = [], deep = [];
  const cx = (claim[0] + claim[2]) >> 1, cz = (claim[1] + claim[3]) >> 1;
  for (const [dx, dz] of [[1, 0], [0, 1]]) for (let x = claim[0] + m; x <= claim[2] - m; x++) for (let z = claim[1] + m; z <= claim[3] - m; z++) {
    if (S.waterAt(x, z) || !S.waterAt(x + dx, z + dz)) continue;
    for (let n = 9; n <= 32; n++) {
      const fx = x + dx * (n + 1), fz = z + dz * (n + 1);
      if (fx > claim[2] - m || fz > claim[3] - m) break;
      if (S.waterAt(fx, fz)) continue;
      const g0 = S.groundAt(x, z), g1 = S.groundAt(fx, fz);
      // (the landings at their ground, or level on the walk's fill up to 4 over the higher bank, as the route's are)
      const tries = [[g0, g1 - g0]];
      for (let k = 0; k <= 4; k++) tries.push([Math.max(g0, g1) + k, 0]);
      let done = false;
      for (const [y0, rise] of tries) {
        const dry = checkBridge(land, [x, y0, z], [dx, dz], n, rise, 3, { form: 'beam' });
        if (dry.ok || dry.code !== 'WATER') continue;
        const wet = checkBridge(land, [x, y0, z], [dx, dz], n, rise, 3, { form: 'beam', wet: { waterDepth: 8, floorAt: S.floorAt, vols: [] } });
        const a = [x - dx * 8, S.groundAt(x - dx * 8, z - dz * 8) + 1, z - dz * 8], b = [fx + dx * 8, S.groundAt(fx + dx * 8, fz + dz * 8) + 1, fz + dz * 8];
        const rec = { a, b, dir: [dx, dz], n, rise, from: [x, y0, z] };
        if (wet.ok) { ok.push({ ...rec, wet: wet.piers.reduce((t, p) => t + (p.wet ?? 0), 0), d: Math.abs(x - cx) + Math.abs(z - cz) }); done = true; break; }
        if (wet.code === 'WATER' && !deep.some((q) => q.from[0] === x && q.from[2] === z)) deep.push({ ...rec, kind: wet.evidence.kind, depth: wet.evidence.depth ?? null });
      }
      void done;
      break;
    }
  }
  // (the most wet pier cells first: a crossing that shows piers standing in the water, not a sliver of it; then the lowest landing)
  ok.sort((p, q) => q.wet - p.wet || p.from[1] - q.from[1] || p.n - q.n || p.d - q.d || p.from[0] - q.from[0] || p.from[2] - q.from[2]);
  return { ok, deep };
}

const keyOf = (x, y, z) => `${x},${y},${z}`;

/** The realised world's re-reads (the T3a gate's: the plan's IR and meta over the before and after dumps), with the checker's report. */
async function realisedOf(ctx, planDir, beforeFile, afterFile) {
  const { buildVirtual, decodeArwd, dumpWorld } = await ctx.imp('lib/region/vworld.mjs');
  const { checkRegion } = await ctx.imp('lib/region/check.mjs');
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs });
  const before = await decodeArwd(fs.readFileSync(beforeFile)), after = await decodeArwd(fs.readFileSync(afterFile));
  const world = dumpWorld(before, after, ir.claim, { virtual: vw, lots: ir.lots });
  const rep = checkRegion({ ir, meta, world, prefix: false, blobs });
  const written = new Set();
  vw.eachWritten((x, y, z) => written.add(keyOf(x, y, z)));
  return { ir, meta, world, rep, before, after, written };
}

const stateAt = (d, x, y, z) => (x < d.box.minX || x > d.box.maxX || y < d.box.minY || y > d.box.maxY || z < d.box.minZ || z > d.box.maxZ ? null : d.palette[d.cells[d.at(x, y, z)]]);
const nameOf = (s) => String(s ?? '').replace(/\[.*$/, '');
const isWater = (s) => /^minecraft:water/.test(String(s)) || /waterlogged=true/.test(String(s)) || /^minecraft:(kelp|kelp_plant|seagrass|tall_seagrass|bubble_column)$/.test(nameOf(s));

/**
 * Item 8's re-read of the wet writes from the world: every cell of each wet record's columns that held water (or ice) before is now
 * the written block: never air, never water, never a waterlogged or non-full state; and nothing in the column under the surface is
 * left air.
 */
function wetReread(R) {
  const out = { records: 0, cells: 0, air: 0, water: 0, waterlogged: 0, sample: [] };
  for (const w of R.meta.wet ?? []) {
    out.records++;
    for (const [x, z, y0, y1] of w.columns) for (let y = y0; y <= y1; y++) {
      const b = stateAt(R.before, x, y, z), a = stateAt(R.after, x, y, z);
      if (b === null || !(isWater(b) || /(^|:)(ice|packed_ice|blue_ice)$/.test(nameOf(b)))) continue;
      out.cells++;
      if (nameOf(a) === 'minecraft:air') { out.air++; if (out.sample.length < 8) out.sample.push([x, y, z, b, a]); }
      else if (/^minecraft:water/.test(String(a))) { out.water++; if (out.sample.length < 8) out.sample.push([x, y, z, b, a]); }
      else if (/waterlogged=true/.test(String(a))) { out.waterlogged++; if (out.sample.length < 8) out.sample.push([x, y, z, b, a]); }
    }
  }
  return out;
}

/** Vanilla's villager both ways between two feet cells. */
async function navBoth(ctx, a, b) {
  const ab = await ctx.L.call('dev.nav.villager', { from: a, to: b, range: 256 }, 120_000);
  const ba = await ctx.L.call('dev.nav.villager', { from: b, to: a, range: 256 }, 120_000);
  return { there: !!ab.canReach, back: !!ba.canReach, nodes: [ab.nodes ?? null, ba.nodes ?? null] };
}

/**
 * One wet run: the plan through Regions.checkPlan (the two-plan flow reads the water's volumes; READY), realised from its approved
 * artifact under the given rules, re-read from the world, crossed by vanilla villagers, removed by its owner, the box compared with
 * its snapshot. `kind` 'flat' judges E-flat 0 (fluid cells by state); else E-normal, classified, with the wet-write rule (no classified
 * mismatch within 6 of a wet write but growth or grazed at an unwritten cell, never gravity).
 */
async function wetRun(ctx, tag, { claim, plan, anchors, kind, bible = null, expect = {} }) {
  const { L, OUT, check, log } = ctx;
  const out = { claim, kind };
  const cx = (claim[0] + claim[2]) / 2, cz = (claim[1] + claim[3]) / 2;
  await L.tp(cx, 200, cz);
  await L.call('dev.waitChunks', { timeoutMs: 120_000 }, 180_000).catch(() => null);
  const c = await L.call('dev.region.checkPlan', { plan, claim, owner: OWNER, anchors, load: 'generate', ...(bible ? { bible } : {}) }, 900_000);
  out.check = { overall: c.check?.overall ?? null, refused: c.refused ?? null, parts: (c.check?.parts ?? []).map((a) => ({ part: a.part, class: a.class, reasons: a.reasons, geometry: a.geometry })), notes: c.check?.notes ?? null, guards: (c.check?.guards ?? []).length };
  fs.writeFileSync(path.join(OUT, `hb-${tag}-check.json`), `${JSON.stringify(c, null, 1)}\n`);
  for (const [id, cls] of Object.entries(expect.classes ?? {})) {
    const a = out.check.parts.find((q) => q.part === id);
    check(a && (Array.isArray(cls) ? cls.includes(a.class) : a.class === cls), `${tag}: ${id} answers ${Array.isArray(cls) ? cls.join(' or ') : cls} through Regions.checkPlan's two-plan flow (${a ? `${a.class}${a.reasons?.length ? ` ${a.reasons.map((q) => `${q.code}${q.evidence?.kind ? ` ${q.evidence.kind}` : ''}${q.until ? ` until ${q.until}` : ''}`).join(', ')}` : ''}` : 'missing'})`);
  }
  for (const a of out.check.parts) for (const q of a.reasons ?? []) check(q.until !== 'H', `${tag}: ${a.part} carries no until H`);
  if (!c.check?.artifactSha || !['READY', 'NEEDS_REPAIR'].includes(c.check?.overall) || !out.check.parts.some((a) => ['fits', 'adjusted'].includes(a.class))) {
    check(false, `${tag}: no approvable artifact (${out.check.overall}; ${j(out.check.parts.map((a) => [a.part, a.class]))})`);
    return out;
  }
  // the box: the claim and 8 round it, from 8 under the deepest bed to 24 over the highest ground
  const sv = await surveyOf(ctx, claim, `${tag}-box`);
  let y0 = 320, y1 = -64;
  for (let x = claim[0]; x <= claim[2]; x += 2) for (let z = claim[1]; z <= claim[3]; z += 2) { y0 = Math.min(y0, sv.S.floorAt(x, z)); y1 = Math.max(y1, sv.S.groundAt(x, z)); }
  const box = [claim[0] - 8, Math.max(-64, y0 - 8), claim[1] - 8, claim[2] + 8, Math.min(319, y1 + 24), claim[3] + 8];
  out.box = box;
  await L.cmd('/kill @e[type=!minecraft:player]');
  await L.settle(kind === 'flat' ? 5000 : 60_000);
  const before = path.join(OUT, `hb-${tag}-before.arwd.gz`), after = path.join(OUT, `hb-${tag}-after.arwd.gz`), snapF = path.join(OUT, `hb-${tag}-snap.gz`);
  await L.call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  const snap = await L.call('dev.region.hash', { box, mode: 'snap', file: snapF }, 4 * 3_600_000);
  const rr = await L.call('dev.region.realiseApproved', { sha: c.check.artifactSha }, 300_000);
  if (rr.refused) { check(false, `${tag}: realiseApproved refused (${j(rr.refused)})`); return out; }
  const st = await L.waitRegion(rr.region, 3 * 3_600_000, async (s) => { if (s.waiting?.OCCUPIED) await L.cmd('/kill @e[type=!minecraft:player]'); });
  out.realise = { region: rr.region, state: st.view.state, cells: st.record?.cellsWritten ?? st.view.cellsWritten, planId: st.view.planId };
  check(st.view.state === 'PLACED', `${tag}: realised from the approved artifact (${st.view.state}, ${out.realise.cells} cells written)`);
  await L.settle(5000);
  await L.call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  const planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', st.view.planId);
  const R = await realisedOf(ctx, planDir, before, after);
  out.items = await item8(ctx, tag, R, expect);
  // item 9: vanilla villagers across every bridge and onto every quay, both ways
  await L.cmd('/kill @e[type=!minecraft:player]');
  out.nav = {};
  for (const q of R.meta.bridges ?? []) out.nav[q.id] = await navBoth(ctx, [q.from[0], q.from[1] + 1, q.from[2]], [q.to[0], q.to[1] + 1, q.to[2]]);
  for (const q of R.meta.quays ?? []) {
    // from the bank's middle to the quay's step down to the water (its exit, on the water's edge), and back
    const [hx, hz] = q.heading, mid = [Math.floor((q.along[0][0] + q.along[1][0]) / 2), Math.floor((q.along[0][2] + q.along[1][2]) / 2)];
    // (the bank row's middle cell, beside the deck)
    const bank = [mid[0] - hx, sv.S.groundAt(mid[0] - hx, mid[1] - hz) + 1, mid[1] - hz];
    const far = [q.steps[0][0], q.steps[0][1] + 1, q.steps[0][2]];
    out.nav[q.id] = await navBoth(ctx, bank, far);
  }
  check(Object.keys(out.nav).length >= (expect.navMin ?? 1) && Object.values(out.nav).every((v) => v.there && v.back), `item 9 (${tag}, the hard bar): vanilla dev.nav.villager across every wet beam and onto every quay, both ways (${j(Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, [v.there, v.back]])))})`);
  // item 5: the removal by its owner, a settle, the box against its snapshot
  await L.cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  const rm = await L.call('dev.region.remove', { region: rr.region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(15_000);
  const diff = await L.call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
  const cells = (box[3] - box[0] + 1) * (box[4] - box[1] + 1) * (box[5] - box[2] + 1);
  out.exact = { kind: kind === 'flat' ? 'E-flat' : 'E-normal', box, cells, snapCells: snap.cells, removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, list: (diff.list ?? []).slice(0, 200) };
  out.journal = { written: out.realise.cells, restored: rm.restored, perPart: Object.fromEntries((R.meta.wet ?? []).map((w) => [w.id, w.columns.reduce((t, q) => t + q[3] - q[2] + 1, 0)])) };
  fs.writeFileSync(path.join(OUT, `hb-${tag}-exact.json`), `${JSON.stringify({ ...out.exact, list: diff.list ?? [] }, null, 2)}\n`);
  if (kind === 'flat') check(rm.removed && diff.mismatches === 0, `item 5 (${tag}): Regions.remove restores the box exactly, fluid cells by state: E-flat ${diff.mismatches} (${rm.restored} cells restored; ${out.realise.cells} written)`);
  else {
    // the wet-write rule: within 6 (3D) of any wet write, only growth or grazed at a cell the plan never wrote; gravity never
    const wetCells = [];
    for (const w of R.meta.wet ?? []) for (const [x, z, a, b] of w.columns) for (let y = a; y <= b; y++) wetCells.push([x, y, z]);
    const near = (x, y, z) => wetCells.some((q) => Math.max(Math.abs(q[0] - x), Math.abs(q[1] - y), Math.abs(q[2] - z)) <= 6);
    // (the scenario's own world class for fluids, H's narrowed T1 `flow`: a water or lava cell that moved at a cell the plan never wrote,
    // more than 6 columns from every written column; the classifier's `none` there is that)
    const cols = new Set([...R.written].map((k) => { const [x, , z] = k.split(','); return `${x},${z}`; }));
    const farCol = (x, z) => { for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) if (cols.has(`${x + dx},${z + dz}`)) return false; return true; };
    const fluidRe = /^minecraft:(water|lava)(\[|$)/;
    let flow = 0;
    for (const mm of diff.list ?? []) {
      const [x, y, z] = String(mm.pos).split(',').map(Number);
      if (mm.class === 'none' && (fluidRe.test(mm.was) || fluidRe.test(mm.now)) && !R.written.has(keyOf(x, y, z)) && farCol(x, z)) { mm.class = 'flow'; flow++; }
    }
    if (flow && diff.classes) { diff.classes.none -= flow; diff.classes.flow = (diff.classes.flow ?? 0) + flow; }
    const bad = [];
    for (const mm of diff.list ?? []) {
      const [x, y, z] = String(mm.pos).split(',').map(Number);
      if (!near(x, y, z)) continue;
      if (!(['growth', 'grazed'].includes(mm.class) && !R.written.has(keyOf(x, y, z)))) bad.push(mm);
    }
    const none = diff.classes ? diff.classes.none ?? 0 : diff.mismatches;
    out.exact.nearWet = bad.length;
    check(rm.removed && none === 0 && (diff.classes?.gravity ?? 0) === 0 && bad.length === 0 && (diff.list ?? []).length === diff.mismatches, `item 5 (${tag}): the removal's E-normal: ${diff.mismatches} mismatch(es) (${j(diff.classes ?? {})}), 0 unclassified, 0 gravity, ${bad.length} classified within 6 of a wet write other than growth or grazed at an unwritten cell${bad.length ? ` (${j(bad.slice(0, 4))})` : ''}; ${rm.restored} cells restored`);
  }
  return out;
}

/** Item 8 over the realised world: the wet piers, the quays, the harbour walls; M25:wet, M10:bridge, M3, M5, M6, M8 there. */
async function item8(ctx, tag, R, expect) {
  const { check } = ctx;
  const out = {};
  const rep = R.rep;
  const f = (re) => rep.findings.filter((x) => re.test(x.rule));
  out.reread = wetReread(R);
  check(out.reread.records >= 1 && out.reread.cells > 0 && out.reread.air + out.reread.water + out.reread.waterlogged === 0, `item 8 (${tag}): the wet writes re-read from the world: ${out.reread.cells} cell(s) that held water or ice are the written blocks: ${out.reread.air} air, ${out.reread.water} water, ${out.reread.waterlogged} waterlogged under the surface${out.reread.sample.length ? ` (${j(out.reread.sample)})` : ''}`);
  const m25 = f(/^M25/);
  check(!m25.length && (rep.metrics.M25?.wet?.bad ?? 1) === 0, `item 8 (${tag}): M25:wet 0 on the realised world (${j(rep.metrics.M25?.wet ?? null)}${m25.length ? `; ${m25.map((x) => x.message).join('; ').slice(0, 300)}` : ''})`);
  if ((R.meta.bridges ?? []).length) {
    const per = rep.metrics.bridges?.per ?? [];
    out.bridges = per.map((q) => ({ ok: q.ok, piers: q.piers, piersOk: q.piersOk, wetPier: q.wetPier ?? null, under: q.under, railed: q.railed, n: q.n }));
    const wetB = per.filter((q) => q.wetPier);
    check(wetB.length >= 1 && wetB.every((q) => q.piersOk === q.piers), `item 8 (${tag}): every wet beam's piers solid from the deck to 2 into the bed, at most 8 apart (${j(out.bridges)})`);
    const m10 = f(/^M10:bridge|^M3/).filter((x) => (R.meta.bridges ?? []).some((b) => b.part === x.part));
    check(!m10.length, `item 8 (${tag}): M10:bridge and M3 0 on the bridge parts (${m10.map((x) => `${x.rule} ${x.message}`).join('; ').slice(0, 300) || 'none'})`);
  }
  for (const q of R.meta.quays ?? []) {
    // the deck solid from bed - 1 to its top over every column, a step at the surface on the water's edge
    let holes = 0;
    const w = (R.meta.wet ?? []).find((x) => x.id === q.record);
    for (const [x, z, y0] of w?.columns ?? []) for (let y = y0 + 2; y <= q.surface; y++) { const a = stateAt(R.after, x, y, z); if (!a || nameOf(a) === 'minecraft:air' || /^minecraft:water/.test(a)) holes++; }
    const steps = q.steps.filter(([x, y, z]) => { const a = stateAt(R.after, x, y, z), up = stateAt(R.after, x, y + 1, z); return a && nameOf(a) !== 'minecraft:air' && !/^minecraft:water/.test(a) && nameOf(up) === 'minecraft:air'; });
    out[`quay_${q.id}`] = { length: q.length, reach: q.reach, holes, steps: `${steps.length}/${q.steps.length}` };
    check(holes === 0 && steps.length === q.steps.length && steps.length >= 1, `item 8 (${tag}): quay ${q.id} (${q.length} x ${q.reach}) solid from the bed to its deck (${holes} hole(s)), its ${q.steps.length} step(s) down to the water standing (exits every 16)`);
    const qf = rep.findings.filter((x) => /^M5|^M6|^M8|^M3/.test(x.rule) && String(x.part ?? '').startsWith('q_'));
    check(!qf.length, `item 8 (${tag}): quay ${q.id}: M5 0 dark deck cells, M6, M8, M3 clean (${qf.map((x) => `${x.rule} ${x.message}`).join('; ').slice(0, 300) || 'none'})`);
  }
  for (const w of R.meta.walls ?? []) {
    if (!w.wet) continue;
    const m = rep.metrics.walls?.[w.id];
    const surface = Math.max(...w.wet.columns.map((q) => q[3]));
    const tops = w.cells.filter(([x, z]) => w.wet.columns.some((q) => q[0] === x && q[1] === z)).map((q) => q[2]);
    out[`wall_${w.id}`] = { closure: m?.closure ?? null, cut: m?.cut, minTop: Math.min(...tops), surface, height: w.height };
    check(m && m.cut === 0 && (!m.closure || ['player', 'villager'].every((mv) => m.closure[mv].leaks === 0)) && Math.min(...tops) - surface >= w.height, `item 8 (${tag}): the harbour wall ${w.id}: closure with its wet sections as wall (${j(m?.closure ?? null)}), its top over the water's surface by at least its height (${Math.min(...tops)} - ${surface} >= ${w.height})`);
    const wf = rep.findings.filter((x) => /^M2:wall|^M8:wall/.test(x.rule));
    check(!wf.length, `item 8 (${tag}): no wall finding (${wf.map((x) => x.message).join('; ').slice(0, 300) || 'none'})`);
  }
  void expect;
  return out;
}

// ------------------------------------------------------------------ in game: the steps

/** The flat claim, its lake (made with /fill: natural water to the survey), the plan and its anchors. */
async function flatScene(ctx) {
  const { L } = ctx;
  const [X, Z] = FLAT0, G = 64;
  await L.tp(X + 48, G + 40, Z + 48);
  await L.call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  for (let x = X - 8; x < X + 112; x += 16) await L.cmd(`/fill ${x} ${G - 9} ${Z - 8} ${x + 15} ${G - 1} ${Z + 103} minecraft:stone`);
  // the lake: x X+16 .. X+111 (past the claim's east edge), z Z+40 .. Z+67 (28 wide), surface G - 1, bed G - 6 (stone): 5 deep
  for (let x = X + 16; x < X + 112; x += 16) {
    await L.cmd(`/fill ${x} ${G - 5} ${Z + 40} ${x + 15} ${G} ${Z + 67} minecraft:air`);
    await L.cmd(`/fill ${x} ${G - 5} ${Z + 40} ${x + 15} ${G - 1} ${Z + 67} minecraft:water`);
  }
  await L.settle(5000);
  const claim = [X, Z, X + 95, Z + 95];
  const anchors = { a: [X + 60, G + 1, Z + 28], b: [X + 60, G + 1, Z + 80], q: [X + 34, G + 1, Z + 37] };
  const plan = {
    schemaVersion: 'plan/0', planId: 'hb_flat',
    forms: [{ id: 'landing', kind: 'quay', where: { near: { anchor: 'q', within: 8 } }, length: 12, reach: 3 }],
    connectors: [
      { id: 'crossing', kind: 'bridge', from: { anchor: 'a' }, to: { anchor: 'b' }, width: 3 },
      { id: 'harbour', kind: 'wall', where: { inside: { claim: true } }, height: 5 },
    ],
  };
  return { claim, anchors, plan };
}

async function hbFlat(ctx) {
  const { L } = ctx;
  await L.fresh('G6B Hb Flat', FLAT);
  await L.setRules('exact');
  const sc = await flatScene(ctx);
  const out = await wetRun(ctx, 'flat', { ...sc, kind: 'flat', expect: { classes: { crossing: 'fits', landing: ['fits', 'adjusted'], harbour: ['fits', 'adjusted'] }, navMin: 2 } });
  const w = out.check?.parts?.find((a) => a.part === 'harbour');
  ctx.check(w?.geometry?.crossing?.over === 'water' && (w.geometry.wet ?? []).length >= 1, `item 8 (flat): the claim's edge wall crosses the lake as a harbour wall (${j(w?.geometry?.wet ?? null)}, crossing ${j(w?.geometry?.crossing ?? null)})`);
  await L.leaveWorld();
  return out;
}

async function hbNatural(ctx) {
  const { L, root } = ctx;
  await L.fresh('G6B Hb River', BASE);
  await L.setRules('exact');
  const claim = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's3_monastery.json'), 'utf8')).fixture.claim;
  const { S } = await surveyOf(ctx, claim, 'natural');
  const cr = await wetCrossings(ctx, S, claim);
  const out = { crossings: { wet: cr.ok.length, deep: cr.deep.length, best: cr.ok[0] ?? null, deepSample: cr.deep.slice(0, 4) } };
  ctx.log(`  S3: ${cr.ok.length} crossing(s) a wet beam fits, ${cr.deep.length} only deeper (best ${j(cr.ok[0] ?? cr.deep[0] ?? null)})`);
  let pick = cr.ok[0] ?? cr.deep[0] ?? null;
  if (!pick) {
    // (no straight crossing the scan can land: T3a's own river crossing (crossings_demo's pick), its anchors 6 past the banks)
    const { pickCrossings } = await ctx.imp('lib/connectors/crossingsBridges.mjs');
    const c = pickCrossings(S, { minX: claim[0], minZ: claim[1], maxX: claim[2], maxZ: claim[3] }, { maxLen: 20, dry: 5 })[0];
    if (c) {
      const at = (t) => (c.axis === 'z' ? [c.line, c.from + t] : [c.from + t, c.line]);
      const [ax, az] = at(-7), [bx, bz] = at(c.len + 6);
      pick = { a: [ax, S.groundAt(ax, az) + 1, az], b: [bx, S.groundAt(bx, bz) + 1, bz], river: c };
      out.crossings.t3River = c;
    }
  }
  const plan = { schemaVersion: 'plan/0', planId: 'hb_river', forms: [{ id: 'landing', kind: 'quay', where: { along: { feature: { water: {} } } }, length: 12, reach: 3 }], connectors: [] };
  const anchors = {};
  if (pick) { plan.connectors.push({ id: 'crossing', kind: 'bridge', from: { anchor: 'a' }, to: { anchor: 'b' }, width: 3, form: 'beam' }); anchors.a = pick.a; anchors.b = pick.b; }
  out.run = await wetRun(ctx, 'natural', { claim, plan, anchors, kind: 'natural', expect: { classes: { landing: ['fits', 'adjusted'], ...(pick ? { crossing: cr.ok.length ? ['fits', 'adjusted'] : 'refused' } : {}) }, navMin: 1 } });
  if (!cr.ok.length && pick) {
    const a = out.run.check?.parts?.find((q) => q.part === 'crossing');
    ctx.check(a?.class === 'refused' && ['WATER', 'SPAN', 'HEADROOM', 'ANCHOR'].includes(a.reasons?.[0]?.code) && !a.reasons[0].until, `item 11 (natural): S3's river takes no wet beam (deeper than waterDepth where a pier is needed): refused ${a?.reasons?.[0]?.code} ${a?.reasons?.[0]?.evidence?.kind ?? ''}, no until (recorded; the natural wet beam stands on the frozen site, hb-cold)`);
  }
  await L.leaveWorld();
  return out;
}

async function hbCold(ctx) {
  const { L } = ctx;
  const base = await L.seedBase(FROZEN_SEED);
  await L.fresh('G6B Hb Frozen', base);
  await L.setRules('exact');
  const claim = FROZEN_CLAIM;
  const { S } = await surveyOf(ctx, claim, 'cold');
  const cr = await wetCrossings(ctx, S, claim);
  const frozen = cr.ok.filter((q) => { for (let t = 1; t <= q.n; t++) { const x = q.from[0] + q.dir[0] * t, z = q.from[2] + q.dir[1] * t; if (S.frozenAt(x, z)) return true; } return false; });
  const pick = frozen[0] ?? cr.ok[0] ?? null;
  const out = { crossings: { wet: cr.ok.length, frozen: frozen.length, deep: cr.deep.length, pick } };
  ctx.check(!!pick, `item 8 (cold): a crossing of the frozen river a wet beam fits (${cr.ok.length} wet, ${frozen.length} through ice; ${j(pick)})`);
  if (!pick) { await L.leaveWorld(); return out; }
  const plan = { schemaVersion: 'plan/0', planId: 'hb_frozen', connectors: [{ id: 'crossing', kind: 'bridge', from: { anchor: 'a' }, to: { anchor: 'b' }, width: 3, form: 'beam' }] };
  out.run = await wetRun(ctx, 'cold', { claim, plan, anchors: { a: pick.a, b: pick.b }, kind: 'cold', expect: { classes: { crossing: ['fits', 'adjusted'] }, navMin: 1 } });
  await L.leaveWorld();
  return out;
}

// ------------------------------------------------------------------ the look (client)

function installBible(ctx, id) {
  const dst = path.join(ctx.L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(ctx.root, 'scenarios', 'bibles', `${id}.json`), path.join(dst, 'bible.json'));
}
async function shot(ctx, name, eye, at) {
  const { L, OUT } = ctx;
  await L.call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
  await L.call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  await L.settle(1500);
  const r = await L.call('dev.screenshot', { name: `hb_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
  const dir = path.join(OUT, 'look-hb');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, eye, at, file: dst };
}

async function hbLook(ctx) {
  const { L, OUT, check } = ctx;
  const out = { shots: [], bibles: {} };
  for (const b of LOOK_BIBLES) if (b) installBible(ctx, b);
  for (const bible of LOOK_BIBLES) {
    const tag = bible ?? 'default';
    await L.fresh(`G6B Hb Look ${tag}`, FLAT);
    await L.setRules('exact');
    const sc = await flatScene(ctx);
    const c = await L.call('dev.region.checkPlan', { plan: sc.plan, claim: sc.claim, owner: OWNER, anchors: sc.anchors, load: 'generate', ...(bible ? { bible } : {}) }, 900_000);
    const ok = c.check?.artifactSha && c.check.parts.every((a) => ['fits', 'adjusted'].includes(a.class));
    check(!!ok, `look (${tag}): the wet scene checks (${c.check?.overall}; ${j((c.check?.parts ?? []).map((a) => [a.part, a.class]))}; recorded, not judged)`);
    if (!ok) { await L.leaveWorld(); continue; }
    const rr = await L.call('dev.region.realiseApproved', { sha: c.check.artifactSha }, 300_000);
    const st = await L.waitRegion(rr.region, 3_600_000);
    const planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', st.view.planId);
    const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
    out.bibles[tag] = { state: st.view.state, bridges: (meta.bridges ?? []).map((q) => ({ id: q.id, pier: q.pier, deck: q.deck, rail: q.rail, wet: q.wet?.cells ?? 0 })), quays: meta.quays ?? [], walls: (meta.walls ?? []).map((w) => ({ id: w.id, wet: w.wet?.columns?.length ?? 0 })) };
    await L.cmd('/time set 6000');
    const [X, Z] = FLAT0;
    const b = (meta.bridges ?? [])[0];
    if (b) {
      const mid = [b.from[0], b.from[1], Math.floor((b.from[2] + b.to[2]) / 2)];
      out.shots.push({ ...(await shot(ctx, `${tag}_wet_piers_side`, [mid[0] + 26.5, mid[1] - 2, mid[2] + 0.5], [mid[0] + 0.5, mid[1] - 5, mid[2] + 0.5])), what: 'wet piers', bible: tag });
      if (tag === 'default') out.shots.push({ ...(await shot(ctx, `${tag}_wet_piers_low`, [mid[0] + 10.5, mid[1] - 3.5, mid[2] - 9.5], [mid[0] + 0.5, mid[1] - 6, mid[2] + 0.5])), what: 'wet piers (at the water line)', bible: tag });
    }
    const q = (meta.quays ?? [])[0];
    if (q) {
      const [hx, hz] = q.heading, mid = [Math.floor((q.along[0][0] + q.along[1][0]) / 2), q.along[0][1], Math.floor((q.along[0][2] + q.along[1][2]) / 2)];
      out.shots.push({ ...(await shot(ctx, `${tag}_quay`, [mid[0] + hx * 12 + 6.5, mid[1] + 5, mid[2] + hz * 12 + 0.5], [mid[0] + 0.5, mid[1], mid[2] + 0.5])), what: 'quay', bible: tag });
    }
    out.shots.push({ ...(await shot(ctx, `${tag}_harbour_wall`, [X + 70.5, 72, Z + 54.5], [X + 94.5, 66, Z + 54.5])), what: 'harbour wall', bible: tag });
    if (tag === 'default') out.shots.push({ ...(await shot(ctx, `${tag}_overview`, [X + 48.5, 110, Z + 10.5], [X + 60.5, 62, Z + 54.5])), what: 'the scene', bible: tag });
    await L.call('dev.release', {}).catch(() => null);
    await L.call('dev.region.remove', { region: rr.region, requester: OWNER }, 3_600_000).catch(() => null);
    await L.leaveWorld();
  }
  fs.writeFileSync(path.join(OUT, 'look-hb', 'look.json'), JSON.stringify(out, null, 2));
  return out;
}

export const items = {
  unit: [{ name: 'hb-kit', run: hbKit }, { name: 'hb-unchanged', run: hbUnchanged }, { name: 'hb-asks', run: hbAsks }],
  ingame: [{ name: 'hb-flat', run: hbFlat }],
  crash: [],
  probe: [],
  natural: [{ name: 'hb-natural', run: hbNatural }],
  cold: [{ name: 'hb-cold', run: hbCold }],
  look: [{ name: 'hb-look', run: hbLook }],
};
