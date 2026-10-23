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
// every number below is derived from this tree's, so a release bump moves none of these tests
const CUR = Object.fromEntries(readVersions(ROOT).map((v) => [v.kind, v.value]));
const TAG = { tag: `v${CUR.mod}`, api: CUR.api, kit: CUR.kit }; // as if this tree were the last tag
const minor = (v) => { const [a, b] = v.split('.').map(Number); return `${a}.${b + 1}.0`; };
const patch = (v, n) => { const [a, b, c] = v.split('.').map(Number); return `${a}.${b}.${c + n}`; };
const NEW = { api: minor(CUR.api), mod: minor(CUR.mod), kit: minor(CUR.kit), catalogue: String(Number(CUR.catalogue) + 1) };
const LEGACY = patch(CUR.api, 5); // an in-flight slice's own semver guess, above the last tag's API
const esc = (v) => v.replaceAll('.', '\\.');

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
  // (the tree's own placeholders, when this runs on a slice branch that stamped NEXT: counted, so the planted ones are judged alone)
  const own = findPlaceholders(t);
  const base = own.length;
  // a slice's placeholders: one catalogue entry (plan.json, then the golden regenerated as a slice does) and javadoc
  const pj = path.join(t, 'kit/schemas/plan.json');
  const s = fs.readFileSync(pj, 'utf8');
  const first = /^(\s*\{ "id": "([^"]+)", "sinceApi": ")(\d+\.\d+\.\d+)(")/m.exec(s);
  assert.ok(first, 'a catalogue entry line');
  fs.writeFileSync(pj, s.replace(first[0], `${first[1]}NEXT${first[4]}`));
  const java = path.join(t, 'mod/src/main/java/dev/larattalabs/architect/api/SliceThing.java');
  fs.writeFileSync(java, `/** A new member. Since NEXT. */\ninterface SliceThing {\n\t/** @since NEXT */\n\tint NEXT = 1;\n\t/** (since ${LEGACY}, an in-flight slice's own guess) */\n\tint OLD = 2;\n\t/** Since 1.0.0. */\n\tint KEPT = 3;\n}\n`);
  return { t, entry: first[2], base, own };
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
  const { t, entry, base, own } = tempTree();
  try {
    await regenGolden(t);
    // a slice tree: lenient passes, strict names every placeholder
    assert.deepEqual(checkTree(t, { lenient: true, tag: TAG }).problems, []);
    const strict = checkTree(t, { tag: TAG, goldens: false }).problems;
    assert.equal(strict.filter((p) => p.startsWith('placeholder NEXT')).length, 4 + base, strict.join('\n')); // plan.json, the golden, 2 javadoc (+ the tree's own)
    assert.ok(strict.some((p) => new RegExp(`^catalogue ${esc(entry)}: sinceApi "NEXT"`).test(p)));
    const before = { links: JSON.parse(fs.readFileSync(path.join(t, 'scenarios/goldens/links_demo_flat.json'), 'utf8')), linksIr: fs.readFileSync(path.join(t, 'scenarios/goldens/links_demo_flat/ir.json'), 'utf8') };

    const s = setVersions(t, { ...NEW, tag: TAG });
    const v = Object.fromEntries(readVersions(t).map((x) => [x.id, x.value]));
    assert.deepEqual(v, { 'ArchitectApi.VERSION': NEW.api, PLAN_API: NEW.api, 'golden api': NEW.api, mod_version: NEW.mod, KIT_VERSION: NEW.kit, EVAL_KIT_VERSION: NEW.kit, 'IrStale.KIT_VERSION': NEW.kit, 'golden kitVersion': NEW.kit, catalogueVersion: NEW.catalogue, 'golden catalogueVersion': NEW.catalogue });
    // ((close-out A) the tree's own NEXT stamps, on a slice branch that stamped a catalogue entry, are left out: the planted ones are judged)
    const planted = s.stamped.filter((x) => !own.some((o) => o.file === x.file && o.line === x.line));
    assert.deepEqual(planted.filter((x) => ['plan.json', 'plan-catalogue.golden.json', 'SliceThing.java'].includes(path.basename(x.file))).map((x) => [path.basename(x.file), x.from, x.to]), [['plan.json', 'NEXT', NEW.api], ['plan-catalogue.golden.json', 'NEXT', NEW.api], ['SliceThing.java', 'NEXT', NEW.api], ['SliceThing.java', 'NEXT', NEW.api], ['SliceThing.java', LEGACY, NEW.api]]);
    const j = fs.readFileSync(path.join(t, 'mod/src/main/java/dev/larattalabs/architect/api/SliceThing.java'), 'utf8');
    assert.ok(j.includes(`Since ${NEW.api}. */`) && j.includes(`@since ${NEW.api} */`) && j.includes('int NEXT = 1;') && j.includes(`since ${NEW.api}, an in-flight`) && j.includes('Since 1.0.0.'), j);
    assert.deepEqual(findPlaceholders(t), []);
    assert.deepEqual(s.tracked, ['crossings_demo_flat', 'links_demo_flat']);
    for (const g of s.goldens) assert.ok(g.ok && g.written && !g.programShaMoved && g.kitTo === NEW.kit, JSON.stringify(g));
    // the header: only irSha and kitVersion moved; the IR: only kitVersion
    const after = JSON.parse(fs.readFileSync(path.join(t, 'scenarios/goldens/links_demo_flat.json'), 'utf8'));
    assert.deepEqual({ ...after, irSha: 'x', kitVersion: 'x' }, { ...before.links, irSha: 'x', kitVersion: 'x' });
    assert.equal(after.kitVersion, NEW.kit);
    assert.notEqual(after.irSha, before.links.irSha);
    const linksIr = fs.readFileSync(path.join(t, 'scenarios/goldens/links_demo_flat/ir.json'), 'utf8');
    assert.equal(linksIr, before.linksIr.replace(`"kitVersion":"${CUR.kit}"`, `"kitVersion":"${NEW.kit}"`));
    // consistent, strictly: no placeholder left, every tracked golden at the new kit re-planning byte for byte
    assert.deepEqual(checkTree(t, { tag: TAG, want: NEW }).problems, []);
    // and a check against other numbers fails
    assert.ok(checkTree(t, { tag: TAG, goldens: false, want: { kit: patch(NEW.kit, 1) } }).problems.some((p) => p.startsWith(`kit: want ${patch(NEW.kit, 1)}`)));
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('the golden verifier refuses a non-version change: a planner that plans differently, and the re-plan without its frozen volume', async () => {
  const { t, entry } = tempTree();
  try {
    await regenGolden(t);
    // the quirk: crossings_demo_flat re-planned without --volumes drops its tunnels
    const nv = recutGolden(t, 'crossings_demo_flat', { kitVersion: CUR.kit, noVolumes: true });
    assert.equal(nv.ok, false);
    assert.ok(nv.problems.some((p) => /the IR changed beyond kitVersion/.test(p)) && nv.problems.some((p) => /tile shas differ|cells /.test(p)), nv.problems.join('\n'));
    // with them, the same kit re-plans byte for byte
    const ok = recutGolden(t, 'crossings_demo_flat', { kitVersion: CUR.kit });
    assert.ok(ok.ok && ok.identical, ok.problems.join('\n'));
    // a whole set over a planner that now plans differently (links_demo_flat's bank moved): refused, every file put back
    const snap = snapshot(t);
    assert.throws(() => setVersions(t, { api: NEW.api, mod: NEW.mod, kit: NEW.kit, tag: TAG, goldenNames: ['links_demo_flat'], recutOpts: { paramsOver: { bank: 9 } } }),
      (e) => e.message.includes(`golden links_demo_flat: the re-cut for kit ${NEW.kit} changed more than its version`) && /\$\.(graph|parts|budget|anchors|params)/.test(e.message) && e.restored.length >= 8);
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
  const { t, entry } = tempTree();
  try {
    const f = path.join(t, 'kit/lib/region/plan.mjs');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^export const KIT_VERSION = '[^']+';$/m, `export const KIT_VERSION = '${patch(CUR.kit, 1)}';`));
    const p = checkTree(t, { lenient: true, tag: TAG }).problems;
    assert.ok(p.some((x) => x.startsWith(`kit versions differ: KIT_VERSION ${patch(CUR.kit, 1)}`)), p.join('\n'));
    // the tree's kit is read from KIT_VERSION: the goldens at the old kit now lag it
    assert.ok(p.some((x) => x.startsWith(`golden links_demo_flat records kit ${CUR.kit}, the tree is kit ${patch(CUR.kit, 1)}: re-cut it`)), p.join('\n'));
    const low = checkTree(t, { lenient: true, goldens: false, tag: { tag: 'v9.0.0', api: '9.0.0', kit: '9.0.0' } }).problems;
    assert.ok(low.some((x) => /below the last tag v9\.0\.0/.test(x)));
    // two matching lines: refused
    const a = path.join(t, 'mod/gradle.properties');
    fs.appendFileSync(a, `mod_version=${CUR.mod}\n`);
    assert.match(checkTree(t, { lenient: true, tag: TAG }).problems[0], /2 lines match the mod_version pattern/);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
