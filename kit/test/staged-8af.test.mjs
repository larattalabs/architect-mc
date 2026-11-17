// (8aF) Phase 8a's foundation, the kit's half (docs/CONTRACT.md "Phase 8a" §3, §6, row 1): a survival IR marks a terrain kind's ops
// `staged` (never a fluid op's, never a brush stroke's) and requires `stagedTerrain`; their free-pass cells evaluate as ARTL class 3
// (CLASS_STAGED), counted free, so survival.cells and the bills do not move; a creative IR is untouched; an older kit's kinds refuse it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { region } from '../lib/region/program.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { evalTile, KINDS_FORMAT2, staleReason, walkKinds } from '../lib/realise.mjs';
import { unpack } from '../lib/region/pack.mjs';
import { CLASS_FREE, CLASS_HELD, CLASS_PAID, CLASS_STAGED } from '../lib/region/survival.mjs';
import { columnsOf, windowOf, worldOf } from './region-helpers.mjs';

const flat = worldOf({ flat: 64 });
const CLAIM = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: -64, maxY: 319 };

async function plan(fn, { survival = true, id = 'staged_inline' } = {}) {
  const survey = columnsOf(flat, CLAIM.minX, CLAIM.minZ, 64, 64, 1);
  const res = await planRegion({ program: { id, default: fn }, programSource: fn.toString(), survey, seed: '42', claim: CLAIM, node: 'test', ...(survival ? { survival: true } : {}) });
  const ir = res.ir;
  const cells = new Map();
  for (const s of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles[s][set]) {
    const e = evalTile(ir, key, windowOf(flat, key), { stage: s, set, blobs: (sha) => res.blobs.get(sha) });
    for (const c of unpack(e.payload).cells) cells.set(`${c.x},${c.y},${c.z}`, { state: c.state, cls: c.cls, group: c.group === undefined ? null : ir.survival?.groups[c.group] });
  }
  return { ir, cells };
}

function rows(ctx) {
  const r = region(ctx);
  r.anchor('spawn', [2, 2]);
  r.anchor('entrance', [3, 2]);
  r.stages(['ground', 'forms']);
  // a terrain kind's fill: staged, the free pass
  r.part('land', { stage: 'ground' }).fill({ kind: 'box', min: [4, { abs: 65 }, 4], max: [5, { abs: 66 }, 5] }, 'minecraft:stone', { terrain: true });
  // a plain cut (not a terrain kind): free, not staged
  r.part('cut', { stage: 'ground' }).fill({ kind: 'box', min: [8, { abs: 63 }, 4], max: [9, { abs: 64 }, 5] }, null, { cond: 0 });
  // a wall with a terrain fill in its part: the fill's op staged, its cells held (they wait with the paid ones, as in RS)
  const w = r.part('wall', { stage: 'ground' });
  w.fill({ kind: 'box', min: [12, { abs: 65 }, 4], max: [12, { abs: 67 }, 6] }, 'minecraft:stone_bricks', { cond: 0 });
  w.fill({ kind: 'box', min: [14, { abs: 65 }, 4], max: [14, { abs: 65 }, 6] }, 'minecraft:dirt', { cond: 0, terrain: true });
  // a pad: its cut and fill staged (the free pass today)
  r.part('pads', { stage: 'ground' }).lot('l1', { at: [40, 40], size: [6, 6], pad: { edge: 'slope', maxCut: 4, maxFill: 4 } });
  // a fluid op inside a terrain kind's writes: free, never staged (8c's)
  const fl = r.part('pondw', { stage: 'forms' });
  r.terrain(() => fl._push({ op: 'fluid', id: 'pondw', part: 'pondw', fluid: 'water', cells: [[44, 4, 63, 63]], ice: [[44, 4, 64, 64]], shell: [], spill: [], joins: [], watch: [], predicted: [], cond: 0, walk: false }));
  return r;
}

test('8aF: a survival IR marks a terrain kind\'s ops staged (not a fluid op, not a plain cut, not a wall body) and requires stagedTerrain', async () => {
  const { ir } = await plan(rows);
  const opsOf = (id) => ir.parts.find((p) => p.id === id).ops;
  assert.equal(opsOf('land')[0].staged, true);
  assert.equal(opsOf('cut')[0].staged, undefined);
  assert.equal(opsOf('wall')[0].staged, undefined, 'a wall body is no terrain kind\'s');
  assert.equal(opsOf('wall')[1].staged, true);
  assert.ok(opsOf('pads').some((o) => o.staged), 'the pad\'s cut and fill');
  assert.ok(opsOf('pads').every((o) => (o.staged === true) === (o.free === true)), 'a pad op is staged exactly when free');
  assert.equal(opsOf('pondw')[0].free, true, 'the fluid op is a terrain kind\'s write');
  assert.equal(opsOf('pondw')[0].staged, undefined, 'never staged: a fluid op');
  assert.ok(ir.requires.includes('stagedTerrain') && ir.requires.includes('survival'));
  assert.deepEqual(ir.requires, [...ir.requires].sort());
});

test('8aF: classes: a staged free-pass cell is CLASS_STAGED; held stays held; a cut and a fluid stay free; survival.cells counts staged as free', async () => {
  const { ir, cells } = await plan(rows);
  const cls = (x, y, z) => cells.get(`${x},${y},${z}`)?.cls;
  assert.equal(cls(4, 65, 4), CLASS_STAGED, 'a terrain fill');
  assert.equal(cls(8, 64, 4), CLASS_FREE, 'a plain cut');
  assert.equal(cls(12, 66, 4), CLASS_PAID, 'a wall body');
  assert.equal(cls(14, 65, 4), CLASS_HELD, 'a terrain fill in a part with paid cells: held wins');
  assert.equal(cls(44, 63, 4), CLASS_FREE, 'a water source');
  assert.equal(cls(44, 64, 4), CLASS_FREE, 'its ice cap');
  const pad = [...cells.values()].filter((c) => c.group === 'pads');
  assert.ok(pad.length > 30 && pad.every((c) => c.cls === CLASS_STAGED));
  // the counts: staged cells are free cells (nothing is billed or held by the marks)
  const by = {};
  for (const c of cells.values()) { const g = (by[c.group] ??= { free: 0, held: 0, paid: 0 }); if (c.cls === CLASS_PAID) g.paid++; else if (c.cls === CLASS_HELD) g.held++; else g.free++; }
  for (const [g, n] of Object.entries(by)) assert.deepEqual({ free: ir.survival.cells[g].free, held: ir.survival.cells[g].held, paid: ir.survival.cells[g].paid }, n, g);
});

test('8aF: a creative IR has no staged mark, no stagedTerrain, ARTL v1 tiles', async () => {
  const { ir, cells } = await plan(rows, { survival: false });
  assert.ok(!JSON.stringify(ir).includes('"staged"'));
  assert.ok(!(ir.requires ?? []).includes('stagedTerrain'));
  assert.ok([...cells.values()].every((c) => c.cls === undefined));
});

test('8aF: a brush stroke\'s survival IR is not staged (the player\'s instant tool)', async () => {
  const stroke = (ctx) => {
    const r = region(ctx);
    r.anchor('spawn', [2, 2]);
    r.anchor('entrance', [3, 2]);
    r.part('stroke').fill({ kind: 'box', min: [4, { abs: 65 }, 4], max: [5, { abs: 66 }, 5] }, 'minecraft:stone', { cond: 0 });
    return r;
  };
  const { ir, cells } = await plan(stroke, { id: 'brush' });
  assert.equal(ir.parts[0].ops[0].free, true);
  assert.equal(ir.parts[0].ops[0].staged, undefined);
  assert.ok(!ir.requires.includes('stagedTerrain'));
  assert.ok([...cells.values()].every((c) => c.cls === CLASS_FREE));
});

test('8aF: stagedTerrain is a known kind, walked from the ops; a kit without it refuses PLAN_STALE', () => {
  assert.ok(KINDS_FORMAT2.includes('stagedTerrain'));
  assert.equal(KINDS_FORMAT2[KINDS_FORMAT2.length - 1], 'stagedTerrain', 'appended');
  assert.deepEqual(walkKinds({ parts: [{ ops: [{ op: 'shape', staged: true }] }] }), ['stagedTerrain']);
  assert.deepEqual(walkKinds({ parts: [{ ops: [{ op: 'shape', free: true }] }] }), []);
  assert.equal(staleReason({ format: 2, requires: ['survival', 'stagedTerrain'] }), null);
  // an older kit's list: the plan names the missing kind
  const missing = ['survival', 'stagedTerrain'].filter((k) => !KINDS_FORMAT2.slice(0, -1).includes(k));
  assert.deepEqual(missing, ['stagedTerrain']);
});
