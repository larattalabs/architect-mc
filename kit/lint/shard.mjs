// The water lint's corpus tests (kit/lint/water.mjs), one shard of N: node --test runs each shard file in its own process, in parallel
// (the planning is the cost: about 170 s serial over the corpus on a quiet box, so 9 shards). WATER_LINT_FULL=1 (the release tier) breaches every shell
// cell; otherwise every non-trivial one up to 400 per body (all of them in the corpus today).
import test from 'node:test';
import assert from 'node:assert/strict';
import { corpus, planEntry, lintPlanned } from './water.mjs';

/** The corpus entries that are broken on purpose and the checker rules (or lint rules) each must raise. */
export const BROKEN = Object.freeze({
  'irr/u01_unmasked.json': ['M25:clear'],
  'irr/u02_nobed.json': ['M25:shell', 'M25:leak'],
  'irr/u03_breach_out.json': ['M25:keep', 'W3:irr'], // IRR's broken side: the lint's own breach rule names it too
  // (batch v0.41.0) the batch's broken variants with a body, the ones kc-unit names too (tools/lib/gate6ckc-kit.mjs)
  'f3/u01_tree_in_body.json': ['M25:clear'], // F3: a grown tree in a plan body
  'f3/u04_coral_other_part.json': ['M25:clear'], // F3: coral written by another part
  'fl/u03_zone_ignores_body.json': ['M25:clear'], // FL: a free zone's street through a body
});

export function runShard(i, n) {
  const full = process.env.WATER_LINT_FULL === '1';
  const all = corpus();
  for (const [k, e] of all.entries()) {
    if (k % n !== i) continue;
    test(`water lint: ${e.name}`, async () => {
      const p = await planEntry(e);
      const r = lintPlanned({ ...p, name: e.name }, { full });
      const errs = r.checker.filter((f) => f.severity === 'error');
      const raised = new Set([...errs.map((f) => f.rule), ...r.findings.map((f) => f.rule)]);
      const want = e.rules ?? BROKEN[e.name] ?? (e.fx?.expect?.clearRule ? ['M25:clear'] : null);
      if (want) {
        for (const rule of want) assert.ok(raised.has(rule), `${e.name}: broken on purpose, ${rule} must be raised (raised: ${[...raised].join(', ') || 'nothing'})`);
        return;
      }
      const code = e.fx?.expect?.code;
      if (code && p.overall !== 'READY') {
        const codes = new Set(p.answers.flatMap((a) => (a.reasons ?? []).map((q) => q.code)));
        assert.ok(codes.has(code), `${e.name}: answered ${code} (answers: ${[...codes].join(', ')})`);
      }
      // every body the plan emits: contained (M25, M20 clean), census == prediction, the settle bound, the breach sweep
      assert.deepEqual(errs.map((f) => `${f.rule}: ${f.message}`), [], `${e.name}: the checker's M25/M20`);
      assert.deepEqual(r.findings.map((f) => `${f.rule} ${f.body}: ${f.message}`), [], `${e.name}: the water lint`);
      assert.equal(r.breaches.skipped, 0, `${e.name}: every non-trivial breach run (${JSON.stringify(r.breaches)})`);
    });
  }
}
