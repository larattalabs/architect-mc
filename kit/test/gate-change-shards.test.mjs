// Shards for shared change and slice runs (tools/lib/change-shards.mjs; docs/GATES.md "Slice GX as built"): when it applies, the
// ports derived from the run's one --ports pair (never into the turbo range or 8892-8895), the prefix of usable pairs, and the
// choice of in-game shards and offline lanes from the schedule.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { CHANGE_DEFAULTS, changeApplies, changeConfig, chooseChange, derivePairs, describeChange, forbiddenPort, usablePairs } from '../../tools/lib/change-shards.mjs';

const cc = { ...CHANGE_DEFAULTS };

test('applies to a shared change/slice of more than minSteps with one --ports pair, and nowhere else', () => {
  const base = { chain: 'change', turbo: false, shardsArg: undefined, steps: 30, portsGiven: 1 };
  assert.equal(changeApplies(cc, base).on, true);
  assert.equal(changeApplies(cc, { ...base, chain: 'slice' }).on, true);
  assert.equal(changeApplies(cc, { ...base, chain: 'release' }).on, false, 'release judges timing: no nice\'d lanes there');
  assert.equal(changeApplies(cc, { ...base, chain: 'quick' }).on, false);
  assert.equal(changeApplies(cc, { ...base, turbo: true }).on, false);
  assert.equal(changeApplies(cc, { ...base, shardsArg: '1' }).on, false, '--shards N is taken as given');
  assert.equal(changeApplies(cc, { ...base, steps: 10 }).on, false);
  assert.equal(changeApplies(cc, { ...base, steps: 11 }).on, true);
  assert.equal(changeApplies(cc, { ...base, portsGiven: 0 }).on, false, 'no base pair: one shard, as before');
  assert.equal(changeApplies(cc, { ...base, portsGiven: 3 }).on, false, 'several pairs named: used as given');
  assert.deepEqual(changeConfig({ shards: { change: { minSteps: 4 } } }).minSteps, 4);
});

test('derived ports: pair, pair+2, pair+4; never into the turbo range or 8892-8895; no overlap', () => {
  assert.deepEqual(derivePairs([8904, 8905], 3), [[8904, 8905], [8906, 8907], [8908, 8909]]);
  assert.deepEqual(derivePairs([8904, 8905], 3, { stride: 10 }), [[8904, 8905], [8914, 8915], [8924, 8925]]);
  assert.throws(() => derivePairs([8936, 8937], 3), /turbo range/, '8940 would be derived');
  assert.throws(() => derivePairs([8888, 8889], 3), /8892-8895/);
  assert.throws(() => derivePairs([8904, 8905], 3, { stride: 1 }), /overlap/);
  assert.ok(forbiddenPort(8940) && forbiddenPort(8999) && forbiddenPort(8893) && !forbiddenPort(8939) && !forbiddenPort(8909));
});

test('usable pairs are a prefix: a pair another live run recorded, or one that will not bind, ends the list', async () => {
  const pairs = [[8906, 8907], [8908, 8909]];
  assert.deepEqual(await usablePairs(pairs, { canBind: async () => true }), pairs);
  assert.deepEqual(await usablePairs(pairs, { taken: new Set([8907]), canBind: async () => true }), []);
  assert.deepEqual(await usablePairs(pairs, { taken: new Set([8908]), canBind: async () => true }), [[8906, 8907]]);
  assert.deepEqual(await usablePairs(pairs, { canBind: async (p) => p !== 8909 }), [[8906, 8907]]);
  // a real bound port
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  assert.deepEqual(await usablePairs([[p, p + 1]]), []);
  srv.close();
});

// a schedule model: in-game minutes spread over n shards, offline minutes over the lanes (or the shards when there are none)
const wall = ({ game, offline, longest = 0 }) => (n, lanes) => Math.max(longest, lanes ? Math.max(game / n, offline / lanes) : (game + offline) / n);

test('the choice: the fewest workers within planSlack of the best wall; lanes take the unit steps; caps hold', () => {
  // unit-heavy (SA's change run: 25 offline steps, 5 in-game): lanes pay, a second in-game shard doesn't
  let c = chooseChange(cc, { wallFor: wall({ game: 40, offline: 200 }), offline: 25, game: 5, pairs: 3, probe: { freeGB: 80 } });
  assert.deepEqual([c.n, c.lanes], [1, 2]);
  // in-game heavy: two in-game shards (maxGame 2), the third pair a lane
  c = chooseChange(cc, { wallFor: wall({ game: 200, offline: 60 }), offline: 6, game: 20, pairs: 3, probe: { freeGB: 80 } });
  assert.deepEqual([c.n, c.lanes], [2, 1]);
  assert.ok(c.bound.some((b) => /pairs|maxGame/.test(b)));
  // nothing gains (one long step dominates): one shard, no lanes
  c = chooseChange(cc, { wallFor: wall({ game: 20, offline: 20, longest: 90 }), offline: 5, game: 6, pairs: 3, probe: { freeGB: 80 } });
  assert.deepEqual([c.n, c.lanes], [1, 0]);
  assert.deepEqual(c.bound, ['plan']);
  // only one usable pair: one shard
  c = chooseChange(cc, { wallFor: wall({ game: 200, offline: 200 }), offline: 10, game: 10, pairs: 1, probe: { freeGB: 80 } });
  assert.deepEqual([c.n, c.lanes], [1, 0]);
  // memory: room for one shard only, no lane
  c = chooseChange(cc, { wallFor: wall({ game: 200, offline: 200 }), offline: 10, game: 10, pairs: 3, probe: { freeGB: 9 } });
  assert.deepEqual([c.n, c.lanes], [1, 0]);
  // all offline: no lanes (they run beside in-game shards), the steps take the shards
  c = chooseChange(cc, { wallFor: wall({ game: 0, offline: 200 }), offline: 12, game: 0, pairs: 3, probe: { freeGB: 80 } });
  assert.equal(c.lanes, 0);
  assert.ok(c.n + c.lanes <= 3);
  assert.match(describeChange(c, cc, [[8904, 8905], [8906, 8907], [8908, 8909]]), /one slot for the run/);
});
