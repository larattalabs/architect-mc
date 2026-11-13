#!/usr/bin/env node
// Slice HR gate (7c hidden rooms; docs/CONTRACT.md "Phase 7c" §3 row 3, "Slice HR as built") against the headless server of the HR run
// worktree (GATE6B_RUN, default `../architect-mc-HR-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). Ports
// 8908 (sidecar) / 8909 (DevBridge) by default (GATE6B_SIDECAR_PORT / GATE6B_DEV_PORT override: the verifier's 8920/8921). $0.
//
//   node tools/gate7chr.mjs <step>
//     unit      (hr-unit)      offline: kit/test/hr.test.mjs (the flip, x01-x03 checked clean in each host, the secrets only in the
//                              artifact, the renders and siteplan.json without the room, survival, the refusals, the recorded asks) and
//                              the 7c/P0/catalogue tests it touches; the Java ApiHRTest, PlanChecksSecretsTest, Api7cFTest; byte identity:
//                              every committed plan fixture planned here and on the merge base (../architect-mc-HR-main) identical but the
//                              named ones (HR_MOVED); the 59 asks here and on the merge base (both tables equal fixtures/plan/hr/asks-*.txt)
//     ingame    (hr-ingame)    creative, on the flat base (exact rules): x01 (a room in a hollow mountain, wall entrance), x02 (the hollow
//                              behind a waterfall) and x03 (a cellar under a cottage, trapdoor) each through Regions.checkPlan then
//                              realiseApproved: PLACED, the realised world equal to the check's virtual world (strict), the entrance as
//                              the artifact's secrets say, Remove E-flat 0; the secrets: absent from the check's preview and siteplan
//                              without the ask, present with PlanRequest ext architect_mc:secrets (the same artifact)
//     ghost     (hr-ghost)     (slice SR, S-7c-4) creative, on the flat base: x01 checked, its region ghost shown near the room: every
//                              shown tile's cells (payload sha and count) equal the kit's evalTile of the plan with the meta's secret
//                              parts unwritten (the host as before the room); the room's tile differs from the plan with the room
//     survival  (hr-survival)  survival (the RS base), strict (the verifier re-runs it): x01 and x03 (its cottages bound to RS's rs_hut)
//                              each checked in survival (the hollow free, held 0; the entrance its own target with its bill), an INSTANT
//                              twin, realised and fed from the owner's stockpile in waves: PLACED and built, the targets' bills equal the
//                              check's per part, the world equal to the twin cell for cell, items in = items out (the conservation sum
//                              exact once built and once removed: every item back), Remove E-flat 0
//     report                   REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7c-hr/<step>.json in the main checkout (GATE7CHR_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-HR-run');
process.env.GATE6B_OUT = process.env.GATE7CHR_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7c-hr');
process.env.GATE6B_SIDECAR_PORT ??= '8908';
process.env.GATE6B_DEV_PORT ??= '8909';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, connect, fails, log, results, root, state } = L;
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6crs-game.mjs');
const core = await import('./lib/gate6chy-core.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
const sum = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);

/** The committed fixtures whose answers move with HR (byte identity's named movers). */
export const HR_MOVED = Object.freeze({
  'asks/hidden_village.json': 'HR: waterfall_curtain\'s hollow deviation (asked in its own words) no longer says the hollow waits for 7c: it names the form.hidden_room part that builds it (still adjusted)',
  'extension/e20_7c_drafts.json': 'HR: vault (form.hidden_room in hold, bookshelf) answers fits (was unsupported until 7c)',
});
/** The asks lines that may move: a part that waited on form.hidden_room (none of the 59 has one; the table is checked whole). */
const ASKS_MOVE = /^(hidden_village\/waterfall_curtain) /;

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
  if (name !== 'report') L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice HR is $0: sim only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

steps.unit = async () => {
  const out = {};
  out.kit = kitOnce(['kit/test/hr.test.mjs', 'kit/test/bf.test.mjs', 'kit/test/f7c-foundation.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/catalogue-c38.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 30, `kit: hr.test.mjs (the flip, x01-x03 clean in each host, the secrets only in the artifact, the renders and siteplan.json without the room, survival, the refusals, the recorded asks) and the 7c/P0/catalogue tests it touches: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '-q', '--no-daemon', '--tests', 'dev.larattalabs.architect.apiimpl.ApiHRTest', '--tests', 'dev.larattalabs.architect.region.PlanChecksSecretsTest', '--tests', 'dev.larattalabs.architect.api.Api7cFTest'], { cwd: path.join(root, 'mod'), encoding: 'utf8', env, timeout: 1_800_000 });
  out.java = { code: g.status, tail: `${g.stdout}${g.stderr}`.split('\n').filter((l) => /FAIL|error/i.test(l)).slice(0, 10) };
  check(g.status === 0, 'Java: ApiHRTest (hiddenRooms follows the helper\'s plan.hiddenRooms; the jar\'s plan.json holds form.hidden_room supported), PlanChecksSecretsTest (the secrets in the preview and siteplan only when asked; the ask in the key only when made) and Api7cFTest', out.java.tail);
  // byte identity against the merge base, the named exceptions aside
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'HR', except: HR_MOVED, mergedIf: 'kit/lib/forms/hiddenRoom.mjs' });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
  fs.writeFileSync(path.join(OUT, 'hr-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  // the 59 asks on the merge base and here
  const before = await B.asksGap(path.join(path.resolve(root, '..', 'architect-mc-HR-main'), 'kit'), { current: true }), after = await B.asksGap(KIT, { current: true });
  fs.writeFileSync(path.join(OUT, 'hr-asks-before.txt'), before.text);
  fs.writeFileSync(path.join(OUT, 'hr-asks-after.txt'), after.text);
  const lines = (t) => new Map(t.split('\n').filter((l) => /^[a-z_0-9]+\/[a-z_0-9]+ /.test(l)).map((l) => [l.split(' ')[0], l]));
  const lb = lines(before.text), la = lines(after.text);
  const moved = [...new Set([...la.keys(), ...lb.keys()])].filter((k) => lb.get(k) !== la.get(k));
  const F = path.join(KIT, 'test', 'fixtures', 'plan', 'hr');
  out.asks = { moved: moved.map((k) => la.get(k)), malformed: after.malformed, committedAfter: fs.existsSync(path.join(F, 'asks-after.txt')) && fs.readFileSync(path.join(F, 'asks-after.txt'), 'utf8') === after.text, committedBefore: fs.existsSync(path.join(F, 'asks-before.txt')) && fs.readFileSync(path.join(F, 'asks-before.txt'), 'utf8') === before.text };
  check(after.malformed === 0 && moved.every((k) => ASKS_MOVE.test(`${k} `)) && out.asks.committedAfter && out.asks.committedBefore,
    `the 59 asks on the merge base and here: 0 malformed; no line moves but those named (${out.asks.moved.join('; ') || 'none'}); both tables equal fixtures/plan/hr/asks-{before,after}.txt (${out.asks.committedBefore}, ${out.asks.committedAfter})`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game

const planDir = (checkId) => path.join(L.SIDECAR_DATA, 'regions', 'plans', checkId);
const fixture = (n) => G.fixture(ctx, `hr/${n}`);
/** The snapshot box of a site: the claim and 8 round it, 16 under its lowest ground (the cellar) to 64 over its highest (the mountain). */
const boxOf = (W) => [W.claim[0] - 8, W.minY - 16, W.claim[1] - 8, W.claim[2] + 8, W.maxY + 64, W.claim[3] + 8];

/** One fixture in creative: check (with and without the secrets ask), realise, realised == virtual, the entrance's cells, remove (E-flat 0). */
async function creative(tag, fx, partId, probe) {
  const r = { tag };
  const s = await G.site(ctx, `hr ${tag}`, fx, { creative: true });
  const box = boxOf(s.W);
  await L.call('dev.waitChunks', { timeoutMs: 120_000 }, 150_000).catch(() => {});
  await L.settle(3000);
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`);
  await call('dev.region.dump', { box, file: before, light: false }, 1_800_000);
  const pre = await G.snap(ctx, box, `hr-${tag}-pre`);
  const ck = await G.check(ctx, tag, s);
  const a = ck.check?.parts?.find((p) => p.part === partId);
  r.check = { overall: ck.check?.overall, class: a?.class, reasons: a?.reasons, notes: a?.notes, parts: (ck.check?.parts ?? []).map((q) => [q.part, q.class]) };
  check(ck.check?.overall === 'READY' && ['fits', 'adjusted'].includes(a?.class) && a?.geometry === undefined, `${tag}: Regions.checkPlan: ${ck.check?.overall}, ${partId} ${a?.class} ${json(a?.reasons ?? [])} (no geometry in its answer)`, r.check);
  if (!ck.check?.artifactSha) return r;
  // the secrets: only in the artifact, unless asked
  const art = await call('dev.region.artifact', { sha: ck.check.artifactSha, body: true }, 60_000);
  const body = art.artifact?.body ? (typeof art.artifact.body === 'string' ? JSON.parse(art.artifact.body) : art.artifact.body) : null;
  const sec = (body?.secrets ?? []).find((q) => q.part === partId);
  const cell = sec?.entrance?.cell;
  const plainJson = JSON.stringify(ck.check ?? {}).replaceAll(' ', '');
  const asked = await call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate', ext: { 'architect_mc:secrets': true } }, 1_800_000);
  const ap = asked.check?.preview ?? {};
  r.secrets = { secret: sec, inPlain: !!cell && plainJson.includes(`[${cell.join(',')}]`), plainPreview: 'secrets' in (ck.check?.preview ?? {}), plainSiteplan: 'secrets' in (ck.check?.preview?.siteplan ?? {}), askedPreview: ap.secrets ?? null, askedSiteplan: ap.siteplan?.secrets ?? null, sameArtifact: asked.check?.artifactSha === ck.check.artifactSha };
  check(!!sec && !r.secrets.inPlain && !r.secrets.plainPreview && !r.secrets.plainSiteplan && JSON.stringify(ap.secrets) === JSON.stringify(body.secrets) && JSON.stringify(ap.siteplan?.secrets) === JSON.stringify(body.secrets) && r.secrets.sameArtifact,
    `${tag}: the secret (${sec?.entrance?.kind} at ${json(cell)}) is in the artifact's $.secrets[] only: not in the check, its preview or its siteplan; asked (ext architect_mc:secrets), the preview and the siteplan carry the artifact's secrets, the artifact the same (${r.secrets.sameArtifact})`, r.secrets);
  const region = await G.realise(ctx, ck.check.artifactSha);
  const st = await L.waitRegion(region, 3_600_000);
  r.state = st.view.state;
  check(st.view.state === 'PLACED', `${tag}: realiseApproved: ${st.view.state} (${st.record?.cellsWritten ?? st.view.cellsWritten ?? '?'} cells)`);
  await L.settle(5000);
  await call('dev.region.dump', { box, file: after, light: false }, 1_800_000);
  const RV = await import('./lib/realised-virtual.mjs');
  const rv = await RV.realisedVsVirtual(planDir(ck.check.checkId), after, before, { lots: true });
  r.virtual = { written: rv.written, differ: rv.differ, byKind: Object.fromEntries(Object.entries(rv.byKind).map(([k, v]) => [k, { written: v.written, differ: v.differ }])), first: rv.first };
  // (a waterfall's curtain: the cells over its basin the plan clears to air hold the falling water in the world, the body's own predicted
  // flow (H's spill); a `fluid` cell is accepted only when it is one of the plan's bodies' predicted cells, every other one stays loose)
  const fl = await fluidCells(planDir(ck.check.checkId), after);
  r.fluid = fl;
  const ok = RV.realisedOk({ ...rv, fluid: (rv.fluid ?? 0) - fl.predicted.length }, ['forms'], { strict: true });
  check(ok.pass && fl.other.length === 0, `${tag}: the realised world equals the check's virtual world (strict, the flat base): ${rv.differ} of ${rv.written} differ: ${RV.describeRealised(rv)}${fl.predicted.length ? `; ${fl.predicted.length} cleared cell(s) hold the plan's own bodies' predicted flow (a waterfall's curtain)` : ''}${rv.first.length ? ` first ${json(rv.first.slice(0, 3))}` : ''}`, { missing: ok.missing, loose: ok.loose, fluidOther: fl.other });
  if (probe && cell) {
    const blocks = {};
    // (read off the after dump: the world as realised)
    const { decodeArwd } = await imp('lib/region/vworld.mjs');
    const w = await decodeArwd(fs.readFileSync(after));
    for (const [k, c] of [['entrance', cell], ['over', [cell[0], cell[1] + 1, cell[2]]], ['under', [cell[0], cell[1] - 1, cell[2]]]]) blocks[k] = w.palette[w.cells[w.at(...c)]] ?? null;
    r.probe = blocks;
    check(probe(blocks), `${tag}: the entrance in the world: ${json(blocks)}`, blocks);
  }
  await G.remove(ctx, region);
  const e = await G.diff(ctx, box, pre);
  r.eflat = { mismatches: e.mismatches, list: e.list.slice(0, 8) };
  check(e.mismatches === 0, `${tag}: Regions.remove: E-flat ${e.mismatches} over the box`, r.eflat);
  return r;
}

/** The cells the plan clears to air that hold a fluid in the realised world: those in its bodies' predicted flow, and the rest. */
async function fluidCells(dir, afterFile) {
  const { loadPlanDir, virtualOf } = await imp('lib/lint/vworld-fixtures.mjs');
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const F = loadPlanDir(dir);
  const { vw } = virtualOf(F);
  const d = await decodeArwd(fs.readFileSync(afterFile));
  const b = d.box;
  const pred = new Set(F.ir.parts.flatMap((q) => q.ops).filter((o) => o.op === 'fluid').flatMap((o) => (o.predicted ?? []).map(([x, y, z]) => `${x},${y},${z}`)));
  const out = { predicted: [], other: [] };
  vw.eachWritten((x, y, z, idx) => {
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ) return;
    const want = vw.pal.states[idx], got = d.palette[d.cells[d.at(x, y, z)]];
    if (!/^minecraft:(air|cave_air)$/.test(want) || !/^minecraft:(water|lava)/.test(String(got))) return;
    (pred.has(`${x},${y},${z}`) ? out.predicted : out.other).push([x, y, z]);
  });
  return out;
}

steps.ingame = async () => {
  await ensure();
  spendZero();
  const out = {};
  const base = (b) => String(b ?? '').replace(/\[.*$/, '');
  out.x01 = await creative('x01', fixture('x01_mountain_room'), 'vault', (b) => base(b.entrance) === base(b.over) && /stone|deepslate/.test(base(b.entrance)));
  out.x02 = await creative('x02', fixture('x02_waterfall_hollow'), 'hollow', (b) => base(b.entrance) === 'minecraft:air' && base(b.over) === 'minecraft:air');
  out.x03 = await creative('x03', fixture('x03_cellar'), 'cellar', (b) => /_trapdoor$/.test(base(b.entrance)) && base(b.under) === 'minecraft:ladder');
  return out;
};

// ------------------------------------------------------------------ ghost (slice SR: the region ghost hides the room, S-7c-4)

/**
 * (7c SR) x01's region ghost (previewRegion) near the hidden room: every shown tile's payload sha equals the kit's own evalTile of the
 * plan dir's IR over windowFromSurvey with the plan meta's secret parts emptied (the host as before the room, as the previews draw it);
 * the tile holding the room differs from the un-hidden evaluation (so the check is not vacuous). Nothing is placed.
 */
steps.ghost = async () => {
  await ensure();
  spendZero();
  const out = {};
  const s = await G.site(ctx, 'hr ghost', fixture('x01_mountain_room'), { creative: true });
  const ck = await G.check(ctx, 'ghost', s);
  check(ck.check?.overall === 'READY' && !!ck.check?.checkId && !!ck.check?.artifactSha, `ghost x01: Regions.checkPlan ${ck.check?.overall} (check ${ck.check?.checkId})`);
  if (!ck.check?.checkId) return out;
  const art = await call('dev.region.artifact', { sha: ck.check.artifactSha, body: true }, 60_000);
  const body = art.artifact?.body ? (typeof art.artifact.body === 'string' ? JSON.parse(art.artifact.body) : art.artifact.body) : null;
  const sec = (body?.secrets ?? []).find((q) => q.part === 'vault');
  const room = sec?.room;
  const dir = planDir(ck.check.checkId);
  const { loadPlanDir } = await imp('lib/lint/vworld-fixtures.mjs');
  const { evalTile } = await imp('lib/realise.mjs');
  const { windowFromSurvey } = await imp('lib/region/survey.mjs');
  const F = loadPlanDir(dir);
  const hide = Object.entries(F.meta?.parts ?? {}).filter(([, m]) => m?.secret === true).map(([id]) => id).sort();
  out.hide = hide;
  out.room = room ?? null;
  check(!!room && hide.length === 2 && hide.every((id) => F.ir.parts.some((p) => p.id === id && p.ops.length > 0)), `ghost x01: the plan meta marks the room's parts secret (${json(hide)}), the artifact names the room's box ${json(room)}`);
  if (!room) return out;
  const roomKey = `${Math.floor(((room[0] + room[3]) / 2) / 64)},${Math.floor(((room[2] + room[5]) / 2) / 64)}`;
  // stand over the room (the ghost loads the tiles within NEAR = 64)
  const cx = Math.round((room[0] + room[3]) / 2), cz = Math.round((room[2] + room[5]) / 2);
  await L.tp(cx, Math.min(310, (s.W.maxY ?? 120) + 40), cz, 0, 90);
  const g = await call('dev.region.ghost', { planId: ck.check.checkId }, 120_000);
  out.show = g;
  // the ghost renders on a client (the step's host is the client, not the headless server)
  check(!g.refused, `ghost x01: dev.region.ghost shows the check's plan ${ck.check.checkId}${g.refused ? `: refused ${json(g.refused)}` : ` (${g.tiles} tiles)`}`, g.refused ?? null);
  if (g.refused) { await L.leaveWorld(); return out; }
  let st = null;
  const t0 = Date.now();
  for (;;) {
    await L.settle(3000);
    st = await call('dev.region.ghost', {}, 30_000);
    const shown = Object.keys(st.shown ?? {});
    if ((shown.length > 0 && shown.length >= (st.tilesRequested ?? 0) && shown.includes(roomKey)) || (st.errors ?? []).length || Date.now() - t0 > 240_000) break;
  }
  await call('dev.region.ghost', { off: true }, 30_000).catch(() => null);
  out.state = { tiles: st?.tiles, tilesRequested: st?.tilesRequested, tilesShown: st?.tilesShown, cellsShown: st?.cellsShown, errors: st?.errors ?? [], shown: st?.shown ?? {} };
  const hidden = { ...F.ir, parts: F.ir.parts.map((p) => (hide.includes(p.id) ? { ...p, ops: [] } : p)) };
  const rows = [];
  for (const [key, t] of Object.entries(st?.shown ?? {})) {
    const w = windowFromSurvey(F.survey, key);
    const host = evalTile(hidden, key, w, { blobs: F.blobs });
    const full = evalTile(F.ir, key, w, { blobs: F.blobs });
    rows.push({ key, cells: t.cells, sha: t.sha, host: host.sha, hostCount: Number(host.count), full: full.sha, fullCount: Number(full.count) });
  }
  out.tiles = rows;
  const bad = rows.filter((r) => r.sha !== r.host || r.cells !== r.hostCount);
  const at = rows.find((r) => r.key === roomKey);
  check(rows.length > 0 && bad.length === 0 && !(st?.errors ?? []).length, `ghost x01: ${rows.length} shown tile(s), each tile's cells (sha and count) equal the host without the room (the kit's evalTile with ${json(hide)} unwritten)${bad.length ? `; differ ${json(bad.map((r) => r.key))}` : ''}${(st?.errors ?? []).length ? `; errors ${json(st.errors)}` : ''}`, { bad, errors: st?.errors });
  check(!!at && at.full !== at.host && at.sha === at.host, `ghost x01: the room's tile ${roomKey} is shown and differs from the plan with the room (${at ? `${at.cells} cells; with the room ${at.fullCount}` : 'not shown'}): the ghost does not show the room`, at ?? null);
  await L.leaveWorld();
  return out;
};

// ------------------------------------------------------------------ survival (strict: the verifier re-runs it)

/** The lot entries a fixture binds: every lot of its plan RS's rs_hut. */
function entriesOf(fx) {
  const out = {};
  for (const z of fx.plan.zones ?? []) for (const l of z.program?.lots ?? []) out[l.id] = 'rs_hut';
  return out;
}

/**
 * One fixture built in survival: its INSTANT twin; a survival world checked in survival (the room's hollow free, held 0; its entrance its own
 * target with a bill), a stockpile, the conservation sum, realised and fed in waves: PLACED and built, the bills per part equal the check's,
 * the world equal to the twin, the sum exact; removed: E-flat 0, every item back (the sum exact again).
 */
async function buildOne(tag, fx, partId) {
  const out = { tag };
  const entries = entriesOf(fx);
  const T = await G.twin(ctx, `hr-${tag}`, fx, entries);
  const s = await G.site(ctx, `hr ${tag}`, fx);
  if (Object.keys(entries).length) await G.designs(ctx);
  const box = boxOf(s.W);
  const pre = await G.snap(ctx, box, `hr-${tag}-pre`);
  const ck = await G.check(ctx, `hr-${tag}`, s);
  const a = (ck.check?.parts ?? []).find((q) => q.part === partId);
  const sv = a?.cost?.survival;
  out.check = { overall: ck.check?.overall, survival: ck.check?.survival, part: { class: a?.class, survival: sv } };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && ['fits', 'adjusted'].includes(a?.class) && sv?.free > 0 && sv?.held === 0 && sum(sv?.bom) > 0 && JSON.stringify(sv?.entrance?.bom) === JSON.stringify(sv?.bom),
    `${tag} (survival): Regions.checkPlan in survival: ${ck.check?.overall}; ${partId} ${a?.class}: the hollow free ${sv?.free}, held ${sv?.held}; the entrance its own target, its bill ${json(sv?.entrance?.bom)} (the part's ${json(sv?.bom)})`, out.check);
  if (!ck.check?.artifactSha) return out;
  const crateAt = await G.pile(ctx, s, 3);
  const C = new G.Conservation(ctx, box);
  await C.start();
  const region = await G.realise(ctx, ck.check.artifactSha, entries);
  out.region = region;
  const p0 = await C.point('realised');
  let waves = 0;
  const f = await G.feed(ctx, region, { cons: C, fraction: 0.5, timeoutMs: 2_400_000, onWave: async () => { waves++; } });
  const st = f.last.st, rs = f.last.rs;
  out.feed = { waves: f.waves, inserted: f.inserted };
  out.build = rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent, parts: (rs.build.parts ?? []).map((q) => [q.part, q.state, q.targets?.length]) };
  check(st.view.state === 'PLACED' && rs.build?.built && rs.build?.done && rs.build?.percent === 100, `${tag} (survival): realiseApproved and fed in ${f.waves} waves (${sum(f.inserted)} items): ${st.view.state}, build ${json(out.build)}`);
  const targets = (rs.targets ?? []).filter((t) => t.part === partId || t.part === `${partId}:entrance`).map((t) => ({ target: t.target, part: t.part, cells: t.cells, built: t.built, bom: t.bom }));
  out.targets = targets;
  check(targets.length > 0 && targets.every((t) => t.built), `${tag} (survival): the entrance is a construction target, built: ${json(targets.map((t) => [t.part, t.cells, t.built, t.bom]))}`, targets);
  const bills = G.billsOf(ck, rs);
  // the entrance's target is its part's (group <part>:entrance): counted with the part
  if (bills.got[`${partId}:entrance`]) { bills.got[partId] = G.plus(bills.got[partId], bills.got[`${partId}:entrance`]); delete bills.got[`${partId}:entrance`]; }
  out.bills = bills;
  const differ = Object.keys({ ...bills.want, ...bills.got }).filter((p) => p in bills.want && !G.same(bills.want[p], bills.got[p]));
  // (the hidden room's own bill is HR's item; another part's difference (x03's hamlet: its pads' held dirt, the same with or without the
  // cellar) is recorded, not HR's to gate)
  out.billsDiffer = differ.map((p) => ({ part: p, diff: G.minus(bills.want[p], bills.got[p]) }));
  check(!differ.includes(partId) && G.same(bills.want[partId], sv?.bom), `${tag} (survival): ${partId}'s cost.survival.bom against its targets' bills put down (the entrance's target counted in its part): ${differ.includes(partId) ? `differs ${json(G.minus(bills.want[partId], bills.got[partId]))}` : `equal, item for item (${json(bills.got[partId])})`}${differ.length ? `; recorded, not HR's: ${differ.filter((p) => p !== partId).map((p) => `${p} ${json(G.minus(bills.want[p], bills.got[p]))}`).join('; ')}` : ''}`, bills);
  const pb = await C.point('built');
  out.builtPoint = pb;
  check(G.exact(p0) && G.exact(pb), `${tag} (survival): items in = items out once built: every item fed is in the stockpile or standing as a paid block (the conservation sum ${json(pb.diff)}, identity ${pb.identity})`, pb);
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d;
  check(d.mismatches === 0, `${tag} (survival): the realised world equals its INSTANT twin cell for cell (the crates aside): ${d.mismatches} differ`, d.list);
  const rm = await G.remove(ctx, region);
  out.removed = { removed: rm.removed, refund: rm.refund, kept: rm.kept };
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = { mismatches: ef.length, list: ef.slice(0, 8) };
  check(rm.removed && ef.length === 0, `${tag} (survival): Regions.remove: E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
  const pr = await C.point('removed');
  out.removedPoint = pr;
  check(G.exact(pr), `${tag} (survival): items in = items out once removed: every item back (the conservation sum ${json(pr.diff)}, identity ${pr.identity}; refund ${json(rm.refund)})`, pr);
  out.conservation = C.points;
  return out;
}

steps.survival = async () => {
  await ensure();
  spendZero();
  const out = {};
  out.x01 = await buildOne('s01', fixture('x01_mountain_room'), 'vault');
  out.x03 = await buildOne('s03', fixture('x03_cellar'), 'cellar');
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'ingame', 'survival']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7c-HR (hidden rooms)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7chr.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
