// tools/unit-scope.mjs (docs/GATES.md "Scoped unit suites"): the selection over a synthetic tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, selectTests, fullCounts, languageOf, excludedTags, SHARED_CORE } from '../../tools/unit-scope.mjs';

const J = 'mod/src/main/java/dev/larattalabs/architect';
const T = 'mod/src/test/java/dev/larattalabs/architect';
const TREE = {
  'kit/lib/a.mjs': "export const a = 1;\n",
  'kit/lib/b.mjs': "import { a } from './a.mjs';\nexport const b = a;\n",
  'kit/lib/c.mjs': "import { b } from './b.mjs';\nexport const c = b;\n",
  'kit/lib/lone.mjs': 'export const lone = 1;\n',
  'kit/lib/check.mjs': 'export function check() {}\n',
  'kit/fixtures-dir/x.json': '{}\n',
  'kit/test/a.test.mjs': "import { a } from '../lib/a.mjs';\n",
  'kit/test/b.test.mjs': "import { b } from '../lib/b.mjs';\n",
  'kit/test/c.test.mjs': "import { c } from '../lib/c.mjs';\n",
  'kit/test/doc.test.mjs': "const t = fs.readFileSync(path.join(ROOT, 'kit', 'NOTES.md'), 'utf8');\nconst d = fs.readdirSync('kit/fixtures-dir');\n",
  'kit/NOTES.md': '# notes\n',
  'docs/X.md': '# x\n',
  'sidecar/src/proto.ts': 'export const P = 1;\n',
  'sidecar/src/server.ts': "import { P } from './proto.js';\nconst SRC = 'sidecar/src';\n",
  'sidecar/test/proto.test.ts': "import { P } from '../src/proto.js';\n",
  'sidecar/test/server.test.ts': "import '../src/server.js';\n",
  'mod/build.gradle': 'test {\n useJUnitPlatform {\n  excludeTags "umt-long", "umt-explore"\n }\n}\n',
  [`${J}/region/Tile.java`]: 'package dev.larattalabs.architect.region;\npublic final class Tile {}\n',
  [`${J}/region/Stream.java`]: 'package dev.larattalabs.architect.region;\npublic final class Stream { Tile t; }\n',
  [`${J}/site/Items.java`]: 'package dev.larattalabs.architect.site;\nimport dev.larattalabs.architect.region.Stream;\npublic class Items {}\n',
  [`${T}/region/TileTest.java`]: 'package dev.larattalabs.architect.region;\nimport org.junit.jupiter.api.Test;\nclass TileTest { @Test void t() { new Tile(); } }\n',
  [`${T}/site/ItemsTest.java`]: 'package dev.larattalabs.architect.site;\nimport org.junit.jupiter.api.Test;\nclass ItemsTest { @Test void t() { new Items(); } }\n',
  [`${T}/site/OracleTest.java`]: 'package dev.larattalabs.architect.site;\nimport org.junit.jupiter.api.Test;\nclass OracleTest { @Test void t() { read("../kit/lib/lone.mjs"); } }\n',
  [`${T}/site/LongTest.java`]: 'package dev.larattalabs.architect.site;\nimport org.junit.jupiter.api.Tag;\nimport org.junit.jupiter.api.Test;\n@Tag("umt-long")\nclass LongTest { @Test void t() { new Items(); } }\n',
};
const graph = () => buildGraph(new Set(Object.keys(TREE)), (p) => {
  if (!(p in TREE)) throw new Error(`no ${p}`);
  return TREE[p];
});
const IGNORE = ['docs/**', '**/*.md'];
const sel = (files) => selectTests(files, graph(), { ignore: IGNORE });
const picks = (r, s) => [...r.suites[s].picks.keys()].sort();

test('a changed module picks its importing tests and the tests of its direct dependents (two hops), not further', () => {
  const r = sel(['kit/lib/a.mjs']);
  assert.deepEqual(picks(r, 'kit'), ['kit/test/a.test.mjs', 'kit/test/b.test.mjs']);
  assert.equal(r.suites.kit.full, null);
  assert.ok(r.suites.kit.picks.get('kit/test/b.test.mjs')[0].includes('kit/lib/b.mjs <- kit/lib/a.mjs'), 'the chain is printed');
});

test('a changed test picks itself', () => {
  assert.deepEqual(picks(sel(['kit/test/c.test.mjs']), 'kit'), ['kit/test/c.test.mjs']);
});

test('shared core selects the full suites it names; the full counts are the trees\' tests', () => {
  const r = sel(['kit/lib/check.mjs']);
  assert.ok(r.suites.kit.full[0].includes('shared core (checker core)'));
  assert.ok(r.suites.sidecar.full);
  assert.equal(r.suites.gradle.full, null);
  for (const f of ['mod/build.gradle', 'sidecar/package-lock.json', 'tools/unit-scope.mjs']) {
    const x = sel([f]);
    assert.ok(x.suites.kit.full && x.suites.sidecar.full && x.suites.gradle.full, `${f}: every suite full`);
  }
  assert.ok(SHARED_CORE.some((c) => c.name === 'journal') && SHARED_CORE.some((c) => c.name === 'ledger'));
  assert.deepEqual(fullCounts(graph()), { kit: 4, sidecar: 2, gradle: 3 });
});

test('a file no test reaches falls back to its language\'s full suite; a deleted file too; never a silent skip', () => {
  const r = sel(['kit/lib/lone.mjs', 'sidecar/src/gone.ts']);
  assert.equal(r.suites.kit.full, null, 'lone.mjs is read by a Java test, so it is mapped');
  assert.deepEqual([...r.suites.gradle.picks.keys()], [`${T}/site/OracleTest.java`]);
  assert.match(r.suites.sidecar.full[0], /sidecar\/src\/gone\.ts: deleted/);
  const u = selectTests(['tools/orphan.mjs'], buildGraph(new Set(['tools/orphan.mjs']), () => ''), { ignore: IGNORE });
  assert.match(u.suites.kit.full[0], /no test within two hops \(unmapped\)/);
  assert.deepEqual([languageOf('mod/x'), languageOf('devserver/x'), languageOf('sidecar/x'), languageOf('scenarios/x')], ['gradle', 'gradle', 'sidecar', 'kit']);
});

test('a doc a test reads is picked, not ignored; an unread doc is ignored; a data file under a named directory is picked', () => {
  const r = sel(['kit/NOTES.md', 'docs/X.md', 'kit/fixtures-dir/x.json']);
  assert.deepEqual(picks(r, 'kit'), ['kit/test/doc.test.mjs']);
  assert.deepEqual(r.ignored, ['docs/X.md']);
  for (const s of ['kit', 'sidecar', 'gradle']) assert.equal(r.suites[s].full, null);
});

test('TypeScript .js specifiers resolve to the .ts; a directory string in a module is not a dependency on its code', () => {
  const r = sel(['sidecar/src/proto.ts']);
  assert.deepEqual(picks(r, 'sidecar'), ['sidecar/test/proto.test.ts', 'sidecar/test/server.test.ts']);
  const s = sel(['sidecar/src/server.ts']);
  assert.deepEqual(picks(s, 'sidecar'), ['sidecar/test/server.test.ts'], "server.ts's 'sidecar/src' does not make it depend on proto.ts's readers");
});

test('Java: same-package simple names and imports are edges; a class the test task excludes by tag is never a --tests filter', () => {
  const g = graph();
  assert.deepEqual(excludedTags(TREE['mod/build.gradle']), ['umt-long', 'umt-explore']);
  assert.deepEqual(g.excluded, [`${T}/site/LongTest.java`]);
  const r = selectTests([`${J}/region/Tile.java`], g);
  // Tile <- TileTest (same package); Tile <- Stream <- (nothing tests Stream directly); Items imports Stream: three hops, not picked
  assert.deepEqual([...r.suites.gradle.picks.keys()], [`${T}/region/TileTest.java`]);
  const s = selectTests([`${J}/region/Stream.java`], g);
  assert.deepEqual([...s.suites.gradle.picks.keys()], [`${T}/site/ItemsTest.java`]);
  assert.equal(g.gradle.get(`${T}/site/ItemsTest.java`), 'dev.larattalabs.architect.site.ItemsTest');
});

test('a gate driver no unit reaches gets node --check, not the full kit suite; step roots map drivers to steps', async () => {
  const { gateDrivers } = await import('../../tools/unit-scope.mjs');
  const drivers = gateDrivers({ steps: { 'unit-kit': { roots: ['kit/test/a.test.mjs'] }, 'aq-unit': { roots: ['tools/gate7x.mjs'] }, 'aq-ingame': { roots: ['tools/gate6b.mjs', 'tools/gate7x.mjs'] } } });
  assert.deepEqual([...drivers], [['tools/gate7x.mjs', ['aq-unit', 'aq-ingame']], ['tools/gate6b.mjs', ['aq-ingame']]]);
  const g = buildGraph(new Set(['tools/gate7x.mjs', 'tools/orphan.mjs']), () => '');
  const r = selectTests(['tools/gate7x.mjs', 'tools/orphan.mjs'], g, { drivers });
  assert.deepEqual(r.checks, ['tools/gate7x.mjs']);
  assert.deepEqual(r.suites.kit.full, ['tools/orphan.mjs: no test within two hops (unmapped)']);
});
