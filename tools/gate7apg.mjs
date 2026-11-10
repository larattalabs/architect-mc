#!/usr/bin/env node
// Slice PG gate (docs/CONTRACT.md "Slice PG: passage gates in the gate join") against the headless server of the run worktree (the sim
// sidecar, no Claude; ports from the gate runner). $0: no Claude call anywhere; spend.json $0.00. Helpers as tools/gate7agj.mjs's.
//
//   node tools/gate7apg.mjs <step>
//     start [world] | stop | base      the client (or server) and the base worlds
//     pgunit                            items 1, 2, 3, 5 (kit), the Java parity and feature, item 6 (every plan fixture as on the merge base)
//     passage                           items 1, 3, 4, 5, 7 in game on pg_town (its only gate a K3 gatehouse lot)
//
// Evidence: artifacts/gate7a-pg/<step>.json (GATE7APG_OUT overrides), all.log, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { srcGradle } from './lib/src-gradle.mjs';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-PG-run');
process.env.GATE6B_OUT = process.env.GATE7APG_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-pg');
process.env.GATE6B_SIDECAR_PORT ??= '8896';
process.env.GATE6B_DEV_PORT ??= '8897';
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, leaveWorld, log, results, root, state, startClient, stopClient, tp, sleep } = L;

L.refuseKeys();
const FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const OWNER = 'test:pg';
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o) ?? 'undefined').replaceAll(' ', '');
const STUB = 'g6a_stub_9';
/** The town's lots (D3's d3_town: a hall and seven cottages on a 160 claim). */
const TOWN_LOTS = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, ...Array.from({ length: 7 }, (_, i) => ({ id: `cottage_${i + 1}`, type: 'cottage', size: [9, 9] }))];
const TOWN_SIZE = 160;
const ONE = (id, extra = {}) => ({ spec: { districts: [{ id, size: [48, 48], lots: 4, ...extra }] } });

const steps = {};
async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== ${name}`);
  try {
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (!['stop', 'start'].includes(name)) L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice PG is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B PG Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  await L.ensureBase(FLAT);
  spendZero();
  return { worlds: [FLAT] };
};

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}

// ------------------------------------------------------------------ in-game helpers

const planReq = (o) => call('dev.region.plan', { surveyLoad: 'bounded:256', owner: OWNER, ...o }, 900_000);
const checkBeside = (o) => call('dev.region.checkBeside', { surveyLoad: 'bounded:256', owner: OWNER, ...o }, 900_000);
const planFiles = (planId) => {
  const d = path.join(L.SIDECAR_DATA, 'regions', 'plans', planId);
  return { ir: JSON.parse(fs.readFileSync(path.join(d, 'ir.json'), 'utf8')), meta: JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8')), report: fs.existsSync(path.join(d, 'report.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'report.json'), 'utf8')) : null };
};
async function undo(region, requester = OWNER) {
  const r = await call('dev.region.remove', { region, requester }, 3_600_000);
  for (let i = 0; i < 2400; i++) {
    const st = await call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || s === 'REMOVED') return r;
    if (s === 'PARTIAL' || s === 'FAILED') throw new Error(`undo of ${region} ended ${s}: ${json(r)}`);
    await sleep(250);
  }
  throw new Error(`undo of ${region} did not finish`);
}
const hash = async (box) => (await call('dev.region.hash', { box }, 3_600_000)).sha256;
const view = async (region) => (await call('dev.region.state', { region }, 60_000)).view;
const kill = () => cmd('/kill @e[type=!minecraft:player]');
async function dump(box, name) {
  const f = path.join(OUT, `${name}.arwd.gz`);
  await call('dev.region.dump', { box, file: f, light: false }, 1_800_000);
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  return decodeArwd(fs.readFileSync(f));
}
/** The cells two dumps differ in over rect columns, optionally skipping columns (a Set of "x,z"). */
function diffCols(a, b, rects, skip = null) {
  const bx = a.box;
  let n = 0;
  const sample = [];
  for (const [x0, z0, x1, z1] of rects) for (let x = Math.max(x0, bx.minX); x <= Math.min(x1, bx.maxX); x++) for (let z = Math.max(z0, bx.minZ); z <= Math.min(z1, bx.maxZ); z++) {
    if (skip && skip.has(`${x},${z}`)) continue;
    for (let y = bx.minY; y <= bx.maxY; y++) if (a.palette[a.cells[a.at(x, y, z)]] !== b.palette[b.cells[b.at(x, y, z)]]) { n++; if (sample.length < 10) sample.push([x, y, z]); }
  }
  return { cells: n, sample };
}
async function groundAt(x, z) {
  const sf = path.join(OUT, `survey-${x}-${z}.bin`);
  await call('dev.region.survey', { claim: [x - 1, z - 1, x + 1, z + 1], surveyLoad: 'loaded', file: sf }, 300_000);
  return (await imp('lib/region/pack.mjs')).decodeColumns(fs.readFileSync(sf)).ground[4];
}
const runKeysOf = async (runs) => (await imp('lib/region/beside.mjs')).runKeys(runs);
const stacksOver = async (runs) => (await call('dev.journal.columns', { runs }, 600_000)).cells ?? [];
const listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);

/** A town claim's chunks generated before its realise (D3's generateFor: a throwaway plan over the claim grown by 16, prepared). */
async function generateFor(A, params) {
  const g = await planReq({ program: 'flat_village', params, claim: [A[0] - 16, A[1] - 16, A[2] + 16, A[3] + 16], check: false });
  if (g.refused) return;
  await L.prepare(g.planId);
}

/** D3's d3_town, plainly: a flat_village of 8 lots on a 160 claim at (X, Z), 4 cottages with stubs. {A, region, ir, world0, all, g}. */
async function town(X, Z) {
  const A = [X, Z, X + TOWN_SIZE - 1, Z + TOWN_SIZE - 1];
  const params = { lots: TOWN_LOTS, apronLamps: false };
  await generateFor(A, params);
  const g = await groundAt(X + 80, Z + 80);
  const all = [A[0] - 40, -64, A[1] - 40, A[2] + 120, 160, A[3] + 40];
  const world0 = await dump(all, `world0-${X}`);
  const pa = await planReq({ program: 'flat_village', params, claim: A, check: false });
  if (pa.refused) throw new Error(`the town's plan: ${pa.refused}`);
  const ir = planFiles(pa.planId).ir;
  const lots = Object.fromEntries(ir.lots.filter((l) => l.id.startsWith('cottage_')).slice(0, 4).map((l) => [l.id, STUB]));
  await kill();
  const region = await L.realise(pa.planId, { lots });
  const st = await L.waitRegion(region, 3_600_000);
  return { A, region, ir, world0, all, g, state: st.view.state };
}

/** A C38 wall round a standing region through plan/0 (checkPlan of wall.around {feature: {region}}, then realiseApproved). */
async function wallRound(townId, A, { gates = null, extra = [], anchors = {}, ring = [4, 12] } = {}) {
  const C = [A[0] - 24, A[1] - 24, A[2] + 24, A[3] + 24];
  const plan = { schemaVersion: 'plan/0', connectors: [{ id: 'ring', kind: 'wall', where: { around: { feature: { region: townId }, ...(ring ? { ring } : {}) } }, ...(ring ? { height: 5 } : {}), ...(gates !== null ? { gates } : {}) }, ...extra] };
  const ck = await call('dev.region.checkPlan', { plan, claim: C, anchors: { stone: [Math.floor((A[0] + A[2]) / 2), 65, Math.floor((A[1] + A[3]) / 2)], ...anchors }, owner: OWNER }, 900_000);
  const part = ck.check?.parts?.find((x) => x.part === 'ring') ?? null;
  let region = null;
  if (ck.check?.artifactSha && part?.class === 'fits') {
    const ra = await call('dev.region.realiseApproved', { sha: ck.check.artifactSha }, 300_000);
    region = ra.region ?? null;
    if (region) await L.waitRegion(region, 3_600_000);
  }
  return { C, check: ck.check, part, region, geometry: part?.geometry ?? null, ir: ck.check?.checkId ? checkIr(ck.check.checkId) : null };
}

/** A plan check's IR (its sidecar plan directory, by the check's id). */
const checkIr = (checkId) => JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', checkId, 'ir.json'), 'utf8'));
/** The gates of a standing region as the reach step reads them (the kit's besideGates over its IR). */
async function gatesOf(regionId, ir) {
  return (await imp('lib/region/beside.mjs')).besideGates(regionId, ir);
}
/** A refusal's text (the realise answer's `refused`, an object or a string). */
const refusedText = (r) => (r == null ? '' : typeof r === 'string' ? r : JSON.stringify(r));

/** A district plan beside a town (its checkBeside verdict first, item 9's parity) -> {plan, files, verdict, parity}. */
async function besidePlan(townId, claim, params, { opKey, ext } = {}) {
  const verdict = await checkBeside({ program: 'districts', params, claim, beside: townId, check: true });
  const plan = await planReq({ program: 'districts', params, claim, beside: townId, check: true, ...(opKey ? { opKey } : {}), ...(ext ? { ext } : {}) });
  const files = plan.refused ? null : planFiles(plan.planId);
  const j = files?.meta?.districts?.join ?? null;
  const parity = plan.refused ? !verdict.fits && String(plan.refused).includes(String(verdict.message).split(' (the request')[0].slice(0, 60))
    : verdict.fits && verdict.join && verdict.join.kind === (j?.junction?.kind ?? 'end') && verdict.join.step === (j?.step ?? 'seam') && json(verdict.join.at) === json(j?.junction?.at ?? j?.at)
      && (verdict.land?.parts ?? []).find((p) => p.kind === 'join')?.via === j?.via;
  return { plan, files, verdict, parity };
}
/** The gate's box: its opening's columns from its walk up past its lintel. */
const gateBox = (g) => { const xs = g.cells.flatMap((q) => [q[0], q[2]]), zs = g.cells.flatMap((q) => [q[1], q[3]]); return [Math.min(...xs), g.y - 1, Math.min(...zs), Math.max(...xs), g.y + g.h + 2, Math.max(...zs)]; };
/** Villager paths from every district lot's entrance to the bell and back: {lot: [there, back]}. */
async function villagers(ir, bell) {
  const out = {};
  for (const l of ir.lots) {
    const e = l.ext?.['architect_mc:village']?.entrance;
    if (!e) continue;
    const there = await call('dev.nav.villager', { from: e, to: bell, range: 320 }, 120_000);
    const back = await call('dev.nav.villager', { from: bell, to: e, range: 320 }, 120_000);
    out[l.id] = [!!there.canReach, !!back.canReach];
  }
  return out;
}
/** The columns a region holds in the journal over rects and runs. */
async function heldBy(groupId, runs) {
  return new Set((await stacksOver(runs)).filter((c) => c.stack.some((e) => e.group === groupId)).map((c) => `${c.x},${c.z}`));
}
const rowsOf = (r) => { const out = []; for (let z = r[1]; z <= r[3]; z++) out.push([r[0], z, r[2], z]); return out; };

// ------------------------------------------------------------------ slice PG: a district joins through a K3 gatehouse's passage

/** pg_town's plan/0: gj_town_wall's street town and its own ring, its gate a K3 gatehouse lot east (`mech` its mechanism), no K1 gate. */
const PG_LOTS = [{ id: 'gatehouse_1', type: 'gatehouse', size: [13, 11] }, ...TOWN_LOTS.slice(0, 6)];
const pgTownPlan = (mech) => ({ schemaVersion: 'plan/0',
  zones: [{ id: 'town', program: { lots: PG_LOTS, layout: 'street', orientation: 'ew' }, where: { near: { anchor: 'stone', within: 16 } } }],
  connectors: [{ id: 'town_wall', kind: 'wall', where: { around: { feature: { part: 'town' }, ring: [8, 14] } }, height: 5, lots: [{ lot: 'gatehouse_1', at: 'gate', near: { anchor: 'east' }, ...(mech ? { mech } : {}) }] }] });

/** The artifact's wall lots (dev.region.artifact), as K3's gate reads them. */
async function pgArtifactLots(sha) {
  const a = await call('dev.region.artifact', { sha, body: true }, 120_000);
  const find = (o) => (o && typeof o === 'object' ? (Array.isArray(o.lots) && o.lots.some((l) => l?.onWall)) ? o.lots : Object.values(o).map(find).find(Boolean) : null);
  return find(a) ?? [];
}

/** K3's stub gatehouse design for a wall lot (tools/lib/gate7ak3-designs.mjs), written to the run's library: its entry id. */
async function pgGatehouse(lot, tag) {
  const D = await import('./lib/gate7ak3-designs.mjs');
  const kit = await imp('lib/kit.mjs'), style = await imp('lib/connectors/style.mjs');
  const K = { Blueprint: kit.Blueprint, palette: kit.palette, variant: kit.variant, shapeOf: style.shapeOf, doorOf: style.doorOf };
  const { resolveRoles } = await imp('lib/region/plan.mjs');
  const { writeBlueprint } = await imp('lib/write.mjs');
  const id = `pg_${lot.id}_${tag}`;
  const bp = D.gatehouseDesign(K, id, lot, resolveRoles({}), lot.onWall.passage.mechanism ? { roof: 10 } : {});
  const dir = path.join(L.LIBRARY, id);
  fs.rmSync(dir, { recursive: true, force: true });
  writeBlueprint(bp, dir);
  await cmd('/architect reload');
  await L.settle(1500);
  return id;
}

steps.passage = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B PG Passage', FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  // (GM §6: the planner can't know the hour; the day held so a portcullis rests open while the gate runs)
  await cmd('/gamerule doDaylightCycle false');
  await cmd('/time set noon');
  for (const [name, mech, X] of [['plain', null, 68000], ['portcullis', 'portcullis', 69000]]) {
    const Z = 20000, o = (out[name] = {});
    await tp(X + 80, 40, Z + 80);
    await kill();
    const A = [X, Z, X + TOWN_SIZE - 1, Z + TOWN_SIZE - 1];
    await generateFor(A, { lots: TOWN_LOTS, apronLamps: false });
    const g0 = await groundAt(X + 80, Z + 80);
    const anchors = { stone: [X + 80, g0 + 1, Z + 80], east: [A[2] - 6, g0 + 1, Z + 80] };
    const all = [A[0] - 40, -64, A[1] - 40, A[2] + 120, 160, A[3] + 40];
    const B = [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30];
    const ck = await call('dev.region.checkPlan', { plan: pgTownPlan(mech), claim: A, anchors, owner: OWNER }, 900_000);
    const wallPart = (ck.check?.parts ?? []).find((a) => a.part === 'town_wall');
    o.check = { overall: ck.check?.overall, parts: (ck.check?.parts ?? []).map((a) => [a.part, a.class]), wallLots: wallPart?.geometry?.wallLots?.map((q) => [q.lot, q.passage?.mechanism?.kind ?? null]) };
    check(ck.check?.overall === 'READY' && wallPart?.class === 'fits' && (wallPart?.geometry?.wallLots ?? []).length === 1, `pg_town (${name}): READY, its wall fits with one gatehouse lot and no K1 gate (${json(o.check)})`);
    if (!ck.check?.artifactSha) continue;
    const sha = ck.check.artifactSha, tir = checkIr(ck.check.checkId);
    const lot = (await pgArtifactLots(sha)).find((l) => l.id === 'gatehouse_1');
    if (mech) check(lot?.onWall?.passage?.mechanism?.kind === mech, `item 5 (${name}): the gatehouse's passage carries the ${mech} (${json(lot?.onWall?.passage?.mechanism?.rest)})`);
    const world0 = await dump(all, `pg-${name}-world0`);
    if (name === 'plain') {
      // ---- item 3: the town realised with the gatehouse unbound (a reserved box): skipped, not standing as built; the only gate
      await kill();
      const r0 = await call('dev.region.realiseApproved', { sha }, 300_000);
      const s0 = r0.region ? await L.waitRegion(r0.region, 3_600_000) : null;
      const lot0 = s0?.view?.lots?.find((l) => l.id === 'gatehouse_1');
      o.unbuilt = { region: r0.region ?? null, refused: r0.refused ?? null, state: s0?.view?.state, lot: lot0 };
      check(s0?.view?.state === 'PLACED' && lot0 && lot0.state !== 'placed', `item 3: the town realised with its gatehouse unbound (${json(o.unbuilt)})`);
      if (r0.region) {
        const p0 = await besidePlan(r0.region, B, ONE('east'));
        o.unbuilt.answer = refusedText(p0.plan.refused).slice(0, 600);
        check(/NO_JOIN: \[wall\].*:gatehouse_1 not standing as built \(gatehouse lot gatehouse_1 is not built/.test(o.unbuilt.answer), `item 3: the unbuilt gatehouse, the only gate, is skipped: NO_JOIN [wall] naming it (${o.unbuilt.answer.slice(0, 300)})`);
        check(p0.parity, `item 3: checkBeside equals Regions.plan (${json(p0.verdict?.message)?.slice(0, 200)})`);
        await kill();
        await undo(r0.region);
        await L.settle(3000);
        const w1 = await dump(all, 'pg-plain-world1');
        const d0 = diffCols(world0, w1, [[all[0], all[2], all[3], all[5]]]);
        check(d0.cells === 0, `item 3: the unbuilt town removed: E-flat 0 (${d0.cells}; ${json(d0.sample)})`);
      }
    }
    // ---- item 4: the town realised with the stub gatehouse built; the district joins through its passage
    const gid = await pgGatehouse(lot, name);
    await kill();
    const ra = await call('dev.region.realiseApproved', { sha, lotEntries: { gatehouse_1: gid } }, 300_000);
    const st = ra.region ? await L.waitRegion(ra.region, 3_600_000) : null;
    const TR = ra.region;
    o.town = { region: TR, refused: ra.refused ?? null, state: st?.view?.state, lot: st?.view?.lots?.find((l) => l.id === 'gatehouse_1') };
    check(st?.view?.state === 'PLACED' && o.town.lot?.state === 'placed', `item 4 (${name}): the town PLACED, its gatehouse ${gid} built (${json(o.town)})`);
    if (!TR) continue;
    await L.settle(3000);
    const gs = await gatesOf(TR, tir);
    o.gates = gs.map((q) => [q.id, q.kind ?? 'gate', q.mechanism?.rest ?? null]);
    if (mech) {
      // ---- item 5: the grate lowered by its front lever (a day-driven gate counts as open: GM §6): the plan still crosses the passage
      const lever = lot.onWall.passage.mechanism.triggers.find((t) => t.kind === 'lever' && t.side === 'front');
      await call('dev.pt.uses', { ops: [{ item: 'minecraft:stick', at: lever.at, on: lever.at, face: 'up' }] }, 30_000);
      await L.settle(3000);
      const moving = gs[0]?.mechanism?.moving ?? [];
      const solid = [];
      const mvx = [], mvz = [], mvy = [];
      for (let i = 0; i + 3 < moving.length; i += 4) { mvx.push(moving[i]); mvz.push(moving[i + 1]); mvy.push(moving[i + 2], moving[i + 3]); }
      const mb = await dump([Math.min(...mvx), Math.min(...mvy), Math.min(...mvz), Math.max(...mvx), Math.max(...mvy), Math.max(...mvz)], `pg-${name}-closed`);
      for (let i = 0; i + 3 < moving.length; i += 4) for (let y = moving[i + 2]; y <= moving[i + 3]; y++) { const b = mb.palette[mb.cells[mb.at(moving[i], y, moving[i + 1])]]; if (b && !/air/.test(b)) solid.push([moving[i], y, moving[i + 1]]); }
      const v = await checkBeside({ program: 'districts', params: ONE('east'), claim: B, beside: TR, check: true });
      o.closed = { lever: lever.at, solidMoving: solid.length, fits: v.fits, via: (v.land?.parts ?? []).find((q) => q.kind === 'join')?.via ?? null, message: v.message ?? null };
      check(v.fits && o.closed.via === `${TR}:gatehouse_1`, `item 5: the portcullis lowered by its front lever (${solid.length} moving cells solid): checkBeside still joins through the passage, GJ's open-gate rule for a day-driven gate (${json(o.closed)})`);
      await call('dev.pt.uses', { ops: [{ item: 'minecraft:stick', at: lever.at, on: lever.at, face: 'up' }] }, 30_000);
      await L.settle(3000);
    }
    const p = await besidePlan(TR, B, ONE('east'));
    if (p.plan.refused) { check(false, `item 4 (${name}): the district's plan through the passage: ${refusedText(p.plan.refused).slice(0, 400)}`); continue; }
    const ir = p.files.ir, gt = ir.reach?.gate, j = p.files.meta.districts.join;
    o.plan = { via: j?.via, node: j?.node, gate: gt && { id: gt.id, kind: gt.kind, lot: gt.lot, mechanism: gt.mechanism ? [gt.mechanism.kind, gt.mechanism.rest] : null } };
    check(j?.via === `${TR}:gatehouse_1` && gt?.kind === 'passage' && gt?.lot === 'gatehouse_1', `item 1/4 (${name}): the district joins through the gatehouse's passage (${json(o.plan)})`);
    const ji = (p.files.meta.route?.edges ?? []).find((e) => e.id === 'join_in'), jo = (p.files.meta.route?.edges ?? []).find((e) => e.id === 'join');
    check(json(jo?.path?.at(-1)?.filter((_, i) => i !== 1)) === json(gt?.outer) && json(ji?.path?.[0]?.filter((_, i) => i !== 1)) === json(gt?.inner), `item 1 (${name}): the walk front port ${json(gt?.outer)} -> back port ${json(gt?.inner)}`);
    check(p.parity, `item 4 (${name}): checkBeside equals Regions.plan (${json(p.verdict.join)})`);
    const gb = gateBox(gt);
    const gh0 = await hash(gb);
    const before = await dump(all, `pg-${name}-before-district`);
    await kill();
    const rb = await L.realise(p.plan.planId, { lots: {} });
    const sb = await L.waitRegion(rb, 3_600_000);
    check(sb.view.state === 'PLACED' && (await hash(gb)) === gh0, `item 4 (${name}): the re-check holds (the gatehouse lot's site holds the passage): the district ${rb} PLACED, the passage's cells unchanged (hash)`);
    await tp(Math.floor((A[0] + B[2]) / 2), 0, Math.floor((A[1] + A[3]) / 2));
    await kill();
    o.nav = await villagers(ir, tir.anchors?.bell ?? tir.anchors?.entrance);
    check(Object.keys(o.nav).length >= 1 && Object.values(o.nav).every((v) => v[0] && v[1]), `item 4 (${name}, hard bar): villagers from every district lot to the town's bell and back through the passage: ${json(o.nav)}`);
    // ---- item 7 (the verifier re-runs): the district removed: the wall and the gatehouse as built
    await kill();
    await undo(rb);
    await L.settle(3000);
    const after = await dump(all, `pg-${name}-after-district`);
    o.item7 = diffCols(before, after, [A, [B[0] - 8, B[1] - 8, B[2] + 8, B[3] + 8]]);
    o.item7.gate = (await hash(gb)) === gh0;
    check(o.item7.cells === 0 && o.item7.gate, `item 7 (${name}): the joined district removed: E-flat 0 over the town's claim and the district's (+8), the wall and gatehouse as built (${o.item7.cells}; ${json(o.item7.sample)})`);
    await kill();
    await undo(TR);
    await L.settle(3000);
    const fin = await dump(all, `pg-${name}-final`);
    o.final = diffCols(world0, fin, [[all[0], all[2], all[3], all[5]]]);
    check(o.final.cells === 0, `item 7 (${name}): then the town: E-flat 0 (${o.final.cells}; ${json(o.final.sample)})`);
  }
  await leaveWorld();
  spendZero();
  return out;
};

steps.pgunit = async () => {
  const out = {};
  out.pg = nodeTest(['kit/test/pg.test.mjs', 'kit/test/gj.test.mjs']);
  check(out.pg.code === 0 && out.pg.fail === 0 && out.pg.pass >= 24, `PG items 1, 2, 3, 5 (kit): kit/test/pg.test.mjs (a gatehouse-only town joins front port -> back port, a mixed wall in GJ's order, an unbuilt gatehouse skipped, a portcullis open and a swing skipped, the parity fixture) with gj.test.mjs: ${out.pg.pass} pass, ${out.pg.fail} fail`, out.pg.failing);
  out.k3 = nodeTest(['kit/test/k3.test.mjs', 'kit/test/gm-a.test.mjs', 'kit/test/districts-d3-parity.test.mjs']);
  check(out.k3.code === 0 && out.k3.fail === 0, `PG: K3's, GM-a's and D3's parity suites unchanged: ${out.k3.pass} pass, ${out.k3.fail} fail`, out.k3.failing);
  const g = srcGradle(root, () => spawnSync('./gradlew', ['test', '--offline', '-q', '--tests', '*GateJoinTest', '--tests', '*DistrictLandTest', '--tests', '*ApiGJTest', '--tests', '*ApiPGTest', '--tests', '*ApiRulesTest'], { cwd: path.join(root, 'mod'), encoding: 'utf8', env: { ...process.env, JAVA_HOME, GRADLE_USER_HOME: path.join(root, '.gradle-home') }, timeout: 1_800_000 }));
  out.java = { code: g.status, tail: `${g.stdout}${g.stderr}`.split('\n').filter((l) => /FAILED|tests completed|error/.test(l)).slice(0, 10) };
  check(g.status === 0, `PG (Java): GateJoin.gates and BesideReach.standing's walls equal the kit's on the passage fixture, the feature passageJoins: gradle exit ${g.status}`, out.java.tail);
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'PG', except: {} });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
  spendZero();
  return out;
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7apg.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
