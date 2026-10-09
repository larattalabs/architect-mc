#!/usr/bin/env node
// Phase 6b gate (docs/CONTRACT.md "# Phase 6b contract", §12) against the dev client of the 6b run worktree
// (`../architect-mc-6b-run`, tools/run-gate6b-client.sh). Regions go through the DevBridge (docs/DEVBRIDGE.md "Regions
// (phase 6b)"). The client is launched and stopped by PID. Paid steps (the template picks: crater, rift, picks) run on the
// claude login only: the script refuses to start with an API key or token in its environment, and logs the sidecar's auth
// mode at each paid step (artifacts/gate6b/auth.log); spend is summed in artifacts/gate6b/spend.json, cap $3.
//
//   node tools/gate6b.mjs <step> [args]       steps at the end of this file
//
// Evidence: artifacts/gate6b/<step>.json in the main checkout (GATE6B_OUT overrides), all.log, REPORT.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CAP_USD, GAME_DIR, LIBRARY, SIDECAR_DATA, SIDECAR_PORT as SIDECAR_PORT_6B, MAIN, OUT, RUN, SAVES, call, check, clientPids, cmd, connect, copyWorld, fails, fresh, leaveWorld, log, logAuth,
  openWorld, plan, prepare, realise, refuseKeys, results, root, setRules, settle, sleep, spendAdd, spendGuard, spendRead, startClient, state,
  stopClient, tp, waitRegion, write,
} from './lib/run6b.mjs';
import { findSite, SCENARIO_DIR, readScenario } from './find-site.mjs';

refuseKeys();

/** The pinned world seed of every 6b fixture (S1-S6, the crater and rift gate sites, the volume fixture). */
export const SEED = '2026100906';
const STUB_IDS = ['g6a_stub_9', 'g6a_stub_14', 'g6a_stub_19', 'g6a_stub_24'];
const KIT_EXAMPLES = ['cabin', 'gatehouse', 'tavern', 'tower'];
export const LOT_ENTRIES = [...STUB_IDS, ...KIT_EXAMPLES];
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';

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
  if (!['stop', 'start'].includes(name)) write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
const box3 = (claim, y0, y1, m = 8) => [claim[0] - m, y0 - m, claim[1] - m, claim[2] + m, y1 + m, claim[3] + m];

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? FLAT, { backend: process.argv[4] ?? 'sim' });
  return { head, pids: clientPids() };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
  return { pids: clientPids() };
};

/** The base worlds: the pinned seed's normal world (default rules) and a flat one (the exact rules); the stub blueprints. */
steps.base = async () => {
  await ensure();
  for (const [name, preset] of [[BASE, 'normal'], [FLAT, 'flat']]) {
    if (fs.existsSync(path.join(SAVES, name, 'level.dat'))) continue;
    await leaveWorld();
    await openWorld(name, { mode: 'creative', preset, seed: SEED, cheats: true });
    await setRules(preset === 'flat' ? 'exact' : 'default');
    await tp(0.5, 200, 0.5);
    await cmd('/save-all flush');
    await leaveWorld();
  }
  if (!STUB_IDS.every((id) => fs.existsSync(path.join(LIBRARY, id)) || fs.existsSync(path.join(LIBRARY, `${id}.nbt`)))) execFileSync('node', [path.join(root, 'tools', 'gate6a-stubs.mjs'), LIBRARY]);
  return { worlds: [BASE, FLAT], seed: SEED };
};

/** find-site for the scenarios and gate sites: `findsite <id>|all`. */
steps.findsite = async () => {
  await ensure();
  const all = [...fs.readdirSync(SCENARIO_DIR), ...fs.readdirSync(path.join(SCENARIO_DIR, 'sites'))].filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  const ids = process.argv[3] && process.argv[3] !== 'all' ? process.argv[3].split(',') : all;
  const out = {};
  for (const id of ids) {
    const sc = readScenario(id);
    if (sc.fixture?.surveySha && !process.env.REFIND) { out[id] = { pinned: sc.fixture }; continue; }
    await fresh('G6B FindSite', BASE);
    out[id] = await findSite(id, { call, cmd, tp, log });
    check(!!out[id].claim, `findsite ${id}: ${JSON.stringify(out[id].claim)} score ${out[id].score} (${out[id].tried} candidates)`);
  }
  await leaveWorld();
  return out;
};

/** A crater_works end to end on the flat world: plan (report, previews), prepare, realise with lots, the group undo exact. */
steps.smoke = async () => {
  await ensure();
  await fresh('G6B Smoke', FLAT);
  await tp(0.5, 120, 0.5);
  const claim = [-100, -100, 99, 99];
  const p = await plan('crater_works', claim, { surveyLoad: 'bounded:256' });
  check(!!p.report && p.report.errors === 0, `smoke: the plan carries a report (${p.report?.errors} errors, ${p.report?.warnings} warnings)`, p.summary);
  check(!!p.previews?.paths && Object.keys(p.previews.paths).length >= 4, `smoke: the plan carries previews (${JSON.stringify(p.previews).slice(0, 200)})`);
  const pr = await prepare(p.planId);
  const p2 = await plan('crater_works', claim, { surveyLoad: 'generated:64' });
  const yr = p2.claimY ?? [-64, 319];
  const box = box3(claim, yr[0], yr[1]);
  const h0 = await call('dev.region.hash', { box }, 3_600_000);
  const region = await realise(p2.planId, { lotEntries: LOT_ENTRIES, fitLots: true });
  const st = await waitRegion(region, 3_600_000);
  check(st.view.state === 'PLACED', `smoke: region ${region} ${st.view.state}, ${st.view.cellsWritten} cells, lots ${JSON.stringify(st.view.lots.map((l) => l.state))}`);
  const rm = await call('dev.region.remove', { region }, 3_600_000);
  await settle(5000);
  const h2 = await call('dev.region.hash', { box }, 3_600_000);
  check(rm.removed && h2.sha256 === h0.sha256, `smoke: the group undo is exact (${rm.restored} cells, ${rm.seconds?.toFixed(1)} s)`, rm);
  await leaveWorld();
  return { plan: { planId: p2.planId, irSha: p2.irSha, budget: p2.budget, report: p2.report?.errors }, prepare: pr.stats, state: st.view, remove: rm };
};

// ------------------------------------------------------------------ helpers for the gate items
const site = (id) => { const sc = readScenario(id); if (!sc.fixture?.claim) throw new Error(`${id}: not pinned (findsite ${id})`); return sc.fixture; };
const centre = (c) => [(c[0] + c[2]) / 2, (c[1] + c[3]) / 2];
const sub200 = (c, n = 200) => { const [x, z] = centre(c).map(Math.floor); return [x - n / 2, z - n / 2, x + n / 2 - 1, z + n / 2 - 1]; };
const planFile = (planId, f) => path.join(SIDECAR_DATA, 'regions', 'plans', planId, f);
const readPlanJson = (planId, f) => JSON.parse(fs.readFileSync(planFile(planId, f), 'utf8'));
const SHOTS = path.join(OUT, 'shots6b');
async function shot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const s = await call('dev.screenshot', { name: `g6b_${name}`, frames: 20, chunkTimeoutMs: 60_000 }, 180_000);
  const to = path.join(SHOTS, `${name}.png`);
  fs.copyFileSync(s.path, to);
  return to;
}
async function stateOf(region) { return call('dev.region.state', { region }, 60_000); }
async function waitFor(region, pred, ms, what) {
  const end = Date.now() + ms;
  let st;
  while (Date.now() < end) {
    st = await stateOf(region);
    if (pred(st)) return st;
    await sleep(3000);
  }
  throw new Error(`${region}: timed out waiting for ${what} (${JSON.stringify({ state: st?.view?.state, waiting: st?.view?.waiting, actions: st?.actions })})`);
}
const kinds = (st) => (st.actions ?? []).map((a) => a.kind);
/** Whether the block at (x, y, z) is `id` (an /execute test; the command's feedback says passed or failed). */
async function blockIs(x, y, z, id) {
  const r = await cmd(`/execute if block ${x} ${y} ${z} ${id}`);
  return { ok: /passed/i.test(JSON.stringify(r.messages ?? r)), said: r.messages ?? r };
}
/** The newest plan dir of `program` made after `t0` (a plan started from chat). */
function newestPlan(program, t0) {
  const dir = path.join(SIDECAR_DATA, 'regions', 'plans');
  const c = fs.readdirSync(dir).map((d) => ({ d, t: fs.statSync(path.join(dir, d)).mtimeMs })).filter((x) => x.t >= t0 - 1000).sort((a, b) => b.t - a.t);
  for (const x of c) { try { if (JSON.parse(fs.readFileSync(path.join(dir, x.d, 'request.json'), 'utf8')).program === program && fs.existsSync(path.join(dir, x.d, 'ir.json'))) return x.d; } catch { /* partial */ } }
  return null;
}

/** Item 4: mega_bench's plan with the check, on the prepared mega world (a copy of 6a's), full resolution, per rule. */
steps.checktime = async () => {
  await ensure();
  await fresh('G6B Mega', 'G6A Mega Base Prepared');
  await tp(0.5, 160, 0.5);
  const claim = [-500, -500, 499, 499];
  const t0 = Date.now();
  const bare = await call('dev.region.plan', { program: 'mega_bench', claim, surveyLoad: 'generated:64', check: false }, 900_000);
  const bareMs = Date.now() - t0;
  const t1 = Date.now();
  const p = await call('dev.region.plan', { program: 'mega_bench', claim, surveyLoad: 'generated:64', check: true }, 900_000);
  const withMs = Date.now() - t1;
  if (p.refused || bare.refused) throw new Error(`plan refused: ${p.refused ?? bare.refused}`);
  const rep = readPlanJson(p.planId, 'report.json');
  const prog = await call('dev.region.progress', { planId: p.planId }).catch(() => null);
  const checkMs = rep.ms?.total ?? null;
  check(checkMs !== null && checkMs <= 120_000, `checktime: mega_bench full-resolution check ${(checkMs / 1000).toFixed(1)} s single-threaded (bar 120 s; coarse = full: 60 s), per rule ${JSON.stringify(rep.ms?.perRule)}`);
  check(withMs - checkMs <= 30_000, `checktime: mega_bench plan with the check ${(withMs / 1000).toFixed(1)} s = ${((withMs - checkMs) / 1000).toFixed(1)} s + the check (bar 30 s + the check; without the check ${(bareMs / 1000).toFixed(1)} s)`);
  check(rep.errors === 0, `checktime: mega_bench's report: ${rep.errors} errors, ${rep.warnings} warnings (${[...new Set(rep.findings.map((f) => f.rule))].join(', ')})`);
  await leaveWorld();
  return { bareMs, withMs, check: rep.ms, resolution: rep.resolution, findings: rep.findings.map((f) => `${f.rule} ${f.part} x${f.count}`), progress: prog };
};

/** Item 6: the region ghost for crater_works (flat world) and S1 (its fixture), inside and beyond 64 blocks. */
steps.ghost = async () => {
  await ensure();
  const out = {};
  const cases = [
    { id: 'crater', world: FLAT, program: 'crater_works', claim: [-100, -100, 99, 99], params: {} },
    { id: 's1', world: BASE, program: 'floating_islands', claim: site('s1_floating_islands').claim, params: {}, seed: readScenario('s1_floating_islands').seed ?? undefined },
  ];
  for (const c of cases) {
    await fresh(`G6B Ghost ${c.id}`, c.world);
    const [cx, cz] = centre(c.claim);
    await tp(cx, 200, cz);
    const p = await plan(c.program, c.claim, { params: c.params, surveyLoad: 'bounded:256', seed: c.seed });
    const g = await call('dev.region.ghost', { planId: p.planId }, 120_000);
    await settle(8000);
    const st = await call('dev.region.ghost', {}, 30_000);
    const yTop = (p.claimY ?? [60, 200])[1];
    const views = {
      inside: [cx + 20, Math.min(yTop + 10, 300), cz + 60, 180, 35],
      edge: [cx, Math.min(yTop + 30, 310), c.claim[3] + 40, 180, 30],
      beyond: [cx, Math.min(yTop + 60, 315), c.claim[3] + 160, 180, 25],
    };
    out[c.id] = { planId: p.planId, ghost: g, state: st, shots: {} };
    for (const [k, v] of Object.entries(views)) {
      await call('dev.camera', { x: v[0], y: v[1], z: v[2], yaw: v[3], pitch: v[4], mode: 'spectator' }, 30_000);
      await settle(4000);
      out[c.id].shots[k] = await shot(`ghost_${c.id}_${k}`);
      out[c.id][`state_${k}`] = await call('dev.region.ghost', {}, 30_000);
    }
    await call('dev.release', {}).catch(() => null);
    await call('dev.region.ghost', { off: true }, 30_000);
    check(!g.refused && (st.tilesShown ?? 0) > 0 && (st.cellsShown ?? 0) > 0, `ghost ${c.id}: on (${st.tilesShown}/${st.tiles} tiles, ${st.cellsShown} cells shown, verdict ${st.verdict}, errors ${JSON.stringify(st.errors ?? [])}); shots in artifacts/gate6b/shots6b`);
  }
  await leaveWorld();
  return out;
};

/** Item 7: Survey.volume over the pinned cliff-and-cave fixture (256x256x128): MSPT, bytes, sha twice, class counts; the cell limit. */
steps.volume = async () => {
  await ensure();
  const fx = site('volume_site');
  const c = fx.claim;
  const y0 = Math.max(-64, (fx.stats?.min ?? 40) - 40);
  const box = [c[0], y0, c[1], c[0] + 255, y0 + 127, c[1] + 255];
  await fresh('G6B Volume', BASE);
  const [cx, cz] = centre(c);
  await tp(cx, y0 + 140, cz);
  // the area generated first (the measurement is the sampling, not worldgen)
  await call('dev.chunks.status', { box: [box[0], box[2], box[3], box[5]] }, 600_000).catch(() => null);
  const runs = [];
  for (let i = 0; i < 2; i++) {
    await call('dev.mspt.trace', { start: true });
    const v = await call('dev.survey.volume', { box, load: 'generated:64' }, 1_800_000);
    const m = await call('dev.mspt.trace', { stop: true });
    if (v.refused) throw new Error(`volume refused: ${v.refused}`);
    let fileSha = null;
    try { const zlib = await import('node:zlib'); const b = fs.readFileSync(path.isAbsolute(v.file) ? v.file : path.join(GAME_DIR, v.file)); fileSha = (await import('node:crypto')).createHash('sha256').update(b[0] === 0x1f ? zlib.gunzipSync(b) : b).digest('hex'); } catch (e) { fileSha = `unreadable: ${e.message}`; }
    runs.push({ ...v, mspt: m.all, fileSha });
    log(`  volume ${i + 1}: ${v.cells} cells in ${(v.sampleMs / 1000).toFixed(1)} s sampling (${Math.round(v.cellsPerSecond)} cells/s), ${v.bytes} bytes (${v.bytesPerCell.toFixed(4)} B/cell), max slice ${v.maxTickMs.toFixed(1)} ms, counts ${JSON.stringify(v.counts)}, MSPT ${JSON.stringify(m.all)}`);
  }
  const [a, b] = runs;
  check(a.mspt.over50 === 0 && b.mspt.over50 === 0, `volume: 0 ticks over 50 ms while sampling (max ${a.mspt.max.toFixed(1)}/${b.mspt.max.toFixed(1)} ms; max sampling slice ${a.maxTickMs.toFixed(1)} ms)`);
  check(a.sha === b.sha, `volume: a second sample of the unchanged area gives the same sha (${a.sha.slice(0, 12)})`);
  check(a.fileSha === a.sha, `volume: the frozen file reads back to the sha (${String(a.fileSha).slice(0, 12)})`);
  const need = ['ROCK', 'AIR', 'WATER', 'LOG', 'LEAVES'];
  check(need.every((k) => (a.counts[k] ?? 0) > 0), `volume: ROCK, AIR, WATER, LOG and LEAVES each above 0 (${need.map((k) => `${k} ${a.counts[k] ?? 0}`).join(', ')})`);
  const cps = Math.min(a.cellsPerSecond, b.cellsPerSecond);
  const bpc = Math.max(a.bytesPerCell, b.bytesPerCell);
  const limit = Math.floor(Math.min(60 * cps, (64 * 1024 * 1024) / bpc) / 1e6) * 1e6;
  log(`  volume: the cell limit at the measured rates (60 s of sampling at ${Math.round(cps)} cells/s, 64 MB at ${bpc.toFixed(4)} B/cell): ${limit}`);
  await leaveWorld();
  return { box, runs: runs.map((r) => ({ ...r, file: undefined })), cellsPerSecond: cps, bytesPerCell: bpc, limit, current: a.maxCells };
};

/** A paid design on the claude login: the guard, the auth log, the spend ledger. */
async function design(step, req) {
  refuseKeys();
  spendGuard(0.1);
  const auth = await logAuth(step);
  if (auth.keysInEnv.length || auth.useClaudeLogin === false) throw new Error(`refused: ${step} needs the claude login (auth ${JSON.stringify(auth)})`);
  const d = await call('dev.region.design', { ...req, wait: true }, 1_800_000);
  spendAdd({ step, usd: d.costUsd ?? 0, designId: d.designId, brief: req.brief, outcome: d.result?.outcome ?? d.status });
  log(`  design ${step}: ${d.status} ${JSON.stringify(d.result ?? d.error ?? d.refused)} $${(d.costUsd ?? 0).toFixed(4)} in ${((d.ms ?? 0) / 1000).toFixed(0)} s`);
  return d;
}
const M14 = (rep) => rep.findings.filter((f) => /^M[1-4](\b|:)/.test(f.rule));

/** Steward's crater gate (§7.3) steps 1-5 (and the rift's 2-5) on a fresh world at the pinned site. */
async function designGate(name, siteId, req, program, { playerBlock = false } = {}) {
  await ensure();
  const fx = site(siteId);
  const claim = fx.claim;
  await fresh(`G6B ${name}`, BASE);
  const [cx, cz] = centre(claim);
  await tp(cx, (fx.stats?.max ?? 80) + 60, cz);
  const out = { claim };
  const d = await design(name, { ...req, claim });
  out.design = d;
  const picked = d.result?.outcome === 'PICKED' && d.result?.program === program && !!d.result?.planId;
  check(picked, `${name}: step 1: Regions.design picks ${program} (${d.result?.outcome} ${d.result?.program} ${JSON.stringify(d.result?.params)}; ${d.result?.reason ?? d.error ?? ''})`);
  if (!picked) { await leaveWorld(); return out; }
  const planId = d.result.planId;
  const rep = readPlanJson(planId, 'report.json');
  out.report = { errors: rep.errors, warnings: rep.warnings, findings: rep.findings.map((f) => `${f.rule} ${f.severity} ${f.part ?? '-'} x${f.count}`) };
  check(rep.errors === 0 && M14(rep).length === 0, `${name}: step 2: the plan has no M1-M4 findings and no errors (${rep.errors} errors; ${out.report.findings.join('; ') || 'no findings'})`);
  const t0 = Date.now();
  await prepare(planId);
  out.prepareSeconds = (Date.now() - t0) / 1000;
  // realise over the prepared chunks (the design's plan), with the lots from the library (no model call)
  const ir = readPlanJson(planId, 'ir.json');
  const box = [claim[0] - 8, ir.claim.minY, claim[1] - 8, claim[2] + 8, ir.claim.maxY, claim[3] + 8];
  await call('dev.region.hash', { box, mode: 'snap', file: path.join(OUT, `${name}.snap.gz`) }, 4 * 3_600_000);
  let pb = null;
  if (playerBlock) {
    // case (a): a non-natural block (no block entity) inside a lot's pad area, before realise
    const lot = ir.lots[0];
    const b = lot.box;
    pb = [b.minX + 2, b.minY + 1, b.minZ + 2];
    await cmd(`/setblock ${pb[0]} ${pb[1]} ${pb[2]} minecraft:red_wool`);
    out.playerBlockA = { lot: lot.id, at: pb };
  }
  const { fitEntries } = await import('./scenarios.mjs');
  const lots = fitEntries(ir.lots);
  await call('dev.mspt.trace', { start: true });
  const region = await realise(planId, { lots });
  const st = await waitRegion(region, 3 * 3_600_000);
  out.mspt = (await call('dev.mspt.trace', { stop: true })).all;
  out.region = region;
  out.state = { state: st.view.state, cells: st.view.cellsWritten, lots: st.view.lots.map((l) => `${l.id}:${l.state}${l.reason ? `:${l.reason}` : ''}`), failed: st.failed };
  if (playerBlock) {
    const lotA = st.view.lots.find((l) => l.id === out.playerBlockA.lot);
    out.playerBlockA.lotState = lotA;
    check(st.view.state === 'PARTIAL' && lotA && lotA.state !== 'placed', `${name}: step 6 (case a): the lot over the player's block refuses (${JSON.stringify(lotA)}) and the region ends ${st.view.state} (bar PARTIAL); the other lots ${out.state.lots.join(', ')}`);
  } else {
    check(st.view.state === 'PLACED' && st.view.lots.every((l) => l.state === 'placed'), `${name}: steps 3-4: prepared (${out.prepareSeconds.toFixed(0)} s), realised through the queue: ${st.view.state}, every lot placed (${out.state.lots.join(', ')}), ${st.view.cellsWritten} cells`);
  }
  // case (b): a block on a path or pad cell after realise
  let pbB = null;
  if (playerBlock) {
    const meta = readPlanJson(planId, 'meta.json');
    const [pid, pm] = Object.entries(meta.paths ?? {}).find(([, m]) => m.kind === 'bridge') ?? Object.entries(meta.paths ?? {})[0] ?? [];
    if (pm) {
      const c0 = pm.cells[Math.floor(pm.cells.length / 2)];
      const at = [c0[0], c0[1] + 1, c0[2]];
      await cmd(`/setblock ${at[0]} ${at[1]} ${at[2]} minecraft:blue_wool`);
      pbB = at;
      out.playerBlockB = { path: pid, at };
    }
  }
  await cmd('/kill @e[type=!minecraft:player]');
  await settle(5000);
  const rm = await call('dev.region.remove', { region }, 4 * 3_600_000);
  await settle(10_000);
  const diff = await call('dev.region.hash', { box, mode: 'diff', file: path.join(OUT, `${name}.snap.gz`) }, 4 * 3_600_000);
  out.remove = { removed: rm.removed, restored: rm.restored, kept: rm.kept, seconds: rm.seconds };
  out.diff = { mismatches: diff.mismatches, classes: diff.classes, sample: (diff.sample ?? []).slice(0, 20) };
  const expected = (playerBlock ? 1 : 0) + (pbB ? 1 : 0);
  const unclassified = diff.classes?.none ?? 0;
  check(rm.removed && unclassified <= expected && diff.mismatches <= expected + 0.0001 * st.view.cellsWritten, `${name}: step 5: one Regions.remove returns the area under the 6a rules (${diff.mismatches} mismatches ${JSON.stringify(diff.classes)}; the player's blocks ${expected})`);
  if (playerBlock) {
    const a = await blockIs(pb[0], pb[1], pb[2], 'minecraft:red_wool');
    check(a.ok, `${name}: step 6: after the group undo the player's block (case a) is still there (${JSON.stringify(a.said)})`);
    if (pbB) {
      const bb = await blockIs(pbB[0], pbB[1], pbB[2], 'minecraft:blue_wool');
      const keptOk = JSON.stringify(rm.kept ?? []).length > 2;
      check(bb.ok && keptOk, `${name}: step 7 (case b): the block on path ${out.playerBlockB.path} survives the group undo (${JSON.stringify(bb.said)}) and is reported in kept (${JSON.stringify(rm.kept).slice(0, 200)})`);
    }
  }
  await leaveWorld();
  return out;
}

steps.crater = async () => designGate('Crater', 'crater_site', { brief: 'repurposed giant meteor crater mining facility, hellish evil lair', card: { site: 'giant meteor crater', purpose: 'mining facility', style: 'hellish evil lair', text: 'repurposed giant meteor crater mining facility, hellish evil lair' } }, 'crater_works', { playerBlock: false });
steps.craterab = async () => designGate('CraterAB', 'crater_site', { brief: 'repurposed giant meteor crater mining facility, hellish evil lair', card: { site: 'giant meteor crater', purpose: 'mining facility', style: 'hellish evil lair', text: 'repurposed giant meteor crater mining facility, hellish evil lair' } }, 'crater_works', { playerBlock: true });
steps.rift = async () => designGate('Rift', 'rift_site', { brief: 'a rift settlement', card: { site: 'rift', purpose: 'settlement', text: 'a rift settlement' } }, 'rift_city');

/** 8b: pick accuracy, six briefs on their pinned sites (no plan is realised). */
steps.picks = async () => {
  await ensure();
  const briefs = [
    ['a walled town on a hill, with gates and towers', 'walled_hill', 'hill_site'],
    ['a stone citadel floating on a single great sky rock, held up by pillars', 'sky_isle', 's1_floating_islands'],
    ['a scattered hamlet on several small floating islands', 'floating_islands', 's1_floating_islands'],
    ['a mining camp in a blasted crater', 'crater_works', 'crater_site'],
    ['a town built down the walls of a deep canyon', 'rift_city', 'rift_site'],
    ['a cozy two-room cottage', 'NO_TEMPLATE', 'crater_site'],
  ];
  await fresh('G6B Picks', BASE);
  const rows = [];
  for (const [brief, want, siteId] of briefs) {
    const fx = site(siteId);
    const claim = siteId === 's1_floating_islands' ? sub200(fx.claim, 240) : fx.claim;
    const [cx, cz] = centre(claim);
    await tp(cx, (fx.stats?.max ?? 80) + 60, cz);
    const d = await design(`pick:${want}`, { brief, claim });
    const r = d.result ?? {};
    const got = r.fits === false || r.outcome === 'NO_TEMPLATE' ? 'NO_TEMPLATE' : r.program;
    rows.push({ brief, want, got, fits: r.fits, offered: r.program, reason: r.reason, tries: r.tries, usd: d.costUsd });
  }
  const ok = rows.filter((x) => x.got === want(x)).length;
  function want(x) { return x.want; }
  const nt = rows.find((x) => x.want === 'NO_TEMPLATE');
  check(ok >= 5 && nt.got === 'NO_TEMPLATE', `picks: ${ok} of 6 as expected, the NO_TEMPLATE brief ${nt.got === 'NO_TEMPLATE' ? 'among them' : 'MISSED'} (${rows.map((x) => `${x.want}->${x.got}`).join(', ')})`);
  await leaveWorld();
  return rows;
};

/** Item 9: the command path on crater_works at 200x200 under default gamerules, exact; the four nudges. */
steps.commands = async () => {
  await ensure();
  const claim = sub200(site('crater_site').claim);
  await fresh('G6B Commands', BASE);
  const [cx, cz] = centre(claim);
  await tp(cx, 140, cz);
  const said = {};
  const say = async (k, c) => { const r = await cmd(c); said[k] = r.messages ?? r; log(`  ${c}: ${JSON.stringify(r.messages ?? r).slice(0, 300)}`); return r; };
  const tPlan = Date.now();
  await say('plan', `/architect region plan crater_works ${claim.join(' ')}`);
  let planId = null;
  for (let i = 0; i < 300 && !planId; i++) { await sleep(2000); planId = newestPlan('crater_works', tPlan); }
  await sleep(5000); // the check and previews finish after ir.json
  if (!planId) throw new Error('no plan id in chat after /architect region plan');
  await say('check', '/architect region check');
  await say('preview', '/architect region preview');
  await say('prepare', '/architect region prepare');
  for (let i = 0; i < 1800; i++) { const s = await call('dev.region.prepare.state', { planId }).catch(() => null); if (s && /DONE|READY|COMPLETE/i.test(JSON.stringify(s.view ?? s))) break; await sleep(2000); }
  const ir = readPlanJson(planId, 'ir.json');
  const box = [claim[0] - 8, ir.claim.minY, claim[1] - 8, claim[2] + 8, ir.claim.maxY, claim[3] + 8];
  await call('dev.region.hash', { box, mode: 'snap', file: path.join(OUT, 'G6B_Commands.snap.gz') }, 4 * 3_600_000);
  await say('realise', '/architect region realise fill');
  let region = null;
  for (let i = 0; i < 60 && !region; i++) { await sleep(2000); region = ((await call('dev.region.list', {})).regions ?? []).find((r) => r.planId === planId)?.id ?? null; }
  if (!region) throw new Error('no region after /architect region realise');
  const st = await waitRegion(region, 3 * 3_600_000);
  await say('state', '/architect region state');
  await cmd('/kill @e[type=!minecraft:player]');
  await settle(5000);
  await say('remove', '/architect region remove');
  for (let i = 0; i < 600; i++) { const s = await stateOf(region).catch(() => ({ missing: true })); if (s.missing || /REMOVED/.test(s.view?.state ?? '')) break; await sleep(2000); }
  await settle(10_000);
  const diff = await call('dev.region.hash', { box, mode: 'diff', file: path.join(OUT, 'G6B_Commands.snap.gz') }, 4 * 3_600_000);
  check(st.view.state === 'PLACED', `commands: plan, check, preview, prepare, realise fill through /architect region: ${st.view.state}, ${st.view.cellsWritten} cells`);
  check((diff.classes?.none ?? 0) === 0 && diff.mismatches <= 0.0001 * st.view.cellsWritten, `commands: /architect region remove is exact under the classified-mismatch rule (${diff.mismatches} ${JSON.stringify(diff.classes)})`);
  await leaveWorld();
  return { planId, region, said, diff: { mismatches: diff.mismatches, classes: diff.classes } };
};

/** Item 9: each nudge once: PREPARE (not prepared), MOVE_CLOSER (LOADED_ONLY, far), START_SIDECAR (killed), APPROVE_STAGE (a dig). */
steps.nudges = async () => {
  await ensure();
  const out = {};
  const claim = [3000, 3000, 3199, 3199]; // fresh land, never generated in the base world
  const [cx, cz] = centre(claim);
  const nudge = async (region, action) => { const r = await call('dev.region.nudge', { region, action }, 120_000); log(`  nudge ${action}: ${JSON.stringify(r)}`); return r; };
  // PREPARE: realise over ungenerated land; the region waits NOT_GENERATED; the first nudge shows the estimate, the second starts it
  await fresh('G6B Nudge Prepare', FLAT);
  await tp(0.5, 120, 0.5);
  {
    const p = await plan('crater_works', claim, { surveyLoad: 'bounded:256' });
    const region = await realise(p.planId, { load: 'loaded', lotEntries: LOT_ENTRIES, fitLots: true });
    const w = await waitFor(region, (s) => kinds(s).includes('PREPARE') || kinds(s).includes('MOVE_CLOSER'), 300_000, 'a PREPARE or MOVE_CLOSER action');
    out.prepareActions = w.actions;
    if (kinds(w).includes('PREPARE')) {
      const a = await nudge(region, 'PREPARE');
      const b = await nudge(region, 'PREPARE');
      check(!a.done && /estimate|would generate/i.test(a.message) && b.done, `nudges: PREPARE shows the size and time first (${a.message}), then starts it (${b.message})`);
      out.prepare = { first: a, second: b };
    } else {
      // over LOADED_ONLY the far, unloaded items ask the player to move: that is MOVE_CLOSER
      const a = await nudge(region, 'MOVE_CLOSER');
      out.moveCloserFirst = a;
    }
    await call('dev.region.remove', { region, force: true }, 600_000).catch(() => null);
  }
  await leaveWorld();
  // MOVE_CLOSER: a prepared site, LOADED_ONLY, the player 3000 blocks away
  await fresh('G6B Nudge Move', FLAT);
  await tp(0.5, 120, 0.5);
  {
    const c2 = [-100, -100, 99, 99];
    const p = await plan('crater_works', c2, { surveyLoad: 'bounded:256' });
    await prepare(p.planId);
    await tp(4000.5, 120, 4000.5);
    await settle(5000);
    const region = await realise(p.planId, { load: 'loaded', lotEntries: LOT_ENTRIES, fitLots: true });
    const w = await waitFor(region, (s) => kinds(s).includes('MOVE_CLOSER'), 300_000, 'MOVE_CLOSER');
    const a = await nudge(region, 'MOVE_CLOSER');
    const t = w.actions.find((x) => x.kind === 'MOVE_CLOSER').target;
    await tp((t?.x ?? 0) + 0.5, 120, (t?.z ?? 0) + 0.5);
    const st = await waitRegion(region, 3_600_000);
    check(/walk/i.test(a.message) && st.view.state === 'PLACED', `nudges: MOVE_CLOSER names where to walk (${a.message}); after the walk the region ends ${st.view.state}`);
    out.moveCloser = { nudge: a, target: t, state: st.view.state };
    await call('dev.region.remove', { region, force: true }, 600_000).catch(() => null);
  }
  await leaveWorld();
  // START_SIDECAR: the sidecar (a child of my client, found by its port) killed mid-realise
  await fresh('G6B Nudge Sidecar', FLAT);
  await tp(0.5, 120, 0.5);
  {
    const c2 = [-100, -100, 99, 99];
    const p = await plan('crater_works', c2, { surveyLoad: 'bounded:256' });
    await prepare(p.planId);
    const p2 = await plan('crater_works', c2, { surveyLoad: 'generated:64' });
    const region = await realise(p2.planId, { lotEntries: LOT_ENTRIES, fitLots: true });
    await waitFor(region, (s) => (s.view.cellsWritten ?? 0) > 0, 300_000, 'the first writes');
    const pids = execFileSync('lsof', ['-ti', `tcp:${SIDECAR_PORT_6B}`, '-sTCP:LISTEN']).toString().trim().split(/\s+/).filter(Boolean).map(Number);
    const mine = pids.filter((pid) => { try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)]).toString().includes(path.basename(RUN)); } catch { return false; } });
    for (const pid of mine) { log(`  killing my sidecar pid ${pid}`); process.kill(pid, 'SIGKILL'); }
    let w = null;
    try { w = await waitFor(region, (s) => kinds(s).includes('START_SIDECAR'), 180_000, 'START_SIDECAR'); } catch (e) { out.sidecarWait = String(e.message); }
    const a = w ? await nudge(region, 'START_SIDECAR') : { done: false, message: 'no START_SIDECAR action (the launcher restarted it first?)' };
    const st = await waitRegion(region, 3_600_000);
    check(!!w && a.done && st.view.state === 'PLACED', `nudges: START_SIDECAR after the sidecar was killed (pids ${mine}): ${a.message}; the region ends ${st.view.state}`);
    out.startSidecar = { killed: mine, nudge: a, state: st.view.state };
    await call('dev.region.remove', { region, force: true }, 600_000).catch(() => null);
  }
  await leaveWorld();
  // APPROVE_STAGE: a scripted dig in the claim after the plan; the realise (no auto approval) holds the drifted stage
  await fresh('G6B Nudge Drift', FLAT);
  await tp(0.5, 120, 0.5);
  {
    const c2 = [-100, -100, 99, 99];
    const p = await plan('crater_works', c2, { surveyLoad: 'bounded:256' });
    await prepare(p.planId);
    const p2 = await plan('crater_works', c2, { surveyLoad: 'generated:64' });
    const g = (p2.claimY ?? [-64, 319]);
    // the flat world's ground is at y -61..-60 (the superflat preset): dig a 16x16 pit to bedrock's top
    void g;
    await cmd('/fill 55 -63 55 70 -60 70 minecraft:air');
    const region = await realise(p2.planId, { lotEntries: LOT_ENTRIES, fitLots: true, autoApprove: false });
    const w = await waitFor(region, (s) => kinds(s).includes('APPROVE_STAGE'), 600_000, 'APPROVE_STAGE');
    const a = await nudge(region, 'APPROVE_STAGE');
    const st = await waitRegion(region, 3_600_000, async (s) => { if (kinds(s).includes('APPROVE_STAGE')) await nudge(region, 'APPROVE_STAGE'); });
    check(a.done && ['PLACED', 'PARTIAL'].includes(st.view.state), `nudges: APPROVE_STAGE on the drifted stage (${JSON.stringify(w.actions.find((x) => x.kind === 'APPROVE_STAGE'))}): ${a.message}; the region ends ${st.view.state}`);
    out.approveStage = { action: w.actions, nudge: a, state: st.view.state };
    await call('dev.region.remove', { region, force: true }, 600_000).catch(() => null);
  }
  await leaveWorld();
  return out;
};

/** 10(a): a format-2 IR (rift_city: a field blob) realised after the helper's plan dir is deleted mid-realise; equal to an uninterrupted run. */
steps.versiona = async () => {
  await ensure();
  const claim = [-128, -100, 127, 99];
  const runOnce = async (world, drop) => {
    await fresh(world, FLAT);
    await tp(0.5, 120, 0.5);
    const p = await plan('rift_city', claim, { surveyLoad: 'bounded:256' });
    await prepare(p.planId);
    const p2 = await plan('rift_city', claim, { surveyLoad: 'generated:64' });
    const ir = readPlanJson(p2.planId, 'ir.json');
    const box = [claim[0] - 8, ir.claim.minY, claim[1] - 8, claim[2] + 8, ir.claim.maxY, claim[3] + 8];
    await call('dev.tiles.resends', { reset: true });
    if (drop) await call('dev.region.drop', { planId: p2.planId, after: 3 });
    const region = await realise(p2.planId, { lots: Object.fromEntries(ir.lots.map((l) => [l.id, 'g6a_stub_9'])) });
    const st = await waitRegion(region, 3_600_000);
    const dropped = drop ? await call('dev.region.drop.state', {}) : null;
    const resends = await call('dev.tiles.resends', {});
    const h = await call('dev.region.hash', { box }, 3_600_000);
    await leaveWorld();
    return { irSha: p2.irSha, format: ir.format, blobs: ir.blobs, state: st.view.state, cells: st.view.cellsWritten, dropped, resends, hash: h.sha256 };
  };
  const ref = await runOnce('G6B V10a Ref', false);
  const cut = await runOnce('G6B V10a Drop', true);
  check(cut.format === 2 && Object.keys(cut.blobs ?? {}).length > 0, `version (a): rift_city is a format-2 IR with side blobs (${JSON.stringify(cut.blobs)})`);
  check(cut.dropped?.dropped && (cut.resends.ir ?? 0) > 0 && (cut.resends.blob ?? 0) > 0, `version (a): the plan dir and blobs deleted after ${cut.dropped?.at} tiles (${JSON.stringify(cut.dropped?.deleted)}); the realise resumed through ir_unknown (${cut.resends.ir}) and then blob_unknown (${cut.resends.blob})`);
  check(cut.state === 'PLACED' && cut.irSha === ref.irSha && cut.hash === ref.hash, `version (a): the same region hash as an uninterrupted run in a world copy (${cut.hash?.slice(0, 12)} vs ${ref.hash?.slice(0, 12)}; ${cut.state}, ${cut.cells} vs ${ref.cells} cells)`);
  return { ref, cut };
};

/** 10(b): a newer IR (format 3, kitVersion 0.99.0) refuses PLAN_STALE at accept, at realise start and at resume, nothing written. */
steps.versionb = async () => {
  await ensure();
  await fresh('G6B V10b', FLAT);
  await tp(0.5, 120, 0.5);
  const claim = [-128, -100, 127, 99];
  const out = {};
  const stale = (x) => /PLAN_STALE/.test(typeof x === 'string' ? x : JSON.stringify(x ?? ''));
  for (const [label, override] of [['format 3', { format: 3 }], ['kitVersion 0.99.0', { kitVersion: '0.99.0' }]]) {
    const r = {};
    const p = await plan('rift_city', claim, { surveyLoad: 'bounded:256' });
    await prepare(p.planId);
    const ir = readPlanJson(p.planId, 'ir.json');
    const box = [claim[0] - 8, ir.claim.minY, claim[1] - 8, claim[2] + 8, ir.claim.maxY, claim[3] + 8];
    const lots = Object.fromEntries(ir.lots.map((l) => [l.id, 'g6a_stub_9']));
    const h0 = await call('dev.region.hash', { box }, 3_600_000);
    // accept: the next plan's IR is doctored; the plan must refuse
    r.acceptDoctor = await call('dev.region.planStale', { at: 'accept', ...override });
    r.accept = await plan('rift_city', claim, { surveyLoad: 'generated:64' }).then((x) => ({ accepted: x.planId })).catch((e) => String(e.message));
    // realise: the held plan's IR is doctored; realise must refuse
    const p2 = await plan('rift_city', claim, { surveyLoad: 'generated:64' });
    r.realiseDoctor = await call('dev.region.planStale', { at: 'realise', planId: p2.planId, ...override });
    r.realise = await realise(p2.planId, { lots }).then((x) => ({ region: x })).catch((e) => String(e.message));
    const h1 = await call('dev.region.hash', { box }, 3_600_000);
    // resume: a live region's IR is doctored mid-realise; its items wait PLAN_STALE and nothing more is written
    const p3 = await plan('rift_city', claim, { surveyLoad: 'generated:64' });
    const region = await realise(p3.planId, { lots });
    await waitFor(region, (st) => (st.view.cellsWritten ?? 0) > 0, 300_000, 'the first writes');
    r.resumeDoctor = await call('dev.region.planStale', { at: 'resume', region, ...override });
    await settle(5000);
    const h2 = await call('dev.region.hash', { box }, 3_600_000);
    await settle(20_000);
    const st = await stateOf(region);
    const h3 = await call('dev.region.hash', { box }, 3_600_000);
    r.resume = { stale: st.stale ?? null, waits: st.waits ?? null, state: st.view.state, waiting: st.view.waiting };
    r.hashes = { before: h0.sha256, afterAcceptRealise: h1.sha256, atDoctor: h2.sha256, after20s: h3.sha256 };
    await call('dev.region.remove', { region, force: true }, 600_000).catch(() => null);
    out[label] = r;
    check(stale(r.accept) && stale(r.realise) && (stale(r.resume) || stale(r.resumeDoctor)) && h0.sha256 === h1.sha256 && h2.sha256 === h3.sha256,
      `version (b) ${label}: PLAN_STALE at accept (${String(JSON.stringify(r.accept)).slice(0, 140)}), at realise start (${String(JSON.stringify(r.realise)).slice(0, 140)}) and at resume (${JSON.stringify(r.resume).slice(0, 160)}); nothing written (accept/realise ${h0.sha256 === h1.sha256}, after the resume gate ${h2.sha256 === h3.sha256})`);
  }
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ the main
const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6b.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
