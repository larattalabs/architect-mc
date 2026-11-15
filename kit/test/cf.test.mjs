// Slice 7c CF (composer feedback), the kit half: a leg no route reaches because a sealed wall ring stands between its ends answers
// UNREACHABLE naming the wall and the fix (closed with no gate part: add a gate part or open the ring; gates 0: give it gates), not
// the generic "no route within the grade ..."; the evidence is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asksSurvey, stewardAnchors, checkPlanLocal, FIX } from './plan-helpers.mjs';

const S = asksSurvey();
const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'k1a', 'sealed.json'), 'utf8'));
const run = (plan) => checkPlanLocal(plan, { survey: S.bytes, claim: S.claim, anchors: stewardAnchors(S.claim), protected: fx.protected ?? [] });
const part = (r, id) => r.check.parts.find((a) => a.part === id);

test('CF: a road through a closed wall ring with no gate part names the ring and the fix', async () => {
  const r = await run(fx.plan);
  const why = part(r, 'in').reasons[0];
  assert.equal(why.code, 'UNREACHABLE');
  assert.match(why.message, /^leg 1: the wall ring w is closed with no gate part, so the route can't leave it; add a gate part \(\{kind: "gate", wall: "w", crossing: "in"\}\) or open the ring/);
  assert.doesNotMatch(why.message, /no route within the grade/);
  assert.deepEqual(why.evidence.walls, [{ wall: 'w', sealed: true, gates: 0, max: 0 }]);
  assert.equal(part(r, 'round').class, 'fits');
});

test('CF: a ring sealed by gates 0 says so; a gate part opens the closed ring', async () => {
  const zero = structuredClone(fx.plan);
  const w = zero.connectors.find((c) => c.id === 'w');
  delete w.where.around.closed;
  w.gates = 0;
  const why = part(await run(zero), 'in').reasons[0];
  assert.equal(why.code, 'UNREACHABLE');
  assert.match(why.message, /the wall ring w is sealed \(gates 0\), so the route can't leave it; give the wall gates/);
  const gated = structuredClone(fx.plan);
  gated.connectors.push({ id: 'g', kind: 'gate', wall: 'w', crossing: 'in' });
  const r = await run(gated);
  assert.notEqual(part(r, 'in').class, 'refused', JSON.stringify(part(r, 'in')));
});
