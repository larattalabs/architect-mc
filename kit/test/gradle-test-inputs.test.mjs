// (TI) tools/lib/gradle-test-inputs.mjs: the literal kit/ and scenarios/ paths the mod's Java tests name against mod/build.gradle's test
// inputs (`node tools/step-inputs.mjs check`). A directory read needs an inputs.dir of it or a parent (v0.89.0 review P3).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { declaredTestInputs, gradleTestInputGaps, literalTestPaths, tracedTestInputGaps } from '../../tools/lib/gradle-test-inputs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GRADLE = fs.readFileSync(path.join(ROOT, 'mod', 'build.gradle'), 'utf8');
const FILES = new Set(execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { maxBuffer: 256 << 20 }).toString().split('\0').filter(Boolean));
const SOURCES = [...FILES].filter((f) => f.startsWith('mod/src/test/java/') && f.endsWith('.java')).map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
const EXAMPLES_DIR = 'inputs.dir("../kit/examples").withPropertyName("kitExamples").withPathSensitivity(PathSensitivity.RELATIVE)';

test('the tree\'s mod/build.gradle declares every literal path its tests name', () => {
  assert.ok(GRADLE.includes(EXAMPLES_DIR));
  assert.deepEqual(gradleTestInputGaps(GRADLE, SOURCES, FILES), []);
});

test('the v0.89.0 review\'s probe: kit/examples declared only by one file under it fails MinLotSizeTest\'s directory read', () => {
  const probe = GRADLE.replace(EXAMPLES_DIR, 'inputs.files("../kit/examples/cabin/cabin.blueprint.json").withPropertyName("kitExamples")');
  assert.notEqual(probe, GRADLE);
  assert.deepEqual(declaredTestInputs(probe).files.filter((f) => f.startsWith('kit/examples')), ['kit/examples/cabin/cabin.blueprint.json']);
  const gaps = gradleTestInputGaps(probe, SOURCES, FILES);
  const ex = gaps.filter((g) => g.startsWith('mod/build.gradle: kit/examples '));
  assert.equal(ex.length, 1, gaps.join('\n'));
  assert.match(ex[0], /MinLotSizeTest/);
  assert.match(ex[0], /a directory: declare it, or a parent, with inputs\.dir/);
});

test('files and directories: a file by inputs.files or a parent dir; a directory only by an inputs.dir of it or a parent', () => {
  const files = new Set(['kit/a/one.json', 'kit/a/two.json', 'kit/b/x.json']);
  const src = [['mod/src/test/java/T.java', 'Path.of("../kit/a"); Files.readString(Path.of("..", "kit", "b", "x.json"));\n  // "../kit/c" in a comment\n/* "../kit/d" */']];
  const g = (body) => gradleTestInputGaps(`test {\n${body}\n}\n`, src, files);
  assert.deepEqual(literalTestPaths(src[0][1]), ['kit/a', 'kit/b/x.json']);
  assert.equal(g('inputs.files("../kit/a/one.json", "../kit/a/two.json", "../kit/b/x.json")').length, 1, 'every file under kit/a declared singly still leaves the directory read');
  assert.deepEqual(g('inputs.dir("../kit/a")\ninputs.files("../kit/b/x.json")'), []);
  assert.deepEqual(g('inputs.dir("../kit")'), [], 'a parent directory covers both');
  assert.equal(g('inputs.dir("../kit/a")').length, 1, 'kit/b/x.json undeclared');
  assert.deepEqual(gradleTestInputGaps('test {\ninputs.files("../kit/b/x.json")\n}\n', src, files, ['kit/a']), [], 'a known gap passes');
});

// (TI2) computed paths: a path a test builds at run time (a Path constant's resolve chain, a literal head with a computed tail, a
// concatenation) counts by its literal head, which must be declared as a directory; the node scripts a test runs count by their
// module closure (tools/lib/step-inputs.mjs moduleClosure), every file and directory of it declared.
const TI2_FILES = new Set(['kit/lib/a.mjs', 'kit/newdir/one.json', 'kit/newdir/two.json', 'kit/t/run.mjs', 'kit/vocab2/roles.json', 'scenarios/g/s1/ir.json']);
const TI2_TEXT = {
  'kit/t/run.mjs': "import '../lib/a.mjs';\nimport ROLES from '../vocab2/roles.json' with { type: 'json' };\n",
  'kit/lib/a.mjs': 'export const A = 1;\n',
};
const ti2 = (body, src) => gradleTestInputGaps(`test {\n${body}\n}\n`, [['mod/src/test/java/T.java', src]], TI2_FILES, [], { read: (p) => TI2_TEXT[p] ?? '' });

test('(TI2) a computed read under a Path constant goes red until its directory is declared', () => {
  const src = 'class T {\n  static final Path KIT = Path.of("..", "kit");\n  JsonObject f(String id) { return json(KIT.resolve("newdir").resolve(id + ".json")); }\n}\n';
  const red = ti2('inputs.dir("../kit/lib")', src);
  assert.equal(red.length, 1, red.join('\n'));
  assert.match(red[0], /kit\/newdir \(read by T\)/);
  assert.match(red[0], /computed/);
  assert.deepEqual(ti2('inputs.dir("../kit/lib")\ninputs.dir("../kit/newdir")', src), []);
  assert.equal(ti2('inputs.files("../kit/newdir/one.json", "../kit/newdir/two.json")', src).length, 1, 'single files never cover a computed name');
});

test('(TI2) the other computed forms: a local Path with a concatenated resolve, a literal Path.of head, a string concatenation', () => {
  for (const src of [
    'void f(String p) { Path kit = Path.of("../kit").toAbsolutePath().normalize(); read(kit.resolve("newdir/" + p + ".json")); }',
    'void f(String id) { read(Path.of("..", "kit", "newdir", id)); }',
    'void f(String id) { read(Path.of("../kit/newdir/x_" + id)); }',
    'void f(String id) { read(Path.of("..", "scenarios", "g", id, "ir.json")); }',
  ]) {
    const want = src.includes('scenarios') ? 'scenarios/g' : 'kit/newdir';
    const red = ti2('inputs.dir("../kit/lib")', src);
    assert.equal(red.length, 1, `${src}: ${red.join('\n')}`);
    assert.ok(red[0].startsWith(`mod/build.gradle: ${want} `), red[0]);
    assert.deepEqual(ti2(`inputs.dir("../kit/lib")\ninputs.dir("../${want}")`, src), [], src);
  }
});

test('(TI2) a node script a test runs: its module closure (a JSON module outside the declared tree) goes red until declared', () => {
  const src = 'static final Path KIT = Path.of("../kit");\nvoid f() { run("node", KIT.resolve("t/run.mjs").toString()); }';
  const red = ti2('inputs.files("../kit/t/run.mjs")\ninputs.dir("../kit/lib")', src);
  assert.deepEqual(red.map((g) => g.split(' ')[1]), ['kit/vocab2/roles.json'], red.join('\n'));
  assert.match(red[0], /closure of kit\/t\/run\.mjs/);
  assert.deepEqual(ti2('inputs.files("../kit/t/run.mjs")\ninputs.dir("../kit/lib")\ninputs.dir("../kit/vocab2")', src), []);
});

test('(TI2) a fileTree with excludes covers what it does not exclude, never an excluded path', () => {
  const tree = 'inputs.files(fileTree("../kit") { exclude "**/t/**", "**/examples/**" })';
  const d = declaredTestInputs(`test {\n${tree}\n}\n`);
  assert.deepEqual(d.trees, [{ dir: 'kit', excludes: ['**/t/**', '**/examples/**'] }]);
  const src = 'static final Path KIT = Path.of("../kit");\nvoid f(String id) { read(KIT.resolve("newdir").resolve(id)); run("node", KIT.resolve("t/run.mjs").toString()); }';
  assert.deepEqual(ti2(tree, src).map((g) => g.split(' ')[1]), ['kit/t/run.mjs'], 'kit/newdir and the closure sit in the tree; t/ is excluded');
  assert.deepEqual(ti2(`${tree}\ninputs.files("../kit/t/run.mjs")`, src), []);
});

test('(TI2) the tree\'s mod tests: every computed read and every node script\'s closure is declared', () => {
  assert.deepEqual(gradleTestInputGaps(GRADLE, SOURCES, FILES, [], { read: (p) => fs.readFileSync(path.join(ROOT, p), 'utf8') }), []);
});

// (TI2) template steps: a split step's parts (tools/lib/step-split.mjs) run their own `shell` under the parent's set, so the parent's
// roots hold every part's drivers; a driver path the shell computes (`node tools/gate${X}.mjs`) has no static closure and fails the check.
import * as SI from '../../tools/lib/step-inputs.mjs';
const TPL_FILES = new Set(['tools/a.mjs', 'tools/b.mjs', 'tools/lib/c.mjs']);
const TPL_TEXT = { 'tools/a.mjs': '', 'tools/b.mjs': "import './lib/c.mjs';\n", 'tools/lib/c.mjs': '' };
const TPL_CONF = { classes: {}, classRules: {} };
const split = { shell: 'node tools/a.mjs', split: { parts: [{ shell: 'node tools/a.mjs' }, { shell: 'node tools/a.mjs && node tools/b.mjs' }] } };

test('(TI2) a split part\'s own shell: its drivers and their closure are in the parent\'s static set', () => {
  const e = SI.staticEntry('s', split, TPL_CONF, TPL_FILES, { read: (p) => TPL_TEXT[p] ?? '' });
  assert.deepEqual(e.roots, ['tools/a.mjs', 'tools/b.mjs']);
  assert.deepEqual(e.closure, ['tools/a.mjs', 'tools/b.mjs', 'tools/lib/c.mjs']);
});

test('(TI2) a computed driver path in a step or part shell is reported; literal drivers and flag expansions are not', () => {
  assert.equal(typeof SI.computedStepRoots, 'function');
  assert.deepEqual(SI.computedStepRoots({ shell: 'node --test ${GATE_TEST_CONCURRENCY:+--test-concurrency=$GATE_TEST_CONCURRENCY} kit/test/a.test.mjs; node tools/a.mjs --out $OUT/x' }), []);
  assert.deepEqual(SI.computedStepRoots({ shell: 'node tools/gate${PHASE}.mjs unit' }), ['tools/gate${PHASE}.mjs']);
  assert.deepEqual(SI.computedStepRoots({ cmd: ['node', '$DRIVER'] }), ['$DRIVER']);
  assert.deepEqual(SI.computedStepRoots({ shell: 'node tools/a.mjs', split: { parts: [{ shell: 'bash tools/run-$K.sh' }] } }), ['tools/run-$K.sh']);
});

// (TI2, v0.90.0 review P3) a preload a node option takes (--import/--require/-r/--loader) is not the driver: the script after it is.
test('(TI2) a value-taking node option is parsed before the driver: a preload argument is not mistaken for it', () => {
  assert.deepEqual(SI.computedStepRoots({ shell: 'node --import tools/bootstrap.mjs tools/gate${X}.mjs' }), ['tools/gate${X}.mjs']);
  assert.deepEqual(SI.computedStepRoots({ shell: 'node --require tools/b.cjs tools/gate${X}.mjs' }), ['tools/gate${X}.mjs']);
  assert.deepEqual(SI.computedStepRoots({ shell: 'node -r tools/b.cjs --loader tools/l.mjs $DRIVER' }), ['$DRIVER']);
  assert.deepEqual(SI.computedStepRoots({ shell: 'node --import=tools/bootstrap.mjs tools/gate${X}.mjs' }), ['tools/gate${X}.mjs']);
  assert.deepEqual(SI.computedStepRoots({ shell: 'node --import tools/bootstrap.mjs tools/a.mjs' }), []);
  assert.deepEqual(SI.computedStepRoots({ shell: 'node --import tools/hook-${H}.mjs tools/a.mjs' }), ['tools/hook-${H}.mjs'], 'a computed preload is a computed root too');
});

// (TI2, v0.90.0 review P3) a traced directory listing needs the directory rule (an inputs.dir of it or a parent), as the static check.
test('(TI2) a traced directory listing goes red until the directory is declared; single files under it never cover it', () => {
  const t = (body, trace) => tracedTestInputGaps(`test {\n${body}\n}\n`, new Map(trace), TI2_FILES);
  const listing = [['kit/newdir', new Set(['d'])]];
  assert.deepEqual(t('inputs.dir("../kit/lib")', listing), ['kit/newdir']);
  assert.deepEqual(t('inputs.files("../kit/newdir/one.json", "../kit/newdir/two.json")', listing), ['kit/newdir']);
  assert.deepEqual(t('inputs.dir("../kit/newdir")', listing), []);
  assert.deepEqual(t('inputs.dir("../kit")', listing), []);
  assert.deepEqual(t('inputs.files("../kit/newdir/one.json")', [['kit/newdir/one.json', new Set(['r'])]]), [], 'a file read: the file rule');
  assert.deepEqual(t('inputs.dir("../kit/lib")', [['kit/newdir/one.json', new Set(['r'])]]), ['kit/newdir/one.json']);
});
