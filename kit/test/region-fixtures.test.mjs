// Phase 6b gate item 2: the family fixtures' checker reports equal their expected reports (which rules fire, at what
// severity, on which parts, and why), and every broken variant (CONTRACT 6b §9) is caught by its rule on the named part.
// Gate item 3: M2 and M3 hold on every stage prefix of walled_hill, and the prefix total is at most 2x one full check.
// Regenerate an expected report (keeping the written reasons): UPDATE_EXPECTED=1 node --test kit/test/region-fixtures.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { synthSurvey } from '../lib/region/synth.mjs';
import { makeColumns, FLAG_WATER } from '../lib/region/pack.mjs';
import { checkRegion } from '../lib/region/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures', 'regions');

/** The family fixtures: program, claim size, synthetic survey seed, params (defaults). */
export const FAMILIES = {
  crater_works: { size: 200, seed: 'fixture' },
  sky_isle: { size: 240, seed: 'fixture' },
  rift_city: { size: 256, seed: 'fixture' },
  walled_hill: { size: 200, seed: 'fixture' },
};

export function claimOf(size) { const h = size / 2; return { minX: -h, minZ: -h, maxX: h - 1, maxZ: h - 1, minY: -64, maxY: 319 }; }

export async function planFixture(id, o = FAMILIES[id]) {
  const claim = claimOf(o.size);
  const survey = o.survey ?? synthSurvey(claim, o.seed);
  const p = await planRegion({ programFile: o.file ?? path.join(KIT, 'regions', `${id}.mjs`), survey, claim, params: o.params ?? {}, node: 'golden' });
  return { p, survey, claim };
}

const key = (f) => `${f.rule}|${f.severity}|${f.part ?? '-'}`;

for (const id of Object.keys(FAMILIES)) {
  test(`family fixture ${id}: the report equals its expected report`, async () => {
    const { p, survey } = await planFixture(id);
    const r = checkRegion({ ir: p.ir, survey, blobs: p.blobs, meta: p.meta });
    const got = [...new Set(r.findings.map(key))].sort();
    const file = path.join(FIX, `${id}.expected.json`);
    if (process.env.UPDATE_EXPECTED === '1') {
      const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { findings: [] };
      const reasons = Object.fromEntries(old.findings.map((f) => [key(f), f.reason]));
      const findings = got.map((k) => { const [rule, severity, part] = k.split('|'); return { rule, severity, part: part === '-' ? null : part, reason: reasons[k] ?? 'TODO' }; });
      fs.writeFileSync(file, `${JSON.stringify({ program: id, claim: FAMILIES[id].size, seed: FAMILIES[id].seed, errors: r.errors, findings }, null, 1)}\n`);
    }
    const exp = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(got, exp.findings.map(key).sort(), `${id}: rules that fire`);
    for (const f of exp.findings) assert.ok(f.reason && f.reason !== 'TODO', `${id}: ${key(f)} has a reason`);
    assert.equal(r.errors, exp.errors, `${id}: errors`);
    // no M1-M4 findings on any family fixture (the crater gate's must-pass rules)
    assert.deepEqual(r.findings.filter((f) => /^M[1-4]\b/.test(f.rule)).map(key), [], `${id}: no M1-M4 findings`);
  });
}

// ---- broken variants

function lakeSurvey(claim) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const c = makeColumns(claim.minX, claim.minZ, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const k = i + j * W;
    if (i < 24) { c.ground[k] = 63; c.height[k] = 63; c.floor[k] = 57; c.flags[k] = FLAG_WATER; } else { c.ground[k] = 64; c.height[k] = 64; c.floor[k] = 64; }
  }
  return c;
}

const BROKEN = [
  { file: 'lot_no_path', rule: 'M2', part: 'plinth' },
  { file: 'lake_carve', rule: 'M4', part: 'pit', survey: lakeSurvey },
  { file: 'floating_spur', rule: 'M3:floating_spur', part: 'isle' },
  { file: 'dark_cavern', rule: 'M5', part: 'cave' },
  { file: 'long_span', rule: 'M10', part: 'span' },
  { file: 'steep_stair', rule: 'M7', part: 'steep' },
  { file: 'ends_in_air', rule: 'M10', part: 'deck' },
  { file: 'outside_claim', rule: 'M1', part: 'overhang', severity: 'error' },
  { file: 'plain', rule: 'M14', part: 'mound', severity: 'error', doctor: (ir) => { ir.parts[ir.parts.findIndex((p) => p.id === 'cairn')].id = 'mound'; } },
  { file: 'plain', rule: 'M13', part: 'mound', severity: 'error', doctor: (ir) => { ir.parts.find((p) => p.id === 'mound').ops[0].material = 'minecraft:not_a_block'; } },
];

for (const b of BROKEN) {
  test(`broken variant ${b.file}${b.doctor ? ` (${b.rule})` : ''}: ${b.rule} on part ${b.part}`, async () => {
    const claim = claimOf(96);
    const survey = b.survey ? b.survey(claim) : synthSurvey(claim, 'broken');
    const p = await planRegion({ programFile: path.join(FIX, 'broken', `${b.file}.mjs`), survey, claim, node: 'golden' });
    const ir = structuredClone(p.ir);
    if (b.doctor) b.doctor(ir);
    let r;
    if (b.rule === 'M13') r = checkRegion({ ir, survey, blobs: p.blobs, meta: p.meta, rules: ['M13'] });
    else r = checkRegion({ ir, survey, blobs: p.blobs, meta: p.meta });
    const hit = r.findings.find((f) => f.rule === b.rule && f.part === b.part);
    assert.ok(hit, `${b.rule} on ${b.part}: got ${JSON.stringify(r.findings.map((f) => `${f.rule}/${f.part}`))}`);
    if (b.severity) assert.equal(hit.severity, b.severity);
  });
}

test('prefix checks: M2 and M3 hold on every stage prefix of walled_hill; the prefixes cost at most 2x one full check', async () => {
  const { p, survey } = await planFixture('walled_hill');
  // warm the evaluator, then time a full check with prefixes and one without
  checkRegion({ ir: p.ir, survey, blobs: p.blobs, meta: p.meta, prefix: false });
  const t0 = performance.now();
  const full = checkRegion({ ir: p.ir, survey, blobs: p.blobs, meta: p.meta, prefix: false });
  const tFull = performance.now() - t0;
  const r = checkRegion({ ir: p.ir, survey, blobs: p.blobs, meta: p.meta, prefix: true });
  assert.ok(r.prefix.length >= 3, `prefixes checked: ${r.prefix.map((x) => x.stage)}`);
  for (const x of r.prefix) {
    assert.deepEqual(x.M2.unreachable, [], `M2 holds after stage ${x.stage}`);
    assert.equal(x.M3.floatingCells, 0, `M3 holds after stage ${x.stage}`);
    assert.equal(x.M3.spurs, 0, `no floating spur after stage ${x.stage}`);
  }
  console.log(`# walled_hill: full check ${tFull.toFixed(0)} ms (rules ${JSON.stringify(full.ms.perRule)}), prefixes ${r.ms.prefix} ms over ${r.prefix.length} prefixes`);
  assert.ok(r.ms.prefix <= 2 * tFull, `prefixes ${r.ms.prefix} ms <= 2 x full ${tFull.toFixed(0)} ms`);
});
