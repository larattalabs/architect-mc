#!/usr/bin/env node
// Phase 6c slice 0c gate (docs/CONTRACT.md "Phase 6c slice 0c", §12) against a dev client of the 0c run worktree
// (`../architect-mc-0c-run`, a detached worktree at this checkout's HEAD; tools/run-gate6b-client.sh: the sim sidecar, no
// Claude, apitest on the classpath). Ports 8912 (sidecar) / 8913 (DevBridge). $0: no Claude call anywhere; spend.json reads $0.
// The client is started and stopped by PID (lib/run6b.mjs). API checks go through the apitest mod (/apitest, API only);
// DevBridge hooks hash boxes, list the journal and drive the move ghost.
//
//   node tools/gate6c0c.mjs <step>     start [world] | stop | base | api | minlot | roads | ground | protect | tags | all
//
// Evidence: artifacts/gate6c0c/<step>.json in the main checkout (GATE6C0C_OUT overrides), all.log, REPORT.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-0c-run');
process.env.GATE6B_OUT ??= process.env.GATE6C0C_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c0c');
process.env.GATE6B_SIDECAR_PORT ??= '8912';
process.env.GATE6B_DEV_PORT ??= '8913';
const L = await import('./lib/run6b.mjs');
const { RUN, OUT, GAME_DIR, SAVES, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, settle, sleep, startClient, state,
  stopClient, tp, write, copyWorld } = L;

refuseKeys();
const SEED = '2026101000';
const FLAT = 'G6B 0c Superflat', FOREST = 'G6B 0c Forest', BOOT = 'G6B 0c Flat';
const A = 'test:a', B = 'test:b';

// ---- the apitest mod
const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
  return JSON.parse(line);
};
const result = async (pending, timeoutMs = 120_000) => {
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
const reasons = (x) => (x?.refusals ?? []).map((r) => r.reason);
const hash = async (min, max) => (await call('dev.box.hash', { min, max }, 300_000)).sha256;
const entries = async () => (await call('dev.journal.state', {}, 60_000)).entries?.length ?? -1;
const json = (o) => JSON.stringify(o).replaceAll(' ', '');

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
async function fresh(name, from) {
  await leaveWorld();
  copyWorld(from, name);
  await openWorld(name);
}
/** The feet y of a column (the survey's height + 1). */
async function feet(x, z) {
  const h = await later(`heights ${x} ${z} ${x} ${z} 1`);
  return h[0][2] + 1;
}

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? BOOT, { backend: 'sim' });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [] }, null, 2)}\n`);
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};

/** The base worlds: a flat creative one (exact rules) and the pinned seed's normal one. */
steps.base = async () => {
  await ensure();
  for (const [name, preset] of [[FLAT, 'flat'], [FOREST, 'normal']]) {
    if (fs.existsSync(path.join(SAVES, name, 'level.dat'))) continue;
    await openWorld(name, { mode: 'creative', preset, seed: SEED, cheats: true });
    for (const r of ['random_tick_speed 0', 'mob_griefing false', 'advance_time false', 'advance_weather false', 'spawn_mobs false', 'spawn_monsters false']) await cmd(`/gamerule ${r}`);
    await cmd('/time set 6000');
    await tp(0.5, 120, 0.5);
    await cmd('/save-all flush');
    await leaveWorld();
  }
  return { worlds: [FLAT, FOREST], seed: SEED };
};

/** Item 10 (in game part): the version, the appended reasons and the features. */
steps.api = async () => {
  await ensure();
  await fresh('G6B 0c Api', FLAT);
  const v = await api('api112');
  check(v.version === '1.12.0', `api: ArchitectApi.VERSION 1.12.0 (${v.version})`);
  check(v.last2 === 'PROTECTED,FIELD_LIMIT', `api: PROTECTED and FIELD_LIMIT appended last (${v.last2})`);
  check(v.features.includes('extendInfo'), `api: the sim helper offers extendInfo`);
  return v;
};

/** Item 1 in game: a Steward-sized lot sized from minLotSize places. */
steps.minlot = async () => {
  await ensure();
  await fresh('G6B 0c MinLot', FLAT);
  await tp(300.5, -40, 300.5);
  const out = {};
  for (const bp of ['cabin', 'tavern']) {
    const m = await api(`minlot ${bp}`);
    const y = await feet(300, 300);
    const lot = [300, y, 300, 300 + m.alongStreet - 1, y + 20, 300 + m.deep - 1];
    const f = await api(`fit ${bp} ${lot.join(',')} north owner=${A}`);
    const small = await api(`fit ${bp} ${[lot[0], lot[1], lot[2], lot[3] - 1, lot[4], lot[5]].join(',')} north`);
    const shallow = await api(`fit ${bp} ${[lot[0], lot[1], lot[2], lot[3], lot[4], lot[5] - 1].join(',')} north`);
    const again = await api(`fit ${bp} ${f.recommendedLot.join(',')} north`);
    const placed = await later(`place ${bp} ${f.at.join(' ')} INSTANT unowned noactor ${f.rot} owner=${A}`);
    check(f.ok, `minlot ${bp}: a lot of exactly ${m.alongStreet} x ${m.deep} fits (${json(f.refusals)})`);
    check(reasons(small).includes('LOT_TOO_SMALL') && reasons(shallow).includes('LOT_TOO_SMALL'), `minlot ${bp}: one block less on either axis is LOT_TOO_SMALL`);
    check(again.origin === f.origin && again.rot === f.rot, `minlot ${bp}: fitToLot(recommendedLot) gives the same origin and rotation (${again.origin} ${f.origin})`);
    check(placed.placed, `minlot ${bp}: placed at the fit (${placed.siteId}; ${json(placed.refusals)})`);
    out[bp] = { m, lot, f, placed };
    if (placed.siteId) await later(`remove ${placed.siteId} ${A} noforce`);
  }
  return out;
};

/** A stone pad with its top at y 19 under the road strip of item 2 (the flat world's ground is too shallow for a trench). */
async function pad(x0, z0, x1, z1, top) {
  const y0 = await feet(x0, z0) - 1;
  for (let x = x0; x <= x1; x += 20) await cmd(`/fill ${x} ${y0} ${z0} ${Math.min(x1, x + 19)} ${top} ${z1} minecraft:stone`);
}

/**
 * Item 2 in game: a partial road over a trench on segment 2 (no ground within 8: TOO_STEEP; a step or wall can't fail TOO_STEEP,
 * see HANDOFF-0c), placed as one site with a gap, then undone exactly.
 */
steps.roads = async () => {
  await ensure();
  await fresh('G6B 0c Roads', FLAT);
  const X = 500, Z = 500;
  await tp(X + 20.5, 100, Z + 0.5, 0, 89);
  const T = (await feet(X, Z)) + 20;
  await pad(X - 4, Z - 8, X + 44, Z + 8, T);
  await cmd(`/fill ${X + 24} ${T - 17} ${Z - 8} ${X + 27} ${T} ${Z + 8} minecraft:air`);
  await settle(2000);
  const pts = [0, 10, 20, 30, 40].map((d) => [X + d, T + 1, Z]);
  const road = { points: pts, width: 3, owner: A };
  const min = [X - 6, T - 40, Z - 10], max = [X + 46, T + 12, Z + 10];
  const h0 = await hash(min, max);
  const e0 = await entries();
  const c = await api(`roadcheck ${json(road)}`);
  check(!c.ok && reasons(c)[0] === 'TOO_STEEP', `roads: checkRoad refuses TOO_STEEP (${json(c.refusals).slice(0, 200)})`);
  check(c.spans.length === 1 && c.spans[0].from === 2 && c.spans[0].to === 3 && c.spans[0].reason === 'TOO_STEEP', `roads: span [2,3] TOO_STEEP (${json(c.spans)})`);
  const cp = await api(`roadcheck ${json({ ...road, partial: true })}`);
  check(cp.ok && cp.spans.length === 1, `roads: a partial checkRoad passes and still lists the span (${json(cp.spans)})`);
  const p = await later(`road ${json({ ...road, partial: true, tag: 'p1' })}`);
  check(p.placed && p.skipped.length === 1 && p.skipped[0].from === 2 && p.skipped[0].to === 3, `roads: placed partial as ${p.siteId}, skipped ${json(p.skipped)}`);
  check(p.notes.some((n) => n.startsWith('skipped segment [2,3] (TOO_STEEP)')), `roads: a note names the skipped span (${json(p.notes)})`);
  const e1 = await entries();
  check(e1 === e0 + 1, `roads: one journal entry for both runs (${e0} -> ${e1})`);
  const site = (await api('sites')).all.find((s) => s.id === p.siteId);
  const r = await later(`remove ${p.siteId} ${A} noforce`);
  await settle(2000);
  const h1 = await hash(min, max);
  check(r.removed && h1 === h0, `roads: one undo restores both runs exactly (world diff ${h1 === h0 ? 0 : 'NOT 0'})`);
  return { check: c, partial: p, site, remove: r };
};

/** Item 3: ground heights on a worldgen forest box; Sample.ground vs Volume.ground per column; the volume sha (twice). */
steps.ground = async () => {
  await ensure();
  await fresh('G6B 0c Ground', FOREST);
  const loc = await cmd('/locate biome minecraft:forest');
  const m = (loc.messages ?? []).join(' ').match(/\[(-?\d+), (?:~|-?\d+), (-?\d+)\]/);
  if (!m) throw new Error(`no forest: ${json(loc)}`);
  const [fx, fz] = [Number(m[1]), Number(m[2])];
  await tp(fx + 0.5, 140, fz + 0.5, 0, 89);
  await settle(5000);
  const R = 24;
  const hs = await later(`heights ${fx - R} ${fz - R} ${fx + R} ${fz + R} 1`, 300_000);
  const ys = hs.map((c) => c[2]);
  const y0 = Math.min(...ys) - 8, y1 = Math.max(...ys) + 24;
  const args = `${fx - R} ${fz - R} ${fx + R} ${fz + R} ${y0} ${y1}`;
  const g = await later(`ground ${args}`, 600_000);
  const g2 = await later(`ground ${args}`, 600_000);
  check(g.trunkColumns > 0 && g.trunkGroundBelowHeight === g.trunkColumns, `ground: under every trunk column ground < height (${g.trunkGroundBelowHeight}/${g.trunkColumns})`);
  check(g.dryOtherGroundEqualsHeight === g.dryOtherColumns, `ground: elsewhere (dry) ground == height (${g.dryOtherGroundEqualsHeight}/${g.dryOtherColumns}; ${json(g.firstOtherDiff)})`);
  check(g.compared > 0 && g.sampleEqualsVolume === g.compared, `ground: Sample.ground == Volume.ground in every column (${g.sampleEqualsVolume}/${g.compared}; ${json(g.firstDiff)})`);
  check(g.volumeSha === g2.volumeSha, `ground: the volume sha is stable (${g.volumeSha.slice(0, 12)})`);
  const v = await call('dev.survey.volume', { box: [fx - R, y0, fz - R, fx + R, y1, fz + R], load: 'loaded' }, 600_000).catch((e) => ({ error: String(e) }));
  return { forest: [fx, fz], box: [fx - R, y0, fz - R, fx + R, y1, fz + R], ground: g, devVolume: v };
};

/** A cabin at (x, z) on the flat ground by {@code owner}; returns the site id. */
async function cabin(x, z, owner, bp = 'cabin') {
  const y = await feet(x, z);
  const r = await later(`place ${bp} ${x} ${y} ${z} INSTANT unowned noactor 0 owner=${owner}`);
  if (!r.placed) throw new Error(`place ${bp} at ${x},${z}: ${json(r.refusals)}`);
  await settle(1500);
  return r.siteId;
}

/** gate5b's kit version builder: the cabin as entry {@code id} v1, v2 (width 10, no porch) into OUT/versions. */
function kitVersions(id) {
  const V = path.join(OUT, 'versions', id);
  for (const [v, args] of [['v1', []], ['v2', ['--values', '{"width":10,"porch":false}']]]) {
    const tmp = path.join(OUT, 'kitbuild', id + '-' + v);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    execFileSync('node', [path.join(root, 'kit', 'build.mjs'), 'cabin', '--out', tmp, ...args], { stdio: 'ignore' });
    const dir = path.join(V, v);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(tmp)) {
      if (!f.startsWith('cabin.')) continue;
      const target = path.join(dir, id + f.slice('cabin'.length));
      if (f.endsWith('.blueprint.json')) {
        const j = JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8'));
        Object.assign(j, { id, name: id, source: id + '.mjs' });
        fs.writeFileSync(target, JSON.stringify(j, null, 2));
      } else fs.copyFileSync(path.join(tmp, f), target);
    }
  }
  return V;
}
async function installEntry(id) {
  const V = kitVersions(id);
  const lib = path.join(GAME_DIR, 'architect', 'library');
  const d = path.join(lib, id);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(path.join(V, 'v1'))) fs.copyFileSync(path.join(V, 'v1', f), path.join(d, f));
  await cmd('/architect reload');
  await settle(2000);
  const r = await call('dev.entry.installVersion', { entry: id, dir: path.join(V, 'v2'), summary: 'v2' }, 60_000);
  return r.version;
}

/**
 * Item 7: one area of test:a across a strip. Every op of §8's table by test:a is refused PROTECTED and writes nothing (force
 * too); a partial road crosses it; test:b and the player pass; remove, undo and undoStage of test:a sites marked after placing
 * succeed; the area survives a save and reload.
 */
steps.protect = async () => {
  await ensure();
  const W = 'G6B 0c Protect';
  await fresh(W, FLAT);
  const ID = 'g0c_cabin';
  const v2 = await installEntry(ID);
  check(v2 === 2, `protect: the delta fixture ${ID} has v2 (${v2})`);
  const X = 1000, Z = 1000;
  await tp(X + 40.5, 0, Z + 30.5, 0, 89);
  // before the mark: test:a's sites (remove, undo, undoStage, delta and revert later) and a region plan
  const s1 = await cabin(X + 10, Z + 5, A);
  const s2 = await cabin(X + 30, Z + 5, A, ID);
  const d1 = await call('dev.site.delta.apply', { site: s2, version: 2, owner: A }, 120_000);
  check(d1.applied, `protect: ${s2} at v2 before the mark (${json(d1.refusals ?? [])})`);
  const y = await feet(X + 50, Z + 5);
  const bq = await later(`bqueue ${json({ owner: A, autoApprove: true, items: [{ key: 'b1', bp: 'cabin', at: [X + 50, y, Z + 5], mode: 'INSTANT' }] })}`);
  await sleep(8000);
  const bv = await api(`batch ${bq}`);
  const grp = (await api(`sgroups ${A}`)).find?.((g) => g.owner === A) ?? null;
  const rp = await call('dev.region.plan', { program: 'region_small', claim: [X + 200, Z - 96, X + 391, Z + 95], surveyLoad: 'bounded:256', check: false, owner: A }, 900_000);
  check(!!rp.planId, `protect: a region of test:a planned before the mark (${rp.planId ?? json(rp)})`);
  // the mark: the strip x X..X+400, z Z-100..Z+100 (the sites, the region's claim, the road and cell strips)
  const area = await api(`protect ${json({ owner: A, id: 'strip', x0: X, z0: Z - 100, x1: X + 400, z1: Z + 100, label: 'test strip' })}`);
  check(area.id === 'strip', `protect: area marked (${json(area)})`);
  const min = [X, -64, Z - 100], max = [X + 120, 60, Z + 100];
  const h0 = await hash(min, max);
  const e0 = await entries();
  const out = {};
  const refused = (name, r) => {
    const rs = Array.isArray(r) ? r : reasons(r);
    out[name] = r;
    return check(rs.includes('PROTECTED'), `protect: ${name} refused PROTECTED (${json(rs)})`);
  };
  const y2 = await feet(X + 70, Z + 30);
  for (const f of ['', ' force']) {
    refused(`check${f}`, await api(`check cabin ${X + 70} ${y2} ${Z + 30} INSTANT unowned noactor 0 owner=${A}${f}`));
    refused(`place${f}`, await later(`place cabin ${X + 70} ${y2} ${Z + 30} INSTANT unowned noactor 0 owner=${A}${f}`));
  }
  refused('fitToLot', await api(`fit cabin ${X + 70},${y2},${Z + 30},${X + 90},${y2 + 10},${Z + 55} north owner=${A}`));
  const bb = await later(`bqueue ${json({ owner: A, items: [{ key: 'k1', bp: 'cabin', at: [X + 70, y2, Z + 30], mode: 'INSTANT', force: true }] })}`);
  await sleep(6000);
  const bbv = await api(`batch ${bb}`);
  refused('batch building item', (bbv.items ?? []).map((i) => i.reason));
  for (const f of [false, true]) {
    refused(`checkDelta${f ? ' force' : ''}`, await api(`checkdelta ${s2} 1 ${A}${f ? ' force' : ''}`));
    refused(`applyDelta${f ? ' force' : ''}`, await later(`applydelta ${s2} 1 ${A}${f ? ' force' : ''}`));
  }
  refused('revert', await later(`srevert ${s2} 1`).then((r) => r.refusals ? r : { refusals: [{ reason: String(r.error ?? json(r)).includes('protected') ? 'PROTECTED' : json(r) }] }));
  const bd = await later(`bqueue ${json({ owner: A, items: [{ key: 'd1', delta: { site: s2, version: 1, owner: A, force: true } }] })}`);
  await sleep(6000);
  refused('batch delta item', ((await api(`batch ${bd}`)).items ?? []).map((i) => i.reason));
  const yr = await feet(X + 100, Z - 20);
  const road = { points: [[X + 100, yr, Z - 140], [X + 100, yr, Z - 105], [X + 100, yr, Z + 105], [X + 100, yr, Z + 140]], width: 3, owner: A };
  for (const f of [false, true]) {
    refused(`checkRoad${f ? ' force' : ''}`, await api(`roadcheck ${json({ ...road, force: f })}`));
    refused(`placeRoad${f ? ' force' : ''}`, await later(`road ${json({ ...road, force: f, tag: 'pr' + f })}`));
  }
  const br = await later(`bqueue ${json({ owner: A, items: [{ key: 'r1', road }] })}`);
  await sleep(6000);
  refused('batch road item', ((await api(`batch ${br}`)).items ?? []).map((i) => i.reason));
  const cells = { kind: 'test:pad', cells: [[X + 110, yr, Z + 10, 'minecraft:gold_block'], [X + 111, yr, Z + 10, 'minecraft:gold_block']], owner: A };
  for (const f of [false, true]) {
    refused(`checkCells${f ? ' force' : ''}`, await api(`cellscheck ${json({ ...cells, force: f })}`));
    refused(`placeCells${f ? ' force' : ''}`, await later(`cells ${json({ ...cells, force: f, tag: 'pc' + f })}`));
  }
  const bc = await later(`bqueue ${json({ owner: A, items: [{ key: 'c1', cells }] })}`);
  await sleep(6000);
  refused('batch cells item', ((await api(`batch ${bc}`)).items ?? []).map((i) => i.reason));
  const rr = await call('dev.region.realise', { planId: rp.planId, autoApprove: true }, 300_000).catch((e) => ({ refused: String(e) }));
  refused('region realise after a late mark', [String(json(rr.refused ?? rr)).includes('PROTECTED') || String(json(rr)).includes('protected area') ? 'PROTECTED' : json(rr)]);
  const rp2 = await call('dev.region.plan', { program: 'region_small', claim: [X + 200, Z - 96, X + 391, Z + 95], surveyLoad: 'bounded:256', check: false, owner: A }, 900_000).catch((e) => ({ refused: String(e) }));
  refused('region plan over the area', [String(json(rp2.refused ?? rp2)).includes('PROTECTED') || String(json(rp2)).includes('protected area') ? 'PROTECTED' : json(rp2)]);
  // a move of a test:a site into the area (the ghost's server verdict)
  await call('dev.build.start', { blueprint: 'cabin', origin: [X + 70, y2, Z + 60], move: s1 }, 60_000).catch(() => {});
  await sleep(3000);
  const mv = await call('dev.build.state', {}, 30_000).catch((e) => ({ error: String(e) }));
  const mvc = await call('dev.build.confirm', {}, 60_000).catch((e) => ({ error: String(e) }));
  await call('dev.build.cancel', {}, 10_000).catch(() => {});
  out.move = { state: mv, confirm: mvc };
  check(json(mv).includes('PROTECTED') || json(mvc).includes('protectedarea'), `protect: a move of ${s1} into the area refused PROTECTED (${json(mvc).slice(0, 200)})`);
  await settle(3000);
  const h1 = await hash(min, max);
  const e1 = await entries();
  check(h1 === h0 && e1 === e0, `protect: nothing written: world diff ${h1 === h0 ? 0 : 'NOT 0'}, journal entries ${e0} -> ${e1}`);
  // a partial road across the area: both sides placed, the area's span skipped
  const pp = await later(`road ${json({ ...road, partial: true, tag: 'partial' })}`);
  check(pp.placed && pp.skipped.some((s) => s.reason === 'PROTECTED'), `protect: a partial road crossing the area places both sides and skips its span (${json(pp.skipped).slice(0, 300)})`);
  // the same ops by test:b and by the player pass
  const ok = (name, r) => check(!reasons(r).includes('PROTECTED') && (r.ok ?? r.placed ?? true), `protect: ${name} passes (${json(r.refusals ?? []).slice(0, 160)})`);
  for (const [who, flag] of [[B, ` owner=${B}`], ['the player', '']]) {
    ok(`check by ${who}`, await api(`check cabin ${X + 70} ${y2} ${Z + 30} INSTANT unowned noactor 0${flag}`));
    ok(`checkRoad by ${who}`, await api(`roadcheck ${json({ ...road, owner: who === B ? B : undefined })}`));
    ok(`checkCells by ${who}`, await api(`cellscheck ${json({ ...cells, owner: who === B ? B : undefined })}`));
    ok(`fitToLot by ${who}`, await api(`fit cabin ${X + 70},${y2},${Z + 30},${X + 90},${y2 + 10},${Z + 55} north${who === B ? ` owner=${B}` : ''}`));
  }
  const pb = await later(`place cabin ${X + 70} ${y2} ${Z + 30} INSTANT unowned noactor 0 owner=${B}`);
  check(pb.placed, `protect: test:b places inside test:a's area (${pb.siteId})`);
  // remove, undo and undoStage of test:a sites marked after placing
  const rm = await later(`remove ${s1} ${A} noforce`);
  check(rm.removed, `protect: remove of ${s1} succeeds (${json(rm.blockers)})`);
  const g = (await api(`sgroups ${A}`)).find?.((x) => (x.sites ?? []).length) ?? grp;
  if (g) {
    const st = (g.stages ?? [])[0]?.name ?? bq;
    const un = await later(`sundo ${g.group} ${st}`);
    check(un.removed, `protect: undoStage of ${g.group}/${st} succeeds (${json(un.blockers ?? un)})`);
  } else check(false, `protect: no group of ${A} for undoStage (${json(bv).slice(0, 200)})`);
  const rm2 = await later(`remove ${s2} ${A} noforce`);
  check(rm2.removed, `protect: remove (undo) of ${s2} after its delta succeeds`);
  // survives a save and reload
  await leaveWorld();
  await openWorld(W);
  const areas = await api(`areas ${A}`);
  check(areas.some((x) => x.id === 'strip' && x.x0 === X && x.z1 === Z + 100), `protect: the area survives a save and reload (${json(areas)})`);
  return { area, out, partial: pp };
};

/**
 * Item 8: entities tagged architect:owner=test:a don't block or get discarded by test:a's ops; untagged, other-owner tags and
 * players still block.
 */
steps.tags = async () => {
  await ensure();
  await fresh('G6B 0c Tags', FLAT);
  const ID = 'g0c_cabin';
  await installEntry(ID);
  const X = 1500, Z = 1500;
  await tp(X + 20.5, 0, Z - 20.5, 0, 60);
  const summon = async (type, x, y, z, tag, extra = '') => {
    await cmd(`/summon ${type} ${x} ${y} ${z} {NoAI:1b,PersistenceRequired:0b${tag ? `,Tags:["architect:owner=${tag}"]` : ''}${extra}}`);
    await settle(500);
  };
  const kill = async () => { await cmd(`/kill @e[type=!minecraft:player,x=${X - 50},y=-64,z=${Z - 50},dx=200,dy=200,dz=200]`); await settle(1000); };
  const alive = async (x, y, z, type) => (await api(`tagged ${x} ${y} ${z} 30`)).filter((e) => e.type === type && e.alive);
  const y = await feet(X, Z);
  const out = {};
  // a new place over a tagged villager
  await summon('minecraft:villager', X + 4.5, y, Z + 4.5, A);
  const p1 = await later(`place cabin ${X} ${y} ${Z} INSTANT unowned noactor 0 owner=${A}`);
  check(p1.placed, `tags: a new place over a test:a-tagged villager goes ahead (${json(p1.refusals)})`);
  check((await alive(X + 4, y, Z + 4, 'minecraft:villager')).length === 1, 'tags: the villager is alive (not discarded)');
  // remove with the tagged villager in the box
  const rm = await later(`remove ${p1.siteId} ${A} noforce`);
  check(rm.removed, `tags: remove goes ahead (${json(rm.blockers)})`);
  check((await alive(X + 4, y, Z + 4, 'minecraft:villager')).length === 1, 'tags: the villager is alive after the remove');
  await kill();
  // a delta over a tagged villager
  const s2 = await cabin(X + 40, Z, A, ID);
  await summon('minecraft:villager', X + 44.5, y, Z + 4.5, A);
  const d = await call('dev.site.delta.apply', { site: s2, version: 2, owner: A }, 120_000).catch((e) => ({ error: String(e) }));
  check(d.applied, `tags: applyDelta goes ahead (${json(d.refusals ?? d.error ?? '')})`);
  check((await alive(X + 44, y, Z + 4, 'minecraft:villager')).length === 1, 'tags: the villager is alive after the delta');
  await later(`remove ${s2} ${A} noforce`);
  await kill();
  // group undo over a tagged villager
  const bq = await later(`bqueue ${json({ owner: A, autoApprove: true, items: [{ key: 'g1', bp: 'cabin', at: [X + 80, y, Z], mode: 'INSTANT' }] })}`);
  await sleep(8000);
  const g = (await api(`sgroups ${A}`)).find?.((x) => (x.sites ?? []).length);
  await summon('minecraft:villager', X + 84.5, y, Z + 4.5, A);
  const gu = g ? await later(`sgremove ${g.group} noforce ${A}`, 300_000) : { error: 'no group' };
  check(gu.removed, `tags: group undo goes ahead (${json(gu.blockers ?? gu)})`);
  check((await alive(X + 84, y, Z + 4, 'minecraft:villager')).length === 1, 'tags: the villager is alive after the group undo');
  await kill();
  // untagged blocks; tagged test:b blocks test:a
  await summon('minecraft:villager', X + 4.5, y, Z + 4.5, null);
  const c0 = await api(`check cabin ${X} ${y} ${Z} INSTANT unowned noactor 0 owner=${A}`);
  check(reasons(c0).includes('OCCUPIED'), `tags: an untagged villager blocks (OCCUPIED) (${json(reasons(c0))})`);
  await kill();
  await summon('minecraft:villager', X + 4.5, y, Z + 4.5, B);
  const cb = await api(`check cabin ${X} ${y} ${Z} INSTANT unowned noactor 0 owner=${A}`);
  check(reasons(cb).includes('OCCUPIED'), `tags: a test:b-tagged villager blocks test:a (${json(reasons(cb))})`);
  await kill();
  // an untagged villager in a standing test:a site blocks its removal
  const s3 = await cabin(X, Z + 40, A);
  await summon('minecraft:villager', X + 4.5, y, Z + 44.5, null);
  const rb = await later(`remove ${s3} ${A} noforce`);
  check(!rb.removed && rb.blockers.length > 0, `tags: untagged, it blocks the removal (${json(rb.blockers)})`);
  await kill();
  await later(`remove ${s3} ${A} noforce`);
  // a tagged unnamed zombie isn't discarded (at night: a zombie burns at noon); an untagged one is (the control)
  await cmd('/time set 18000');
  await cmd('/difficulty easy'); // a peaceful world summons no zombie
  await summon('minecraft:zombie', X + 44.5, y, Z + 4.5, null);
  const pu = await later(`place cabin ${X + 40} ${y} ${Z} INSTANT unowned noactor 0 owner=${A}`);
  const zu = (await alive(X + 44, y, Z + 4, 'minecraft:zombie')).length;
  check(pu.placed && zu === 0 && pu.notes.some((n) => n.includes('zombie')), `tags: control: an untagged unnamed zombie is discarded (${pu.placed})`);
  if (pu.siteId) await later(`remove ${pu.siteId} ${A} noforce`);
  await summon('minecraft:zombie', X + 4.5, y, Z + 4.5, A);
  const pz = await later(`place cabin ${X} ${y} ${Z} INSTANT unowned noactor 0 owner=${A}`);
  check(pz.placed && (await alive(X + 4, y, Z + 4, 'minecraft:zombie')).length === 1, `tags: a tagged unnamed zombie isn't discarded (${pz.placed})`);
  await later(`remove ${pz.siteId} ${A} noforce`);
  await kill();
  await cmd('/difficulty peaceful');
  await cmd('/time set 6000');
  // a player in the box still blocks
  await cmd('/gamemode creative');
  await cmd(`/tp @s ${X + 4.5} ${y} ${Z + 4.5}`);
  await settle(1500);
  const cp = await api(`check cabin ${X} ${y} ${Z} INSTANT unowned noactor 0 owner=${A}`);
  check(reasons(cp).includes('PLAYER_IN_BOX'), `tags: a player in the box still blocks (${json(reasons(cp))})`);
  await tp(X + 20.5, 0, Z - 20.5, 0, 60);
  return out;
};

steps.all = async () => {
  for (const s of ['base', 'api', 'minlot', 'roads', 'ground', 'protect', 'tags']) await run(s);
};

const name = process.argv[2];
if (!steps[name]) {
  console.log(`steps: ${Object.keys(steps).join(' ')}`);
  process.exit(2);
}
if (name === 'all') await steps.all();
else await run(name);
try { state.dev?.close(); } catch { /* closed */ }
log(`${name}: ${fails()} failure(s)`);
process.exit(fails() ? 1 : 0);
