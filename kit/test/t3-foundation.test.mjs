// Phase 6c slice T3, the shared foundation (docs/CONTRACT.md "Phase 6c slice T3" §1, §2, §4, §7, §11; T3a and T3b build on it):
// catalogue 6 and its diff from K1's, the special-move table's bridge and tunnel rows, `profile`'s signed sag, the bible's bridge and
// tunnel roles, the validator's R18 (the drawbridge block) and R8 checks, R19's lenient via (a tunnel with via validates).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './plan-helpers.mjs';
import { SPECIAL_MOVES, onceOf } from '../lib/region/passes/route.mjs';
import { profile, sagOf, maxStep } from '../lib/connectors/ropeGeom.mjs';
import { connectorRoles, connectorsError } from '../lib/connectors/style.mjs';
import { diffCatalogues, planCatalogue, PLAN_API } from '../lib/plan/catalogue.mjs';
import { validatePlan, PLAN_SCHEMA } from '../lib/plan/schema.mjs';
import { resolveRoles } from '../lib/region/plan.mjs';
import { T3_KINDS, FALLBACK_KINDS } from '../lib/connectors/t3kinds.mjs';

const FIX = path.join(ROOT, 'kit', 'test', 'fixtures', 'plan');

test('catalogue 6: the golden, and the K1 -> T3 diff is exactly the two flips, auto\'s moves and the six added ids', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  assert.equal(golden.catalogueVersion, 6);
  assert.equal(golden.api, PLAN_API);
  const k1 = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-k1.json'), 'utf8'));
  assert.equal(k1.catalogueVersion, 5);
  const pending = [{ part: 'drawbridge', block: 'connector.bridge' }, { part: 'tunnel_cellar', block: 'connector.tunnel' }, { part: 'lift', block: 'connector.lift' }];
  const d = diffCatalogues(k1, golden, { pending });
  assert.deepEqual(d.reservedToSupported, ['connector.bridge', 'connector.tunnel']);
  assert.deepEqual(d.added, [{ id: 'bridge.arch', state: 'supported' }, { id: 'bridge.beam', state: 'supported' }, { id: 'connector.drawbridge', state: 'reserved' },
    { id: 'connector.tube', state: 'reserved' }, { id: 'tunnel.through', state: 'supported' }, { id: 'tunnel.under', state: 'reserved' }]);
  assert.deepEqual(d.limitsChanged, [{ id: 'connector.auto', from: { moves: ['walk', 'stair', 'ladder', 'rope_bridge'] }, to: { moves: ['walk', 'stair', 'ladder', 'rope_bridge', 'bridge', 'tunnel'] } }]);
  assert.deepEqual(d.schemaVersionBumps.map((x) => x.id), ['connector.bridge', 'connector.tunnel']);
  assert.deepEqual([d.removed, d.retired, d.otherStateChanges, d.untilChanged, d.notesChanged], [[], [], [], [], []]);
  // the recorded pending parts naming connector.bridge or connector.tunnel are flagged to recheck (item 10)
  assert.deepEqual(d.recheck, [{ part: 'drawbridge', block: 'connector.bridge' }, { part: 'tunnel_cellar', block: 'connector.tunnel' }]);
  const e = Object.fromEntries(golden.entries.map((x) => [x.id, x]));
  assert.deepEqual(e['connector.bridge'].limits, { span: [1, 32], width: [1, 5], villagerMinWidth: 2, forms: ['beam', 'arch'], archSpan: [4, 24], pierEvery: 8, pierDepth: 24, clearance: [0, 6], approach: 32 });
  assert.deepEqual(e['connector.tunnel'].limits, { length: [4, 64], width: [1, 5], height: [2, 5], cover: 2, fluidBuffer: 2, approach: 32 });
  for (const [id, until] of [['tunnel.under', '7b'], ['connector.tube', 'UW'], ['connector.drawbridge', 'mechanism']]) assert.equal(e[id].until, until, id);
  // the new and flipped entries carry the branch's API placeholder (a real semver; the merge restamps it)
  for (const id of ['connector.bridge', 'connector.tunnel', 'connector.auto', 'bridge.beam', 'bridge.arch', 'tunnel.through', 'tunnel.under', 'connector.tube', 'connector.drawbridge']) assert.equal(e[id].sinceApi, PLAN_API, id);
  // the reason codes NO_COVER and VOLUME are appended (additive output)
  const codes = PLAN_SCHEMA.$defs.reason.properties.code.enum;
  assert.deepEqual(codes.slice(-7), ['NO_GAP', 'SPAN', 'ANCHOR', 'HEADROOM', 'MOVER', 'NO_COVER', 'VOLUME']);
});

test('the special-move table: gate, rope, then bridge (7) and tunnel (8), each off without an edge that asks', () => {
  assert.deepEqual(SPECIAL_MOVES.map((m) => [m.name, m.code, m.segment, m.flag]), [['gate', 5, 'gate', false], ['rope', 6, 'rope', true], ['bridge', 7, 'bridge', true], ['tunnel', 8, 'tunnel', true]]);
  for (const m of SPECIAL_MOVES) for (const f of ['init', 'active', 'needsFlag', 'blocks', 'expand', 'cells', 'commit']) assert.equal(typeof m[f], 'function', `${m.name}.${f}`);
  for (const m of SPECIAL_MOVES.slice(1)) assert.equal(typeof m.fail, 'function', `${m.name}.fail`);
  const env = { W: 4, D: 4, r: 1, minX: 0, minZ: 0, flags: new Uint8Array(16), G: new Int16Array(16) };
  for (const m of SPECIAL_MOVES) assert.equal(m.init(env, { edges: [] }), null, m.name);
  for (const m of SPECIAL_MOVES.slice(2)) assert.equal(m.init(env, { edges: [{ spans: ['rope'] }] }), null, `${m.name}: a rope edge is not mine`);
  // once: a bridge or tunnel edge names its row; K1b's spanOnce reads as rope
  assert.equal(onceOf({ spanOnce: true }), 'rope');
  assert.equal(onceOf({ once: 'bridge' }), 'bridge');
  assert.equal(onceOf({ once: 'tunnel', spanOnce: true }), 'tunnel');
  assert.equal(onceOf({ spans: ['rope', 'bridge', 'tunnel'] }), null);
  assert.deepEqual([...T3_KINDS], ['bridge', 'tunnel']);
  assert.deepEqual([...FALLBACK_KINDS], ['street', 'road', 'path']);
});

test('profile\'s signed sag: the default is rope\'s (unchanged), a beam is straight, an arch\'s camber humps within one half block', () => {
  for (let n = 1; n <= 40; n++) for (let rise = -5; rise <= 5; rise++) for (const y0 of [-40, 0, 64]) {
    assert.deepEqual(profile(n, y0, rise), profile(n, y0, rise, sagOf(n)), `default ${n}/${rise}`);
  }
  for (let n = 1; n <= 32; n++) {
    // (§3's rise bound max(1, floor(n / 8)), and at most n / 2 so a step is one half block: a 1-cell span is level)
    const maxRise = Math.min(Math.max(1, Math.floor(n / 8)), Math.floor(n / 2));
    for (let rise = -maxRise; rise <= maxRise; rise++) for (const y0 of [-40, 0, 64]) {
      const beam = profile(n, y0, rise, 0), arch = profile(n, y0, rise, -sagOf(n));
      assert.equal(beam[0], 2 * y0);
      assert.equal(beam[n], 2 * (y0 + rise));
      assert.equal(arch[n], 2 * (y0 + rise));
      assert.ok(maxStep([...beam, 2 * (y0 + rise)]) <= 1, `beam ${n}/${rise}`);
      assert.ok(maxStep([...arch, 2 * (y0 + rise)]) <= 1, `arch ${n}/${rise}`);
      // a camber never dips below the straight line
      for (let i = 0; i <= n; i++) assert.ok(arch[i] >= beam[i], `arch ${n}/${rise} at ${i}`);
    }
  }
});

test('the bible\'s bridge and tunnel roles (§7, N-T3-1, N-T3-3)', () => {
  const roles = resolveRoles({});
  const d = connectorRoles(roles, null);
  for (const k of ['deck', 'rail', 'pier', 'arch']) assert.ok(k in d.bridge, `bridge.${k}`);
  for (const k of ['lining', 'portal', 'floor']) assert.ok(k in d.tunnel, `tunnel.${k}`);
  assert.equal(d.bridge.deck, roles.path ? 'path' : 'floor');
  assert.equal(d.bridge.pier, roles.structure ? 'structure' : roles.foundation ? 'foundation' : 'wall');
  assert.equal(d.tunnel.lining, roles.foundation ? 'foundation' : 'structure');
  assert.equal(d.tunnel.portal, roles.trim ? 'trim' : null);
  assert.equal(connectorsError({ bridge: { deck: 'nope' } }, roles), "connectors.bridge.deck: 'nope' is not a role of this bible");
  assert.equal(connectorsError({ tunnel: { roof: 'structure' } }, roles), "connectors.tunnel: unknown slot 'roof' (one of lining, portal, floor)");
});

test('the validator: a moving bridge answers connector.drawbridge (R18, S-T3-7), a tunnel with via validates (R19), R8 on span and length', () => {
  const zone = { id: 'town', program: { lots: [{ id: 'h1', type: 'house', size: [9, 9] }] } };
  const v = (connectors) => validatePlan({ schemaVersion: 'plan/0', zones: [zone], connectors });
  const p = (r, id) => r.parts.find((x) => x.id === id);
  // redstone_gate's recorded drawbridge
  const dr = v([{ id: 'drawbridge', kind: 'bridge', required: true, from: { part: 'town', port: 'h1' }, to: { anchor: 'claim_s' }, params: { mechanism: 'redstone', movable: true } }]);
  assert.equal(p(dr, 'drawbridge').verdict, 'unsupported');
  assert.equal(p(dr, 'drawbridge').block, 'connector.drawbridge');
  assert.equal(p(dr, 'drawbridge').reason.until, 'mechanism');
  assert.equal(p(v([{ id: 'b', kind: 'bridge', from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' }, params: { movable: true } }]), 'b').block, 'connector.drawbridge');
  // a plain bridge, every member, compiles; params are never malformed
  const full = v([{ id: 'b', kind: 'bridge', from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' }, form: 'arch', span: { min: 4, max: 24 }, width: 3, clearance: 2, approach: 12, params: { material: 'stone', width: 'wide' } }]);
  assert.equal(p(full, 'b').verdict, 'compile', JSON.stringify(p(full, 'b').reason));
  // a tunnel with via validates (the compiler reads the first leg, R19); its every member
  const tv = v([{ id: 't', kind: 'tunnel', from: { anchor: 'claim_n' }, via: [{ anchor: 'claim_center' }], to: { anchor: 'claim_s' }, height: 3, width: 3, length: { min: 8, max: 64 }, lining: 'all', portal: 'plain' }]);
  assert.equal(p(tv, 't').verdict, 'compile', JSON.stringify(p(tv, 't').reason));
  // R8: min over max
  assert.equal(p(v([{ id: 'b', kind: 'bridge', from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' }, span: { min: 20, max: 10 } }]), 'b').verdict, 'malformed');
  assert.equal(p(v([{ id: 't', kind: 'tunnel', from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' }, length: { min: 40, max: 10 } }]), 't').verdict, 'malformed');
  // out of range members are malformed (strict defs)
  assert.equal(p(v([{ id: 'b', kind: 'bridge', from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' }, clearance: 7 }]), 'b').verdict, 'malformed');
  assert.equal(p(v([{ id: 't', kind: 'tunnel', from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' }, height: 6 }]), 't').verdict, 'malformed');
});
