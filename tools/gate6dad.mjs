#!/usr/bin/env node
// Slice 6d AD gate (adopting a VillageLayout settlement as a region; docs/CONTRACT.md "Phase 6d slice AD" §4, the 6d rows of the C12 joint
// gate) against the headless server of the AD run worktree (GATE6B_RUN, default `../architect-mc-AD-run`; the sim sidecar, no Claude). $0.
//
//   node tools/gate6dad.mjs <step>
//     start [world] | stop | base      the headless server (or client) and the flat base world
//     unit      (ad-unit)              row 1 offline: kit ad.test (20 synthetic VillageLayout settlements: lots, roads and graph as V's, no parts;
//                                      the refusals; GR frontage and an extension over the adopted IR; plan/0 revision.grow over the adopted
//                                      artifact's plan), JournalRegroupTest (the metadata-only regroup), RegionAdoptTest, ApiRulesTest, ApiADTest;
//                                      api-compat against the 0.47.0 / 0.45.0 apitest jars and the 0.47.0 mod surface
//     ingame    (ad-ingame)            rows 2-6c on a Steward-shaped settlement (Steward's BatchPlanner shape through the API: the street road
//                                      items `street`, `street#2` of two builds in two groups, lot items keyed by their lot ids, steward_mc ext):
//                                      2 adopt (0 cells changed, 0 journal entries written, RegionView lots and street, one owner per site; LC
//                                      reads it); 4 applyDelta on an adopted lot; 3 a GR growth through checkPlan of a revision plan naming the
//                                      adopted artifact, then realiseApproved; 5 Regions.remove E-flat 0 (the verifier re-runs it); 6 and 6c a
//                                      second settlement adopted, Steward adds a site to an old group, un-adopted: memberships and stage lists as
//                                      before plus the added site, Steward's own undo of one site exact, then the rest removed E-flat 0
//     crash     (ad-crash)             row 6b (the verifier re-runs it): a kill after each of §2.3's steps 1-4 for adopt (AD1-AD4) and for
//                                      un-adopt (UA1-UA4) on a settlement with a lot of two deltas and a road: each restart rolls forward or back,
//                                      one owner per site in every record, 0 cells written; then architect-sites.json deleted and Sites.reconcile
//                                      rebuilds every record with the same membership; Steward's own undo of every site exact (E-flat 0)
//     report                            the step JSONs' check counts
//
// Row 7 (the joint row: the link pass over the adopted region, then rows 3-5 again) is 7b LP's: GATE6DAD_LP=1 adds its checks to this
// step (step lp-ad of tools/gate-chains.json; the adopted region has no port link, so its growth's realise runs no link pass).
// Evidence: artifacts/gate6d-ad/<step>.json in the main checkout (GATE6DAD_OUT overrides), all.log, spend.json ($0.00).
// Ports: 8896/8897 (the AD lane).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-AD-run');
process.env.GATE6B_OUT = process.env.GATE6DAD_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6d-ad');
process.env.GATE6B_SIDECAR_PORT ??= '8896';
process.env.GATE6B_DEV_PORT ??= '8897';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, call, cmd, sleep } = L;

L.refuseKeys();
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');

const OWNER = 'test:ad';
const FLAT = 'G6B Flat Base';
const ENTRY = 'ad_cabin';
const LOT = { sx: 15, sz: 17 };

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice AD is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ cells

function norm(s) {
  const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(String(s));
  if (!m) return String(s);
  const id = m[1].includes(':') ? m[1] : `minecraft:${m[1]}`;
  const props = m[2] ? m[2].split(',').filter(Boolean).sort() : [];
  return props.length ? `${id}[${props.join(',')}]` : id;
}
function asState(nbt) {
  const bs = /^Block\{([a-z0-9_.-]+:[a-z0-9_./-]+)\}(\[[^\]]*\])?/.exec(nbt);
  if (bs) return norm(`${bs[1]}${bs[2] ?? ''}`);
  const n = /(?:Name|id)\s*:\s*["']?([a-z0-9_.-]+:[a-z0-9_./-]+)/i.exec(nbt)?.[1];
  if (!n) return nbt;
  const pm = /properties\s*:\s*\{([^}]*)\}/i.exec(nbt)?.[1];
  const props = pm ? [...pm.matchAll(/["']?([a-z0-9_]+)["']?\s*:\s*["']?([a-z0-9_]+)["']?/g)].map((m) => `${m[1]}=${m[2]}`).sort() : [];
  return norm(props.length ? `${n}[${props.join(',')}]` : n);
}
const idOf = (s) => String(s).replace(/\[.*$/, '').replace(/^minecraft:/, '');
async function cellsOf(b) {
  const h = await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], cells: true }, 300_000);
  return new Map((h.cells ?? []).map((l) => { const sp = l.indexOf(' '); return [l.slice(0, sp), asState(l.slice(sp + 1).split(' be=')[0])]; }));
}
const hashOf = async (b) => (await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] }, 300_000)).sha256;
function diff(a, b, max = 12) {
  const out = [];
  let n = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = norm(a.get(k) ?? 'minecraft:air'), y = norm(b.get(k) ?? 'minecraft:air');
    if (x !== y) { n++; if (out.length < max) out.push(`${k} expected ${x} got ${y}`); }
  }
  return { n, first: out };
}
async function groundY(x, z) {
  const c = await cellsOf([x, -64, z, x, 255, z]);
  let g = -64;
  for (const [k, s] of c) { const y = Number(k.split(',')[1]); if (idOf(s) !== 'air' && y > g) g = y; }
  return g;
}
async function freshFlat(name, at) {
  await L.fresh(name, FLAT);
  await L.setRules('exact');
  await cmd('/op @s').catch(() => null);
  await L.tp(at[0], 60, at[1]);
}

// ------------------------------------------------------------------ the delta fixture: ad_cabin v1, v2, v3 (gate5b's kit version builder)

function kitVersions(id) {
  const V = path.join(OUT, 'versions', id);
  for (const [v, args] of [['v1', []], ['v2', ['--values', '{"width":10,"porch":false}']], ['v3', ['--values', '{"width":10,"porch":true}']]]) {
    const tmp = path.join(OUT, 'kitbuild', `${id}-${v}`);
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
        Object.assign(j, { id, name: id, source: `${id}.mjs` });
        fs.writeFileSync(target, JSON.stringify(j, null, 2));
      } else fs.copyFileSync(path.join(tmp, f), target);
    }
  }
  return V;
}
async function installEntry(id = ENTRY) {
  const V = kitVersions(id);
  const d = path.join(L.LIBRARY, id);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(path.join(V, 'v1'))) fs.copyFileSync(path.join(V, 'v1', f), path.join(d, f));
  await cmd('/architect reload');
  await L.settle(2000);
  const v2 = await call('dev.entry.installVersion', { entry: id, dir: path.join(V, 'v2'), summary: 'v2' }, 60_000);
  const v3 = await call('dev.entry.installVersion', { entry: id, dir: path.join(V, 'v3'), summary: 'v3' }, 60_000);
  return [v2.version, v3.version];
}

// ------------------------------------------------------------------ a Steward-shaped VillageLayout settlement

/**
 * VillageLayout's lots on a flat street: `n` lots alternating north and south from x0, 15 x 17 (the design's 11 x 12 cabin and its approach),
 * lotGap 3; the street (z = sz) from the first lot's x to the last lot's max x.
 */
function layout({ x0, sz, n, prefix }) {
  const lots = [];
  let xn = x0, xs = x0;
  for (let i = 0; i < n; i++) {
    const north = i % 2 === 0;
    const x = north ? xn : xs;
    const z = north ? sz - 2 - 1 - LOT.sz + 1 : sz + 2 + 1;
    lots.push({ id: `${prefix}_${i + 1}`, x, z, sx: LOT.sx, sz: LOT.sz, north });
    if (north) xn = x + LOT.sx + 3; else xs = x + LOT.sx + 3;
  }
  const xa = Math.min(...lots.map((l) => l.x)), xb = Math.max(...lots.map((l) => l.x + l.sx - 1));
  return { lots, x0: xa, x1: xb };
}
async function batchWait(batchId, timeoutMs = 600_000) {
  const t0 = Date.now();
  let b;
  while (Date.now() - t0 < timeoutMs) {
    b = await call('dev.ad.batch', { batchId }, 10_000);
    if (['DONE', 'CANCELLED', 'FAILED'].includes(b.status)) return b;
    await sleep(L.pollDelayMs(Date.now() - t0));
  }
  throw new Error(`batch ${batchId} did not end: ${json(b)}`);
}
/** One Steward build (BatchPlanner's shape): its street pieces (keys street, street#n), its lots, in a new group (or `group`). */
async function build({ y, sz, lots, spans, keys, group, settlement, build: b, stage }) {
  const q = await call('dev.ad.settlement', { owner: OWNER, entry: ENTRY, streetZ: sz, y, lots, spans, ...(keys ? { keys } : {}), ...(group ? { group } : {}), settlement, build: b,
    ...(stage ? { stage } : {}) }, 120_000);
  if (q.refused) throw new Error(`the build was refused: ${q.refused}`);
  const done = await batchWait(q.batchId);
  const bad = done.items.filter((i) => i.status !== 'PLACED');
  check(done.status === 'DONE' && !bad.length, `Steward's build ${b} (${settlement}): ${done.items.length} items placed in group ${done.group} (${json(bad)})`);
  const site = Object.fromEntries(done.items.map((i) => [i.key, i.site]));
  return { group: done.group, site, items: done.items };
}
async function adopt(T, extra = {}) {
  return call('dev.ad.adopt', { owner: OWNER, claim: T.claim, geometry: { streetZ: T.sz, xLo: T.x0, xHi: T.x1 }, roads: T.roads, lots: T.lotSites, ...extra }, 900_000);
}
const adState = (sites) => call('dev.ad.state', { sites }, 60_000);
const sitesOf = (T) => [...T.roads, ...Object.values(T.lotSites)];
async function removeRegion(region, requester = OWNER) {
  const r = await call('dev.region.remove', { region, requester }, 4 * 3_600_000);
  for (let i = 0; i < 2400; i++) {
    const st = await call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || ['REMOVED', 'PARTIAL', 'FAILED'].includes(s)) break;
    await sleep(500);
  }
  await L.settle(2000);
  return r;
}
async function siteRemove(site) {
  return call('dev.rv.siteRemove', { site, force: true, requester: OWNER }, 600_000);
}
async function rvState(region) { return call('dev.rv.state', { region }, 60_000); }
async function rvWait(region, rid, timeoutMs = 1_800_000) {
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < timeoutMs) {
    st = await rvState(region);
    const r = st.revisions.find((x) => x.rid === rid);
    if (st.busy === null && r && !['ACCEPTED', 'PLACING'].includes(r.state)) return { st, r };
    await sleep(L.pollDelayMs(Date.now() - t0));
  }
  throw new Error(`revision ${rid} of ${region} did not end (${json(st?.revisions?.map((x) => [x.rid, x.state]))}, busy ${st?.busy})`);
}
async function checkPlan(plan, claim) {
  const r = await call('dev.region.checkPlan', { plan, claim, owner: OWNER }, 900_000);
  if (r.refused) { log(`  check refused: ${r.refused}`); return r; }
  log(`  check ${r.check.checkId}: ${r.check.overall} ${r.check.parts.map((p) => `${p.part}:${p.class}`).join(' ')} artifact ${r.check.artifactSha?.slice(0, 12) ?? '-'}`);
  return r.check;
}

/** A settlement of two Steward builds: the founding build (street + n lots, group A) and an addition (street#2 east of it + 1 lot, group B). */
async function settlement({ cx, cz, n, prefix }) {
  const y = await groundY(cx + 4, cz + 4);
  const sz = cz + 48;
  const L1 = layout({ x0: cx + 12, sz, n, prefix });
  const b1 = await build({ y, sz, lots: L1.lots, spans: [[L1.x0, L1.x1]], settlement: prefix, build: 'b1' });
  // the addition: one lot past the street's east end, the street extended to it (street#2), a later build in its own group
  const ax = L1.x1 + 4;
  const add = { id: `${prefix}_${n + 1}`, x: ax, z: sz + 3, sx: LOT.sx, sz: LOT.sz, north: false };
  const b2 = await build({ y, sz, lots: [add], spans: [[L1.x1 + 1, ax + LOT.sx - 1]], keys: ['street#2'], settlement: prefix, build: 'b2' });
  const lotSites = {};
  for (const l of [...L1.lots, add]) lotSites[l.id] = b1.site[l.id] ?? b2.site[l.id];
  const claim = [cx, cz, cx + 160, cz + 96];
  const box = [claim[0] - 4, y - 12, claim[1] - 4, claim[2] + 4, y + 24, claim[3] + 4];
  return { y, sz, x0: L1.x0, x1: ax + LOT.sx - 1, claim, box, lots: [...L1.lots, add], lotSites, roads: [b1.site.street, b2.site['street#2']], groups: [b1.group, b2.group], b1, b2 };
}

// ------------------------------------------------------------------ the client or server and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B AD Lobby', { backend: 'sim' });
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

// ------------------------------------------------------------------ ad-unit: row 1 offline, the mod's units, api-compat

async function javaTests(patterns, minTests) {
  const { srcGradle } = await import('./lib/src-gradle.mjs');
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const args = ['test', '--offline', '-q', ...patterns.flatMap((p) => ['--tests', p])];
  const g = srcGradle(root, () => spawnSync('./gradlew', args, { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 }));
  const dir = path.join(root, 'mod', 'build', 'test-results', 'test');
  let tests = 0, failures = 0;
  const names = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.xml') || !patterns.some((p) => f.includes(p.replaceAll('*', '')))) continue;
    const x = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = /tests="(\d+)" skipped="\d+" failures="(\d+)" errors="(\d+)"/.exec(x);
    if (m) { tests += +m[1]; failures += +m[2] + +m[3]; names.push(`${f.replace(/^TEST-|\.xml$/g, '')}: ${m[1]}/${+m[2] + +m[3]}`); }
  }
  return { code: g.status, tests, failures, names, tail: `${g.stdout ?? ''}${g.stderr ?? ''}`.split('\n').slice(-12), ok: g.status === 0 && tests >= minTests && failures === 0 };
}
function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
function apiJars() {
  const A = process.env.GATE6DAD_JARS ?? path.join(os.homedir(), 'Developer', 'LarattaLabs', 'Minecraft', 'architect-mc', 'artifacts', 'gate6d-rv', 'jars');
  return { jars: [path.join(A, 'architect_apitest-0.47.0.jar'), path.join(A, 'architect_apitest-0.45.0.jar')], surface: path.join(A, 'architect_mc-0.47.0.jar') };
}

steps.unit = async () => {
  const out = {};
  out.kit = nodeTest(['kit/test/ad.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 5, `row 1 (kit ad.test): 20 synthetic VillageLayout settlements (ew and ns, one and two street pieces): lots the sites' boxes facing the street, roads the road sites flagged with the zone, V's graph (lot nodes, a junction per entrance, the plaza at the middle, two terminal ends GR can extend), no parts, tiles or budget; the refusals; deterministic; GR frontage and an extension over the adopted IR; plan/0 revision.grow over the adopted artifact's plan: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  out.java = await javaTests(['*JournalRegroupTest*', '*RegionAdoptTest*', '*ApiRulesTest*', '*ApiADTest*'], 8);
  check(out.java.ok, `JournalRegroupTest (Meta.group and the head's membership, no section file written, durable, idempotent), RegionAdoptTest, ApiRulesTest (feature regionAdopt), ApiADTest (the defaults that throw): ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
  const J = apiJars();
  out.apicompat = [...J.jars.map((j) => ['tools/api-compat.mjs', j]), ['tools/api-compat.mjs', '--surface', J.surface]].map((args) => {
    const ac = fs.existsSync(args.at(-1)) ? spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 900_000, env }) : { status: -1, stdout: `missing ${args.at(-1)}`, stderr: '' };
    return { args: args.slice(1).map((a) => path.basename(a)), code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter(Boolean).slice(-3) };
  });
  check(out.apicompat.every((a) => a.code === 0), 'api-compat: binary compatible with the 0.47.0 and 0.45.0 apitest jars and the 0.47.0 mod surface (Regions gains adopt and unadopt as defaults that throw; two new records)', out.apicompat);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ ad-ingame: rows 2, 3, 4, 5, 6, 6c

steps.ingame = async () => {
  await ensure();
  const out = {};
  const CX = 14000, CZ = 14000;
  const world = 'G6B AD Ingame';
  await freshFlat(world, [CX + 60, CZ + 48]);
  const vs = await installEntry();
  check(json(vs) === json([2, 3]), `the delta fixture ${ENTRY}: v2 and v3 installed (${json(vs)})`);
  const gy = await groundY(CX + 4, CZ + 4);
  const BOX = [CX - 4, gy - 12, CZ - 4, CX + 164, gy + 24, CZ + 100];
  const B0 = await cellsOf(BOX);
  const T = await settlement({ cx: CX, cz: CZ, n: 4, prefix: 'house' });
  // a delta before the adoption (a site with history)
  const pre = await call('dev.site.delta.apply', { site: T.lotSites.house_2, version: 2, owner: OWNER }, 120_000);
  check(pre.applied === true, `a delta on house_2 before the adoption: applied (${json(pre.refusals ?? [])})`);
  const S0 = await cellsOf(BOX);
  const h0 = await hashOf(BOX);
  const st0 = await adState(sitesOf(T));
  out.before = { groups: T.groups, sites: st0.sites, entries: st0.entries };

  // ---- row 2: adopt: 0 changed cells, 0 journal entries written, RegionView lists the lots and the street
  const a = await adopt(T, { opKey: 'ad.row2' });
  out.adopt = a;
  check(!a.refused && a.state === 'PLACED', `row 2: Regions.adopt: region ${a.region} ${a.state ?? a.refused} in ${a.ms} ms`);
  const region = a.region;
  const h1 = await hashOf(BOX);
  const st1 = await adState(sitesOf(T));
  check(h1 === h0, `row 2: 0 changed cells (the box's hash before ${h0.slice(0, 12)}, after ${h1.slice(0, 12)})`);
  check(st1.entries === st0.entries && st1.nextId === st0.nextId, `row 2: 0 journal entries written (${st0.entries} -> ${st1.entries} entries, next id ${st0.nextId} -> ${st1.nextId})`);
  const lotIds = (a.lots ?? []).map((l) => l.id).sort();
  check(json(lotIds) === json(Object.keys(T.lotSites).sort()) && (a.lots ?? []).every((l) => l.siteId === T.lotSites[l.id] && l.state === 'placed'), `row 2: RegionView lists its ${lotIds.length} lots with their sites, placed (${json(a.lots?.map((l) => [l.id, l.siteId, l.state]))})`);
  const view = await call('dev.region.state', { region }, 60_000);
  const items = await call('dev.region.items', { region, owner: OWNER }, 60_000).catch(() => null);
  out.view = { state: view.view?.state, groupId: view.view?.groupId, ext: view.view?.ext };
  const ir = JSON.parse(fs.readFileSync(path.join(L.SAVES, world, 'architect-regions', region, 'ir.json'), 'utf8'));
  check(ir.roads.length === 2 && ir.roads.every((r) => r.ext?.['architect_mc:street']?.zone === 'village' && T.roads.includes(r.adopted)) && ir.parts.length === 0 && (ir.graph?.nodes ?? []).some((n) => n.kind === 'plaza'), `row 2: its IR: the street ${json(ir.roads.map((r) => [r.id, r.adopted]))} flagged, the plaza, no parts`);
  const g = st1.groups[a.groupId];
  check(st1.agree && g && json([...g.sites].sort()) === json(sitesOf(T).sort()) && T.groups.every((x) => (st1.groups[x]?.sites ?? []).length === 0), `row 2: one owner per site: every site, head record and entry in the region's group ${a.groupId} (${g?.sites?.length} sites, stage ${json(Object.keys(g?.stages ?? {}))}); the old groups ${json(T.groups)} list none (agree ${st1.agree})`);
  check(Object.values(st1.sites).every((s) => s.member?.itemKey?.startsWith('lot:') || s.member?.itemKey?.startsWith('road:street_')), `row 2: each membership is the region's: ${json(Object.values(st1.sites).map((s) => s.member?.itemKey))}`);
  check(typeof view.view?.ext?.['architect_mc:artifact'] === 'string' && view.view?.ext?.['architect_mc:adopted'] === 'village_layout', `row 2: its ext names the artifact and the layout (${json(view.view?.ext)})`);
  const again = await adopt(T, { opKey: 'ad.row2' });
  check(again.region === region, `row 2: adopting again under the same key answers the same region (${again.region ?? again.refused})`);
  const dup = await adopt(T);
  check(/NOT_ALLOWED/.test(String(dup.refused)), `row 2: adopting its sites again refuses NOT_ALLOWED (${dup.refused})`);
  void items;
  // LC reads an adopted region: no change, nothing unattributed on its roads
  const lc = await call('dev.region.landCheck', { region }, 900_000).catch((e) => ({ refused: String(e) }));
  out.landCheck = lc;
  check(!lc.refused && (lc.parts ?? []).every((p) => (p.changed ?? 0) === 0 && (p.removed ?? 0) === 0), `LC on the adopted region: no change reported (${json((lc.parts ?? []).map((p) => [p.part, p.cells, p.changed]))})`);

  // ---- row 4: applyDelta on one adopted lot (v2)
  const d4 = await call('dev.site.delta.apply', { site: T.lotSites.house_3, version: 2, owner: OWNER }, 120_000);
  const st4 = await adState(sitesOf(T));
  check(d4.applied === true && st4.agree, `row 4: applyDelta on the adopted lot house_3 to v2: applied (${json(d4.refusals ?? [])}); its delta entry in the region's group (agree ${st4.agree})`);

  // ---- row 3: a GR growth of one lot on the street: checkPlan of a revision plan naming the adopted artifact, then realiseApproved
  const sha = view.view.ext['architect_mc:artifact'];
  const art = (await call('dev.region.artifact', { sha, body: true }, 60_000)).artifact;
  check(art?.body?.region?.adopted === true && art.body.lots.length === 5 && art.regions?.includes?.(region), `row 3: the adopted artifact ${sha.slice(0, 12)}: region.adopted, ${art?.body?.lots?.length} lots, held by ${json(art?.regions)}`);
  const plan = JSON.parse(JSON.stringify(art.body.plan));
  plan.zones[0].program.lots.push({ id: 'grown_1', type: 'house', size: [LOT.sx, LOT.sz] });
  plan.revision = { n: 1, parentArtifact: sha };
  const c3 = await checkPlan(plan, T.claim);
  const z3 = c3.parts?.find((p) => p.part === 'village');
  out.check3 = { overall: c3.overall, village: z3 };
  check(c3.overall === 'READY' && z3?.class === 'fits' && z3?.standing === true && json(z3?.grown) === json(['grown_1']), `row 3: checkPlan of the adopted zone with one more lot: ${c3.overall ?? c3.refused}; village ${z3?.class} standing ${z3?.standing} grown ${json(z3?.grown)}`);
  const S3 = await cellsOf(BOX);
  // ((7b LP, AD row 7: GATE6DAD_LP=1) the link pass over the adopted region: the adopted IR and the growth have no port links, so the
  // growth's realise runs no link pass and its revision IR has no site_links stage (change 4); rows 3-5 are then AD's own, on LP)
  const LP = process.env.GATE6DAD_LP === '1';
  const lp0 = LP ? await call('dev.lp.stats', {}, 30_000) : null;
  const r3 = await call('dev.region.realiseApproved', { sha: c3.artifactSha, lotEntries: { grown_1: ENTRY } }, 300_000);
  check(r3.region === region, `row 3: realiseApproved answers the adopted region (${json(r3)})`);
  const st3 = await rvState(region);
  const w3 = await rvWait(region, st3.revisions.at(-1).rid);
  const lots3 = w3.st.view.lots.filter((l) => l.id === 'grown_1');
  const d3 = diff(S3, await cellsOf(BOX));
  check(w3.r.state === 'PLACED' && lots3.length === 1 && lots3[0].state === 'placed' && d3.n > 0, `row 3: the growth ${w3.r.state} (rid ${w3.r.rid}); grown_1 ${json(lots3.map((l) => [l.state, l.siteId]))}; ${d3.n} cells written`);
  if (LP) {
    const lp1 = await call('dev.lp.stats', {}, 30_000);
    const rvIr = (await call('dev.rv.ir', { region, rid: w3.r.rid }, 60_000)).ir;
    out.row7 = { calls: lp1.calls - lp0.calls, adoptedPortLinks: !!ir.portLinks, rvStages: rvIr?.stages ?? null, rvPortLinks: !!rvIr?.portLinks };
    check(out.row7.calls === 0 && !ir.portLinks && !(rvIr?.stages ?? []).includes('site_links') && !rvIr?.portLinks, `row 7 (LP): the link pass over the adopted region: no port link in its IR or its growth, so the growth's realise ran no link pass (${out.row7.calls} calls) and its revision IR has no site_links stage (${json(rvIr?.stages)})`, out.row7);
  }
  // the street stands as it was: none of its cells changed
  const street = [T.x0, gy - 2, T.sz - 1, T.x1, gy + 6, T.sz + 1];
  const ds = diff(new Map([...S3].filter(([k]) => { const [x, y, z] = k.split(',').map(Number); return x >= street[0] && x <= street[3] && y >= street[1] && y <= street[4] && z >= street[2] && z <= street[5]; })),
    new Map([...(await cellsOf(street))]));
  check(ds.n === 0, `row 3: the adopted street's cells unchanged by the growth (${ds.n} differ)`, ds.first);

  // ---- row 5: Regions.remove: E-flat 0 over the claim against the world before the settlement (the verifier re-runs it)
  const rm = await removeRegion(region);
  const d5 = diff(B0, await cellsOf(BOX));
  const listed = (await call('dev.region.list', {}, 60_000)).regions.some((x) => x.id === region);
  out.remove = { result: rm, diff: d5, listed };
  check(rm.removed === true && !listed && d5.n === 0, `row 5: Regions.remove of the adopted region (its growth, its delta'd lots, both street pieces): removed ${rm.removed} (restored ${rm.restored}), no longer standing (${!listed}); E-flat ${d5.n} against the world before the settlement`, d5.first);
  const un5 = await call('dev.ad.unadopt', { region }, 60_000);
  check(!!un5.refused, `row 5: the removed region can't be un-adopted (${un5.refused})`);

  // ---- rows 6 and 6c: a second settlement adopted, Steward adds a site to an old group, un-adopted
  const CX2 = CX + 400;
  const BOX2 = [CX2 - 4, gy - 12, CZ - 4, CX2 + 164, gy + 24, CZ + 100];
  await L.tp(CX2 + 60, 60, CZ + 48);
  const B2 = await cellsOf(BOX2);
  const U = await settlement({ cx: CX2, cz: CZ, n: 3, prefix: 'cottage' });
  const before = await adState(sitesOf(U));
  const a6 = await adopt(U);
  check(!a6.refused && a6.state === 'PLACED', `row 6: the second settlement adopted: ${a6.region ?? a6.refused}`);
  // row 6c: Steward adds a site to an old group (a later build of the founding group: a new stage, its own lot)
  const extra = { id: 'cottage_9', x: U.x0, z: U.sz + 3 + LOT.sz + 6, sx: LOT.sx, sz: LOT.sz, north: false };
  const b3 = await build({ y: U.y, sz: U.sz, lots: [extra], spans: [], group: U.b1.group, settlement: 'cottage', build: 'b3', stage: 'stage2' });
  check(b3.group === U.b1.group, `row 6c: Steward's later build joined the old group ${U.b1.group} (${b3.group})`);
  const mid = await adState([...sitesOf(U), b3.site.cottage_9]);
  const un = await call('dev.ad.unadopt', { region: a6.region }, 300_000);
  out.unadopt = un;
  check(!un.refused && Object.keys(un.groups ?? {}).length === sitesOf(U).length && (un.newGroups ?? []).length === 0, `row 6: Regions.unadopt: ${Object.keys(un.groups ?? {}).length} sites back (${json(un.groups)}), new groups ${json(un.newGroups)} ${un.refused ?? ''}`);
  const after = await adState([...sitesOf(U), b3.site.cottage_9]);
  const same = sitesOf(U).filter((s) => json(after.sites[s].member) !== json(before.sites[s].member));
  check(after.agree && same.length === 0, `row 6: every membership as before the adoption (${same.length} differ: ${json(same)}), one owner per site (agree ${after.agree})`);
  const gA0 = before.groups[U.b1.group], gA1 = after.groups[U.b1.group], gB0 = before.groups[U.b2.group], gB1 = after.groups[U.b2.group];
  const stagesA = Object.fromEntries(Object.entries(gA1?.stages ?? {}).map(([k, v]) => [k, v]));
  const okA = gA0 && gA1 && json(stagesA.street) === json(gA0.stages.street) && json(stagesA.stage1) === json(gA0.stages.stage1) && json(stagesA.stage2) === json([b3.site.cottage_9]);
  const okB = gB0 && gB1 && json(gB1.stages) === json(gB0.stages) && json(gB1.sites) === json(gB0.sites);
  check(okA && okB, `row 6, 6c: the stage lists as before, the added site kept in its group: ${U.b1.group} ${json(gA1?.stages)} (before ${json(gA0?.stages)}); ${U.b2.group} ${json(gB1?.stages)}`);
  check(json([...(gA1?.sites ?? [])].sort()) === json([...gA0.sites, b3.site.cottage_9].sort()), `row 6c: ${U.b1.group}'s sites: the adopted ones rejoined, the later one stays (${json(gA1?.sites)})`);
  check(!(await call('dev.region.state', { region: a6.region }, 60_000).catch(() => ({ view: null }))).view, `row 6: the region record is gone`);
  void mid;
  // Steward's own undo of one of its sites still works: cottage_2's site removed, its lot's cells as before the settlement
  const victim = U.lotSites.cottage_2;
  const lot2 = U.lots.find((l) => l.id === 'cottage_2');
  const lotBox = [lot2.x, gy - 12, lot2.z, lot2.x + lot2.sx - 1, gy + 24, lot2.z + lot2.sz - 1];
  const sr = await siteRemove(victim);
  const dl = diff(new Map([...B2].filter(([k]) => { const [x, y, z] = k.split(',').map(Number); return x >= lotBox[0] && x <= lotBox[3] && y >= lotBox[1] && y <= lotBox[4] && z >= lotBox[2] && z <= lotBox[5]; })), await cellsOf(lotBox));
  check(sr.removed === true && dl.n === 0, `row 6: Steward's own undo of ${victim} (cottage_2): removed ${sr.removed}; its lot as before the settlement (${dl.n} differ)`, dl.first);
  // the rest removed by Steward's group removals: E-flat 0
  for (const s of [...sitesOf(U), b3.site.cottage_9]) if (s !== victim) await siteRemove(s).catch(() => null);
  const d6 = diff(B2, await cellsOf(BOX2));
  check(d6.n === 0, `row 6: the second settlement removed by Steward's own undo: E-flat ${d6.n}`, d6.first);
  await L.leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ ad-crash: row 6b

async function haltWait() {
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    const st = await call('dev.state', {}, 10_000).catch(() => null);
    if (st && st.inWorld === false) return true;
  }
  return false;
}

steps.crash = async () => {
  await ensure();
  const out = {};
  const CX = 15000, CZ = 15000;
  const world = 'G6B AD Crash';
  await freshFlat(world, [CX + 60, CZ + 48]);
  await installEntry();
  const gy = await groundY(CX + 4, CZ + 4);
  const BOX = [CX - 4, gy - 12, CZ - 4, CX + 164, gy + 24, CZ + 100];
  const B0 = await cellsOf(BOX);
  const T = await settlement({ cx: CX, cz: CZ, n: 3, prefix: 'home' });
  // a site with two deltas (v2, then v3) and the street's road among the adopted sites
  const d2 = await call('dev.site.delta.apply', { site: T.lotSites.home_1, version: 2, owner: OWNER }, 120_000);
  const d3 = await call('dev.site.delta.apply', { site: T.lotSites.home_1, version: 3, owner: OWNER }, 120_000);
  check(d2.applied === true && d3.applied === true, `row 6b: home_1 has two deltas (v2 ${d2.applied}, v3 ${d3.applied})`);
  // the settlement on disk before the first kill (a halt saves nothing: the builds' own chunks would go back, which is not the adoption's)
  await cmd('/save-all flush');
  await L.settle(3000);
  const H0 = await hashOf(BOX);
  const sites = sitesOf(T);
  const st0 = await adState(sites);
  const reopen = async () => {
    await L.openWorld(world);
    await L.tp(CX + 60, 60, CZ + 48);
    await sleep(3000);
  };
  const regionOf = () => {
    const dir = path.join(L.SAVES, world, 'architect-regions');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'region.json'))) : [];
  };
  /** One owner per site in every record; the region's group or each old group as `adopted` says; nothing written; no intent left. */
  const agrees = async (label, adopted, groupId) => {
    const st = await adState(sites);
    const h = await hashOf(BOX);
    const want = (s) => (adopted ? groupId : st0.sites[s].record);
    const bad = sites.filter((s) => st.sites[s].record !== want(s));
    check(st.agree && bad.length === 0 && h === H0 && st.intents.length === 0 && st.entries === st0.entries, `row 6b ${label}: one owner per site in every record (agree ${st.agree}), each site ${adopted ? `in the region's group ${groupId}` : 'in its old group'} (${bad.length} differ: ${json(bad.map((s) => [s, st.sites[s].record]))}); 0 cells written (${h === H0}); no intent left (${json(st.intents)}); journal entries ${st0.entries} -> ${st.entries}`);
    return st;
  };
  // adopt, killed after each of §2.3's steps 1-4: AD1-AD3 roll back (no region, the sites in their old groups), AD4 forward (PLACED)
  let region = null, groupId = null;
  for (const point of ['AD1', 'AD2', 'AD3', 'AD4']) {
    await call('dev.journal.killAt', { point }, 10_000);
    adopt(T).catch(() => null);
    const down = await haltWait();
    check(down, `row 6b ${point}: the kill point halted the server during the adoption`);
    if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
    await reopen();
    const regs = regionOf();
    const forward = point === 'AD4';
    if (forward) {
      region = regs[0];
      const v = await call('dev.region.state', { region }, 60_000).catch(() => null);
      groupId = v?.view?.groupId;
      check(regs.length === 1 && v?.view?.state === 'PLACED', `row 6b ${point}: rolled forward: region ${region} ${v?.view?.state}`);
    } else {
      check(regs.length === 0, `row 6b ${point}: rolled back: no region record (${json(regs)})`);
    }
    out[point] = await agrees(point, forward, groupId);
  }
  // un-adopt, killed after each of its steps: UA1 back (the sites stay the region's), UA2 back, UA3 and UA4 forward (the record gone)
  for (const point of ['UA1', 'UA2', 'UA3', 'UA4']) {
    if (!region) break;
    await call('dev.journal.killAt', { point }, 10_000);
    call('dev.ad.unadopt', { region }, 300_000).catch(() => null);
    const down = await haltWait();
    check(down, `row 6b ${point}: the kill point halted the server during the un-adoption`);
    if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
    await reopen();
    const forward = point === 'UA3' || point === 'UA4';
    const regs = regionOf();
    check(forward ? regs.length === 0 : regs.length === 1, `row 6b ${point}: rolled ${forward ? 'forward: the region record gone' : 'back: the region stands'} (${json(regs)})`);
    out[point] = await agrees(point, !forward, groupId);
    if (forward) {
      // adopted again for the next un-adoption kill
      const a = await adopt(T);
      check(!a.refused, `row 6b: adopted again after ${point}: ${a.region ?? a.refused}`);
      region = a.region;
      groupId = a.groupId;
      await cmd('/save-all flush');
    }
  }
  // the last adoption un-adopted cleanly, then architect-sites.json deleted: Sites.reconcile rebuilds every record with the same membership
  const un = await call('dev.ad.unadopt', { region }, 300_000);
  check(!un.refused, `row 6b: un-adopted cleanly (${json(un)})`);
  const stU = await adState(sites);
  await L.leaveWorld();
  const sf = path.join(L.SAVES, world, 'architect-sites.json');
  fs.renameSync(sf, `${sf}.deleted-by-gate`);
  await reopen();
  const stR = await adState(sites);
  const lost = sites.filter((s) => json(stR.sites[s].member) !== json(stU.sites[s].member));
  out.reconcile = { lost, members: Object.fromEntries(sites.map((s) => [s, stR.sites[s].member])) };
  check(lost.length === 0 && sites.every((s) => stR.sites[s].record === stU.sites[s].record), `row 6b: architect-sites.json deleted: Sites.reconcile rebuilt every record with the same membership (${lost.length} differ: ${json(lost)})`);
  check((await hashOf(BOX)) === H0, 'row 6b: 0 cells written across every kill and the rebuild');
  // (the site groups are not in the journal: a deleted sites file loses them, so Steward's own undo is per site; recorded in the as-built)
  for (const s of [...Object.values(T.lotSites), ...T.roads]) {
    const r = await siteRemove(s);
    if (r.removed !== true) log(`  ${s}: ${json(r)}`);
  }
  const df = diff(B0, await cellsOf(BOX));
  check(df.n === 0, `row 6b: then Steward's own undo of every site (the deltas' lot included): E-flat ${df.n}`, df.first);
  await L.leaveWorld();
  spendZero();
  return out;
};

steps.report = async () => {
  const out = {};
  for (const f of ['unit', 'ingame', 'crash']) {
    const p = path.join(OUT, `${f}.json`);
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const r = Object.values(j.results ?? {});
    out[f] = { ok: r.filter((x) => x.ok).length, fail: r.filter((x) => !x.ok).length };
  }
  log(json(out));
  return out;
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6dad.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
