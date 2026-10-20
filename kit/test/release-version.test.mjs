// tools/release-version.mjs (docs/GATES.md "Release versions: one command at merge"): this tree's versions are consistent (the
// NEXT placeholder allowed only off a release branch), and the tool sets, stamps, re-cuts and refuses as documented, on a temp
// copy of the files it touches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, checkTree, findPlaceholders, readVersions, recutGolden, setVersions, verifyRecut } from '../../tools/release-version.mjs';
import { releaseContext } from '../../tools/release-context.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAG = { tag: 'v0.40.0', api: '1.37.0', kit: '0.38.0' };

test('this tree: every version agrees, the tracked goldens re-plan byte for byte, no NEXT on a release branch', () => {
  const ctx = releaseContext(ROOT);
  const r = checkTree(ROOT, { lenient: !ctx.release });
  assert.deepEqual(r.problems, [], `release context: ${ctx.why}`);
  assert.ok(r.goldens.length >= 1, 'at least one golden tracks the kit');
});

test('the constants\' lines are the ones impact.versionConstants classifies as version-only', () => {
  const vc = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'gate-chains.json'), 'utf8')).impact.versionConstants.lines;
  for (const t of TARGETS.filter((x) => x.kind !== 'catalogue')) {
    const line = t.re.exec(fs.readFileSync(path.join(ROOT, t.file), 'utf8'))[0];
    assert.ok((vc[t.file] ?? []).some((p) => new RegExp(p).test(line)), `${t.id}: ${JSON.stringify(line)} matches no versionConstants pattern of ${t.file}`);
  }
});

test('release context: env wins, CI refs, lenient without git', () => {
  assert.equal(releaseContext(ROOT, { ARCHITECT_RELEASE: '1' }).release, true);
  assert.equal(releaseContext(ROOT, { ARCHITECT_RELEASE: '0' }).release, false);
  assert.equal(releaseContext(ROOT, { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' }).release, true);
  assert.equal(releaseContext(ROOT, { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/tags/v0.41.0' }).release, true);
  assert.equal(releaseContext(ROOT, { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/pull/9/merge', GITHUB_HEAD_REF: 'slice/FL' }).release, false);
  assert.equal(releaseContext(ROOT, { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/pull/9/merge', GITHUB_HEAD_REF: 'integrate/fl' }).release, true);
  assert.equal(releaseContext(fs.mkdtempSync(path.join(os.tmpdir(), 'relctx-')), {}).release, false);
});

/** A temp tree with what the tool reads and writes, two goldens (one with a frozen volume) and a NEXT-stamped entry and class. */
function tempTree() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'reltool-test-'));
  const cp = (rel) => fs.cpSync(path.join(ROOT, rel), path.join(t, rel), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, 'kit'))) if (!['test', 'stamps'].includes(e)) cp(`kit/${e}`); // the kit but its tests
  for (const f of ['tools/scenarios.mjs', 'tools/lib/scenario-eval-worker.mjs', 'tools/catalogue-since-check.mjs', 'tools/release-context.mjs', 'mod/gradle.properties',
    'mod/src/main/java/dev/larattalabs/architect/api/ArchitectApi.java', 'mod/src/main/java/dev/larattalabs/architect/region/IrStale.java']) cp(f);
  for (const g of ['links_demo_flat', 'crossings_demo_flat']) { cp(`scenarios/goldens/${g}`); cp(`scenarios/goldens/${g}.json`); }
  // a slice's placeholders: one catalogue entry (plan.json, then the golden regenerated as a slice does) and javadoc
  const pj = path.join(t, 'kit/schemas/plan.json');
  const s = fs.readFileSync(pj, 'utf8');
  assert.ok(s.includes('"id": "zone.outpost", "sinceApi": "1.29.0"'));
  fs.writeFileSync(pj, s.replace('"id": "zone.outpost", "sinceApi": "1.29.0"', '"id": "zone.outpost", "sinceApi": "NEXT"'));
  const java = path.join(t, 'mod/src/main/java/dev/larattalabs/architect/api/SliceThing.java');
  fs.writeFileSync(java, '/** A new member. Since NEXT. */\ninterface SliceThing {\n\t/** @since NEXT */\n\tint NEXT = 1;\n\t/** (since 1.38.5, an in-flight slice\'s own guess) */\n\tint OLD = 2;\n\t/** Since 1.30.0. */\n\tint KEPT = 3;\n}\n');
  return t;
}
const regenGolden = async (t) => {
  const { planCatalogue } = await import(`${path.join(t, 'kit/lib/plan/catalogue.mjs')}?${Date.now()}`);
  fs.writeFileSync(path.join(t, 'kit/schemas/plan-catalogue.golden.json'), `${JSON.stringify(planCatalogue(), null, 1)}\n`);
};
const snapshot = (t) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(t, p)] = fs.readFileSync(p).toString('base64'); } };
  walk(t);
  return out;
};

test('set: every constant, the NEXT and legacy stamps, the goldens re-cut (kitVersion and irSha only), then consistent', async () => {
  const t = tempTree();
  try {
    await regenGolden(t);
    // a slice tree: lenient passes, strict names every placeholder
    assert.deepEqual(checkTree(t, { lenient: true, tag: TAG }).problems, []);
    const strict = checkTree(t, { tag: TAG, goldens: false }).problems;
    assert.equal(strict.filter((p) => p.startsWith('placeholder NEXT')).length, 4, strict.join('\n')); // plan.json, the golden, 2 javadoc
    assert.ok(strict.some((p) => /zone\.outpost: sinceApi "NEXT"/.test(p)));
    const before = { links: JSON.parse(fs.readFileSync(path.join(t, 'scenarios/goldens/links_demo_flat.json'), 'utf8')), linksIr: fs.readFileSync(path.join(t, 'scenarios/goldens/links_demo_flat/ir.json'), 'utf8') };

    const s = setVersions(t, { api: '1.38.0', mod: '0.41.0', kit: '0.39.0', catalogue: 10, tag: TAG });
    const v = Object.fromEntries(readVersions(t).map((x) => [x.id, x.value]));
    assert.deepEqual(v, { 'ArchitectApi.VERSION': '1.38.0', PLAN_API: '1.38.0', 'golden api': '1.38.0', mod_version: '0.41.0', KIT_VERSION: '0.39.0', EVAL_KIT_VERSION: '0.39.0', 'IrStale.KIT_VERSION': '0.39.0', 'golden kitVersion': '0.39.0', catalogueVersion: '10', 'golden catalogueVersion': '10' });
    assert.deepEqual(s.stamped.map((x) => [path.basename(x.file), x.from, x.to]), [['plan.json', 'NEXT', '1.38.0'], ['plan-catalogue.golden.json', 'NEXT', '1.38.0'], ['SliceThing.java', 'NEXT', '1.38.0'], ['SliceThing.java', 'NEXT', '1.38.0'], ['SliceThing.java', '1.38.5', '1.38.0']]);
    const j = fs.readFileSync(path.join(t, 'mod/src/main/java/dev/larattalabs/architect/api/SliceThing.java'), 'utf8');
    assert.ok(j.includes('Since 1.38.0. */') && j.includes('@since 1.38.0 */') && j.includes('int NEXT = 1;') && j.includes('since 1.38.0, an in-flight') && j.includes('Since 1.30.0.'), j);
    assert.deepEqual(findPlaceholders(t), []);
    assert.deepEqual(s.tracked, ['crossings_demo_flat', 'links_demo_flat']);
    for (const g of s.goldens) assert.ok(g.ok && g.written && !g.programShaMoved && g.kitTo === '0.39.0', JSON.stringify(g));
    // the header: only irSha and kitVersion moved; the IR: only kitVersion
    const after = JSON.parse(fs.readFileSync(path.join(t, 'scenarios/goldens/links_demo_flat.json'), 'utf8'));
    assert.deepEqual({ ...after, irSha: 'x', kitVersion: 'x' }, { ...before.links, irSha: 'x', kitVersion: 'x' });
    assert.equal(after.kitVersion, '0.39.0');
    assert.notEqual(after.irSha, before.links.irSha);
    const linksIr = fs.readFileSync(path.join(t, 'scenarios/goldens/links_demo_flat/ir.json'), 'utf8');
    assert.equal(linksIr, before.linksIr.replace('"kitVersion":"0.38.0"', '"kitVersion":"0.39.0"'));
    // consistent, strictly: no placeholder left, every tracked golden at kit 0.39.0 re-planning byte for byte
    assert.deepEqual(checkTree(t, { tag: TAG, want: { api: '1.38.0', mod: '0.41.0', kit: '0.39.0', catalogue: '10' } }).problems, []);
    // and a check against other numbers fails
    assert.ok(checkTree(t, { tag: TAG, goldens: false, want: { kit: '0.39.1' } }).problems.some((p) => /^kit: want 0\.39\.1/.test(p)));
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('the golden verifier refuses a non-version change: a planner that plans differently, and the re-plan without its frozen volume', async () => {
  const t = tempTree();
  try {
    await regenGolden(t);
    // the quirk: crossings_demo_flat re-planned without --volumes drops its tunnels
    const nv = recutGolden(t, 'crossings_demo_flat', { kitVersion: '0.38.0', noVolumes: true });
    assert.equal(nv.ok, false);
    assert.ok(nv.problems.some((p) => /the IR changed beyond kitVersion/.test(p)) && nv.problems.some((p) => /tile shas differ|cells /.test(p)), nv.problems.join('\n'));
    // with them, the same kit re-plans byte for byte
    const ok = recutGolden(t, 'crossings_demo_flat', { kitVersion: '0.38.0' });
    assert.ok(ok.ok && ok.identical, ok.problems.join('\n'));
    // a whole set over a planner that now plans differently (links_demo_flat's bank moved): refused, every file put back
    const snap = snapshot(t);
    assert.throws(() => setVersions(t, { api: '1.38.0', mod: '0.41.0', kit: '0.39.0', tag: TAG, goldenNames: ['links_demo_flat'], recutOpts: { paramsOver: { bank: 9 } } }),
      (e) => /golden links_demo_flat: the re-cut for kit 0\.39\.0 changed more than its version/.test(e.message) && /\$\.(graph|parts|budget|anchors|params)/.test(e.message) && e.restored.length >= 8);
    assert.deepEqual(snapshot(t), snap, 'every file restored byte for byte');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('verifyRecut: only kitVersion and programSha in the IR; blobs, tiles and cells exact', () => {
  const ir = { kitVersion: '0.38.0', programSha: 'a', budget: { cells: 10 }, parts: [{ id: 'p' }] };
  const header = { cells: 10, tiles: { 'a|terrain|0,0': 'x' } };
  const tiles = { cells: 10, tiles: { 'a|terrain|0,0': 'x' }, workersSame: true };
  const blobs = new Map([['b'.repeat(64), Buffer.from('1')]]);
  const base = { oldIr: ir, oldBlobs: blobs, newBlobs: new Map(blobs), header, tiles, kitVersion: '0.39.0' };
  assert.deepEqual(verifyRecut({ ...base, newIr: { ...ir, kitVersion: '0.39.0' } }).problems, []);
  assert.equal(verifyRecut({ ...base, newIr: { ...ir, kitVersion: '0.39.0', programSha: 'b' } }).programShaMoved, true);
  assert.match(verifyRecut({ ...base, newIr: { ...ir, kitVersion: '0.39.0', budget: { cells: 11 } } }).problems.join(), /\$\.budget\.cells: 10 -> 11/);
  assert.match(verifyRecut({ ...base, newIr: { ...ir } }).problems.join(), /kitVersion is 0\.38\.0, want 0\.39\.0/);
  assert.match(verifyRecut({ ...base, newIr: { ...ir, kitVersion: '0.39.0' }, newBlobs: new Map([['b'.repeat(64), Buffer.from('2')]]) }).problems.join(), /bytes differ/);
  assert.match(verifyRecut({ ...base, newIr: { ...ir, kitVersion: '0.39.0' }, tiles: { ...tiles, tiles: { 'a|terrain|0,0': 'y' } } }).problems.join(), /tile shas differ/);
  assert.match(verifyRecut({ ...base, newIr: { ...ir, kitVersion: '0.39.0' }, tiles: { ...tiles, workersSame: false } }).problems.join(), /1 worker/);
});

test('check: a constant out of step, a lagging golden, a version below the last tag', () => {
  const t = tempTree();
  try {
    const f = path.join(t, 'kit/lib/region/plan.mjs');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^export const KIT_VERSION = '[^']+';$/m, "export const KIT_VERSION = '0.38.1';"));
    const p = checkTree(t, { lenient: true, tag: TAG }).problems;
    assert.ok(p.some((x) => /^kit versions differ: .*KIT_VERSION 0\.38\.1/.test(x)), p.join('\n'));
    // the tree's kit is read from KIT_VERSION: the goldens at 0.38.0 now lag it
    assert.ok(p.some((x) => /golden links_demo_flat records kit 0\.38\.0, the tree is kit 0\.38\.1: re-cut it/.test(x)), p.join('\n'));
    const low = checkTree(t, { lenient: true, goldens: false, tag: { tag: 'v9.0.0', api: '9.0.0', kit: '9.0.0' } }).problems;
    assert.ok(low.some((x) => /below the last tag v9\.0\.0/.test(x)));
    // two matching lines: refused
    const a = path.join(t, 'mod/gradle.properties');
    fs.appendFileSync(a, 'mod_version=0.40.0\n');
    assert.match(checkTree(t, { lenient: true, tag: TAG }).problems[0], /2 lines match the mod_version pattern/);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
