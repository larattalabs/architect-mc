// The water lint's W5 (kit/lint/water.mjs): the drain cases the mod's RegionFluidsLintTest reads are what drainCases() generates today
// (a change to the fluid model regenerates them: node kit/lint/water.mjs --write), and the attribution is a partition of the flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DRAIN_CASES, drainCases, drainCasesJson, fedBy } from './water.mjs';
import { mapWorld } from '../lib/fluids/sim.mjs';

test('W5: the committed drain cases equal the generated ones', () => {
  assert.equal(fs.readFileSync(DRAIN_CASES, 'utf8'), drainCasesJson(), 'regenerate with node kit/lint/water.mjs --write');
});

test('W5: what this source fed: own-only, raised, joint and foreign-only cover the flow; a foreign feeder takes cells out of own-only', () => {
  const cs = drainCases();
  const by = Object.fromEntries(cs.map((c) => [c.name, c]));
  assert.ok(by['breach/bare'].ownOnly.length > 50 && by['breach/bare'].never.length === 0, 'a bare breach: all of its flow is its own');
  for (const n of ['breach/pond', 'breach/player-bucket', 'breach/pond-and-player', 'breach/other-body']) {
    assert.ok(by[n].never.length > 0 && by[n].ownOnly.length < by['breach/bare'].ownOnly.length + 40, `${n}: foreign water spares cells`);
    const never = new Set(by[n].never.map(String));
    assert.ok(by[n].ownOnly.every((c) => !never.has(String(c))), `${n}: own-only and never are disjoint`);
  }
  // the partition on a small world: a source feeding a 1-wide channel, a foreign source half way
  const ch = new Map();
  for (let x = 1; x <= 12; x++) ch.set(`${x},64,0`, 'open');
  const at = (x, y, z) => ch.get(`${x},${y},${z}`) ?? 'stop';
  const f = fedBy(at, [[0, 64, 0]], [[6, 64, 0]]);
  // foreign water alone reaches the whole channel: 1 and 2 stand higher for the own source (raised: its flow), 3 on at the foreign level
  assert.deepEqual([[...f.ownOnly], [...f.raised].sort(), f.joint.has('3,64,0'), f.joint.has('7,64,0')], [[], ['1,64,0', '2,64,0'], true, true]);
  assert.deepEqual([...fedBy(mapWorld(new Map(), () => 'stop').at, [[0, 0, 0]], []).ownOnly], []);
});
