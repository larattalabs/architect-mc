// (7c SF) Style format 3 (docs/CONTRACT.md "Phase 7c: composition" §3 row 4, S-7c-3, Steward's change 1): the validator's format 3
// members, format 2 byte for byte as before (every committed Style), any Style read as format 3 (a format 2 Style a settlement Style
// with no zone Styles), related Styles (the shared core roles), and in the plan check: connector.auto's preferred moves (a bias, never a
// filter) and the look parameters, each changing only what it names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateBible, builtinBible, BUILTIN_BIBLES } from '../lib/bible.mjs';
import { CORE_ROLES } from '../lib/kit.mjs';
import { planCatalogue } from '../lib/plan/catalogue.mjs';
import { AUTO_ROWS, FORMAT3, LOOK_PARAMS, PREFER_KINDS, SETTLEMENT_DEFAULTS, format3Of, relatedErrors, sharedCoreRoles, splitConnectors } from '../lib/style3.mjs';
import { checkPlanLocal, flatSurvey, stewardAnchors, FIX } from './plan-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MACRO = { rock: 'minecraft:stone', surface: 'minecraft:grass_block', subsurface: 'minecraft:dirt', rubble: 'minecraft:cobblestone', rail: 'minecraft:oak_fence', structure: 'minecraft:oak_planks' };
const rustic = () => builtinBible('rustic');
/** A format 3 settlement Style over rustic's roles. */
const settlement3 = (extra = {}) => ({ id: 'bib_town', name: 'Town', version: 1, format: 3, scope: 'settlement', roles: { ...rustic().roles, ...MACRO }, ...extra });

test('format 3: the members validate, a settlement Style gets the settlement defaults, the errors name the field', () => {
  const r = validateBible(settlement3({
    connectors: { prefer: ['rope_bridge', 'ladder', 'branch_walk'], rope_bridge: { deck: 'floor', maxSpan: 24, sagRatio: 16, light: 'light' }, ladder: { landingEvery: 12 }, tunnel: { lining: 'foundation' } },
    forms: { giantTree: { species: 'jungle', heightBand: [40, 70] }, rockSpire: { strata: ['rock', 'minecraft:tuff', 'calcite'] } },
    scatter: { ground: ['fern', 'minecraft:moss_carpet'], wall: ['vine'], density: 'moderate' },
    settlement: { verticality: 'high', roleShares: { wall: [0.25, 0.45], frame: [0.1, 0.25] } },
    references: [{ blob: 'ref_s3_silhouette', label: 'silhouette' }],
  }));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.bible.format, FORMAT3);
  assert.deepEqual(r.bible.settlement, { ...SETTLEMENT_DEFAULTS, verticality: 'high', roleShares: { wall: [0.25, 0.45], frame: [0.1, 0.25] } });
  // format 2's restraint comes with format 3
  assert.ok(r.bible.restraint && r.bible.restraint.accentShareMax === 0.12);
  // a settlement Style without the member: the defaults
  assert.deepEqual(validateBible(settlement3()).bible.settlement, { ...SETTLEMENT_DEFAULTS, roleShares: {} });
  // a building Style without it: none filled in
  assert.equal(validateBible({ ...settlement3(), scope: 'building' }).bible.settlement, undefined);
  const bad = (extra, re) => {
    const v = validateBible(settlement3(extra));
    assert.equal(v.ok, false, JSON.stringify(extra));
    assert.ok(v.errors.some((e) => re.test(e)), `${JSON.stringify(extra)}: ${v.errors.join('; ')}`);
  };
  bad({ connectors: { prefer: ['monorail'] } }, /connectors\.prefer: monorail is not a connector kind/);
  bad({ connectors: { prefer: ['ladder', 'ladder'] } }, /listed twice/);
  bad({ connectors: { prefer: ['auto'] } }, /auto is not a connector kind/);
  bad({ connectors: { rope_bridge: { maxSpan: 41 } } }, /rope_bridge\.maxSpan must be an integer 8\.\.40/);
  bad({ connectors: { rope_bridge: { sagRatio: 8 } } }, /sagRatio must be an integer 12\.\.64/);
  bad({ connectors: { ladder: { landingEvery: 30 } } }, /landingEvery must be an integer 8\.\.24/);
  // connectors never name blocks: light is a role (or none), and slots stay roles
  bad({ connectors: { rope_bridge: { light: 'minecraft:lantern' } } }, /light must be a role name or 'none'/);
  bad({ connectors: { rope_bridge: { light: 'lamp' } } }, /'lamp' is not a role of this Style/);
  bad({ connectors: { rope_bridge: { rope: 'minecraft:chain' } } }, /rope_bridge\.rope must be a role name/);
  // a look parameter of another type is a slot there (format 2's message)
  bad({ connectors: { ladder: { maxSpan: 12 } } }, /connectors\.ladder: unknown slot 'maxSpan'/);
  bad({ forms: { volcano: {} } }, /forms: unknown generator 'volcano'/);
  bad({ forms: { giantTree: { heightBand: [70, 40] } } }, /heightBand must be \[lo, hi\]/);
  bad({ forms: { rockSpire: { strata: ['granitey'] } } }, /'granitey' is neither a role of this Style nor a block/);
  bad({ scatter: { ground: ['notablock'] } }, /scatter\.ground: 'notablock' is not a block/);
  bad({ scatter: { density: 'lush' } }, /scatter\.density must be one of/);
  bad({ settlement: { lightEvery: 2 } }, /lightEvery must be an integer 4\.\.32/);
  bad({ settlement: { edges: 'walled' } }, /edges must be one of railed, open/);
  bad({ settlement: { roleShares: { glow: [0, 1] } } }, /'glow' is not a role of this Style/);
  bad({ settlement: { roleShares: { wall: [0.5, 0.2] } } }, /roleShares\.wall must be \[lo, hi\]/);
  bad({ settlement: { mood: 'grim' } }, /settlement: unknown field 'mood'/);
  bad({ references: [{ blob: 'a b' }] }, /references\[0\]\.blob must be a blob id/);
  bad({ references: Array.from({ length: 9 }, (_, i) => ({ blob: `b${i}` })) }, /at most 8/);
  bad({ relatedTo: { id: 'bib_town', version: 1 } }, /cannot derive from itself/);
  bad({ relatedTo: { id: 'bib_x' } }, /relatedTo must be \{ id, version \}/);
  bad({ format: 4 }, /format must be 1, 2 or 3/);
});

test('format 2 is unchanged: format 3 members below format 3 are warned, never read, and every committed Style normalises as on main', () => {
  // a format 2 Style with prefer in its connectors is refused as it was (an unknown member)
  const p = validateBible({ ...settlement3(), format: 2, connectors: { prefer: ['bridge'] } });
  assert.equal(p.ok, false);
  assert.ok(p.errors.some((e) => /connectors: unknown member 'prefer'/.test(e)), p.errors.join('; '));
  // forms, settlement ...: carried as before (a warning that they are read only in format 3), no defaults filled in
  const w = validateBible({ ...settlement3(), format: 2, settlement: { density: 'low' }, forms: { cave: {} } });
  assert.equal(w.ok, true, w.errors.join('; '));
  assert.deepEqual(w.bible.settlement, { density: 'low' });
  assert.ok(w.warnings.some((x) => /^forms: read only in format 3/.test(x)) && w.warnings.some((x) => /^settlement: read only in format 3/.test(x)), w.warnings.join('; '));
  // every committed Style JSON (each scope) and every built-in: {ok, errors, bible} byte for byte as main 0cdb1869 normalised them
  const want = JSON.parse(fs.readFileSync(path.join(FIX, '..', 'sf', 'format2-normalised.json'), 'utf8')).shas;
  const sha = (v) => crypto.createHash('sha256').update(JSON.stringify({ ok: v.ok, errors: v.errors, bible: v.bible })).digest('hex');
  let n = 0;
  for (const [key, h] of Object.entries(want)) {
    if (key.startsWith('builtin:')) {
      const name = key.slice(8);
      assert.ok(BUILTIN_BIBLES.includes(name), key);
      assert.equal(sha(validateBible(builtinBible(name))), h, key);
    } else {
      const [file, scope] = key.split('#');
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      assert.notEqual(j.format, 3, `${file} is not format 3`);
      assert.equal(sha(validateBible(j, { scope })), h, key);
    }
    n++;
  }
  assert.ok(n >= 64, `${n} normalisations compared`);
});

test("Steward's change 1: any Style reads as format 3; a format 2 Style is a settlement Style with no zone Styles", () => {
  for (const b of [rustic(), { ...settlement3(), format: 2, restraint: {} }, { ...settlement3(), format: undefined }]) {
    const f = format3Of(b);
    assert.equal(f.settlementStyle, true);
    assert.equal(f.zone, false);
    assert.equal(f.relatedTo, null);
    assert.deepEqual(f.prefer, []);
    assert.deepEqual(f.look, {});
    assert.deepEqual(f.forms, {});
    assert.deepEqual(f.references, []);
    assert.deepEqual(f.settlement, { ...SETTLEMENT_DEFAULTS, roleShares: {} });
  }
  // its format 2 members below format 3 are not read (settlement as the defaults)
  assert.deepEqual(format3Of({ ...settlement3(), format: 2, settlement: { density: 'low' } }).settlement.density, 'medium');
  const z = format3Of(settlement3({ id: 'bib_harbour', relatedTo: { id: 'bib_town', version: 2 }, connectors: { prefer: ['bridge'], rope_bridge: { deck: 'floor', maxSpan: 20 } } }));
  assert.equal(z.zone, true);
  assert.equal(z.settlementStyle, false);
  assert.deepEqual(z.relatedTo, { id: 'bib_town', version: 2 });
  assert.deepEqual(z.prefer, ['bridge']);
  assert.deepEqual(z.look, { rope_bridge: { maxSpan: 20 } });
  // the slots and the look parameters split (the plan reads the slots as format 2's)
  assert.deepEqual(splitConnectors({ prefer: ['ladder'], rope_bridge: { deck: 'floor', maxSpan: 20 }, wall: { body: 'structure' } }), { slots: { rope_bridge: { deck: 'floor' }, wall: { body: 'structure' } }, prefer: ['ladder'], look: { rope_bridge: { maxSpan: 20 } } });
});

test('related Styles: a zone Style shares its settlement Style\'s core roles; a format 2 target reads as a settlement Style; a zone is no target', () => {
  const town2 = { id: 'bib_town', version: 3, name: 'Town', format: 2, scope: 'settlement', roles: { ...rustic().roles, ...MACRO } };
  const zone = { id: 'bib_harbour', name: 'Harbour', version: 1, format: 3, relatedTo: { id: 'bib_town', version: 3 }, roles: { ...rustic().roles, ...MACRO, structure: 'minecraft:spruce_planks', mooring: 'minecraft:spruce_fence' } };
  assert.deepEqual(relatedErrors(zone, town2), [], 'a format 2 settlement Style is a target; the zone differs only in other roles');
  assert.deepEqual(relatedErrors(zone, { ...town2, format: undefined, scope: 'building' }), [], 'a format 1 building Style reads as a settlement Style too');
  const off = relatedErrors({ ...zone, roles: { ...zone.roles, wall: 'minecraft:sandstone', roof: 'red_sandstone' } }, town2);
  assert.equal(off.length, 1);
  assert.match(off[0], /wall is minecraft:sandstone, not minecraft:/);
  assert.match(off[0], /roof is red_sandstone, not /);
  // the shared roles are the core roles only, and a bible job copies them in (then it relates)
  const shared = sharedCoreRoles(town2);
  assert.deepEqual(Object.keys(shared).sort(), [...CORE_ROLES].sort());
  assert.deepEqual(relatedErrors({ ...zone, roles: { ...zone.roles, wall: 'minecraft:sandstone', ...shared } }, town2), []);
  // a zone Style is not a settlement Style
  assert.match(relatedErrors(zone, { ...zone, id: 'bib_other', relatedTo: { id: 'bib_town', version: 3 } })[0], /is itself a zone Style/);
  assert.match(relatedErrors(zone, null)[0], /not there/);
});

test('the prefer list names connector kinds: the catalogue\'s, but auto; auto\'s rows are its span moves', () => {
  const kinds = planCatalogue().entries.filter((e) => e.id.startsWith('connector.') && e.id !== 'connector.auto').map((e) => e.id.slice('connector.'.length)).sort();
  assert.deepEqual([...PREFER_KINDS].sort(), kinds);
  for (const k of Object.keys(AUTO_ROWS)) assert.ok(PREFER_KINDS.includes(k), k);
  for (const [type, ps] of Object.entries(LOOK_PARAMS)) assert.ok(PREFER_KINDS.includes(type) && Object.keys(ps).length, type);
});

// ---- the plan check: what a format 3 Style changes -------------------------------------------------------------------------------

/** A 14-wide, 13-deep ditch the auto connector crosses (a rope spans it; so does an arch). */
const GAP = { terrain: { bands: [{ x0: 1000, z0: 2046, x1: 1180, z1: 2059, y: 52 }] }, anchors: { a: [1060, 65, 2036], b: [1060, 65, 2070] }, plan: { schemaVersion: 'plan/0', connectors: [{ id: 'across', kind: 'auto', from: { anchor: 'a' }, to: { anchor: 'b' } }] } };
const LADDER = JSON.parse(fs.readFileSync(path.join(FIX, 'valid', 'v7a_cl_ladder.json'), 'utf8'));

async function check(fx, connectors) {
  const s = flatSurvey(fx.terrain ?? {});
  const r = await checkPlanLocal(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, ...(connectors ? { style: { roles: {}, connectors } } : {}) });
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts.map((p) => [p.part, p.class, p.reasons])));
  return r;
}
const across = (r) => r.check.parts.find((p) => p.part === 'across');
const crossing = (r) => { const g = across(r).geometry; return { rope: (g.spans ?? []).map((x) => x.n), bridge: (g.bridges ?? []).map((b) => [b.form, b.n]) }; };

test('connector.auto prefers the Style\'s moves (a bias): no prefer, or one auto already takes, is byte-identical', async () => {
  const base = await check(GAP, null);
  assert.deepEqual(crossing(base), { rope: [14], bridge: [] }, 'auto spans the ditch on a rope');
  // a format 2 Style's connectors (slots only) and a prefer list naming none of auto's moves: unchanged
  for (const c of [{ rope_bridge: { deck: 'floor' } }, { prefer: ['ladder', 'branch_walk'] }, { prefer: ['rope_bridge'] }, { prefer: ['rope_bridge', 'bridge'] }]) {
    assert.equal((await check(GAP, c)).res.irSha, base.res.irSha, JSON.stringify(c));
  }
  // preferring bridges: the same gap on an arch
  const arch = await check(GAP, { prefer: ['bridge'] });
  assert.deepEqual(crossing(arch), { rope: [], bridge: [['arch', 14]] });
  // a bias, never a filter: preferring tunnels (none serves a ditch) still crosses it; rope and arch both cost the penalty, so the
  // cheaper rope as before
  assert.deepEqual(crossing(await check(GAP, { prefer: ['tunnel'] })), crossing(base));
  // and a gap only a rope spans keeps its rope under any prefer list (v34: the 35-cell rift, past every bridge form)
  const v34 = JSON.parse(fs.readFileSync(path.join(FIX, 'valid', 'v34_auto.json'), 'utf8'));
  const s = flatSurvey(v34.terrain ?? {});
  const rift = async (c) => (await checkPlanLocal(v34.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(v34.anchors ?? {}) }, ...(c ? { style: { roles: {}, connectors: c } } : {}) })).res.irSha;
  assert.equal(await rift({ prefer: ['bridge', 'tunnel'] }), await rift(null), 'the rift is a rope or nothing');
});

test('the look parameters change only what they name', async () => {
  const base = await check(GAP, null), ladder = await check(LADDER, null);
  // rope_bridge.maxSpan under the gap: no rope span (the arch instead); over it: unchanged
  assert.deepEqual(crossing(await check(GAP, { rope_bridge: { maxSpan: 12 } })), { rope: [], bridge: [['arch', 14]] });
  assert.equal((await check(GAP, { rope_bridge: { maxSpan: 14 } })).res.irSha, base.res.irSha);
  // rope_bridge.light: none: the same span without its lamps; a role: that role's fixture
  const dark = await check(GAP, { rope_bridge: { light: 'none' } });
  assert.deepEqual(crossing(dark), crossing(base));
  assert.notEqual(dark.res.irSha, base.res.irSha);
  assert.ok(across(dark).cost.cells < across(base).cost.cells, `${across(base).cost.cells} cells, then ${across(dark).cost.cells}`);
  assert.equal((await check(GAP, { rope_bridge: { light: 'light' } })).res.irSha, base.res.irSha, 'the light role is the default');
  // ladder.landingEvery: more rest landings on the same ladders
  const land = (r) => r.check.parts.map((p) => (p.geometry.climbs ?? []).flatMap((c) => c.ladders.map((l) => [l.rungs, l.landings])));
  const eight = await check(LADDER, { ladder: { landingEvery: 8 } });
  assert.deepEqual(land(ladder), [[[30, 1]], [[16, 0]]]);
  assert.deepEqual(land(eight), [[[30, 3]], [[16, 1]]]);
  // each names one connector type: the ladder's parameter leaves the rope plan byte-identical, the rope's the ladder plan
  assert.equal((await check(GAP, { ladder: { landingEvery: 8 } })).res.irSha, base.res.irSha);
  assert.equal((await check(LADDER, { rope_bridge: { maxSpan: 12, light: 'none' }, prefer: ['bridge'] })).res.irSha, ladder.res.irSha);
  // sagRatio is carried, not read yet (the route, the generator and the checker share one profile): no change
  assert.equal((await check(GAP, { rope_bridge: { sagRatio: 24 } })).res.irSha, base.res.irSha);
});

test('roleShares (tools/lib/scenario-metrics.mjs): role shares over the written cells outside lots, shape variants as their role, the row only with bands', async () => {
  const M = await import('../../tools/lib/scenario-metrics.mjs');
  const states = ['minecraft:air', 'minecraft:oak_planks', 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]', 'minecraft:cobblestone', 'minecraft:diamond_block', 'minecraft:lantern[hanging=false,waterlogged=false]'];
  // 10 cells: 1 air, 3 planks + 1 stairs (floor), 2 cobblestone (foundation), 1 diamond (no role), 1 lantern (light), 1 planks in a lot
  const cells = [[0, 0], [1, 1], [2, 1], [3, 1], [4, 2], [5, 3], [6, 3], [7, 4], [8, 5], [9, 1]];
  const world = {
    pal: { states, air: states.map((s) => s === 'minecraft:air') },
    lotAt: (x) => x === 9,
    eachWritten: (cb) => { for (const [x, idx] of cells) cb(x, 0, 0, idx); },
  };
  const ir = { roles: { floor: 'minecraft:oak_planks', foundation: 'minecraft:cobblestone', light: 'minecraft:lantern' } };
  const r = M.roleShares(ir, world, { floor: [0.4, 0.6], foundation: [0, 0.1] });
  assert.equal(r.cells, 8);
  assert.deepEqual(r.shares, { floor: 4 / 8, foundation: 2 / 8, light: 1 / 8 });
  assert.deepEqual(r.outside, ['foundation']);
  assert.deepEqual(r.bands.floor, { lo: 0.4, hi: 0.6, share: 0.5, inside: true });
  // the bars: the row only with bands, never gated (BR turns it on)
  const rows = M.bars({ palette: { share: 1, adherent: 1, cells: 1 }, roleShares: r });
  const row = rows.find((x) => x.id === 'roleShares');
  assert.equal(row.gated, false);
  assert.equal(row.pass, null);
  assert.match(row.value, /foundation 0\.250 \[0, 0\.1\] OUTSIDE/);
  assert.equal(M.bars({ palette: { share: 1, adherent: 1, cells: 1 } }).some((x) => x.id === 'roleShares'), false);
});
