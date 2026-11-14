// Phase 7c slice PM (docs/CONTRACT.md "Phase 7c" §3 row 14): the shape-promotion pipeline (tools/promote.mjs, tools/lib/promote.mjs,
// kit/lib/forms/CANDIDATES.md) and its first candidate, archSpan (kit/lib/forms/archSpan.mjs): the lint and its import option, the
// recorded golden on this Node, the properties, the variety numbers, approval and output refusing what they must, r.archSpan, and the
// older IRs that embedded the form before promotion (its ops; its baked voxels) still evaluating to their recorded tiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../../tools/lib/promote.mjs';
import { archSpan, overhangOf, OVERHANG, PROFILES, VERSION, soffit } from '../lib/forms/archSpan.mjs';
import { lintAuthored } from '../lib/plan/authored.mjs';
import { evalTile } from '../lib/realise.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'promote', 'archSpan');
const c = P.candidateOf('archSpan');
const rec = P.readRecord(c);

test('lint: archSpan is clean under AU\'s lint with its own imports; the default lint unchanged; a banned form and a foreign import caught', () => {
  assert.deepEqual(P.stepLint(c).findings, []);
  const src = fs.readFileSync(path.join(P.REPO, c.module), 'utf8');
  // the default (AU's authored programs): no id or default export, and ../noise.mjs is not on AU's list
  const d = lintAuthored(src).map((f) => f.rule);
  assert.ok(d.includes('exports') && d.includes('imports'), JSON.stringify(d));
  const bad = `${src}\nconst q = Math.sin(1) + 2 ** 3;\nimport x from '../sdf.mjs';\n`;
  const f = lintAuthored(bad, { imports: c.imports, exports: false });
  assert.ok(f.some((x) => /Math\.sin/.test(x.message)) && f.some((x) => /\*\*/.test(x.message)) && f.some((x) => x.rule === 'imports'), JSON.stringify(f));
});

test('determinism: this Node\'s 20 shas equal the recorded golden (recorded over 3 runs, two Node majors and Linux)', async () => {
  const d = await P.determinismShas(c);
  assert.ok(rec.steps.determinism?.pass, 'the record has a passing determinism step');
  assert.deepEqual(d.lines, rec.steps.determinism.golden);
  assert.equal(d.all, rec.steps.determinism.all);
  assert.ok(rec.steps.determinism.legs.some((l) => /linux/.test(l.label) && l.ok && l.all === d.all), 'a Linux leg recorded equal');
  assert.ok(rec.steps.determinism.legs.some((l) => /mise/.test(l.label) && l.ok && l.all === d.all), 'the other Node major recorded equal');
});

test('properties: 12 param sets (valleys, both axes, explicit params): bounds, per-tile = whole, M3 and errors clean, S-THEME clean', async () => {
  for (let k = 0; k < 12; k++) {
    const r = await P.propertyCheck(c, k);
    assert.deepEqual(r.bad, [], `set ${k} ${r.params}`);
  }
});

test('generator: no soffit overhangs past M3\'s ledge limit for any profile and any span the layout keeps; same params, same ops', () => {
  for (const profile of PROFILES) for (let S = 3; S <= 40; S++) {
    // the layout raises the bay count while the overhang is past OVERHANG; past S 8 that holds for every profile measured here
    const o = overhangOf(profile, S, 45, 160);
    if (S <= 8) assert.ok(o <= OVERHANG, `${profile} S ${S}: ${o}`);
    for (let t = 0; t < S; t++) assert.ok(Number.isFinite(soffit(profile, S, Math.abs(t + 0.5 - S / 2), 45, 160)));
  }
  for (let k = 0; k < 200; k++) {
    const g = archSpan({ at: [0, 65, 0], length: 12 + (k % 100), width: 3 + (k % 7), seed: `g${k}` });
    for (const T of g.stats.tiers) assert.ok(T.span < 3 || overhangOf(g.params.profile, T.span, g.params.flat, g.params.point) <= OVERHANG, `g${k}: ${JSON.stringify(T)}`);
  }
  const a = archSpan({ at: [3, 70, -2], seed: 'x' }), b = archSpan({ at: [3, 70, -2], seed: 'x' });
  assert.deepEqual(a.ops, b.ops);
  assert.throws(() => archSpan({ at: [0, 0, 0], tiers: 2, height: 8 }), /two tiers/);
  assert.throws(() => archSpan({ at: [0, 0, 0], profile: 'gothic' }), /profile/);
});

test('variety: the recorded sheet\'s numbers (190 pairs, >= 80% under IoU 0.8); a copy of one seed 20 times fails', () => {
  const v = rec.steps.variety;
  assert.ok(v?.pass);
  assert.equal(v.pairs, 190);
  assert.ok(v.below / v.pairs >= P.IOU_SHARE, `${v.below}/${v.pairs}`);
  const s = new Uint8Array(100).fill(1);
  assert.equal(P.varietyOf(Array.from({ length: 20 }, () => s)).pass, false);
  const a = new Uint8Array([1, 1, 0, 0]), b = new Uint8Array([1, 0, 1, 0]);
  assert.equal(P.iou(a, b), 1 / 3);
});

test('approval refuses another sheet, a missing --by and a no without reasons; records who, when and the sheet\'s sha', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const fake = path.join(tmp, 'sheet.png');
  fs.writeFileSync(fake, 'not the sheet');
  const r = structuredClone(rec);
  assert.throws(() => P.approve(r, { sheet: fake, by: 'Noah', at: 't' }), /not the recorded sheet/);
  // a file with the recorded bytes' sha: write the recorded sheet if it is on this machine, else skip this half
  const real = path.join(path.dirname(path.dirname(P.REPO)), 'architect-mc', 'artifacts', 'promote', 'archSpan', 'sheet.png');
  const sheet = [real, rec.steps.variety?.sheet].find((f) => f && fs.existsSync(f));
  if (sheet) {
    if (P.sha256Of(fs.readFileSync(sheet)) === rec.steps.variety.sheetSha) {
      assert.throws(() => P.approve(structuredClone(rec), { sheet, by: '', at: 't' }), /--by/);
      assert.throws(() => P.approve(structuredClone(rec), { sheet, by: 'Noah', at: 't', yes: false }), /reasons/);
      const ok = P.approve(structuredClone(rec), { sheet, by: 'Noah', at: '2026-11-14T00:00:00Z', via: 'test' });
      assert.deepEqual(ok.steps.approval, { pass: true, by: 'Noah', at: '2026-11-14T00:00:00Z', sheetSha: rec.steps.variety.sheetSha, via: 'test' });
    }
  }
  fs.rmSync(tmp, { recursive: true });
});

test('output refuses until every earlier step passed (approval included); stamps the semver on a copy', () => {
  const r = structuredClone(rec);
  delete r.steps.approval;
  assert.throws(() => P.output(c, r, '1.0.0'), /approval/);
  assert.throws(() => P.output(c, structuredClone(rec), '1.0'), /semver/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const file = path.join(tmp, 'm.mjs');
  fs.writeFileSync(file, "export const VERSION = '0.1.0';\n");
  const steps = Object.fromEntries(P.STEPS.slice(0, -1).map((s) => [s, { pass: true }]));
  const out = P.output({ module: path.relative(P.REPO, file) }, { steps }, '1.0.0');
  assert.equal(fs.readFileSync(file, 'utf8'), "export const VERSION = '1.0.0';\n");
  assert.equal(out.steps.output.from, '0.1.0');
  fs.rmSync(tmp, { recursive: true });
});

test('r.archSpan: a form part recorded in ir.forms (generator archSpan, the module\'s VERSION), seeded from the plan when no seed is given', async () => {
  const p = { at: [0, 65, 0], length: 40, width: 5 };
  const a = await P.planForm(c, { ...p, seed: 'r1' });
  const f = a.plan.ir.forms.find((x) => x.id === 'f');
  assert.equal(f.generator, 'archSpan');
  assert.equal(f.version, VERSION);
  assert.equal(a.gen.seed, 'r1');
  const b = await P.planForm(c, p), b2 = await P.planForm(c, p);
  assert.equal(b.gen.seed, b2.gen.seed, 'the program seed is deterministic');
  assert.match(b.gen.seed, /^[0-9a-f]{16}$/);
});

for (const file of ['pre-ops.json', 'pre-baked.json']) {
  test(`older IRs: ${file} (archSpan before promotion) evaluates to its recorded tiles, and today's module plans the same tiles`, async () => {
    const fx = JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8'));
    assert.equal(fx.version, '0.1.0', 'the fixture was written before promotion');
    const survey = P.surveyOf(fx.claim, { valley: fx.valley, axis: fx.params.axis ?? 'x' });
    const blobs = (sha) => (fx.blobs[sha] ? new Uint8Array(Buffer.from(fx.blobs[sha], 'base64')) : null);
    const t = P.tileEval(fx.ir, survey, blobs);
    assert.deepEqual(t.shas, fx.tiles, 'the old IR evaluates as it did');
    assert.equal(t.cells.size, fx.cells);
    if (file === 'pre-baked.json') assert.deepEqual(fx.ir.parts[0].ops.map((o) => o.op), ['voxels']);
    else assert.ok(fx.ir.parts[0].ops.every((o) => o.op === 'columns'));
    const now = await P.planForm(c, fx.params, { valley: fx.valley, bake: file === 'pre-baked.json' });
    assert.deepEqual(P.tileEval(now.plan.ir, now.survey, now.blobs).shas, fx.tiles, 'today\'s module: the same tiles');
    assert.ok(typeof evalTile === 'function');
  });
}
