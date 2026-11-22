#!/usr/bin/env node
// (RTE5) Writes kit/test/fixtures/rte-compat/rte5.json.gz: the second RTE readers' compatibility corpus, for the shapes RTE4's corpus
// lacked (kit/tools/rte5-compat-worker.mjs) and for releases before v0.85.0 (RTE4's own cases, kit/tools/rte-compat-worker.mjs, planned by
// older trees). Each released kit, in a tree of its tag (`git archive <tag> kit | tar -x -C <dir>`: the kit imports only node builtins),
// plans and grows the cases; a history one release starts is continued by the next trees of its chain (`mixed`). Then v0.88.0's readers
// read every round (`expected`: kit/test/rte5-compat.test.mjs and DistrictLandCompat5Test hold this tree to it), each release's own
// readers its own cases (`own`, where they differ), and v0.89.0's readers every round (`v089`, where they differ from v0.88.0's: none
// expected, RTE4's claim). v0.89.0 also plans each unmixed case (`written`: its IR and revisions' sha, with and without the district
// tag, neither covering an IR's `kitVersion` or `node`), for the test's emission check: this tree writes v0.89.0's IRs but where RTE5
// drops a tag v0.89.0 wrote needlessly (plan_v0).
//   node kit/tools/rte5-compat-fixture.mjs v0.48.0=<tree> ... v0.88.0=<tree> v0.89.0=<tree>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cases as rte4Cases } from './rte-compat-worker.mjs';
import { cases as newCases, mixedCases } from './rte5-compat-worker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = path.join(HERE, '..', 'test', 'fixtures', 'rte-compat', 'rte5.json.gz');
export const EXPECTED_FROM = 'v0.88.0';
export const WRITTEN_BY = 'v0.89.0';
/** The releases before RTE4's corpus that plan RTE4's own cases (v0.48.0 is the first with revise.mjs: v0.47.0 cannot grow). */
export const PRE = ['v0.48.0', 'v0.55.0', 'v0.65.0', 'v0.75.0', 'v0.84.0'];
/** The releases that plan the new cases. */
export const NEW = [...PRE, 'v0.85.0', 'v0.86.0', 'v0.87.0', 'v0.88.0'];
/** The chains a mixed history runs through: stage i runs op i (the first plans too; the last takes the rest). The last chain goes backwards. */
export const CHAINS = [['v0.48.0', 'v0.65.0', 'v0.84.0', 'v0.88.0'], ['v0.85.0', 'v0.86.0', 'v0.87.0', 'v0.88.0'], ['v0.88.0', 'v0.85.0', 'v0.87.0', 'v0.86.0']];

/** The corpus: {versions, expectedFrom, writtenBy, cases: [...]}. */
export function loadCorpus(file = FIXTURE) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

/** The district tag stripped from an IR's roads (a copy). */
export function untagged(ir) {
  return { ...ir, roads: (ir.roads ?? []).map((r) => { if (!r.ext?.['architect_mc:district']) return r; const { 'architect_mc:district': _, ...ext } = r.ext; return { ...r, ext }; }) };
}
/** An IR without its writer's metadata: `kitVersion` (every release bumps it) and `node` (the runtime's major: CI's need not be the
 *  fixture's). Everything else is hashed exactly. */
export function unversioned(ir) {
  const { kitVersion: _k, node: _n, ...rest } = ir;
  return rest;
}
/** The sha of a case's written state (its IR and each revision's IR, in order), without each IR's writer metadata (`unversioned`). */
export function writtenSha(ir, revisions, strip = false) {
  const f = strip ? (x) => unversioned(untagged(x)) : unversioned;
  return crypto.createHash('sha256').update(JSON.stringify([f(ir), ...revisions.map((r) => f(r.ir))])).digest('hex');
}

function worker(file, args) {
  const r = spawnSync(process.execPath, [path.join(HERE, file), ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`${file} ${args[0]} ${args[1]}: exit ${r.status}: ${r.stderr.slice(-2000)}`);
}
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const trees = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')).map(([v, t]) => [v, path.resolve(t)]));
  for (const v of [...NEW, WRITTEN_BY]) if (!trees[v]) throw new Error(`usage: node kit/tools/rte5-compat-fixture.mjs ${[...NEW, WRITTEN_BY].map((x) => `${x}=<tree>`).join(' ')}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rte5-compat-'));
  const t = (n) => path.join(tmp, n);
  const cases = [], seen = new Map();
  const keep = (c, v, key) => {
    if (c.error) { console.log(`${key}: not planned (${c.error})`); return; }
    const body = JSON.stringify({ ir: c.ir, revisions: c.revisions, rounds: c.rounds });
    if (seen.has(body)) { seen.get(body).alsoBy.push(v); return; }
    const k = { key, version: v, alsoBy: [], ...c };
    seen.set(body, k);
    cases.push(k);
  };
  // ---- RTE4's cases under the releases before v0.85.0 (RTE4's worker; its rounds are prefixes: rid k at position k)
  for (const v of PRE) {
    worker('rte-compat-worker.mjs', ['plan', trees[v], t(`pre-${v}.json`)]);
    for (const c of readJ(t(`pre-${v}.json`))) {
      const { grows, ...rest } = c;
      const revisions = (c.revisions ?? []).map((ir, i) => ({ rid: i + 1, position: i + 1, by: v, ir }));
      keep({ ...rest, family: 'rte4', ops: grows.map(([d, lots, prefer]) => ['grow', d, lots, prefer]), revisions, rounds: [{ revs: [], revised: false }, ...revisions.map((_, i) => ({ revs: revisions.slice(0, i + 1).map((r) => r.rid), revised: true }))], by: v }, v, `${v}/rte4/${c.id}`);
    }
  }
  // ---- the new cases under every release from v0.48.0 to v0.88.0
  fs.writeFileSync(t('new.json'), JSON.stringify(newCases()));
  for (const v of NEW) {
    worker('rte5-compat-worker.mjs', ['plan', trees[v], t('new.json'), t(`new-${v}.json`), v]);
    for (const c of readJ(t(`new-${v}.json`))) keep(c, v, `${v}/${c.id}`);
  }
  // ---- histories across releases
  for (const chain of CHAINS) {
    let state = mixedCases();
    chain.forEach((v, i) => {
      for (const c of state) { c.from = i; c.to = i === chain.length - 1 ? c.ops.length : i + 1; }
      fs.writeFileSync(t('mix.json'), JSON.stringify(state));
      worker('rte5-compat-worker.mjs', ['plan', trees[v], t('mix.json'), t('mix-out.json'), v]);
      state = readJ(t('mix-out.json'));
    });
    for (const c of state) { delete c.from; delete c.to; keep({ ...c, chain }, chain[0], `${chain.join('>')}/${c.id}`); }
  }
  // ---- the readings: v0.88.0's (expected), v0.89.0's, each release's own
  fs.writeFileSync(t('all.json'), JSON.stringify(cases));
  worker('rte5-compat-worker.mjs', ['read', trees[EXPECTED_FROM], t('all.json'), t('expected.json')]);
  const expected = readJ(t('expected.json'));
  cases.forEach((c, i) => { c.expected = expected[i]; });
  worker('rte5-compat-worker.mjs', ['read', trees[WRITTEN_BY], t('all.json'), t('v089.json')]);
  const v089 = readJ(t('v089.json'));
  cases.forEach((c, i) => { c.v089 = JSON.stringify(v089[i]) === JSON.stringify(c.expected) ? null : v089[i]; });
  for (const v of NEW) {
    if (v === EXPECTED_FROM) { cases.forEach((c) => { if (c.version === v) c.own = null; }); continue; }
    const mine = cases.filter((c) => c.version === v);
    fs.writeFileSync(t(`mine-${v}.json`), JSON.stringify(mine));
    worker('rte5-compat-worker.mjs', ['read', trees[v], t(`mine-${v}.json`), t(`own-${v}.json`)]);
    const own = readJ(t(`own-${v}.json`));
    mine.forEach((c, i) => { c.own = JSON.stringify(own[i]) === JSON.stringify(c.expected) ? null : own[i]; });
  }
  // ---- what v0.89.0 writes for each unmixed new case (the test's emission check)
  worker('rte5-compat-worker.mjs', ['plan', trees[WRITTEN_BY], t('new.json'), t('w089.json'), WRITTEN_BY]);
  const written = Object.fromEntries(readJ(t('w089.json')).map((c) => [c.id, c.error ? { error: c.error } : { sha: writtenSha(c.ir, c.revisions), untagged: writtenSha(c.ir, c.revisions, true), log: c.log.map((l) => l.slice(0, -1).filter((x) => x !== WRITTEN_BY)) }]));
  const out = { $comment: 'Generated by kit/tools/rte5-compat-fixture.mjs from the released trees; read by kit/test/rte5-compat.test.mjs and mod DistrictLandCompat5Test. Do not edit. own / v089: null when that release read the case as expected (v0.88.0).',
    versions: NEW, expectedFrom: EXPECTED_FROM, writtenBy: WRITTEN_BY, chains: CHAINS, cases, written };
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, zlib.gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 }));
  fs.rmSync(tmp, { recursive: true, force: true });
  const rounds = cases.reduce((a, c) => a + c.rounds.length, 0);
  const differ = (k) => cases.filter((c) => c[k]).map((c) => c.key);
  console.log(`wrote ${FIXTURE}: ${cases.length} cases (${rounds} effective IRs); ${fs.statSync(FIXTURE).size} bytes`);
  console.log(`v0.89.0 reads differently from v0.88.0: ${JSON.stringify(differ('v089'))}`);
  console.log(`own readings differ: ${differ('own').length} cases`);
}
