#!/usr/bin/env node
// Slice 6d FS gate (updates follow the source; docs/CONTRACT.md "Phase 6d slice FS" §6) against the headless server of the FS run worktree
// (GATE6B_RUN, default `../architect-mc-FS-run`; the sim sidecar, no Claude). $0: no Claude call anywhere.
//
//   node tools/gate6dfs.mjs <step>
//     base                             the flat base world
//     unit      (fs-unit)              items 1 and 7 offline: the sidecar's follow.test (the follow job on the cabin and tavern sources: byte
//                                      identity with an independent rebuild, every refusal, opKey replay and conflict, followAll's frozen set,
//                                      the already-followed no-op, a kill mid-followAll and its resume) with 0b's copy and versionOf units (and
//                                      5b's versions units in unit-sidecar); WireFSTest and Wire0bTest; api-compat against the 0.47.0 and 0.45.0 apitest jars
//                                      and the 0.47.0 and 0.57.0 mod surfaces
//     ingame    (fs-ingame)            items 2-6 in game (headless) on a flat world: a group with an archetype and 2 copies plus a VARIANT
//                                      (followers); the copies as lots of a plan/0 town through checkPlan and realiseApproved; the source's
//                                      versionOf (sim); followAll; outdated, a player's block KEEP, applyDelta and revert of each lot cell for
//                                      cell; a source version with a moved front (every follower `frame`, nothing installed, lots unchanged);
//                                      one lot's site removed alone and refilled at the new copy version (RV); Regions.remove: E-flat 0
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6d-fs/<step>.json in the main checkout (GATE6DFS_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
// Ports: 8896/8897 unless the runner gives others.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-FS-run');
process.env.GATE6B_OUT = process.env.GATE6DFS_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6d-fs');
process.env.GATE6B_SIDECAR_PORT ??= '8896';
process.env.GATE6B_DEV_PORT ??= '8897';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, call, cmd, sleep } = L;

L.refuseKeys();
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');

const OWNER = 'test:fs';
const FLAT = 'G6B Flat Base';
const CX = 13200, CZ = 13200;
/** The town's claim (112 x 112, as RV's), its two lots big enough for a grown, mirrored cabin. */
const CLAIM = [CX, CZ, CX + 111, CZ + 111];
const P0_TOWN = { schemaVersion: 'plan/0', planId: 'fs_town', zones: [{ id: 'town', program: { lots: [{ id: 'h1', type: 'cabin', size: [17, 17] }, { id: 'h2', type: 'cabin', size: [17, 17] }] }, where: { near: { anchor: 'claim_center', within: 8 } } }] };

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
  L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice FS is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
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
  return { n, first: out, keys: n ? [...new Set([...a.keys(), ...b.keys()])].filter((k) => norm(a.get(k) ?? 'minecraft:air') !== norm(b.get(k) ?? 'minecraft:air')) : [] };
}
async function groundY() {
  const c = await cellsOf([CX + 100, -64, CZ + 100, CX + 100, 255, CZ + 100]);
  let g = -64;
  for (const [k, s] of c) { const y = Number(k.split(',')[1]); if (idOf(s) !== 'air' && y > g) g = y; }
  return g;
}
const parseBox = (s) => (String(s).match(/-?\d+/g) ?? []).map(Number);

// ------------------------------------------------------------------ apitest

const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null' || m.startsWith('"'));
  if (line === undefined) throw new Error(`/apitest ${args.slice(0, 200)}: no JSON answer: ${JSON.stringify(r).slice(0, 500)}`);
  return JSON.parse(line);
};
const result = async (pending, timeoutMs = 600_000) => {
  const key = pending?.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r.value !== undefined && r.value !== null) return r.value;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${key}`);
};
const until = async (fn, what, timeoutMs = 900_000, every = 1500) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const sites = async () => { const s = await api('sites'); return s.sites ?? s.all ?? []; };
const siteView = async (id) => (await sites()).find((v) => v.id === id) ?? null;
async function designDone(id, what) {
  return until(async () => {
    const x = await api(`designget ${id}`);
    return ['DONE', 'FAILED', 'CANCELLED'].includes(x?.status) ? x : null;
  }, what, 600_000);
}
const versionOf = async (key, entryId, notes) => {
  const d = await result(await api(`versionof ${key} ${b64({ type: 'cabin', style: 'rustic', notes, size: [24, 20, 24] })} ${entryId} -`));
  if (typeof d !== 'string') return { error: d };
  return designDone(d, `the versionOf ${key}`);
};
const followers = (src) => api(`followers ${src}`);
const eventsFrom = async (n) => api(`events ${n}`);

async function checkPlan(plan, claim) {
  const r = await call('dev.region.checkPlan', { plan, claim, owner: OWNER }, 900_000);
  if (r.refused) { log(`  check refused: ${r.refused}`); return r; }
  log(`  check ${r.check.checkId}: ${r.check.overall} ${r.check.parts.map((p) => `${p.part}:${p.class}`).join(' ')} artifact ${r.check.artifactSha?.slice(0, 12) ?? '-'}`);
  return r.check;
}
async function rvWait(region, rid, timeoutMs = 1_800_000) {
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < timeoutMs) {
    st = await call('dev.rv.state', { region }, 60_000);
    const r = st.revisions.find((x) => x.rid === rid);
    if (st.busy === null && r && !['ACCEPTED', 'PLACING'].includes(r.state)) return { st, r };
    await sleep(L.pollDelayMs(Date.now() - t0));
  }
  throw new Error(`revision ${rid} of ${region} did not end (${json(st?.revisions?.map((x) => [x.rid, x.state]))}, busy ${st?.busy})`);
}

// ------------------------------------------------------------------ base

steps.base = async () => {
  await ensure();
  await L.ensureBase(FLAT);
  spendZero();
  return { worlds: [FLAT] };
};

// ------------------------------------------------------------------ offline (items 1 and 7)

function sh(cmdline, opts = {}) {
  const r = spawnSync('bash', ['-c', cmdline], { cwd: root, encoding: 'utf8', timeout: 3_600_000, env: { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` }, ...opts });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
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
/** The archived apitest jars and mod surfaces (RV's jars; the 0.57.0 surface: GATE6DFS_SURFACE, default artifacts/gate6d-fs/jars, main 4b844fea's build). */
function apiJars() {
  const A = process.env.GATE6DFS_JARS ?? path.join(os.homedir(), 'Developer', 'LarattaLabs', 'Minecraft', 'architect-mc', 'artifacts', 'gate6d-rv', 'jars');
  const s57 = process.env.GATE6DFS_SURFACE ?? path.join(os.homedir(), 'Developer', 'LarattaLabs', 'Minecraft', 'architect-mc', 'artifacts', 'gate6d-fs', 'jars', 'architect_mc-0.57.0.jar');
  return { jars: [path.join(A, 'architect_apitest-0.47.0.jar'), path.join(A, 'architect_apitest-0.45.0.jar')], surfaces: [path.join(A, 'architect_mc-0.47.0.jar'), s57] };
}

steps.unit = async () => {
  const out = {};
  const s = sh('cd sidecar && npx vitest run test/follow.test.ts test/copies.test.ts test/versionof.test.ts');
  fs.writeFileSync(path.join(OUT, 'unit-sidecar.log'), s.out);
  const tests = /Tests\s+([^\n]+)/.exec(s.out)?.[1] ?? '?';
  out.sidecar = { code: s.code, tests };
  check(s.code === 0 && /\d+ passed/.test(tests) && !/failed/.test(tests), `item 1 (sidecar, real kit): follow.test (cabin and tavern: byte identity with an independent rebuild; frame, check, bar, fit, bible_gone, source_gone, head_moved; opKey replay and conflict; the frozen set and version; already followed; NOT_ALLOWED not_copy and until_7b; a kill and its resume), with 0b's copies and versionOf units (5b's versions units run in unit-sidecar): ${tests}`);
  const java = await javaTests(['*WireFSTest*', '*Wire0bTest*'], 4);
  out.java = java;
  check(java.ok, `item 7 (Java): WireFSTest (followers, the results wire, followSource, the defaults that throw) and Wire0bTest: ${java.tests} tests, ${java.failures} failures (${java.names.join('; ')})`, java.tail);
  const J = apiJars();
  out.apicompat = [...J.jars.map((j) => ['tools/api-compat.mjs', j]), ...J.surfaces.map((j) => ['tools/api-compat.mjs', '--surface', j])].map((args) => {
    const ac = fs.existsSync(args.at(-1)) ? sh(`node ${args.map((a) => `'${a}'`).join(' ')}`) : { code: -1, out: `missing ${args.at(-1)}` };
    return { args: args.slice(1).map((a) => path.basename(a)), code: ac.code, tail: ac.out.split('\n').filter(Boolean).slice(-3) };
  });
  check(out.apicompat.every((a) => a.code === 0), `item 7: api-compat binary compatible with the 0.47.0 and 0.45.0 apitest jars and the 0.47.0 and 0.57.0 mod surfaces (FS adds Library.followers, Library.Follower, Designs.follow, followAll and FollowResult, all new)`, out.apicompat);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game: items 2-6

steps.ingame = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B FS Follow', FLAT);
  await L.setRules('exact');
  await L.tp(CX + 56, 60, CZ + 56);
  // the helper's follow operations outlive a world (its data dir is the game's): a key of this run
  const KEY = `fs.all.${Date.now().toString(36)}`;
  const fsApi = await api('apifs');
  check(fsApi.followSource === true, `the API names followSource (${json(fsApi)})`);
  // ---- the family: an archetype and 2 copies (0b's cap: 3 placements per design), plus a VARIANT of the archetype
  // (the sim's versionOf raises the first int param's default by one, as simRedirect does; a copy whose recipe's param is exactly that
  // value would no longer differ from the new source by it, and its follow is refused `bar`, correctly: the copies' recipes are seeded by
  // the group id, so a family whose copy collides is made again under a new group, at most 4 times)
  const simChange = (src) => {
    const params = /export\s+const\s+params\s*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? '';
    for (const m of params.matchAll(/(\w+)\s*:\s*\{([^}]*type:\s*'int'[^}]*)\}/g)) {
      const max = /max:\s*(-?\d+)/.exec(m[2]), def = /default:\s*(-?\d+)/.exec(m[2]);
      if (max && def && Number(def[1]) < Number(max[1])) return { name: m[1], value: Number(def[1]) + 1 };
    }
    return null;
  };
  const readJson = (id) => JSON.parse(fs.readFileSync(path.join(L.LIBRARY, id, `${id}.blueprint.json`), 'utf8'));
  let fin, arch, copies, gid, by;
  out.families = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const g = { name: `G6D FS Copies ${attempt}`, bible: 'oak', owner: 'apitest:fs', items: [{ type: 'cabin', style: 'rustic', size: [24, 20, 24], itemKey: 'house', count: 3 }] };
    gid = await result(await api(`group fs1${attempt} ${b64(g)}`));
    fin = await until(async () => {
      const x = await api(`groupget ${gid}`);
      return ['DONE', 'FAILED', 'CANCELLED'].includes(x?.status) ? x : null;
    }, 'the group', 900_000);
    by = (k) => fin.items.find((i) => i.itemKey === k);
    arch = by('house')?.entryId;
    copies = [by('house#2')?.entryId, by('house#3')?.entryId];
    if (fin.status !== 'DONE' || !arch || !copies.every(Boolean)) break;
    const change = simChange(fs.readFileSync(path.join(L.LIBRARY, arch, `${arch}.mjs`), 'utf8'));
    const params = copies.map((c) => readJson(c).derivation?.recipe?.param ?? null);
    const collides = params.some((p) => p && change && p.name === change.name && p.value === change.value);
    out.families.push({ gid, arch, copies, change, params, collides });
    log(`  family ${attempt}: ${arch}, copies ${copies.join(', ')}; the sim's change ${json(change)}; the copies' params ${json(params)}${collides ? ': collides, again' : ''}`);
    if (!collides) break;
  }
  check(fin.status === 'DONE' && arch && copies.every(Boolean) && ['house#2', 'house#3'].every((k) => by(k)?.kind === 'COPY') && !out.families.at(-1)?.collides, `the group ${gid}: ${arch} and the copies ${copies.join(', ')} (${out.families.length} famil${out.families.length === 1 ? 'y' : 'ies'} made)`, fin.items?.map((i) => [i.itemKey, i.kind, i.status, i.entryId]));
  const variant = await result(await api(`variant ${arch} birch`));
  const vId = variant?.id;
  check(!!vId && !variant.error, `a VARIANT of ${arch}: ${vId}`, variant);
  const f0 = await followers(arch);
  out.followers0 = f0;
  const kinds0 = Object.fromEntries(f0.map((f) => [f.entryId, f.kind]));
  check(f0.length === 3 && copies.every((c) => kinds0[c] === 'COPY') && kinds0[vId] === 'VARIANT' && f0.every((f) => !f.behind), `item 2: followers lists the 2 copies and the variant (${json(f0.map((f) => [f.entryId, f.kind, f.behind]))}), none behind`);
  // ---- the town: the copies as the lots of a plan/0 zone, through checkPlan and realiseApproved
  const gy = await groundY();
  const BOX = [CLAIM[0] - 8, gy - 12, CLAIM[1] - 8, CLAIM[2] + 8, gy + 24, CLAIM[3] + 8];
  const before = await hashOf(BOX);
  const B0 = await cellsOf(BOX);
  const c0 = await checkPlan(P0_TOWN, CLAIM);
  check(c0.overall === 'READY' && /^[0-9a-f]{64}$/.test(c0.artifactSha ?? ''), `item 4: the town plan checked: ${c0.overall}`, c0);
  const ra = await call('dev.region.realiseApproved', { sha: c0.artifactSha, lotEntries: { h1: copies[0], h2: copies[1] } }, 300_000);
  const region = ra.region;
  const st0 = await L.waitRegion(region, 3_600_000);
  const lotSite = Object.fromEntries(st0.view.lots.map((l) => [l.id, l.siteId]));
  check(st0.view.state === 'PLACED' && lotSite.h1 && lotSite.h2, `item 4: realiseApproved: region ${region} ${st0.view.state}, lots ${json(st0.view.lots.map((l) => [l.id, l.state, l.siteId]))}`);
  const lotOf = { [copies[0]]: lotSite.h1, [copies[1]]: lotSite.h2 };
  // ---- the source's new version (the sim's versionOf: an int param's default up by one)
  const ev0 = (await eventsFrom(0)).length;
  const vd = await versionOf('fs2', arch, 'make it wider');
  check(vd?.status === 'DONE', `item 2: the source's versionOf is DONE (${vd?.step ?? json(vd)})`);
  const f1 = await followers(arch);
  out.followers1 = f1;
  check(f1.length === 3 && f1.filter((f) => f.behind).map((f) => f.entryId).sort().join() === [...copies].sort().join() && f1.every((f) => f.sourceHead === 2), `item 2: after the versionOf, behind is true for exactly the 2 copies (${json(f1.map((f) => [f.entryId, f.behind, f.sourceVersion, f.sourceHead]))})`);
  // ---- item 3: followAll
  const ev1 = (await eventsFrom(0)).length;
  const fa = await result(await api(`followall fsa ${arch} 0 ${KEY}`), 900_000);
  out.followAll = fa;
  check(Array.isArray(fa) && fa.length === 2 && fa.every((r) => r.followed && r.newVersion === 2 && r.sourceVersion === 2 && r.refused === null), `item 3: followAll: 2 new versions, each passing the check and the bar (${json(fa)})`);
  const evs = (await eventsFrom(ev1)).filter((e) => e.event === 'ENTRY_VERSIONED');
  check(copies.every((c) => evs.filter((e) => e.entry === c && e.version === 2).length === 1), `item 3: ENTRY_VERSIONED once per copy (${json(evs.map((e) => [e.entry, e.version, e.from]))})`);
  const replay = await result(await api(`followall fsb ${arch} 0 ${KEY}`), 300_000);
  check(json(replay) === json(fa), 'the same opKey answers the saved results, nothing installed again');
  for (const c of copies) {
    const ev = await api(`eversions ${c}`);
    check(ev.version === 2 && /follow/i.test(String((ev.versions ?? []).at(-1)?.by)), `${c}: head 2 by follow (${json((ev.versions ?? []).map((v) => [v.version, v.by]))})`);
  }
  const one = await result(await api(`follow fsc ${copies[0]} 2 -`));
  check(one.followed === false && one.alreadyFollowed === true && one.refused === null, `already followed is a no-op (${json(one)})`);
  const vr = await result(await api(`follow fsd ${vId} 0 -`));
  check(vr?.reason === 'NOT_ALLOWED' && vr?.detail === 'not_copy', `a VARIANT does not follow: ${json(vr)}`);
  out.events = { before: ev0 };
  // ---- item 4: the lots
  const od = await api(`outdated ${OWNER}`);
  const odAll = await api('outdated -');
  const odList = JSON.stringify([od, odAll]);
  out.outdated = { od, odAll };
  check(copies.every((c) => odList.includes(lotOf[c])), `item 4: outdated lists both lots (${lotOf[copies[0]]}, ${lotOf[copies[1]]}) 1 -> 2`, odAll);
  const boxOf = async (site) => { const v = await siteView(site); const b = parseBox(v?.restoreBox ?? v?.box); return [b[0], b[1], b[2], b[3], b[4], b[5]]; };
  out.lots = {};
  for (const [i, c] of copies.entries()) {
    const site = lotOf[c];
    const box = await boxOf(site);
    const S1 = await cellsOf(box);
    const o = { site, box };
    let edit = null;
    if (i === 0) {
      // the cells the delta changes: applied once, read, reverted (the revert is checked too)
      const a0 = await result(await api(`applydelta ${site} 2 keep ${OWNER}`));
      const C = diff(S1, await cellsOf(box));
      const r0 = await result(await api(`srevert ${site} 1`));
      const back = diff(S1, await cellsOf(box));
      o.probe = { applied: a0?.applied, changed: C.n, revert: r0?.applied, back: back.n };
      check(a0?.applied === true && C.n > 0 && back.n === 0, `item 4: ${site}: a probe delta changes ${C.n} cells and its revert gives the lot back cell for cell (${back.n} differ)`, { a0, r0, first: back.first });
      // a player's block on a building cell the delta changes
      const k = C.keys.find((key) => idOf(S1.get(key) ?? 'air') !== 'air' && JSON.stringify(S1.get(key)).length > 0);
      if (k) {
        const p = k.split(',').map(Number);
        await cmd(`/setblock ${p.join(' ')} minecraft:gold_block`);
        edit = p;
      }
      check(!!edit, `item 4: a player's block (gold) on ${site} at ${edit?.join(',')} (a cell the delta changes)`);
    }
    const SB = await cellsOf(box); // the world just before the delta (with the player's block)
    const cd = await api(`checkdelta ${site} 2 keep ${OWNER}`);
    const kept = Array.isArray(cd.kept) ? cd.kept.length : cd.kept;
    const ap = await result(await api(`applydelta ${site} 2 keep ${OWNER}`));
    const SA = await cellsOf(box);
    const changed = diff(SB, SA);
    o.check = cd; o.apply = ap; o.changed = changed.n;
    check(ap?.applied === true && changed.n > 0, `item 4: applyDelta(KEEP) on ${site}: applied, ${changed.n} cells changed`, ap);
    if (edit) {
      const g2 = SA.get(edit.join(','));
      check(kept >= 1 && idOf(g2) === 'gold_block' && (Array.isArray(ap.kept) ? ap.kept.length : ap.kept) >= 1, `item 4: the player's block is kept (KEEP; checkDelta kept ${kept}, applyDelta kept ${json(ap.kept)}, the cell holds ${g2})`, cd);
    }
    const sv = await siteView(site);
    check(sv?.version === 2 || /"version":2/.test(JSON.stringify(sv)), `item 4: ${site} stands at v2`, sv);
    const rv = await result(await api(`srevert ${site} 1`));
    const SR = await cellsOf(box);
    const d = diff(SB, SR);
    o.revert = rv; o.revertDiff = d.n;
    check(rv?.applied !== false && d.n === 0, `item 4: revert of ${site} to v1: the world before the delta, cell for cell (${d.n} differ over ${json(box)})`, { rv, first: d.first });
    out.lots[c] = o;
  }
  // put both lots on v2 for what follows (the delta again, KEEP)
  for (const c of copies) await result(await api(`applydelta ${lotOf[c]} 2 keep ${OWNER}`));
  // ---- item 5: a source v3 with a moved front: every follower `frame`, nothing installed, the lots unchanged
  const L5 = {};
  for (const c of copies) L5[c] = await hashOf(await boxOf(lotOf[c]));
  const v3 = await versionOf('fs3', arch, 'turn it sim:frontmove');
  check(v3?.status === 'DONE', `item 5: the source's v3 with a turned front (sim:frontmove) is DONE (${v3?.step ?? json(v3)})`);
  const fr = await result(await api(`followall fse ${arch} 0 -`), 900_000);
  out.frame = fr;
  check(Array.isArray(fr) && fr.length === 2 && fr.every((r) => r.refused === 'frame' && !r.followed && r.newVersion === 2), `item 5: every follower refused frame (${json(fr.map((r) => [r.entryId, r.refused, r.newVersion]))})`);
  let same = true;
  for (const c of copies) {
    const ev = await api(`eversions ${c}`);
    same = same && ev.version === 2 && L5[c] === (await hashOf(await boxOf(lotOf[c])));
  }
  check(same, 'item 5: nothing installed (both copies at v2) and the lots unchanged (their boxes hash as before)');
  // ---- item 6: one lot's site removed alone, the region revised to refill it at the new copy version, then Regions.remove
  const rm = await call('dev.rv.siteRemove', { site: lotOf[copies[0]], force: true, requester: OWNER }, 600_000);
  await sleep(1500);
  let st = await call('dev.rv.state', { region }, 60_000);
  const removed = st.view.lots.find((l) => l.id === 'h1');
  check(rm.removed && removed?.state === 'removed', `item 6: h1's site ${lotOf[copies[0]]} removed alone: the lot reads ${removed?.state}`, rm);
  const p6 = await call('dev.rv.plan', { region, spec: { parts: [], refill: ['h1'] } }, 900_000);
  check(!p6.refused && p6.revisionOf?.rid, `item 6: the refill revision planned (${p6.refused ?? p6.planId})`, p6);
  if (!p6.refused) {
    const r6 = await call('dev.region.realise', { planId: p6.planId, lots: { h1: copies[0] } }, 300_000);
    if (r6.refused) throw new Error(`refill realise refused: ${r6.refused}`);
    const w6 = await rvWait(region, p6.revisionOf.rid);
    const refilled = w6.st.view.lots.find((l) => l.id === 'h1');
    const nsv = refilled?.siteId ? await siteView(refilled.siteId) : null;
    out.refill = { refilled, site: nsv };
    check(w6.r.state === 'PLACED' && refilled?.state === 'placed' && refilled.siteId !== lotOf[copies[0]] && (nsv?.version === 2 || /"version":2/.test(JSON.stringify(nsv))), `item 6: refilled at the new copy version: ${json(refilled)}, the site at v${nsv?.version}`);
  }
  const rem = await call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
  for (let i = 0; i < 2400; i++) {
    const s = (await call('dev.region.state', { region }, 60_000).catch(() => null))?.view?.state;
    if (!s || ['REMOVED', 'PARTIAL', 'FAILED'].includes(s)) break;
    await sleep(500);
  }
  await sleep(2000);
  const after = await hashOf(BOX);
  const dd = after === before ? null : diff(B0, await cellsOf(BOX));
  out.remove = { result: rem, flat: after === before, diff: dd ? { n: dd.n, first: dd.first } : null };
  check(rem.removed !== false && after === before, `item 6: Regions.remove: E-flat 0 over claim + 8 (${after === before})${dd ? `: ${dd.n} cells differ ${json(dd.first.slice(0, 8))}` : ''}`);
  await L.leaveWorld();
  spendZero();
  return out;
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => /^(unit|ingame)\.json$/.test(f));
  const lines = ['# Gate slice 6d FS (updates follow the source)', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
  for (const f of files.sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    lines.push(`## ${j.step} (${Math.round(j.seconds)} s, head ${String(j.head).slice(0, 10)})`, '');
    for (const [m, r] of Object.entries(j.results ?? {})) lines.push(`- ${r?.ok ? 'ok  ' : 'FAIL'} ${m}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { files };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6dfs.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
