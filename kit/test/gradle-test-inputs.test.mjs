// (TI) tools/lib/gradle-test-inputs.mjs: the literal kit/ and scenarios/ paths the mod's Java tests name against mod/build.gradle's test
// inputs (`node tools/step-inputs.mjs check`). A directory read needs an inputs.dir of it or a parent (v0.89.0 review P3).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { declaredTestInputs, gradleTestInputGaps, literalTestPaths } from '../../tools/lib/gradle-test-inputs.mjs';

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
