// Gate base worlds are stamped with a hash of their creation recipe (tools/lib/basestamp.mjs); a reused run dir's older world
// ("G6B Seed Base" made by an earlier creation path) is detected, moved aside (never deleted) and left for the driver to rebuild.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseRecipe, recipeHash, baseStatus, baseCurrent, writeStamp, readStamp, quarantineBase, gateHost, STAMP_FILE, baseSpec, hostBaseName, logicalBaseName } from '../../tools/lib/basestamp.mjs';

const MC = { minecraft: '26.3' };
function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'basestamp-'));
  const saves = path.join(root, 'mod', 'run', 'saves');
  fs.mkdirSync(saves, { recursive: true });
  const world = (name) => { fs.mkdirSync(path.join(saves, name), { recursive: true }); fs.writeFileSync(path.join(saves, name, 'level.dat'), 'x'); };
  return { root, saves, world };
}
const spec = { preset: 'normal', seed: '2026100906' };

test('recipe hash: depends on preset, seed, Minecraft version and the recipe version, not on object order', () => {
  const h = (s, o = MC) => recipeHash(baseRecipe(s, o));
  assert.equal(h(spec), h({ seed: '2026100906', preset: 'normal' }), 'same recipe, same hash');
  assert.equal(h(spec), h({ preset: 'normal', seed: 2026100906 }), 'a numeric seed is the same recipe');
  assert.notEqual(h(spec), h({ preset: 'flat', seed: '2026100906' }));
  assert.notEqual(h(spec), h({ preset: 'normal', seed: '1' }));
  assert.notEqual(h(spec), h(spec, { minecraft: '26.4' }));
  // (housekeeping 3) the host that made it: a headless server's base is another recipe than a client's
  assert.notEqual(h(spec, { ...MC, host: 'client' }), h(spec, { ...MC, host: 'server' }));
  assert.equal(gateHost({}), 'client');
  assert.equal(gateHost({ GATE6B_CLIENT_SCRIPT: 'tools/run-headless-server.mjs' }), 'server');
  assert.equal(gateHost({ GATE6A_CLIENT_SCRIPT: 'tools/run-headless-server.mjs' }), 'server');
  assert.equal(gateHost({ GATE6B_CLIENT_SCRIPT: 'tools/run-gate6b-client.sh' }), 'client');
});

test('status: missing, unstamped (a world from before stamps), current and stale', () => {
  const { saves, world } = run();
  const recipe = baseRecipe(spec, MC);
  assert.equal(baseStatus(saves, 'G6B Seed Base', recipe), 'missing');
  world('G6B Seed Base');
  assert.equal(baseStatus(saves, 'G6B Seed Base', recipe), 'unstamped');
  writeStamp(saves, 'G6B Seed Base', recipe);
  assert.equal(readStamp(saves, 'G6B Seed Base').hash, recipeHash(recipe));
  assert.equal(baseStatus(saves, 'G6B Seed Base', recipe), 'current');
  assert.equal(baseStatus(saves, 'G6B Seed Base', baseRecipe(spec, { minecraft: '26.4' })), 'stale');
});

test('baseCurrent: a current world is kept; an unstamped or stale one is moved aside, not deleted, and reported missing after', () => {
  const { saves, world } = run();
  const logs = [];
  const o = { ...MC, log: (m) => logs.push(m) };
  assert.equal(baseCurrent(saves, 'G6B Seed Base', spec, o), false, 'nothing there: rebuild');
  world('G6B Seed Base');
  assert.equal(baseCurrent(saves, 'G6B Seed Base', spec, o), false, 'unstamped = the stale reused world');
  assert.ok(!fs.existsSync(path.join(saves, 'G6B Seed Base')), 'moved out of saves');
  const stale = path.join(path.dirname(saves), 'saves-stale');
  const kept = fs.readdirSync(stale);
  assert.equal(kept.length, 1);
  assert.ok(kept[0].startsWith('G6B Seed Base-'));
  assert.ok(fs.existsSync(path.join(stale, kept[0], 'level.dat')), 'its files are all still there');
  assert.match(logs[0], /unstamped/);
  // rebuilt by the driver, then stamped: current
  world('G6B Seed Base');
  writeStamp(saves, 'G6B Seed Base', baseRecipe(spec, MC));
  assert.equal(baseCurrent(saves, 'G6B Seed Base', spec, o), true);
  assert.ok(fs.existsSync(path.join(saves, 'G6B Seed Base', STAMP_FILE)));
  // a recipe change makes the same world stale
  assert.equal(baseCurrent(saves, 'G6B Seed Base', spec, { ...o, minecraft: '26.4' }), false);
  assert.match(logs.at(-1), /stale/);
  assert.equal(fs.readdirSync(stale).length, 2, 'a second quarantine does not overwrite the first');
});

test('quarantine refuses anything that is not a G6B world inside saves', () => {
  const { saves, world } = run();
  world('Precious');
  assert.throws(() => quarantineBase(saves, 'Precious'), /refusing/);
  assert.throws(() => quarantineBase(saves, '../outside'), /refusing/);
  assert.ok(fs.existsSync(path.join(saves, 'Precious', 'level.dat')));
});

// (nightly 2026-10-25) a server step and a client step in one run dir each rebuilt the other's 'G6B Seed Base' (11 quarantined copies):
// each host now keeps its own base folder, the server's '<name> Srv', with the same recipe apart from the host
test('one base per host: names, idempotence, specs of either name', () => {
  for (const n of ['G6B Seed Base', 'G6B Flat Base', 'G6B Seed 2026101102']) {
    assert.equal(hostBaseName(n, 'client'), n);
    assert.equal(hostBaseName(n, 'server'), `${n} Srv`);
    assert.equal(hostBaseName(hostBaseName(n, 'server'), 'server'), `${n} Srv`, 'idempotent');
    assert.equal(hostBaseName(`${n} Srv`, 'client'), n, 'a server name asked on a client is the client folder');
    assert.equal(logicalBaseName(`${n} Srv`), n);
    assert.deepEqual(baseSpec(`${n} Srv`), baseSpec(n));
  }
  assert.deepEqual(baseSpec('G6B Seed 2026101102 Srv'), { preset: 'normal', seed: '2026101102' });
  assert.deepEqual(baseSpec('G6B Flat Base'), { preset: 'flat', seed: '2026100906' });
  assert.deepEqual(baseSpec('G6B Seed Base'), { preset: 'normal', seed: '2026100906' });
  assert.equal(baseSpec('G6B Seed Base Srv Srv'), null);
  // not base worlds: unchanged
  for (const n of ['G6B S3 Claim Srv v1', 'G6A Flat Base', 'G6B W Ingame', 'GY2 Base', 'G6B Seed']) {
    assert.equal(hostBaseName(n, 'server'), n);
    assert.equal(baseSpec(n), null);
  }
  assert.equal(hostBaseName('G6B Seed Base', undefined), 'G6B Seed Base', 'host from the environment: a client here');
});

test('one base per host: each host stamps its own folder; neither sees the other stale; the claim worlds keep their recipe hash', () => {
  const { saves, world } = run();
  const logs = [];
  const opt = (host) => ({ ...MC, host, log: (m) => logs.push(m) });
  for (const host of ['server', 'client']) {
    const n = hostBaseName('G6B Seed Base', host);
    assert.equal(baseCurrent(saves, n, spec, opt(host)), false, `${host}: missing`);
    world(n);
    writeStamp(saves, n, baseRecipe(spec, { ...MC, host }));
  }
  for (let round = 0; round < 3; round++) {
    for (const host of ['server', 'client', 'server']) assert.equal(baseCurrent(saves, hostBaseName('G6B Seed Base', host), spec, opt(host)), true, `${host} round ${round}`);
  }
  assert.deepEqual(logs, [], 'nothing moved aside');
  assert.ok(!fs.existsSync(path.join(path.dirname(saves), 'saves-stale')));
  assert.equal(readStamp(saves, 'G6B Seed Base Srv').recipe.host, 'server');
  assert.equal(readStamp(saves, 'G6B Seed Base').recipe.host, 'client');
  // the old shared folder: a server-made world under the client's name is still stale for the client (housekeeping 3)
  assert.equal(baseStatus(saves, 'G6B Seed Base Srv', baseRecipe(spec, { ...MC, host: 'client' })), 'stale');
  // the recipe (what the claim worlds' marks record) is the folder-free spec: renaming moved no hash
  assert.equal(recipeHash(baseRecipe(baseSpec('G6B Seed Base Srv'), { ...MC, host: 'server' })), recipeHash(baseRecipe(spec, { ...MC, host: 'server' })));
});
