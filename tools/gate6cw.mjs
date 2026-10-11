#!/usr/bin/env node
// Phase 6c slice W gate (docs/CONTRACT.md "Phase 6c slice W: village safety", §7, with the Coordinator addition: bible-styled
// lamps) against a dev client of the W run worktree (`../architect-mc-W-run`, a detached worktree at this checkout's HEAD;
// tools/run-gate6b-client.sh: the sim sidecar, no Claude, apitest on the classpath). Ports 8906 (sidecar) / 8907 (DevBridge).
// $0: no Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate6cw.mjs <step>
//     start [world] | stop | base      the client and the base worlds (G6B Seed Base, G6B Flat Base, G6B Seed 2026101102)
//     unit                              items 1, 4, 3 (kit), the goldens that must not move (12), the COPY test (item 1 of §7)
//     variants                          the broken variants, offline: gravity rule off (M3:gravity), FROZEN ignored (a clean plan
//                                       over the frozen river: its street columns are frozen)
//     s7flat | s7                       S7 flat (E-flat) then natural (bars 1-13 plus W's 8b full M5, 8c lamp clutter, 8d gravity)
//     lampsoff                          the "lamps removed" broken variant on S7's realised world (kit light over the dump)
//     pathbibles                        item 5: S7 flat with packed mud, stone bricks and oak planks paths vs coarse dirt
//     frozen                            item 6: the rejected site 2026101102 (FROZEN in the survey, Sample.frozen, the plan, 4e)
//     surveys                           item 7: S1's and S7's plan survey shas unchanged; S2's and S3's re-pinned (FROZEN count)
//     gallery                           S7 natural with the infernal and coastal bibles (the rustic look is S7's own run)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-w/<step>.json in the main checkout (GATE6CW_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-W-run');
process.env.GATE6B_OUT = process.env.GATE6CW_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-w');
process.env.GATE6B_SIDECAR_PORT ??= '8906';
process.env.GATE6B_DEV_PORT ??= '8907';
process.env.SCENARIOS_ART ??= path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'scenarios');
const L = await import('./lib/run6b.mjs');
const { RUN, OUT, SAVES, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, settle, sleep, startClient, state, stopClient, tp,
  write, copyWorld, plan, prepare, realise, waitRegion } = L;

refuseKeys();
const SEED = '2026100906', FROZEN_SEED = '2026101102';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const S7 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's7_flat_village.json'), 'utf8'));
/** S7's rejected site (CONTRACT V as built): a frozen river and sea; it planned clean and realised PARTIAL under V. */
const FROZEN_CLAIM = [4168, 1480, 4279, 1591];
const PHASE = '6c-w';
const json = (o) => JSON.stringify(o).replaceAll(' ', '');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);

const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
  return JSON.parse(line);
};
const result = async (pending, timeoutMs = 300_000) => {
  const key = pending?.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r && r.value !== undefined && r.value !== null) return r.value;
    await sleep(500);
  }
  throw new Error(`no result for ${key}`);
};
const later = async (args, t) => result(await api(args), t);

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
  if (!['stop', 'start'].includes(name)) write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
async function fresh(name, from) {
  await leaveWorld();
  copyWorld(from, name);
  await openWorld(name);
}
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice W is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? FLAT, { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  for (const [name, preset] of [[BASE, 'normal'], [FLAT, 'flat']]) {
    if (fs.existsSync(path.join(SAVES, name, 'level.dat'))) continue;
    await leaveWorld();
    await openWorld(name, { mode: 'creative', preset, seed: SEED, cheats: true });
    await L.setRules(preset === 'flat' ? 'exact' : 'default');
    await tp(0.5, 200, 0.5);
    await cmd('/save-all flush');
    await leaveWorld();
  }
  const frozenBase = await L.seedBase(FROZEN_SEED);
  spendZero();
  return { worlds: [BASE, FLAT, frozenBase], seed: SEED };
};

// ------------------------------------------------------------------ offline: unit, goldens, variants

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}

steps.unit = async () => {
  const out = {};
  out.safety = nodeTest(['kit/test/village-safety.test.mjs']);
  check(out.safety.code === 0 && out.safety.fail === 0 && out.safety.pass >= 9, `items 1, 3, 4 (kit): gravity property test (500 claims), gravity variant, frozen water, fixtures, lightCover on S7: ${out.safety.pass} pass, ${out.safety.fail} fail`, out.safety.failing);
  out.goldens = nodeTest(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/forms-island.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 12: goldens that must not move (mega_bench, S1's tile golden, the 6b fixtures' expected.json) and S7's re-committed golden: ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  out.kit = nodeTest(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const sc = spawnSync('npx', ['vitest', 'run', 'test/breakdown-copy.test.ts', 'test/copies.test.ts', 'test/regions-village.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 900_000 });
  const st = `${sc.stdout}${sc.stderr}`;
  out.copy = { code: sc.status, summary: st.split('\n').filter((l) => /Tests|Test Files/.test(l)).join(' | ') };
  check(sc.status === 0, `item 1 (§2): COPY ms from each copy's span; R's other lines byte-identical; copies and village sidecar tests: ${out.copy.summary}`);
  return out;
};

steps.variants = async () => {
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { decodeColumns, encodeColumns, FLAG_FROZEN, FLAG_WATER } = await imp('lib/region/pack.mjs');
  const out = {};
  // gravity off: the kit test's broken variant (village-safety.test.mjs), run alone and named
  const g = nodeTest(['--test-name-pattern', 'gravity broken variant', 'kit/test/village-safety.test.mjs']);
  out.gravityOff = g;
  check(g.code === 0 && g.pass === 1, `variant: a gravel verge over a 2-deep gap with the rule off -> M3:gravity on the verges (${g.names.join('; ')})`);
  // FROZEN ignored: the frozen site's survey with its FROZEN columns read as ground (V's reading) plans clean, its street over ice
  const f = path.join(OUT, 'frozen-survey.bin');
  if (!fs.existsSync(f)) { out.frozenIgnored = 'run the frozen step first (it writes frozen-survey.bin)'; check(false, `variant: FROZEN ignored: ${out.frozenIgnored}`); return out; }
  const cols = decodeColumns(fs.readFileSync(f));
  const blind = { ...cols, flags: Uint8Array.from(cols.flags), floor: Int16Array.from(cols.floor) };
  let frozenCols = 0;
  for (let k = 0; k < blind.flags.length; k++) if (blind.flags[k] & FLAG_FROZEN) { frozenCols++; blind.flags[k] &= ~(FLAG_FROZEN | FLAG_WATER); blind.floor[k] = blind.ground[k]; }
  const claim = { minX: FROZEN_CLAIM[0], minZ: FROZEN_CLAIM[1], maxX: FROZEN_CLAIM[2], maxZ: FROZEN_CLAIM[3], minY: -64, maxY: 319 };
  const roles = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', S7.bibleFixture), 'utf8')).roles;
  let p = null, why = null;
  try { p = await planRegion({ programFile: path.join(KIT, 'regions', 'flat_village.mjs'), params: S7.params, roles, survey: encodeColumns(blind), claim, node: 'gate' }); } catch (e) { why = e.message; }
  const at = (x, z) => { const i = Math.floor((x - cols.minX) / cols.resolution), j = Math.floor((z - cols.minZ) / cols.resolution); return cols.flags[i + j * cols.width]; };
  const onIce = [];
  for (const r of p?.ir.roads ?? []) {
    const [a, b] = [r.points[0], r.points[r.points.length - 1]];
    for (let x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++) for (let z = Math.min(a[2], b[2]); z <= Math.max(a[2], b[2]); z++) if (at(x, z) & FLAG_FROZEN) onIce.push([x, z]);
  }
  out.frozenIgnored = { frozenColumns: frozenCols, planned: !!p, refused: why, streetOnIce: onIce.length, sample: onIce.slice(0, 10), roads: p?.ir.roads.map((r) => ({ id: r.id, points: r.points })) };
  check(p && onIce.length > 0, `variant: FROZEN ignored -> the plan is clean with its street over ${onIce.length} frozen column(s) (the frozen step's 4e check refuses such a road DEEP_WATER)`);
  return out;
};

// ------------------------------------------------------------------ S7

function scenario(args) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'scenarios.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 4 * 3_600_000, env: process.env });
  const t = `${r.stdout}${r.stderr}`;
  fs.appendFileSync(path.join(OUT, 'scenarios.log'), t);
  return { code: r.status, fails: t.split('\n').filter((l) => /^FAIL /.test(l)), tail: t.split('\n').slice(-30).join('\n') };
}
const artDir = (sub) => path.join(path.resolve(process.env.SCENARIOS_ART), PHASE, sub);
/** The latest run with metrics under <phase>/<sub>, or a runner's $SCENARIOS_ART/<sub>[-flat]. */
const latest = (sub, flat) => {
  const d = artDir(sub);
  const runs = fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith('-flat') === flat && fs.existsSync(path.join(d, x, 'metrics.json'))).map((x) => path.join(d, x)) : [];
  const r = path.join(path.resolve(process.env.SCENARIOS_ART), flat ? `${sub}-flat` : sub);
  if (fs.existsSync(path.join(r, 'metrics.json'))) runs.push(r);
  runs.sort((a, b) => fs.statSync(path.join(a, 'metrics.json')).mtimeMs - fs.statSync(path.join(b, 'metrics.json')).mtimeMs);
  return runs.length ? runs[runs.length - 1] : null;
};
const readJ = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));

steps.s7flat = async () => {
  await ensure();
  const r = scenario(['run', 's7', '--phase', PHASE, '--flat']);
  const dir = latest('s7', true);
  const m = dir ? readJ(dir, 'metrics.json') : null;
  const ex = dir ? readJ(dir, 'exact.json') : null;
  check(r.code === 0, `S7 flat: every gated run bar (exit ${r.code})${r.fails.length ? `: ${r.fails.join('; ')}` : ''}`);
  check(ex && ex.mismatches === 0, `item 10: S7 flat E-flat ${ex?.mismatches} mismatches over ${ex?.cellsWritten} written cells`);
  return { dir, rows: m?.rows, exact: ex && { mismatches: ex.mismatches, cellsWritten: ex.cellsWritten }, village: m?.village };
};

steps.s7 = async () => {
  await ensure();
  const r = scenario(['run', 's7', '--phase', PHASE]);
  const dir = latest('s7', false);
  const m = dir ? readJ(dir, 'metrics.json') : null;
  check(r.code === 0, `S7 natural: every gated run bar but the gallery (exit ${r.code})${r.fails.length ? `: ${r.fails.join('; ')}` : ''}`);
  for (const row of m?.rows ?? []) if (row.gated && row.id !== 'gallery') check(row.pass, `S7 bar ${row.label}: ${row.value} (bar: ${row.threshold})`);
  const ev = dir ? fs.readFileSync(path.join(dir, 'evidence.sha'), 'utf8').trim() : null;
  const lamps = m?.village?.lamps;
  check(lamps && Object.values(lamps.perLot).every((n) => n <= 4), `item 4: at most 4 lamps per lot (${lamps ? Object.entries(lamps.perLot).map(([k, n]) => `${k} ${n}`).join(', ') : 'n/a'})`);
  return { dir, evidence: ev, rows: m?.rows, village: m?.village, mspt: m?.mspt?.architect, tail: r.code ? r.tail : undefined };
};

/** Kit block light over a realised dump world from every emitter in its box (not only the region's), minus `skip` cells. */
async function dumpLight(world, box, skip = new Set()) {
  const P = world.pal;
  const Lm = new Map();
  const q = [];
  for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) for (let y = box.minY; y <= box.maxY; y++) {
    const e = P.emit[world.get(x, y, z)];
    if (e > 0 && !skip.has(`${x},${y},${z}`)) { Lm.set(`${x},${y},${z}`, e); q.push([x, y, z, e]); }
  }
  const D = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let i = 0; i < q.length; i++) {
    const [x, y, z, lv] = q[i];
    if (lv <= 1 || Lm.get(`${x},${y},${z}`) !== lv) continue;
    for (const [dx, dy, dz] of D) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < box.minX || nx > box.maxX || ny < box.minY || ny > box.maxY || nz < box.minZ || nz > box.maxZ) continue;
      const n = world.get(nx, ny, nz);
      if (P.opaque[n]) continue;
      const v = lv - P.cost[n];
      const k = `${nx},${ny},${nz}`;
      if (v > (Lm.get(k) ?? 0)) { Lm.set(k, v); q.push([nx, ny, nz, v]); }
    }
  }
  return (x, y, z) => Lm.get(`${x},${y},${z}`) ?? 0;
}

/** The realised dump world of a run (its own plan's virtual world marks what the region wrote). */
async function runWorld(dir) {
  const { decodeArwd, dumpWorld, buildVirtual } = await imp('lib/region/vworld.mjs');
  const planDir = path.join(dir, 'raw', 'plan');
  const ir = readJ(planDir, 'ir.json'), meta = readJ(planDir, 'meta.json');
  const survey = fs.readFileSync(path.join(planDir, 'survey.bin'));
  const { vw } = buildVirtual({ ir, survey, blobs: (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; } });
  const before = await decodeArwd(fs.readFileSync(path.join(dir, 'raw', 'before.arwd.gz')));
  const after = await decodeArwd(fs.readFileSync(path.join(dir, 'raw', 'after.arwd.gz')));
  return { ir, meta, vw, after, world: dumpWorld(before, after, ir.claim, { virtual: vw, lots: ir.lots }) };
}

steps.lampsoff = async () => {
  const { checkRegion } = await imp('lib/region/check.mjs');
  const dir = latest('s7', false);
  if (!dir) throw new Error('no S7 natural run (run the s7 step first)');
  const { ir, meta, world, after } = await runWorld(dir);
  const lamps = (meta.village.props ?? []).filter((p) => p.kind === 'apron_lamp');
  const lightCells = (ls) => new Set(ls.flatMap((p) => p.cells.filter((c) => world.pal.emit[world.pal.of(c[3])] > 0).map((c) => `${c[0]},${c[1]},${c[2]}`)));
  const m5 = async (skip) => { world.lightAt = await dumpLight(world, after.box, skip); return checkRegion({ ir, meta, world, prefix: false, rules: ['M5'] }).metrics.M5; };
  const out = { run: dir, lamps: lamps.length };
  out.all = await m5(new Set());
  const per = meta.village.apronLamps.perLot;
  const worst = Object.entries(per).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  out.lotOff = { lot: worst[0], lamps: worst[1], M5: await m5(lightCells(lamps.filter((p) => p.lot === worst[0]))) };
  out.allOff = await m5(lightCells(lamps));
  check(out.all.share < 0.01, `lampsoff: the kit's light over the realised dump, every lamp lit: full M5 ${(100 * out.all.share).toFixed(2)}% (< 1%)`);
  check(out.allOff.share > 0.01, `variant: the apron lamps removed -> full M5 ${(100 * out.allOff.share).toFixed(2)}% (over 1%: caught)`);
  out.note = `one lot's lamps removed (${worst[0]}, ${worst[1]}): ${(100 * out.lotOff.M5.share).toFixed(2)}%`;
  return out;
};

// ------------------------------------------------------------------ item 5: road lanterns with three path bibles

steps.pathbibles = async () => {
  await ensure();
  const bibles = [['coarse_dirt', null], ['packed_mud', 'g6cw_path_packed_mud'], ['stone_bricks', 'g6cw_path_stone_bricks'], ['oak_planks', 'g6cw_path_oak_planks']];
  const out = {};
  for (const [blk, bible] of bibles) {
    let dir;
    if (!bible) dir = latest('s7', true);
    else { const r = scenario(['run', 's7', '--phase', PHASE, '--flat', '--bible', bible]); dir = latest(`s7-${bible}`, true); out[`${blk}Exit`] = r.code; }
    if (!dir) { check(false, `pathbibles: no flat run for ${blk}`); continue; }
    const { ir, meta, world } = await runWorld(dir);
    const m = readJ(dir, 'metrics.json');
    // the street's lanterns: light blocks within 3 of the street's rows (outside the square), less the planned props' own
    const v = meta.village, o = v.orientation, sv = v.streetV;
    const props = new Set((v.props ?? []).flatMap((p) => p.cells.map((c) => `${c[0]},${c[1]},${c[2]}`)));
    const sq = v.shared.rect;
    let n = 0;
    const lanterns = [];
    const box = world.claim;
    for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) {
      const across = o === 'ew' ? z - sv : x - sv;
      if (Math.abs(across) > 3 || (x >= sq[0] && x <= sq[2] && z >= sq[1] && z <= sq[3])) continue;
      for (let y = box.minY; y <= box.maxY; y++) {
        const s = world.pal.states[world.get(x, y, z)];
        if (world.pal.emit[world.get(x, y, z)] > 0 && !props.has(`${x},${y},${z}`)) { n++; lanterns.push([x, y, z, s]); }
      }
    }
    const wd = m.village?.walkDark;
    out[blk] = { run: dir, roadLanterns: n, sample: lanterns.slice(0, 4), walkDark: wd && { share: wd.share, cells: wd.walkCells, dark: wd.dark }, roadsIr: ir.roads.map((r) => r.id) };
    check(wd && wd.share === 0, `item 5 (${blk}): M5 over the street, verges, lanes and square 0.00% (${wd ? `${wd.dark} of ${wd.walkCells}` : 'n/a'})`);
  }
  for (const blk of ['packed_mud', 'stone_bricks', 'oak_planks']) if (out[blk] && out.coarse_dirt) check(out[blk].roadLanterns === out.coarse_dirt.roadLanterns, `item 5: road lanterns with a ${blk} path ${out[blk].roadLanterns} = the coarse-dirt bible's ${out.coarse_dirt.roadLanterns}`);
  return out;
};

// ------------------------------------------------------------------ item 6: frozen water on the rejected site

steps.frozen = async () => {
  await ensure();
  const out = {};
  await fresh('G6B W Frozen', await L.seedBase(FROZEN_SEED));
  await L.setRules('gallery');
  const [x0, z0, x1, z1] = FROZEN_CLAIM;
  await tp((x0 + x1) / 2, 120, (z0 + z1) / 2);
  const sv = await call('dev.region.survey', { claim: FROZEN_CLAIM, surveyLoad: 'bounded:256', file: path.join(OUT, 'frozen-survey.bin') }, 900_000);
  out.survey = sv;
  check(sv.frozen > 0, `item 6: the plan survey reads ${sv.frozen} frozen-water column(s) (FROZEN, with WATER; ${sv.water} water in all) on the rejected site`);
  // the public API: Sample.frozen (apitest heights' 7th column), Sample.water unchanged
  const h = await later(`heights ${x0} ${z0} ${x1} ${z1} 4`, 600_000);
  out.sample = { columns: h.length, frozen: h.filter((c) => c[6] === 1).length, waterAndFrozen: h.filter((c) => c[6] === 1 && c[3] === 1).length };
  check(out.sample.frozen > 0 && out.sample.waterAndFrozen === 0, `item 6: Sample.frozen ${out.sample.frozen} of ${out.sample.columns} (Sample.water stays the top fluid: ${out.sample.waterAndFrozen} both)`);
  // the plan: refused with a note naming a frozen column, or planned with the street off the frozen water (then realised, never PARTIAL)
  let p = null, refused = null;
  try { p = await plan(S7.program, FROZEN_CLAIM, { params: S7.params, surveyLoad: 'bounded:256', bible: S7.bible }); } catch (e) { refused = e.message; }
  out.plan = { refused, planId: p?.planId ?? null, notes: p?.notes ?? null };
  if (refused) check(/frozen water (under the shared space )?at -?\d+,-?\d+/.test(refused), `item 6: the plan is refused naming a frozen column: ${refused}`);
  else {
    const ir = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId, 'ir.json'), 'utf8'));
    const frozenSet = new Set();
    const { decodeColumns, FLAG_FROZEN } = await imp('lib/region/pack.mjs');
    const cols = decodeColumns(fs.readFileSync(path.join(OUT, 'frozen-survey.bin')));
    for (let j = 0; j < cols.depth; j++) for (let i = 0; i < cols.width; i++) if (cols.flags[i + j * cols.width] & FLAG_FROZEN) frozenSet.add(`${cols.minX + i * cols.resolution},${cols.minZ + j * cols.resolution}`);
    let onIce = 0;
    for (const r of ir.roads) { const [a, b] = [r.points[0], r.points[r.points.length - 1]]; for (let x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++) for (let z = Math.min(a[2], b[2]); z <= Math.max(a[2], b[2]); z++) if (frozenSet.has(`${x},${z}`)) onIce++; }
    out.plan.streetOnIce = onIce;
    check(onIce === 0, `item 6: planned with the street off the frozen water (${onIce} street column(s) on it)`);
    await prepare(p.planId);
    const p2 = await plan(S7.program, FROZEN_CLAIM, { params: S7.params, surveyLoad: 'generated:64', bible: S7.bible });
    const region = await realise(p2.planId, { lots: S7.lotEntries });
    const st = await waitRegion(region, 3_600_000);
    out.realise = { region, state: st.view.state, items: st.items };
    check(st.view.state === 'PLACED', `item 6: realised ${st.view.state} (never PARTIAL)`);
    await call('dev.region.remove', { region }, 3_600_000);
  }
  // 4e over the frozen river: a ground road along a run of frozen columns is DEEP_WATER (V's rejected run went PARTIAL here)
  const { decodeColumns, FLAG_FROZEN } = await imp('lib/region/pack.mjs');
  const cols = decodeColumns(fs.readFileSync(path.join(OUT, 'frozen-survey.bin')));
  let line = null;
  for (let j = 0; j < cols.depth && !line; j++) {
    let run = 0;
    for (let i = 0; i < cols.width; i++) {
      run = cols.flags[i + j * cols.width] & FLAG_FROZEN ? run + 1 : 0;
      if (run >= 12) { line = { x0: cols.minX + (i - 11) * cols.resolution, x1: cols.minX + i * cols.resolution, z: cols.minZ + j * cols.resolution, y: cols.ground[i + j * cols.width] + 1 }; break; }
    }
  }
  if (line) {
    const c = await call('dev.road.check', { points: [[line.x0, line.y, line.z], [line.x1, line.y, line.z]], width: 3 }, 60_000);
    out.road = { line, refusals: c.refusals ?? c.refused ?? null, ok: c.ok ?? null };
    check(JSON.stringify(c).includes('DEEP_WATER'), `item 6: a 4e ground road along ${line.x1 - line.x0 + 1} frozen columns is refused DEEP_WATER (${JSON.stringify(c.refusals ?? c).slice(0, 200)})`);
  } else check(false, 'item 6: no run of 12 frozen columns to lay a road on');
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ item 7: the pinned plan surveys

steps.surveys = async () => {
  await ensure();
  const { decodeColumns, encodeColumns, FLAG_FROZEN, FLAG_WATER } = await imp('lib/region/pack.mjs');
  const out = {};
  await fresh('G6B W Surveys', BASE);
  for (const id of ['s1_floating_islands', 's7_flat_village', 's2_ice_spikes', 's3_monastery']) {
    const file = path.join(root, 'scenarios', `${id}.json`);
    const sc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = sc.fixture.claim;
    await tp((c[0] + c[2]) / 2, 200, (c[1] + c[3]) / 2);
    const bin = path.join(OUT, `survey-${id.split('_')[0]}.bin`);
    const s = await call('dev.region.survey', { claim: c, surveyLoad: 'bounded:256', file: bin }, 1_800_000);
    // V's reading of the same bytes: FROZEN cleared, the column dry at its ice (WATER cleared, floor = ground)
    const cols = decodeColumns(fs.readFileSync(bin));
    const v = { ...cols, flags: Uint8Array.from(cols.flags), floor: Int16Array.from(cols.floor) };
    for (let k = 0; k < v.flags.length; k++) if (v.flags[k] & FLAG_FROZEN) { v.flags[k] &= ~(FLAG_FROZEN | FLAG_WATER); v.floor[k] = v.ground[k]; }
    const vSha = sha256(encodeColumns(v));
    const golden = path.join(root, 'scenarios', 'goldens', id.split('_')[0], 'survey.bin');
    const gSha = fs.existsSync(golden) ? sha256(fs.readFileSync(golden)) : null;
    out[id] = { claim: c, sha: s.sha, vReadingSha: vSha, goldenSha: gSha, frozen: s.frozen, water: s.water, columns: s.columns, resolution: s.resolution, missing: s.missing };
    if (id === 's1_floating_islands' || id === 's7_flat_village') {
      check(s.frozen === 0 && (gSha === null || s.sha === gSha), `item 7: ${id}'s plan survey unchanged (frozen ${s.frozen}; sha ${s.sha.slice(0, 12)}${gSha ? ` = golden ${gSha.slice(0, 12)}` : ''})`);
    } else {
      check(s.missing === 0, `item 7: ${id}'s plan survey: ${s.frozen} frozen column(s) of ${s.columns}; sha ${s.sha.slice(0, 12)} (V's reading ${vSha.slice(0, 12)}${s.frozen ? ': moved' : ': unchanged'})`);
      sc.fixture.planSurvey = { sha: s.sha, kitVersion: '0.17.0', resolution: s.resolution, columns: s.columns, water: s.water, frozen: s.frozen, previousSha: vSha,
        reason: '6c W (CONTRACT W §5, gate item 7): frozen water reads as water (ARSV FROZEN with WATER, floor at the bed), so a survey with frozen columns gets new bytes; re-pinned at the same claim' };
      if (process.env.GATE6CW_REPIN === '1') fs.writeFileSync(file, `${JSON.stringify(sc, null, 2)}\n`);
    }
  }
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ the gallery's looks

steps.gallery = async () => {
  await ensure();
  const out = {};
  for (const bible of ['g6cw_infernal', 'g6cw_coastal']) {
    const r = scenario(['run', 's7', '--phase', PHASE, '--bible', bible]);
    const dir = latest(`s7-${bible}`, false);
    const m = dir ? readJ(dir, 'metrics.json') : null;
    const row = (id) => m?.rows.find((x) => x.id === id);
    out[bible] = { dir, exit: r.code, lamps: m?.village?.lamps, safetyFull: row('safetyFull')?.value, safety: row('safety')?.value, evidence: dir ? fs.readFileSync(path.join(dir, 'evidence.sha'), 'utf8').trim() : null };
    check(m && Object.values(m.village?.lamps?.perLot ?? {}).every((n) => n <= 4), `gallery (${bible}): at most 4 lamps a lot (${m?.village?.lamps ? Object.entries(m.village.lamps.perLot).map(([k, n]) => `${k} ${n}`).join(', ') : 'n/a'}; recorded: ${row('safetyFull')?.value})`);
  }
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'variants', 's7flat', 's7', 'lampsoff', 'pathbibles', 'frozen', 'surveys', 'gallery']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  const spend = JSON.parse(fs.readFileSync(path.join(OUT, 'spend.json'), 'utf8'));
  const md = `# Gate 6c-W (village safety)\n\nSpend: $${spend.totalUsd.toFixed(2)} (cap $${spend.capUsd}).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cw.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
