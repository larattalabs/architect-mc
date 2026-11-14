// (7c AU) Authored programs, the kit's half (docs/CONTRACT.md "Phase 7c" §3 row 13, "Slice AU as built"): the lint every authored source
// passes (the realise lint's banned forms plus the plan-path rules, and the evasions a static lint must not miss), the sha, staging, the
// plan compile's dispatch (a zone {template: authored, params: {id, sha, params}}: fits over the whole claim, AUTHORED_STALE on a moved
// sha, NO_PROGRAM when none is installed), the artifact's authored member, and the author-check CLI (a clean round, a checker finding).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintAuthored, authoredSha, stageAuthored, loadAuthoredDir, authoredRef, AUTHORED_IMPORTS } from '../lib/plan/authored.mjs';
import { checkPlanLocal, goldenSurvey, FIX } from './plan-helpers.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AU = path.join(KIT, 'test', 'fixtures', 'au');
const COURT = fs.readFileSync(path.join(AU, 'courtyard.mjs'), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'au-'));
const rules = (src) => lintAuthored(src).map((f) => f.rule);
const lintMsgs = (src) => lintAuthored(src).map((f) => f.message).join(' | ');
const wrap = (body) => `import { region } from '../lib/region/program.mjs';\nexport const id = 'x';\nexport default function (ctx) {\n${body}\nreturn region(ctx);\n}\n`;

test('lint: the fixture programs are clean; the banned forms are each found (trig, **, Date, Math.random, clocks, timers, process)', () => {
  assert.deepEqual(lintAuthored(COURT), []);
  assert.deepEqual(lintAuthored(fs.readFileSync(path.join(AU, 'courtyard_floating.mjs'), 'utf8')), []);
  const banned = {
    trig: 'const a = Math.sin(1);', pow: 'const a = Math.pow(2, 3);', exp: 'const a = 2 ** 3;', expAssign: 'let a = 2; a **= 2;', date: 'const a = Date.now();',
    newDate: 'const a = new Date();', random: 'const a = Math.random();', perf: 'const a = performance.now();', timeout: 'setTimeout(() => 0, 1);',
    interval: 'setInterval(() => 0, 1);', immediate: 'setImmediate(() => 0);', micro: 'queueMicrotask(() => 0);', process: 'process.kill(1);', exit: 'process.exit(0);',
    hrtime: 'process.hrtime();', fetch: 'fetch("http://x");', require: 'const fs = require("fs");',
  };
  for (const [k, body] of Object.entries(banned)) assert.ok(rules(wrap(body)).includes('lint'), `${k}: ${lintMsgs(wrap(body))}`);
});

test('lint: the evasions (template expressions, computed members, dynamic code, reflection, escapes, dynamic import) are found', () => {
  const ev = {
    tplExpr: 'const s = `${Math.sin(1)}`;', tplNested: 'const s = `a${`b${Math.cos(2)}`}c`;', computedMath: "const f = Math['sin'];", mathAlias: 'const M = Math; M.sin(1);',
    globalThis: "globalThis['pro' + 'cess'];", eval: '(0, eval)("1");', fn: 'new Function("return 1")();', ctor: '(() => 0).constructor("return process")();',
    ctorString: "({})['constructor'];", proto: '({}).__proto__;', reflect: 'Reflect.get({}, "a");', proxy: 'new Proxy({}, {});', dynImport: 'import("node:fs");',
    importMeta: 'const u = import.meta.url;', unicodeEsc: 'const a = \\u0070rocess;', unicodeId: 'const é = 1;', regex: 'const r = /a/.test("a");', with: 'with ({}) {}',
    wasm: 'WebAssembly.compile(new Uint8Array(0));', sab: 'new SharedArrayBuffer(8);', buffer: 'Buffer.from("a");',
  };
  for (const [k, body] of Object.entries(ev)) assert.ok(lintAuthored(wrap(body)).length > 0, `${k} passed the lint`);
});

test('lint: imports are the closed list only; exports, size and encoding', () => {
  for (const spec of AUTHORED_IMPORTS) assert.deepEqual(lintAuthored(`import * as m from '${spec}';\nexport const id = 'x';\nexport default function () {}\n`), [], spec);
  for (const spec of ['node:fs', 'fs', 'node:child_process', '../lib/region/check.mjs', '../../package.json', 'file:///etc/passwd', '../lib/../../x.mjs']) {
    assert.ok(rules(`import x from '${spec}';\nexport const id = 'x';\nexport default function () {}\n`).includes('imports'), spec);
  }
  assert.ok(rules("export { region } from '../lib/region/program.mjs';\nexport const id = 'x';\nexport default function () {}\n").includes('imports'));
  assert.ok(rules("export * from '../lib/region/program.mjs';\nexport const id = 'x';\nexport default function () {}\n").includes('lint'));
  assert.deepEqual(rules('const a = 1;\n').sort(), ['exports', 'exports']);
  assert.ok(rules(`${COURT}\n// ${'x'.repeat(262144)}`).includes('size'));
  assert.deepEqual(rules(`${COURT}\nconst s = '\uD800';\n`), ['encoding'], 'a lone surrogate');
  assert.ok(rules(`${COURT}\nconst s = '\`;`).includes('lint'), 'an unterminated string is a finding, not a throw');
  // comments and string contents never trip it
  assert.deepEqual(lintAuthored(`${COURT}\n// Math.sin, Date, process, 2 ** 3\nconst msg = 'no Math.cos ** here';\n`), []);
});

test('sha, staging and the loader: the exact bytes hashed; kit imports pointed at this kit; a dirty or broken program is a problem, not a throw', async () => {
  assert.equal(authoredSha(COURT), authoredSha(Buffer.from(COURT, 'utf8')));
  const staged = stageAuthored(COURT, KIT);
  assert.ok(staged.includes(JSON.stringify(`file://${path.join(KIT, 'lib', 'region', 'program.mjs')}`)), 'the import is the kit file');
  assert.ok(!staged.includes("'../lib/region/program.mjs'"));
  const d = tmp();
  fs.writeFileSync(path.join(d, 'au_courtyard.mjs'), COURT);
  fs.writeFileSync(path.join(d, 'au_dirty.mjs'), wrap('const a = Math.sin(1);'));
  fs.writeFileSync(path.join(d, 'au_broken.mjs'), wrap('}}'));
  const m = await loadAuthoredDir(d, KIT);
  assert.equal(m.get('au_courtyard').sha, authoredSha(COURT));
  assert.equal(typeof m.get('au_courtyard').module.default, 'function');
  assert.match(m.get('au_dirty').problem, /^lint: Math\.sin/);
  assert.equal(m.get('au_broken').module, null);
  assert.ok(m.get('au_broken').problem);
  assert.deepEqual(authoredRef({ template: 'authored', params: { id: 'a', sha: 'f'.repeat(64) } }), { id: 'a', sha: 'f'.repeat(64), params: {} });
  assert.equal(authoredRef({ template: 'authored', params: { id: 'A', sha: 'x' } }).error.path, '$.program.params.id');
});

const planOf = (sha, extra = {}) => ({ schemaVersion: 'plan/0', zones: [{ id: 'court', program: { template: 'authored', params: { id: 'au_courtyard', sha, params: { size: 12 } } } }], ...extra });

test('plan: an installed authored program fits over the whole claim; the artifact freezes {part, id, sha}; a moved sha refuses AUTHORED_STALE; none installed NO_PROGRAM', async () => {
  const { bytes, claim } = goldenSurvey('s7');
  const d = tmp();
  fs.writeFileSync(path.join(d, 'au_courtyard.mjs'), COURT);
  const authored = await loadAuthoredDir(d, KIT);
  const sha = authoredSha(COURT);
  const ok = await checkPlanLocal(planOf(sha), { survey: bytes, claim, authored });
  const a = ok.check.parts.find((p) => p.part === 'court');
  assert.equal(a.class, 'fits', JSON.stringify(a.reasons));
  assert.equal(ok.check.overall, 'READY');
  assert.deepEqual(ok.artifact.authored, [{ part: 'court', id: 'au_courtyard', sha }]);
  assert.ok(ok.res.ir.lots.some((l) => l.id === 'lot_1'), 'the program wrote its lot');
  // the same check twice: the same artifact (deterministic)
  const again = await checkPlanLocal(planOf(sha), { survey: bytes, claim, authored: await loadAuthoredDir(d, KIT) });
  assert.equal(again.artifactSha, ok.artifactSha);
  const stale = await checkPlanLocal(planOf('0'.repeat(64)), { survey: bytes, claim, authored });
  const s = stale.check.parts.find((p) => p.part === 'court');
  assert.equal(s.class, 'refused');
  assert.equal(s.reasons[0].code, 'AUTHORED_STALE');
  assert.equal(s.reasons[0].evidence.sha, sha);
  assert.equal(stale.artifact?.authored, undefined, 'a refused authored zone freezes nothing');
  // e19 (moved from extension/): no authored program installed
  const e19 = JSON.parse(fs.readFileSync(path.join(FIX, 'au', 'e19_authored_program.json'), 'utf8'));
  const g = goldenSurvey(e19.on);
  const none = await checkPlanLocal(e19.plan, { survey: g.bytes, claim: g.claim });
  const n = none.check.parts.find((p) => p.part === e19.expect.part);
  assert.deepEqual([n.class, n.reasons[0].code], [e19.expect.class, e19.expect.code]);
  // the sole-zone rule: a second whole-claim zone refuses OVERLAP, as every whole-claim program does
  const two = planOf(sha, {});
  two.zones.push({ id: 'court_2', program: two.zones[0].program });
  const t = await checkPlanLocal(two, { survey: bytes, claim, authored });
  assert.deepEqual(t.check.parts.map((p) => [p.part, p.class, p.reasons?.[0]?.code ?? null]), [['court', 'fits', null], ['court_2', 'refused', 'OVERLAP']], JSON.stringify(t.check.malformed ?? null));
});

test('author-check CLI: a clean round answers no findings; a floating court the checker\'s M3 finding; a lint failure never runs the program', () => {
  const d = tmp();
  const survey = path.join(d, 'survey.bin');
  execFileSync(process.execPath, [path.join(KIT, 'tools', 'region.mjs'), 'synth', '--box', '0,0,95,95', '--out', survey]);
  const run = (file) => JSON.parse(execFileSync(process.execPath, [path.join(KIT, 'tools', 'region.mjs'), 'author-check', file, '--survey', survey, '--claim', '0,0,95,95,-64,320', '--out', fs.mkdtempSync(path.join(d, 'o-')), '--json'], { encoding: 'utf8' }).trim().split('\n').pop());
  const clean = run(path.join(AU, 'courtyard.mjs'));
  assert.deepEqual(clean.findings, []);
  assert.equal(clean.sha, authoredSha(COURT));
  const floating = run(path.join(AU, 'courtyard_floating.mjs'));
  assert.deepEqual(floating.findings.map((f) => f.rule), ['check:M3']);
  const dirty = path.join(d, 'dirty.mjs');
  fs.writeFileSync(dirty, wrap("throw new Error('ran'); const a = Math.atan2(1, 2);"));
  const r = run(dirty);
  assert.equal(r.findings[0].rule, 'lint');
  assert.equal(r.irSha, undefined, 'never planned');
});
