// (6c H) Slice H-a's items of the H gate (tools/gate6ch.mjs): water bodies: ponds (water and lava), fountains, waterfalls, moats, ice caps,
// the farm pond, the wet well (docs/CONTRACT.md "Phase 6c slice H" §14 items 4, 5, 9 for bodies, 10, 13 for bodies, 19). H-a owns this file.
// Each step name (unit, ingame, crash, probe, natural, cold, look) maps to a list of items {name, run(ctx)}, run after H-core's in that
// step; ctx = {L (tools/lib/run6b.mjs), OUT, KIT, imp (a kit module), json, root, check, log}.
//
//   unit     ha-kit         the kit's H-a tests (h-a: v41-v45, v49 through the two-plan flow with M25/M20/M17 clean, the refusals with
//                           evidence and their wouldFits re-checked alone, the moat's road crossing, ice caps, the farm pond, the wet
//                           well, the bible's fluids roles, §13's recorded waterfall and moat, determinism), H-core's h tests, P0's
//            ha-unchanged   item 11: every committed valid/, K1 and T3 fixture without an H part plans as on origin/main
//            ha-asks        item 10: the 59 asks' gap table equals the committed one (fixtures/plan/h/asks-gap-after-ha.txt): form.waterfall
//                           1 -> 0, connector.channel 1 -> 0, no other class moved, 0 malformed, no until H
//   ingame   ha-flat        items 2 (bodies), 9, 13 (bodies) on a flat world (headless, default rules): water_demo's plan through
//                           Regions.checkPlan (READY) and realiseApproved: every body settled with its census equal to the prediction,
//                           a 2-minute stand; vanilla villagers round every body and over the moat's bridge both ways; the villager
//                           stand (4 at each body's edge, 1 in its surface's centre, 2 minutes: 0 drowning damage, 0 deaths, a path
//                           from each swimmer to a bank); the lava pit with fire ticks and random ticks 300: 0 fire in the claim
//            ha-exact       item 5 (bodies): the same plan realised under the exact rules, settled, Regions.remove: E-flat 0 with fluid
//                           cells compared by state; journal cells per part
//   natural  ha-natural     S3: a pond on the river's bank and a lip-existing waterfall into a pond: census, villagers, E-normal undo
//   cold     ha-cold        item 4: the frozen site 2026101102: an ice-capped pond (every capped cell ice after a stand at default
//                           rules) and its uncapped twin (it freezes on its own: the probe, recorded; its undo leaves no water or ice
//                           where the snapshot had none)
//   look     ha-look        item 19 (client, recorded): the natural pond, the built pool, the lava pit, the fountain, the waterfall and
//                           the moat with its bridge, in three bibles
//
// Run H-a's items on their own: `node tools/gate6cha.mjs <step> [item ...]`.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const OWNER = 'test:ha';
const FLAT = 'G6B Flat Base', BASE = 'G6B Seed Base', FROZEN_SEED = '2026101102';
const FLAT_CLAIM = [7000, 7000, 7255, 7175];
const FROZEN_CLAIM = [4168, 1480, 4279, 1591];
const LOOK_BIBLES = [null, 'g7ak1_infernal', 'g7ak1_coastal'];
const j = (o) => JSON.stringify(o).replaceAll(' ', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nodeTest(root, files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}

// ------------------------------------------------------------------ unit

async function haKit(ctx) {
  const r = nodeTest(ctx.root, ['kit/test/h-a.test.mjs', 'kit/test/h-core.test.mjs', 'kit/test/h-foundation.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/plan-p0-asks.test.mjs']);
  ctx.check(r.code === 0 && r.fail === 0 && r.pass >= 40, `items 1, 4, 10, 11, 15 (kit, H-a): v41-v45 and v49 fit through the two-plan flow with M25, M20 and M17 clean; the refusals answer LEAK, FIRE, WATER level and freezes, PROTECTED, VOLUME, NO_FEATURE and channel.course with evidence, their wouldFits fitting alone; the road over the moat clear 1 (N-H-5); ice caps (R23); the farm pond opt-in; the wet well; the bible's fluids roles; §13's waterfall and moat; determinism; H-core's and P0's tests: ${r.pass} pass, ${r.fail} fail`, r.failing);
  return r;
}

/** Item 11's byte identity (H-core's unchanged() over a main worktree of H-a's own: ../architect-mc-Ha-main). */
async function haUnchanged(ctx) {
  const { createHash } = await import('node:crypto');
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const sha256 = (s) => createHash('sha256').update(s).digest('hex');
  const root = ctx.root;
  const mainDir = path.resolve(root, '..', 'architect-mc-Ha-main');
  execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
  const mainHead = execFileSync('git', ['-C', root, 'rev-parse', 'origin/main']).toString().trim();
  if (!fs.existsSync(path.join(mainDir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', mainDir, mainHead]);
  else execFileSync('git', ['-C', mainDir, 'checkout', '-q', '--detach', mainHead]);
  const H = (dir) => import(pathToFileURL(path.join(dir, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(mainDir)];
  const H_KINDS = ['pond', 'fountain', 'waterfall', 'quay', 'channel'];
  const out = { mainHead, fixtures: {} };
  let same = 0, skipped = 0;
  for (const dir of ['valid', 'k1a', 'rope', 'refused', 't3a', 'tunnel']) {
    const fixDir = path.join(root, 'kit', 'test', 'fixtures', 'plan', dir);
    if (!fs.existsSync(fixDir)) continue;
    for (const f of fs.readdirSync(fixDir).filter((x) => x.endsWith('.json')).sort()) {
      const fx = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
      if (!fx.plan) continue;
      const parts = [...(fx.plan.forms ?? []), ...(fx.plan.connectors ?? [])];
      if (parts.some((c) => H_KINDS.includes(c.kind)) || /"farmPond":true/.test(JSON.stringify(fx.plan)) || !fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', dir, f))) { skipped++; continue; }
      if (fx.volume) continue;
      const sv = (h) => (fx.terrain ? h.flatSurvey(fx.terrain) : fx.on === 'asks' ? h.asksSurvey() : fx.on === 'flat' ? h.flatSurvey() : fx.on ? h.goldenSurvey(fx.on) : h.flatSurvey());
      const runOn = async (h) => { const s = sv(h); return h.checkPlanLocal(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...h.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}) }); };
      let a, b;
      try { a = await runOn(hNew); b = await runOn(hOld); } catch (e) { out.fixtures[`${dir}/${f}`] = { error: String(e.message).slice(0, 200) }; continue; }
      const norm = (r) => r.res.irJson.replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"');
      const eq = { answers: JSON.stringify(a.check.parts) === JSON.stringify(b.check.parts), ir: sha256(norm(a)) === sha256(norm(b)), overall: a.check.overall === b.check.overall };
      out.fixtures[`${dir}/${f}`] = eq;
      if (eq.answers && eq.ir && eq.overall) same++;
    }
  }
  out.same = same; out.n = Object.keys(out.fixtures).length; out.skipped = skipped;
  const differ = Object.entries(out.fixtures).filter(([, v]) => !(v.answers && v.ir && v.overall)).map(([k]) => k);
  ctx.check(out.n >= 40 && out.same === out.n, `item 11 (H-a): ${same} of ${out.n} committed valid/, K1 and T3 fixtures without an H part answer as on origin/main ${mainHead.slice(0, 10)} and plan the same IR but its kitVersion (${skipped} H fixtures skipped)`, differ);
  return { same, n: out.n, differ };
}

/** Item 10: the asks' gap table recomputed equals the committed one; its bar. */
async function haAsks(ctx) {
  const H = await import(path.join(ctx.KIT, 'test', 'plan-helpers.mjs'));
  const dir = path.join(ctx.KIT, 'test', 'fixtures', 'plan', 'asks');
  const s = H.asksSurvey();
  const tally = {}, gaps = {}, classes = [];
  let malformed = 0, untilH = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json').sort()) {
    const plan = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).answer.plan;
    const r = await H.checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: H.stewardAnchors(s.claim), volume: {} });
    for (const a of r.check.parts) {
      tally[a.class] = (tally[a.class] ?? 0) + 1;
      if (a.class === 'malformed') malformed++;
      if ((a.reasons ?? []).some((q) => q.until === 'H')) untilH++;
      if (a.class === 'unsupported') gaps[a.block] = (gaps[a.block] ?? 0) + 1;
      classes.push(`${f.replace('.json', '')}/${a.part} ${a.block} ${a.class}${a.reasons?.[0]?.code ? ` ${a.reasons[0].code}` : ''}${a.reasons?.[0]?.until ? ` until ${a.reasons[0].until}` : ''}`);
    }
  }
  const rows = Object.entries(gaps).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const text = `${[`# 59 asks: ${Object.entries(tally).sort().map(([k, v]) => `${k} ${v}`).join(', ')}`, '# gap table (unsupported parts per block id):', ...rows.map(([k, v]) => `  ${k.padEnd(24)} ${v}`), '# every part:', ...classes].join('\n')}\n`;
  fs.writeFileSync(path.join(ctx.OUT, 'ha-asks-gap.txt'), text);
  const committed = fs.readFileSync(path.join(ctx.KIT, 'test', 'fixtures', 'plan', 'h', 'asks-gap-after-ha.txt'), 'utf8');
  const before = fs.readFileSync(path.join(ctx.KIT, 'test', 'fixtures', 'plan', 'h', 'asks-gap-before.txt'), 'utf8');
  const lines = (t) => new Map(t.split('\n').filter((l) => !l.startsWith('#') && !l.startsWith('  ') && l.includes('/')).map((l) => [l.split(' ')[0], l]));
  const lb = lines(before), la = lines(text);
  const moved = [...la].filter(([k, v]) => lb.get(k) !== v).map(([k]) => k).sort();
  ctx.check(text === committed && malformed === 0 && untilH === 0 && j(moved) === j(['hidden_village/waterfall_curtain', 'redstone_gate/moat']), `item 10 (H-a): the 59 asks' gap table equals fixtures/plan/h/asks-gap-after-ha.txt (form.waterfall 1 -> 0, connector.channel 1 -> 0 from v0.36.0's); ${malformed} malformed, ${untilH} until H; the parts whose class moved: ${moved.join(', ')}`);
  return { tally, moved };
}

// ------------------------------------------------------------------ in game: helpers

/** The plan of water_demo's variant over a claim (kit/regions/water_demo.mjs waterPlan), its anchors at the survey's ground. */
async function demoPlan(ctx, claim, params) {
  const { waterPlan } = await ctx.imp('regions/water_demo.mjs');
  const c = { minX: claim[0], minZ: claim[1], maxX: claim[2], maxZ: claim[3] };
  return waterPlan(c, { variant: 'flat', only: 'all', cx: -30000000, cz: -30000000, ...params });
}

const stateAt = (d, x, y, z) => (x < d.box.minX || x > d.box.maxX || y < d.box.minY || y > d.box.maxY || z < d.box.minZ || z > d.box.maxZ ? null : d.palette[d.cells[d.at(x, y, z)]]);

/** The bodies of a plan's IR (its fluid ops): {id, part, fluid, level, cells, ice, spill, predicted, settleTicks, shell} with cells unrolled. */
async function bodiesOfPlan(ctx, planDir) {
  const { bodiesOf } = await ctx.imp('lib/region/checkFluids.mjs');
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  return bodiesOf(ir);
}

/** The bank cells round a body (feet cells: the first air over a solid column next to its surface), at most `n`, spread out. */
function banksOf(b, R, n = 4) {
  const own = new Set(b.cells.map((c) => `${c[0]},${c[2]}`));
  const shell = new Set(b.shell.map((c) => `${c[0]},${c[2]}`));
  const xs = b.cells.map((c) => c[0]), zs = b.cells.map((c) => c[2]);
  const box = { minX: Math.min(...xs) - 2, maxX: Math.max(...xs) + 2, minZ: Math.min(...zs) - 2, maxZ: Math.max(...zs) + 2 };
  const out = [];
  for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) {
    if (own.has(`${x},${z}`) || shell.has(`${x},${z}`)) continue;
    if (x !== box.minX && x !== box.maxX && z !== box.minZ && z !== box.maxZ) continue;
    for (let y = b.level + 6; y >= b.level - 2; y--) {
      const a = stateAt(R.after, x, y, z), f = stateAt(R.after, x, y - 1, z), h = stateAt(R.after, x, y + 1, z);
      if (!a || !f) continue;
      if (/air$/.test(a) && /air$/.test(h ?? 'air') && !/air$|water|lava/.test(f)) { out.push([x, y, z]); break; }
    }
  }
  const step = Math.max(1, Math.floor(out.length / n));
  return out.filter((_, i) => i % step === 0).slice(0, n);
}

/** The surface centre cell of a body (its surface cell nearest the cells' mean). */
function centreOf(b) {
  const surf = b.cells.filter((c) => c[1] === b.level);
  const mx = surf.reduce((t, c) => t + c[0], 0) / surf.length, mz = surf.reduce((t, c) => t + c[2], 0) / surf.length;
  return surf.reduce((best, c) => (!best || Math.abs(c[0] - mx) + Math.abs(c[2] - mz) < Math.abs(best[0] - mx) + Math.abs(best[2] - mz) ? c : best), null);
}

/** The realised world's re-reads over the before and after dumps, with the checker's report. */
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
  const written = new Set(), cols = new Set();
  vw.eachWritten((x, y, z) => { written.add(`${x},${y},${z}`); cols.add(`${x},${z}`); });
  return { ir, meta, world, rep, before, after, written, cols };
}

const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
/** A box around cells grown by g: [x0, y0, z0, x1, y1, z1]. */
function boxAround(cells, g = 2) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of cells) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.min(b[2], z); b[3] = Math.max(b[3], x); b[4] = Math.max(b[4], y); b[5] = Math.max(b[5], z); }
  return [b[0] - g, b[1] - g, b[2] - g, b[3] + g, b[4] + g, b[5] + g];
}

/**
 * Item 2 for a body, live (H-core's censusOf, gate6ch-core.mjs): dev.fluid.census over its watch box against its prediction: every
 * source (and ice cap cell) where planned, every predicted flowing cell at its level, no fluid of its kind outside its cells, spill and
 * joins that the before-census (`before`: a Set of "x,y,z") did not hold; the region's other bodies' cells and flow are theirs.
 */
async function census(ctx, body, before = null, siblings = []) {
  const all = [...body.cells, ...body.shell, ...body.spill, ...body.watch];
  const box = boxAround(all, 2);
  const c = await ctx.L.call('dev.fluid.census', { box }, 120_000);
  const now = new Map(c.fluids.map(([x, y, z, st]) => [`${x},${y},${z}`, st]));
  const pred = new Map(body.predicted.map(([x, y, z, lv]) => [`${x},${y},${z}`, lv]));
  const others = new Set(siblings.filter((o) => o.id !== body.id).flatMap((o) => [...o.cells.map(k3), ...o.ice.map(k3), ...o.predicted.map(k3)]));
  const own = new Set(body.cells.map(k3)), ice = new Set(body.ice.map(k3)), declared = new Set([...body.cells, ...body.spill, ...body.joins].map(k3));
  const kind = body.fluid === 'lava' ? 'minecraft:lava' : 'minecraft:water';
  const levelOf = (st) => { const m = /level=(\d+)/.exec(st); return m ? Number(m[1]) : 0; };
  const mismatch = [], outside = [];
  let sources = 0, flowing = 0, iceN = 0;
  for (const k of own) {
    const st = now.get(k);
    if (ice.has(k)) { if (st !== 'minecraft:ice') mismatch.push([k, st ?? 'none', 'ice']); else iceN++; continue; }
    if (!st || !st.startsWith(kind) || levelOf(st) !== 0) mismatch.push([k, st ?? 'none', 'source']); else sources++;
  }
  for (const [k, lv] of pred) {
    const st = now.get(k);
    if (!st || !st.startsWith(kind) || levelOf(st) !== lv) mismatch.push([k, st ?? 'none', `level ${lv}`]); else flowing++;
  }
  for (const [k, st] of now) {
    if (own.has(k) || pred.has(k) || others.has(k) || !st.startsWith(kind)) continue;
    if (before && before.has(k)) continue;
    if (declared.has(k)) mismatch.push([k, st, 'none']); else outside.push([k, st]);
  }
  return { ok: !mismatch.length && !outside.length, sources, sourcesWant: body.cells.length - ice.size, ice: iceN, flowing, flowingWant: pred.size, mismatch: mismatch.slice(0, 16), outside: outside.slice(0, 16), outsideCount: outside.length, ticks: c.ticks.length };
}

/** The plan through Regions.checkPlan (the two-plan flow) and its artifact realised; the before/after dumps; the bodies. */
async function realiseRun(ctx, tag, { claim, plan, anchors, rules = 'default', bible = null, expect = {} }) {
  const { L, OUT, check } = ctx;
  const out = { claim };
  const cx = (claim[0] + claim[2]) / 2, cz = (claim[1] + claim[3]) / 2;
  // (the rules before the check: under default rules a frozen site's water freezes between the check and the realise: ARTIFACT_STALE)
  await L.setRules(rules);
  await L.tp(cx, 200, cz);
  await L.call('dev.waitChunks', { timeoutMs: 120_000 }, 180_000).catch(() => null);
  const c = await L.call('dev.region.checkPlan', { plan, claim, owner: OWNER, anchors, load: 'generate', ...(bible ? { bible } : {}) }, 900_000);
  fs.writeFileSync(path.join(OUT, `ha-${tag}-check.json`), `${JSON.stringify(c, null, 1)}\n`);
  out.check = { overall: c.check?.overall ?? null, refused: c.refused ?? null, parts: (c.check?.parts ?? []).map((a) => ({ part: a.part, class: a.class, reasons: a.reasons })) };
  const okAll = out.check.parts.length && out.check.parts.every((a) => ['fits', 'adjusted'].includes(a.class));
  check(okAll && ['READY', 'NEEDS_REPAIR'].includes(out.check.overall), `${tag}: the plan through Regions.checkPlan's two-plan flow: ${out.check.overall} (${out.check.parts.map((a) => `${a.part} ${a.class}${a.reasons?.length ? ` ${a.reasons[0].code}` : ''}`).join(', ')})`);
  if (!c.check?.artifactSha) return out;
  const sv = path.join(OUT, `ha-${tag}-survey.bin`);
  await L.call('dev.region.survey', { claim, surveyLoad: 'bounded:256', file: sv }, 600_000);
  const { surveyApi } = await ctx.imp('lib/region/survey.mjs');
  const S = surveyApi(fs.readFileSync(sv), { minX: claim[0], minZ: claim[1], maxX: claim[2], maxZ: claim[3], minY: -64, maxY: 319 });
  let y0 = 320, y1 = -64;
  for (let x = claim[0]; x <= claim[2]; x += 2) for (let z = claim[1]; z <= claim[3]; z += 2) { y0 = Math.min(y0, S.floorAt(x, z)); y1 = Math.max(y1, S.groundAt(x, z)); }
  const box = [claim[0] - 8, Math.max(-64, y0 - 10), claim[1] - 8, claim[2] + 8, Math.min(319, y1 + 24), claim[3] + 8];
  out.box = box;
  await L.setRules(rules);
  await L.cmd('/kill @e[type=!minecraft:player]');
  await L.settle(rules === 'exact' ? 5000 : 20_000);
  const before = path.join(OUT, `ha-${tag}-before.arwd.gz`), after = path.join(OUT, `ha-${tag}-after.arwd.gz`), snapF = path.join(OUT, `ha-${tag}-snap.gz`);
  await L.call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  out.snap = await L.call('dev.region.hash', { box, mode: 'snap', file: snapF }, 4 * 3_600_000);
  const fb = await L.call('dev.fluid.census', { box }, 600_000).catch(() => ({ fluids: [] }));
  out.before = new Set(fb.fluids.map(([x, y, z]) => `${x},${y},${z}`));
  const rr = await L.call('dev.region.realiseApproved', { sha: c.check.artifactSha }, 300_000);
  if (rr.refused) { check(false, `${tag}: realiseApproved refused (${j(rr.refused)})`); return out; }
  const st = await L.waitRegion(rr.region, 3 * 3_600_000, async (s) => { if (s.view?.waiting?.reason === 'OCCUPIED' || s.waiting?.OCCUPIED) await L.cmd('/kill @e[type=!minecraft:player]'); });
  out.realise = { region: rr.region, state: st.view.state, cells: st.record?.cellsWritten ?? st.view.cellsWritten, planId: st.view.planId, fluids: st.view.ext?.['architect_mc:fluids'] ?? null };
  check(st.view.state === 'PLACED', `${tag}: realised from the approved artifact and settled (${st.view.state}, ${out.realise.cells} cells written; fluids ${j(out.realise.fluids)})`);
  await L.settle(5000);
  await L.call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  out.planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', st.view.planId);
  out.R = await realisedOf(ctx, out.planDir, before, after);
  out.bodies = await bodiesOfPlan(ctx, out.planDir);
  out.snapF = snapF;
  void expect;
  return out;
}

/** Regions.remove by its owner, a settle (the drain, a settle bound), the box against its snapshot. */
async function removeRun(ctx, tag, run, { kind }) {
  const { L, OUT, check } = ctx;
  await L.cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  const rm = await L.call('dev.region.remove', { region: run.realise.region, requester: OWNER }, 4 * 3_600_000);
  const bound = Math.max(...run.bodies.map((b) => b.settleTicks ?? 100), 100);
  await L.settle(Math.max(15_000, bound * 50 * 2));
  const diff = await L.call('dev.region.hash', { box: run.box, mode: 'diff', file: run.snapF }, 4 * 3_600_000);
  const exact = { kind, box: run.box, removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, list: (diff.list ?? []).slice(0, 200) };
  fs.writeFileSync(path.join(OUT, `ha-${tag}-exact.json`), `${JSON.stringify({ ...exact, list: diff.list ?? [] }, null, 2)}\n`);
  if (kind === 'E-flat') check(rm.removed && diff.mismatches === 0, `item 5 (${tag}): Regions.remove restores the box exactly, fluid cells by state: E-flat ${diff.mismatches} (${rm.restored} cells restored; ${run.realise.cells} written)`, (diff.list ?? []).slice(0, 12));
  else {
    // the tunnel rule (T3 §8): no classified mismatch within 6 of any body, shell or watched cell; 0 unclassified, 0 gravity
    const cells = run.bodies.flatMap((b) => [...b.cells, ...b.shell, ...b.spill, ...b.watch]);
    const near = (x, y, z) => cells.some((q) => Math.max(Math.abs(q[0] - x), Math.abs(q[1] - y), Math.abs(q[2] - z)) <= 6);
    const bad = (diff.list ?? []).filter((mm) => { const [x, y, z] = String(mm.pos).split(',').map(Number); return near(x, y, z); });
    // T1's flow class as H narrows it (§4.5): a fluid change at an unwritten cell more than 6 columns from every written column (a
    // natural spring the chunk load set flowing): the world's, not the undo's
    const wc = [...run.R.cols].map((k) => k.split(',').map(Number));
    const farFrom = (x, z) => wc.every(([cx, cz]) => Math.max(Math.abs(cx - x), Math.abs(cz - z)) > 6);
    const isFl = (v) => /^minecraft:(water|lava)/.test(String(v ?? ''));
    let flow = 0;
    for (const mm of diff.list ?? []) {
      if (mm.class !== 'none') continue;
      const [x, y, z] = String(mm.pos).split(',').map(Number);
      if ((isFl(mm.was) || isFl(mm.now)) && !run.R.written.has(`${x},${y},${z}`) && farFrom(x, z)) { mm.class = 'flow'; flow++; }
    }
    if (diff.classes && flow) { diff.classes.none = (diff.classes.none ?? 0) - flow; diff.classes.flow = flow; }
    const none = diff.classes ? diff.classes.none ?? 0 : diff.mismatches;
    check(rm.removed && none === 0 && (diff.classes?.gravity ?? 0) === 0 && bad.length === 0, `item 5 (${tag}): the removal's E-normal: ${diff.mismatches} mismatch(es) (${j(diff.classes ?? {})}), 0 unclassified, 0 gravity, ${bad.length} within 6 of a body, shell or watched cell${bad.length ? ` (${j(bad.slice(0, 4))})` : ''}`);
  }
  return exact;
}

/** Vanilla's villager both ways between two feet cells. */
async function navBoth(ctx, a, b) {
  const ab = await ctx.L.call('dev.nav.villager', { from: a, to: b, range: 256 }, 120_000);
  const ba = await ctx.L.call('dev.nav.villager', { from: b, to: a, range: 256 }, 120_000);
  return { there: !!ab.canReach, back: !!ba.canReach };
}

/** Item 9 (bodies): round every body both ways (opposite banks), over the moat's bridge; then the villager stand. */
async function villagers(ctx, tag, run) {
  const { L, check } = ctx;
  const out = { nav: {}, stand: null };
  const R = run.R;
  await L.cmd('/kill @e[type=!minecraft:player]');
  for (const b of run.bodies.filter((q) => q.fluid === 'water' && q.cells.length >= 4)) {
    const banks = banksOf(b, R, 8);
    if (banks.length < 2) { out.nav[b.id] = { banks: banks.length }; continue; }
    // (opposite banks at one height: a header pool on a cliff has banks down its face too, which no walk joins)
    let pair = null;
    for (let i = 0; i < banks.length; i++) for (let k = i + 1; k < banks.length; k++) {
      const [a, c] = [banks[i], banks[k]];
      const d = Math.abs(a[0] - c[0]) + Math.abs(a[2] - c[2]), dy = Math.abs(a[1] - c[1]);
      if (dy <= 1 && (!pair || d > pair.d)) pair = { a, c, d };
    }
    out.nav[b.id] = pair ? await navBoth(ctx, pair.a, pair.c) : { banks: banks.length };
  }
  for (const q of R.meta.bridges ?? []) out.nav[`bridge_${q.id}`] = await navBoth(ctx, [q.from[0], q.from[1] + 1, q.from[2]], [q.to[0], q.to[1] + 1, q.to[2]]);
  const navOk = Object.values(out.nav).every((v) => v.there && v.back);
  check(Object.keys(out.nav).length >= 2 && navOk, `item 9 (${tag}, the hard bar): vanilla dev.nav.villager round every body (bank to opposite bank) and over the moat's bridge, both ways (${j(Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, [v.there, v.back]])))})`);
  // the stand: 4 villagers by each water body's edge, 1 in its surface's centre; 2 minutes at default rules
  await L.setRules('default');
  await L.cmd('/gamerule spawn_monsters false');
  const since = Date.now();
  const placed = [];
  for (const b of run.bodies.filter((q) => q.fluid === 'water' && q.cells.length >= 4)) {
    for (const p of banksOf(b, R, 4)) { await L.cmd(`/summon minecraft:villager ${p[0] + 0.5} ${p[1]} ${p[2] + 0.5} {Tags:["ha_stand"]}`); placed.push({ body: b.id, at: p, swim: false }); }
    const c = centreOf(b);
    if (c) { await L.cmd(`/summon minecraft:villager ${c[0] + 0.5} ${c[1]} ${c[2] + 0.5} {Tags:["ha_stand","ha_swim"]}`); placed.push({ body: b.id, at: [c[0], c[1], c[2]], swim: true }); }
  }
  await L.settle(120_000);
  const dmg = await L.call('dev.entity.damage', { since, type: 'drown' }, 60_000).catch((e) => ({ error: String(e.message ?? e) }));
  const alive = await L.cmd('/execute if entity @e[type=minecraft:villager,tag=ha_stand]');
  const n = Number((/(\d+)/.exec(String(alive.messages?.join(' ') ?? '')) ?? [0, 0])[1]);
  // each swimmer finds a path to a bank
  // (the exits: the body's rim notches, the shell rule's rim cells its op leaves out: a swimmer's way out, M25:exit)
  const { shellOf } = await ctx.imp('lib/fluids/body.mjs');
  const swims = {};
  for (const p of placed.filter((q) => q.swim)) {
    const b = run.bodies.find((q) => q.id === p.body);
    const sh = new Set(b.shell.map((c) => `${c[0]},${c[1]},${c[2]}`));
    const exits = shellOf(b.cells).filter((c) => c[1] === b.level + 1 && !sh.has(`${c[0]},${c[1]},${c[2]}`))
      .sort((a, c) => (Math.abs(a[0] - p.at[0]) + Math.abs(a[2] - p.at[2])) - (Math.abs(c[0] - p.at[0]) + Math.abs(c[2] - p.at[2])));
    let ok = false;
    for (const e of exits.slice(0, 3)) if ((await ctx.L.call('dev.nav.villager', { from: [p.at[0], p.at[1], p.at[2]], to: e, range: 64 }, 120_000)).canReach === true) { ok = true; break; }
    swims[p.body] = exits.length ? ok : 'no exit';
  }
  out.stand = { placed: placed.length, alive: n, damage: dmg, swims };
  const drown = dmg.error ? null : (dmg.damage ?? dmg.events?.length ?? null);
  const deaths = dmg.error ? null : (dmg.deaths ?? null);
  check(!dmg.error && drown === 0 && (deaths === 0 || deaths?.length === 0) && n === placed.length && Object.values(swims).every((v) => v === true), `item 9 (${tag}): the villager stand (${placed.length} villagers: 4 by each body's edge, 1 in its surface's centre; 2 minutes at default rules): ${drown} drowning damage, ${placed.length - n} death(s), a path from each swimmer to a bank (${j(swims)})${dmg.error ? `; dev.entity.damage: ${dmg.error}` : ''}`);
  await L.cmd('/kill @e[type=minecraft:villager,tag=ha_stand]');
  return out;
}

// ------------------------------------------------------------------ in game: the steps

async function haFlat(ctx) {
  const { L, check, json } = ctx;
  await L.fresh('G6B Ha Flat', FLAT);
  await L.setRules('default');
  const { plan, anchors } = await demoPlan(ctx, FLAT_CLAIM, { variant: 'flat' });
  const run = await realiseRun(ctx, 'flat', { claim: FLAT_CLAIM, plan, anchors, rules: 'default' });
  if (!run.R) return run;
  const out = { check: run.check, realise: run.realise, bodies: {} };
  // item 2 (bodies): every body's census equals its prediction
  for (const b of run.bodies) out.bodies[b.id] = await census(ctx, b, run.before, run.bodies);
  check(Object.values(out.bodies).every((c) => c.ok), `item 2 (flat, H-a's bodies): every body settled with its census equal to the prediction (sources, ice, flowing levels; no other fluid in its watch box): ${json(Object.fromEntries(Object.entries(out.bodies).map(([k, c]) => [k, `${c.sources}/${c.sourcesWant}s ${c.flowing}/${c.flowingWant}f ${c.mismatch.length}m ${c.outsideCount}x`])))}`);
  const m25 = run.R.rep.findings.filter((f) => /^M25|^M20|^M17/.test(f.rule));
  check(!m25.length, `item 1 (flat): M25, M20 and M17 0 on the realised world (${m25.map((f) => `${f.rule} ${f.message}`).join('; ').slice(0, 300) || 'none'})`);
  // a 2-minute stand at default rules adds nothing
  await L.settle(120_000);
  const stand = {};
  for (const b of run.bodies) stand[b.id] = await census(ctx, b, run.before, run.bodies);
  check(Object.values(stand).every((c) => c.ok), `item 2 (flat): after a 2-minute stand at default rules every census still equals its prediction (${json(Object.fromEntries(Object.entries(stand).map(([k, c]) => [k, c.ok ? true : { m: c.mismatch, x: c.outside }])))})`);
  // item 13 (bodies): the lava pit with fire ticks on and random ticks at 300: no fire block in the claim
  await L.cmd('/gamerule random_tick_speed 300');
  await L.cmd('/gamerule do_fire_tick true').catch(() => null);
  await L.settle(60_000);
  const pit = run.bodies.find((b) => b.fluid === 'lava');
  const afterF = path.join(ctx.OUT, 'ha-flat-fire.arwd.gz');
  await L.call('dev.region.dump', { box: run.box, file: afterF, light: true }, 1_800_000);
  const { decodeArwd } = await ctx.imp('lib/region/vworld.mjs');
  const D = await decodeArwd(fs.readFileSync(afterF));
  const fireIdx = new Set(D.palette.map((s, i) => [String(s).replace(/\[.*$/, ''), i]).filter(([s]) => s === 'minecraft:fire' || s === 'minecraft:soul_fire').map(([, i]) => i));
  let fires = 0;
  for (let i = 0; i < D.cells.length; i++) if (fireIdx.has(D.cells[i])) fires++;
  const fireCount = { count: fires };
  out.fire = fireCount;
  check(pit && !fireCount.error && (fireCount.count ?? 1) === 0, `item 13 (flat, the lava pit): random ticks 300 and fire ticks for a minute: ${fireCount.count ?? '?'} fire block(s) in the claim${fireCount.error ? ` (${fireCount.error})` : ''}`);
  await L.cmd('/gamerule random_tick_speed 3');
  out.villagers = await villagers(ctx, 'flat', run);
  await L.call('dev.region.remove', { region: run.realise.region, requester: OWNER }, 4 * 3_600_000).catch(() => null);
  return out;
}

async function haExact(ctx) {
  const { L } = ctx;
  await L.fresh('G6B Ha Exact', FLAT);
  await L.setRules('exact');
  const { plan, anchors } = await demoPlan(ctx, FLAT_CLAIM, { variant: 'flat' });
  const run = await realiseRun(ctx, 'exact', { claim: FLAT_CLAIM, plan, anchors, rules: 'exact' });
  if (!run.R) return run;
  const exact = await removeRun(ctx, 'exact', run, { kind: 'E-flat' });
  return { check: run.check, realise: run.realise, exact: { ...exact, list: exact.list.slice(0, 20) }, journal: { written: run.realise.cells, restored: exact.restored } };
}

async function haNatural(ctx) {
  const { L, check, json } = ctx;
  const S3 = JSON.parse(fs.readFileSync(path.join(ctx.root, 'scenarios', 's3_monastery.json'), 'utf8')).fixture.claim;
  const { plan, anchors } = await demoPlan(ctx, S3, { variant: 'natural' });
  // round 1 (default rules): the census and the villagers; the removal not judged (random ticks move the land far from the plan)
  await L.fresh('G6B Ha Natural', BASE);
  const run = await realiseRun(ctx, 'natural', { claim: S3, plan, anchors, rules: 'default' });
  if (!run.R) return run;
  const out = { check: run.check, realise: run.realise, bodies: {} };
  for (const b of run.bodies) out.bodies[b.id] = await census(ctx, b, run.before, run.bodies);
  check(Object.values(out.bodies).every((c) => c.ok), `item 2 (natural): every body's census equals its prediction (${json(Object.fromEntries(Object.entries(out.bodies).map(([k, c]) => [k, c.ok ? true : { m: c.mismatch, x: c.outside }])))})`);
  out.villagers = await villagers(ctx, 'natural', run);
  await L.call('dev.region.remove', { region: run.realise.region, requester: OWNER }, 4 * 3_600_000).catch(() => null);
  // round 2 (the exact rules, a fresh copy): realised, removed, E-normal
  await L.fresh('G6B Ha Natural Exact', BASE);
  const ex = await realiseRun(ctx, 'natural-exact', { claim: S3, plan, anchors, rules: 'exact' });
  if (!ex.R) return out;
  out.exact = await removeRun(ctx, 'natural-exact', ex, { kind: 'E-normal' });
  out.exact.list = out.exact.list.slice(0, 20);
  return out;
}

async function haCold(ctx) {
  const { L, check, json } = ctx;
  const base = await L.seedBase(FROZEN_SEED);
  await L.fresh('G6B Ha Cold', base);
  await L.setRules('default');
  // (the frozen site's dry land in its south-west: its centre is shallow ice on sand, which the realise never replaces)
  const { plan, anchors } = await demoPlan(ctx, FROZEN_CLAIM, { variant: 'cold', twin: true, cx: 4176, cz: 1577 });
  // (checked and realised under the exact rules: the frozen river keeps the state the check read; the stand below is at default rules)
  await L.setRules('exact');
  const run = await realiseRun(ctx, 'cold', { claim: FROZEN_CLAIM, plan, anchors, rules: 'exact' });
  if (!run.R) return run;
  const out = { check: run.check, realise: run.realise };
  const capped = run.bodies.find((b) => b.ice.length), twin = run.bodies.find((b) => /twin/.test(b.id));
  check(!!capped && capped.ice.length > 0, `item 4 (cold): the pond is capped with ice by the plan (${capped?.ice.length ?? 0} cell(s))`);
  // the stand at default rules: every capped cell still ice; the twin left open freezes on its own (the probe of §0's assumption)
  for (const r of ['random_tick_speed 300', 'advance_time true', 'advance_weather true']) await L.cmd(`/gamerule ${r}`);
  await L.settle(120_000);
  await L.cmd('/gamerule random_tick_speed 3');
  const after2 = path.join(ctx.OUT, 'ha-cold-after2.arwd.gz');
  await L.call('dev.region.dump', { box: run.box, file: after2, light: true }, 1_800_000);
  const R2 = await realisedOf(ctx, run.planDir, path.join(ctx.OUT, 'ha-cold-before.arwd.gz'), after2);
  const iceNow = (b) => b.cells.filter(([x, y, z]) => y === b.level && /^minecraft:ice$/.test(String(stateAt(R2.after, x, y, z)).replace(/\[.*$/, ''))).length;
  out.ice = { capped: capped ? { cells: capped.ice.length, ice: iceNow(capped) } : null, twin: twin ? { surface: twin.cells.filter((c) => c[1] === twin.level).length, ice: iceNow(twin) } : null };
  check(out.ice.capped && out.ice.capped.ice === out.ice.capped.cells, `item 4 (cold): every capped surface cell reads ice after the stand at default rules (${json(out.ice.capped)})`);
  check(true, `item 4 (cold, the probe, recorded): the uncapped twin's open surface after 2 minutes at random ticks 300: ${json(out.ice.twin)} cell(s) frozen on their own`);
  // its undo leaves no water or ice where the snapshot had none (§4.3: the twin's ice that formed is still the entry's)
  const rm = await L.call('dev.region.remove', { region: run.realise.region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(20_000);
  const after3 = path.join(ctx.OUT, 'ha-cold-after3.arwd.gz');
  await L.call('dev.region.dump', { box: run.box, file: after3, light: true }, 1_800_000);
  const R3 = await realisedOf(ctx, run.planDir, path.join(ctx.OUT, 'ha-cold-before.arwd.gz'), after3);
  let left = 0;
  const sample = [];
  for (const b of run.bodies) for (const [x, y, z] of [...b.cells, ...b.spill]) {
    const a = String(stateAt(R3.after, x, y, z)), bf = String(stateAt(R3.before, x, y, z));
    if (/^minecraft:(water|ice|frosted_ice)/.test(a) && !/^minecraft:(water|ice|frosted_ice)/.test(bf)) { left++; if (sample.length < 8) sample.push([x, y, z, a]); }
  }
  out.undo = { removed: rm.removed, left, sample };
  check(rm.removed && left === 0, `item 4 (cold): the removal leaves no water or ice where the snapshot had none (${left} cell(s)${sample.length ? ` ${json(sample)}` : ''})`);
  return out;
}

/** Item 19 (client): water_demo flat in three bibles; the cameras over each body. */
async function haLook(ctx) {
  const { L, OUT, log } = ctx;
  const out = { shots: [] };
  for (const bible of LOOK_BIBLES) {
    const tag = bible ?? 'default';
    await L.fresh(`G6B Ha Look ${tag}`, FLAT);
    await L.setRules('exact');
    const { plan, anchors } = await demoPlan(ctx, FLAT_CLAIM, { variant: 'flat' });
    const run = await realiseRun(ctx, `look-${tag}`, { claim: FLAT_CLAIM, plan, anchors, rules: 'exact', bible });
    if (!run.R) continue;
    for (const b of run.bodies) {
      const xs = b.cells.map((c) => c[0]), zs = b.cells.map((c) => c[2]);
      const at = [(Math.min(...xs) + Math.max(...xs)) >> 1, b.level, (Math.min(...zs) + Math.max(...zs)) >> 1];
      const eye = [at[0] + 9, at[1] + 9, at[2] + 13];
      await L.cmd(`/tp @s ${eye[0]} ${eye[1]} ${eye[2]} facing ${at[0]} ${at[1]} ${at[2]}`);
      await L.settle(2500);
      const name = `ha-look-${tag}-${b.id}`;
      const s = await L.call('dev.screenshot', { name }, 120_000).catch((e) => ({ error: String(e.message ?? e) }));
      out.shots.push({ bible: tag, body: b.id, file: s.file ?? s.path ?? null, error: s.error ?? null });
      log(`  shot ${name}: ${s.file ?? s.path ?? s.error}`);
    }
    await L.call('dev.region.remove', { region: run.realise.region, requester: OWNER }, 4 * 3_600_000).catch(() => null);
  }
  fs.writeFileSync(path.join(OUT, 'ha-look.json'), `${JSON.stringify(out, null, 2)}\n`);
  ctx.check(out.shots.length >= 6 && out.shots.every((s) => !s.error), `item 19 (look, recorded): ${out.shots.length} camera shot(s) of H-a's bodies in ${LOOK_BIBLES.length} bibles`);
  return out;
}

export const items = {
  unit: [{ name: 'ha-kit', run: haKit }, { name: 'ha-unchanged', run: haUnchanged }, { name: 'ha-asks', run: haAsks }],
  ingame: [{ name: 'ha-flat', run: haFlat }, { name: 'ha-exact', run: haExact }],
  crash: [],
  probe: [],
  natural: [{ name: 'ha-natural', run: haNatural }],
  cold: [{ name: 'ha-cold', run: haCold }],
  look: [{ name: 'ha-look', run: haLook }],
};

void sleep;
