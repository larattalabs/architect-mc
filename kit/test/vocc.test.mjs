// (6c VOC-c) rule.palette measured (docs/CONTRACT.md "Phase 6c slice VOC-c" §9 items 1, 2, 7, 8): the strict def and its lenient read, the
// groups, the measure (hand counts, terrain and support exempt by the writer), the "no X" re-plan (v65: adjusted, the swaps as
// deviations), every refusal with its evidence and its re-checked wouldFit (r01 TOLERANCE, r02 NO_FEATURE, a "no X" with no other block
// VOCAB), the artifact's palette rows (sorted, stable; the realise's measure from them), r03's pending lot, r04's lenient read, catalogue 9
// against catalogue-hy.json, vocab/1's groups and determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, ROOT, checkPlanVolumes, fixtureLotBlocks, fixtureStyle, flatSurvey, stewardAnchors } from './plan-helpers.mjs';
import { validatePlan } from '../lib/plan/schema.mjs';
import { diffCatalogues, planCatalogue, PLAN_API } from '../lib/plan/catalogue.mjs';
import { irPartExempt, measureLot, measurePalette, readPaletteRule, shareFits, unmeasuredBlocks, swapChain, swapState } from '../lib/plan/palette.mjs';
import { GROUPS, nearestFamily, resolvePalette } from '../lib/vocab/groups.mjs';
import { VOCC_DESIGNS, blueprintBlocks } from './fixtures/vocab/vocc-designs.mjs';

const readJ = (...p) => ({ name: p.join('/'), ...JSON.parse(fs.readFileSync(path.join(FIX, ...p), 'utf8')) });
const sv = flatSurvey();
/** A fixture checked as the game checks it: its bible, its bound lots' histograms, the two-plan flow. */
async function run(fx, { plan = fx.plan, lotBlocks } = {}) {
  const lb = lotBlocks !== undefined ? lotBlocks : await fixtureLotBlocks(fx);
  return checkPlanVolumes(plan, { survey: sv.bytes, claim: sv.claim, anchors: { ...stewardAnchors(sv.claim), ...(fx.anchors ?? {}) }, volume: fx.volume ?? {}, style: fixtureStyle(fx), ...(lb ? { lotBlocks: lb } : {}) });
}
const part = (r, id) => r.check.parts.find((a) => a.part === id);
const ruleOf = (plan, id) => plan.rules.find((x) => x.id === id);
/** A plan with one rule replaced by a fragment applied to it (a wouldFit, re-checked). */
const applied = (plan, id, fragment) => ({ ...plan, rules: plan.rules.map((x) => (x.id === id ? { ...x, ...fragment } : x)) });

// ------------------------------------------------------------------ item 1: the def, its lenient read, groups

test('item 1: the strict def (0 malformed over Steward\'s 7 recorded rules, e16\'s bare rule) and its malformed cases', () => {
  const asks = path.join(FIX, 'asks');
  const recorded = [];
  for (const f of fs.readdirSync(asks).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json')) {
    const plan = JSON.parse(fs.readFileSync(path.join(asks, f), 'utf8')).answer.plan;
    for (const r of plan.rules ?? []) if (r.kind === 'palette') recorded.push([f, r]);
  }
  assert.equal(recorded.length, 7);
  recorded.push(['e16', { id: 'r_palette', kind: 'palette' }]);
  for (const [f, r] of recorded) {
    const v = validatePlan({ schemaVersion: 'plan/0', zones: (r.scope ?? []).map((id) => ({ id })), rules: [r] });
    const p = v.parts.find((x) => x.id === r.id);
    assert.equal(p.verdict, 'compile', `${f} ${r.id}: ${JSON.stringify(p.reason)}`);
    assert.equal(p.block, 'rule.palette');
  }
  const bad = (r) => validatePlan({ schemaVersion: 'plan/0', rules: [{ id: 'r', kind: 'palette', ...r }] }).parts[0];
  for (const [r, at] of [[{ share: [0.9, 0.2] }, '$.rules[0].share'], [{ share: [0, 2] }, '$.rules[0].share[1]'], [{ share: [1] }, '$.rules[0].share'], [{ exempt: ['roof'] }, '$.rules[0].exempt[0]'], [{ family: 'x'.repeat(65) }, '$.rules[0].family'], [{ colours: ['red'] }, '$.rules[0]']]) {
    const p = bad(r);
    assert.equal(p.verdict, 'malformed', JSON.stringify(r));
    assert.equal(p.reason.path, at, `${JSON.stringify(r)}: ${JSON.stringify(p.reason)}`);
  }
});

test('item 1: the lenient read: top level first, then params; defaults share [1, 1] and exempt both; other params keys noted, never read', () => {
  assert.deepEqual(readPaletteRule({ family: 'copper' }), { family: 'copper', share: [1, 1], exempt: ['support', 'terrain'], from: { family: 'top', share: 'default', exempt: 'default' }, notes: [] });
  const r = readPaletteRule({ params: { family: 'copper', share: [1, 1], exempt: ['terrain', 'support'], gradient: 'bright at centre' } });
  assert.equal(r.family, 'copper');
  assert.deepEqual(r.from, { family: 'params', share: 'params', exempt: 'params' });
  assert.deepEqual(r.notes, ['params gradient: noted, not read (VOC-c measures family, share and exempt)']);
  // the top level wins; a malformed params member is noted and its default used
  const t = readPaletteRule({ family: 'stone', share: [0.6, 1], params: { family: 'copper', share: [2, 3] } });
  assert.deepEqual([t.family, t.share, t.from.share], ['stone', [0.6, 1], 'top']);
  const m = readPaletteRule({ params: { share: 'most' } });
  assert.deepEqual([m.family, m.share], [null, [1, 1]]);
  assert.ok(m.notes.some((n) => /params\.share: not a valid share/.test(n)));
  // "no wood"
  assert.deepEqual(readPaletteRule({ family: 'wood', share: [0, 0] }).share, [0, 0]);
});

test('item 1: groups: wood is the 13 woods\' families (leaves and saplings outside); families resolve; the nearest family by name', () => {
  assert.deepEqual(Object.keys(GROUPS), ['wood']);
  const w = resolvePalette('wood');
  assert.equal(w.kind, 'group');
  assert.equal(w.families.length, 13);
  assert.ok(w.blocks.includes('minecraft:oak_planks') && w.blocks.includes('minecraft:spruce_door') && w.blocks.includes('minecraft:stripped_cherry_wood'));
  assert.ok(!w.blocks.some((b) => /_leaves$|_sapling$|propagule/.test(b)), 'leaves and saplings are outside the wood families');
  assert.equal(resolvePalette('copper').blocks.length, 120);
  assert.equal(resolvePalette('stone').kind, 'family');
  assert.equal(resolvePalette('moss_stone_spruce_oak'), null);
  assert.equal(resolvePalette('family_colours'), null);
  assert.deepEqual([nearestFamily('copper_blocks'), nearestFamily('coppers'), nearestFamily('oak_planks'), nearestFamily('moss_stone_spruce_oak')], ['copper', 'copper', 'oak', null]);
});

// ------------------------------------------------------------------ item 1: the measure

test('item 1: the measure by hand: parts in scope, terrain and support exempt by their writer, bound lots less the unmeasured blocks', () => {
  const ir = { parts: [{ id: 'pads', ops: [{ op: 'shape' }] }, { id: 'relief_blend', ops: [{ op: 'relief' }] }, { id: 'props_lamp', ops: [{ op: 'columns' }] }, { id: 'w_wall', ops: [{ op: 'columns' }] }, { id: 'street', ops: [] }, { id: 'other', ops: [{ op: 'columns' }] }] };
  const hist = new Map([[0, { 'minecraft:cobblestone': 40, 'minecraft:cut_copper': 2 }], [1, { 'minecraft:oak_log': 9 }], [2, { 'minecraft:copper_lantern': 4, 'minecraft:copper_bars': 4 }], [3, { 'minecraft:copper_block': 100, 'minecraft:stone_bricks': 10 }], [4, { 'minecraft:cut_copper': 30 }], [5, { 'minecraft:oak_planks': 50 }]]);
  const pc = { partOf: { pads: 'town', relief_blend: 'town', props_lamp: 'town', w_wall: 'wall', street: 'town', other: 'elsewhere' }, lotZone: { a: 'town', b: 'town', c: 'away' }, lotEntries: { a: 'cabin', b: null, c: 'cabin' }, placedLots: new Set(['a', 'b', 'c']) };
  const cu = resolvePalette('copper');
  const lotBlocks = { a: { 'minecraft:copper_block': 20, 'minecraft:oak_door': 2, 'minecraft:dirt': 7, 'minecraft:water': 3 }, c: { 'minecraft:oak_planks': 99 } };
  const m = measurePalette({ scope: ['town', 'wall'], exempt: ['support', 'terrain'] }, cu, { ir, hist, pc, lotBlocks });
  // parts: props_lamp 8/8, w_wall 100/110, street 30/30 (pads and relief exempt; `other` out of scope); lot a: 20/22 (dirt, water unmeasured)
  assert.deepEqual([m.cells, m.family], [8 + 110 + 30 + 22, 8 + 100 + 30 + 20]);
  assert.deepEqual(m.parts, { town: [38, 38], wall: [100, 110] });
  assert.deepEqual(m.lots, { a: [20, 22] });
  assert.deepEqual(m.pendingLots, ['b']);
  assert.deepEqual(m.exempted, { terrain: 9, support: 42 });
  // exempt nothing: the pads and the relief's writes count
  const all = measurePalette({ scope: ['town', 'wall'], exempt: [] }, cu, { ir, hist, pc, lotBlocks });
  assert.deepEqual([all.cells, all.family], [m.cells + 51, m.family + 2]);
  // no scope: every IR part and every lot
  const whole = measurePalette({ scope: null, exempt: ['support', 'terrain'] }, cu, { ir, hist, pc, lotBlocks });
  assert.deepEqual([whole.cells, whole.family], [m.cells + 50 + 99, m.family]);
  assert.deepEqual([irPartExempt({ id: 'clear_entrance', ops: [] }), irPartExempt({ id: 'z2_pads', ops: [] }), irPartExempt({ id: 'scatter_1', ops: [{ op: 'scatter' }, { op: 'stamp' }] }), irPartExempt({ id: 'w_pond_basin', ops: [{ op: 'columns' }] })], ['terrain', 'support', 'terrain', null]);
  // the unmeasured blocks: air, the fluids and the common natural blocks; a lot's other blocks count
  const nat = new Set(unmeasuredBlocks());
  assert.ok(['minecraft:air', 'minecraft:water', 'minecraft:lava', 'minecraft:dirt', 'minecraft:stone', 'minecraft:grass_block', 'minecraft:sand'].every((b) => nat.has(b)));
  assert.ok(!nat.has('minecraft:cobblestone') && !nat.has('minecraft:oak_log') && !nat.has('minecraft:lantern'));
  assert.deepEqual(measureLot({ 'minecraft:copper_block': 3, 'minecraft:stone': 5, 'some_mod:thing': 2 }, new Set(cu.blocks)), { cells: 5, family: 3 });
  assert.deepEqual([shareFits(0, 0, [1, 1]), shareFits(1, 3, [0.3, 0.4]), shareFits(1, 3, [0.4, 1])], [true, true, false]);
});

test('item 1: the material chain (N-VOCc-2, VOC-c\'s own): planks to the base, shapes kept, fences to walls, doors and trapdoors to iron, gates stay', () => {
  const ex = new Set(resolvePalette('wood').blocks);
  const ch = swapChain({ structure: 'minecraft:stone_bricks', foundation: 'minecraft:cobblestone' }, ex);
  assert.deepEqual(ch, ['minecraft:stone_bricks', 'minecraft:cobblestone', 'minecraft:stone']);
  assert.equal(swapState('minecraft:spruce_planks', ch, ex), 'minecraft:stone_bricks');
  assert.equal(swapState('minecraft:spruce_log[axis=x]', ch, ex), 'minecraft:stone_bricks');
  assert.equal(swapState('minecraft:oak_stairs[facing=east,half=bottom]', ch, ex), 'minecraft:stone_brick_stairs[facing=east,half=bottom]');
  assert.equal(swapState('minecraft:oak_slab[type=top,waterlogged=false]', ch, ex), 'minecraft:stone_brick_slab[type=top,waterlogged=false]');
  assert.equal(swapState('minecraft:spruce_fence[east=true,north=false,south=false,waterlogged=false,west=true]', ch, ex), 'minecraft:stone_brick_wall[east=low,north=none,south=none,up=true,waterlogged=false,west=low]');
  assert.equal(swapState('minecraft:oak_door[facing=north,half=upper,hinge=left,open=false,powered=false]', ch, ex), 'minecraft:iron_door[facing=north,half=upper,hinge=left,open=false,powered=false]');
  assert.equal(swapState('minecraft:oak_trapdoor[facing=east,half=bottom,open=true,powered=false,waterlogged=false]', ch, ex), 'minecraft:iron_trapdoor[facing=east,half=bottom,open=true,powered=false,waterlogged=false]');
  assert.equal(swapState('minecraft:oak_fence_gate', ch, ex), null, 'no other block: the rule answers VOCAB');
  assert.equal(swapState('minecraft:lantern', ch, ex), 'minecraft:lantern', 'outside the family: unchanged');
  // a bible whose structure is excluded falls along the chain; with every base excluded there is no other block (VOCAB)
  assert.equal(swapChain({ structure: 'minecraft:oak_planks', foundation: 'minecraft:mud_bricks' }, ex)[0], 'minecraft:mud_bricks');
  const ex2 = new Set([...ex, ...resolvePalette('stone').blocks]);
  assert.equal(swapState('minecraft:oak_planks', swapChain({ structure: 'minecraft:stone_bricks' }, ex2), ex2), null);
});

// ------------------------------------------------------------------ items 1, 4: the fixtures

test('v64 (only copper): fits, READY; the bound lot measured from its entry\'s blocks; the artifact\'s row; the realise\'s measure from the row', async () => {
  const fx = readJ('valid', 'v64_vocc_copper.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  const a = part(r, 'copper_only');
  assert.equal(a.class, 'fits', JSON.stringify(a));
  const cu = new Set(resolvePalette('copper').blocks);
  const lot = measureLot(blueprintBlocks(VOCC_DESIGNS.vocc_copper_cabin()), cu);
  assert.deepEqual(a.measured.lots, { hall: [lot.family, lot.cells] });
  assert.equal(a.measured.family, a.measured.cells);
  assert.deepEqual(a.measured.pendingLots, []);
  assert.deepEqual(Object.keys(a.measured.parts).sort(), ['fount', 'reach', 'reach_wall']);
  // the artifact's palette row: sorted, the family's blocks, the unmeasured blocks, the parts' and the lot's counts
  const row = r.artifact.palette[0];
  assert.deepEqual(Object.keys(row), ['rule', 'required', 'family', 'share', 'lots', 'blocks', 'natural', 'partsCells', 'partsFamily', 'lotCounts']);
  assert.deepEqual([row.rule, row.required, row.family, row.share, row.lots], ['copper_only', true, 'copper', [1, 1], ['hall']]);
  assert.deepEqual(row.blocks, [...cu].sort());
  assert.deepEqual(row.natural, [...unmeasuredBlocks()]);
  assert.deepEqual([row.partsCells + lot.cells, row.partsFamily + lot.family], [a.measured.cells, a.measured.family]);
  assert.deepEqual(row.lotCounts, { hall: [lot.family, lot.cells] });
  // the realise's measure (PaletteRules.measure in Java) from the row and an entry's blocks: the copper cabin fits, the oak one does not
  const realise = (hist) => { const nat = new Set(row.natural), fam = new Set(row.blocks); let c = row.partsCells, f = row.partsFamily; for (const [b, n] of Object.entries(hist)) { if (nat.has(b)) continue; c += n; if (fam.has(b)) f += n; } return shareFits(f, c, row.share); };
  assert.equal(realise(blueprintBlocks(VOCC_DESIGNS.vocc_copper_cabin())), true);
  assert.equal(realise(blueprintBlocks(VOCC_DESIGNS.vocc_oak_cabin())), false);
});

test('v65 (no wood): planned again with the wood group excluded; adjusted with the swaps as deviations; no wood in the IR\'s scope; every other part fits', async () => {
  const fx = readJ('valid', 'v65_vocc_nowood.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  const a = part(r, 'no_wood');
  assert.equal(a.class, 'adjusted', JSON.stringify(a));
  assert.equal(a.measured.family, 0);
  const swaps = Object.fromEntries(a.deviations.map((d) => [d.from, d.to]));
  assert.ok(a.deviations.every((d) => d.what === 'material' && d.value > 0));
  assert.equal(swaps['minecraft:spruce_planks'], 'minecraft:stone_bricks');
  assert.equal(swaps['minecraft:spruce_fence'], 'minecraft:stone_brick_wall');
  assert.equal(swaps['minecraft:oak_trapdoor'], 'minecraft:iron_trapdoor');
  assert.equal(swaps['minecraft:spruce_door'], 'minecraft:iron_door');
  for (const p of r.check.parts) if (p.part !== 'no_wood') assert.equal(p.class, 'fits', p.part);
  // no wood block left anywhere in the IR (the rule has no scope: the whole plan), the 4e roads' surfaces and lamps included
  const wood = resolvePalette('wood').blocks.map((b) => b.replace('minecraft:', ''));
  const re = new RegExp(`minecraft:(${wood.join('|')})(?![a-z0-9_])`);
  // (the IR's `roles` record stays the bible's: the ops and the roads carry the blocks written)
  const written = JSON.stringify({ parts: r.res.ir.parts, roads: r.res.ir.roads });
  assert.ok(!re.test(written), `no wood in the IR's ops and roads: ${re.exec(written)?.[0]}`);
  assert.ok(re.test(JSON.stringify(r.res.ir.roles)), 'the roles record is the bible\'s');
  assert.equal(r.res.meta.planCheck.vocab.pass, 2, 'one re-plan (VOC-b\'s counter)');
  // the first plan wrote wood (what the re-plan measured)
  assert.ok(r.res.meta.planCheck.vocab.first, 'the first plan is recorded');
});

test('a "no wood" whose wood has no other block (a fence-gate gate): refused VOCAB naming the part, with its block and cells', async () => {
  const fx = readJ('valid', 'v65_vocc_nowood.json');
  const plan = { ...fx.plan, connectors: fx.plan.connectors.map((c) => (c.id === 'west_gate' ? { ...c, door: 'fence_gate' } : c)) };
  const r = await run(fx, { plan });
  const a = part(r, 'no_wood');
  assert.equal(a.class, 'refused', JSON.stringify(a));
  assert.equal(a.reasons[0].code, 'VOCAB');
  const ev = a.reasons[0].evidence;
  assert.equal(ev.rule, 'no_wood');
  assert.match(ev.block, /_fence_gate$/);
  assert.ok(ev.cells > 0 && typeof ev.part === 'string', JSON.stringify(ev));
  assert.equal(r.check.overall, 'NEEDS_REPAIR', 'not required: never blocks');
});

test('r01 (only copper missed, no fix): refused TOLERANCE {kind, family, share, measured, worst}; wouldFit the widened share, re-checked: fits', async () => {
  const fx = readJ('vocc', 'r01_share.json');
  const r = await run(fx);
  assert.equal(r.check.overall, fx.expect.overall);
  const a = part(r, 'copper_only');
  assert.equal(a.class, 'refused');
  const reason = a.reasons[0];
  assert.equal(reason.code, 'TOLERANCE');
  assert.deepEqual(Object.keys(reason.evidence), ['kind', 'family', 'share', 'measured', 'worst']);
  assert.deepEqual([reason.evidence.kind, reason.evidence.family, reason.evidence.share], ['palette', 'copper', [1, 1]]);
  assert.equal(reason.evidence.measured, a.measured.share);
  assert.ok(reason.evidence.worst.length >= 1 && reason.evidence.worst.every((w) => w.cells > w.family), JSON.stringify(reason.evidence.worst));
  const wf = a.wouldFit[0];
  assert.deepEqual(wf.fragment.share, [a.measured.share, 1]);
  assert.equal(wf.class, 'fits');
  const again = await run(fx, { plan: applied(fx.plan, 'copper_only', wf.fragment) });
  assert.equal(part(again, 'copper_only').class, 'fits');
  assert.equal(again.check.overall, 'READY');
});

test('r02 (families that resolve to nothing): NO_FEATURE {kind: family}; wouldFit required false, or the nearest family re-checked', async () => {
  const fx = readJ('vocc', 'r02_family.json');
  const r = await run(fx);
  assert.equal(r.check.overall, fx.expect.overall);
  for (const [id, code] of Object.entries(fx.expect.parts)) assert.equal(part(r, id).reasons[0].code, code, id);
  const mossy = part(r, 'mossy');
  assert.deepEqual(mossy.reasons[0].evidence, { kind: 'family', family: 'moss_stone_spruce_oak' });
  assert.deepEqual(mossy.wouldFit.map((w) => w.fragment), [{ required: false }]);
  const prose = part(r, 'prose');
  assert.deepEqual(prose.reasons[0].evidence, { kind: 'family' });
  assert.match(prose.reasons[0].message, /palette guidance only: give a family to measure it/);
  const near = part(r, 'near');
  assert.deepEqual(near.wouldFit[0].fragment, { family: 'copper' });
  assert.equal(near.wouldFit[0].class, 'fits');
  const again = await run(fx, { plan: applied(fx.plan, 'near', near.wouldFit[0].fragment) });
  assert.equal(part(again, 'near').class, 'fits');
});

test('r03 (a required rule over a provisional lot): fits over the parts, the lot pending (R11 amended); READY; the row names the lot', async () => {
  const fx = readJ('vocc', 'r03_entry.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  const a = part(r, 'copper_only');
  assert.equal(a.class, 'fits');
  assert.deepEqual(a.measured.pendingLots, ['hall']);
  assert.ok(a.notes.some((n) => /hall have no bound entry yet: measured at realiseApproved \(a required rule refuses PALETTE there\)/.test(n)), JSON.stringify(a.notes));
  const row = r.artifact.palette[0];
  assert.deepEqual([row.lots, row.lotCounts], [['hall'], {}]);
  assert.equal(r.artifact.lots.find((l) => l.id === 'hall').provisional, true);
});

test('r04 (the lenient read): params-only members answer as v64\'s top-level rule; the gradient noted', async () => {
  const fx = readJ('vocc', 'r04_lenient.json');
  const ref = readJ('valid', 'v64_vocc_copper.json');
  const [r, s] = [await run(fx), await run(ref)];
  const [a, b] = [part(r, 'copper_only'), part(s, 'copper_only')];
  assert.equal(a.class, 'fits');
  assert.deepEqual(a.measured, b.measured);
  assert.ok(a.notes.some((n) => /params gradient: noted, not read/.test(n)));
  assert.equal(r.check.overall, 'READY');
});

test('a non-required rule\'s answers never block; an upper bound of 0 without a re-plan still measured (e05\'s old palette rule, mostly stone)', async () => {
  const fx = readJ('valid', 'v64_vocc_copper.json');
  const plan = { ...fx.plan, rules: [{ id: 'stone_only', kind: 'palette', family: 'stone', share: [0.6, 1], exempt: ['terrain'] }] };
  const r = await run(fx, { plan });
  const a = part(r, 'stone_only');
  assert.equal(a.class, 'refused');
  assert.equal(a.reasons[0].code, 'TOLERANCE');
  assert.equal(r.check.overall, 'NEEDS_REPAIR');
});

// ------------------------------------------------------------------ item 2: the catalogue

test('item 2: catalogue 9 is the golden; its diff from catalogue-hy.json (HY\'s 8) is exactly the one flip, its limits and note folded in', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  // (release tool) at least 9 and the API of this tree: a merge-time bump moves the header, not catalogue 9's entries (checked below)
  assert.ok(golden.catalogueVersion >= 9, String(golden.catalogueVersion));
  assert.equal(golden.api, PLAN_API);
  const hy = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-hy.json'), 'utf8'));
  assert.equal(hy.catalogueVersion, 8);
  const d = diffCatalogues(hy, golden, { pending: [{ part: 'copper_only', block: 'rule.palette' }] });
  assert.deepEqual(d.reservedToSupported, ['rule.palette']);
  assert.deepEqual(d.schemaVersionBumps, [{ id: 'rule.palette', from: 0, to: 1 }]);
  assert.deepEqual([d.added, d.removed, d.retired, d.otherStateChanges, d.untilChanged, d.notesChanged, d.limitsChanged], [[], [], [], [], [], [], []]);
  assert.deepEqual(d.recheck, [{ part: 'copper_only', block: 'rule.palette' }]);
  const e = golden.entries.find((x) => x.id === 'rule.palette');
  // (release tool) VOC-c released rule.palette at API 1.37.0 (v0.40.0); a later API moves PLAN_API, not this stamp
  assert.deepEqual(e, { id: 'rule.palette', sinceApi: '1.37.0', schemaVersion: 1, state: 'supported', limits: { groups: ['wood'], share: [0, 1], exempt: ['terrain', 'support'], scope: 32 }, note: 'measured over parts and bound lots; required rules are checked again at realise' });
  for (const x of golden.entries.filter((q) => q.id.startsWith('rule.') && q.id !== 'rule.palette')) assert.equal(x.state, 'reserved', x.id);
  // every other entry as HY's
  const others = (c) => JSON.stringify(c.entries.filter((x) => x.id !== 'rule.palette'));
  assert.equal(others(golden), others(hy));
});

// ------------------------------------------------------------------ item 7: vocab/1

test('item 7: vocab/1 gains groups (both forms) and compact.palette', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'vocab-1.json'), 'utf8'));
  assert.deepEqual(doc.groups, { wood: [...GROUPS.wood] });
  assert.deepEqual(doc.compact.groups, doc.groups);
  assert.match(doc.compact.palette, /'only X' is share \[1, 1\], 'no X' is share \[0, 0\]/);
  for (const f of doc.groups.wood) assert.ok(doc.compact.families[f], `${f} is a family of vocab/1`);
});

// ------------------------------------------------------------------ item 8: determinism

test('item 8: three checks of each VOC-c fixture give identical answers and artifacts', async () => {
  for (const fx of [readJ('valid', 'v64_vocc_copper.json'), readJ('valid', 'v65_vocc_nowood.json'), ...['r01_share.json', 'r02_family.json', 'r03_entry.json', 'r04_lenient.json'].map((f) => readJ('vocc', f))]) {
    const rs = [await run(fx), await run(fx), await run(fx)];
    const j = rs.map((r) => JSON.stringify(r.check.parts));
    assert.ok(j[1] === j[0] && j[2] === j[0], `${fx.name}: answers`);
    assert.ok(rs.every((r) => r.artifactSha === rs[0].artifactSha && r.res.irSha === rs[0].res.irSha), `${fx.name}: artifact and IR`);
  }
});
