// RP (realised provenance): evalTile's `writers` option and `encodeWriters` (ARWR v1). The payload and its sha never change with the
// option; the winner of every cell is the op the checker's cellOps names; every op that wrote a cell in the tile is either its winner
// or listed among its losers, oldest first, against a reference that evaluates each op alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileIR, encodeWriters, evalTile } from '../lib/realise.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { unpack } from '../lib/region/pack.mjs';
import { windowFromSurvey } from '../lib/region/survey.mjs';
import { synthSurvey } from '../lib/region/synth.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function decodeWriters(b) {
  let o = 0;
  const u8 = () => b[o++];
  const varint = () => { let v = 0, s = 0, x; do { x = b[o++]; v += (x & 127) * 2 ** s; s += 7; } while (x & 128); return v; };
  assert.equal(new TextDecoder().decode(b.subarray(0, 4)), 'ARWR'); o = 4;
  assert.equal(u8(), 1);
  const table = [];
  for (let n = varint(); n > 0; n--) { const len = varint(); const part = new TextDecoder().decode(b.subarray(o, o + len)); o += len; table.push({ part, ordinal: varint(), op: varint(), cond: u8() }); }
  const nCells = varint();
  const win = [];
  for (let r = varint(); r > 0; r--) { const t = varint(); const len = varint(); for (let i = 0; i < len; i++) win.push(t); }
  assert.equal(win.length, nCells);
  const losers = new Map();
  let prev = 0;
  for (let n = varint(); n > 0; n--) { const at = prev + varint(); prev = at; const k = varint(); const l = []; for (let i = 0; i < k; i++) l.push(varint()); losers.set(at, l); }
  assert.equal(o, b.length, 'no trailing bytes');
  return { table, win, losers, nCells };
}

/** The IR with only op `oi` (its part's other ops and every other part's emptied). */
function only(ir, C, oi) {
  const o = C.ops[oi];
  let first = oi;
  while (first > 0 && C.ops[first - 1].part === o.part) first--;
  return { ...ir, parts: ir.parts.map((p, i) => ({ ...p, ops: i === o.part ? [p.ops[oi - first]] : [] })) };
}

test('writers: payload unchanged, winners as cellOps, every overwritten op listed (region_small)', async () => {
  const claim = { minX: -100, minZ: 40, maxX: 155, maxZ: 295, minY: -64, maxY: 319 };
  const survey = synthSurvey(claim, 'rp');
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'region_small.mjs'), survey, claim, node: 'test' });
  const ir = p.ir;
  const C = compileIR(ir);
  let cells = 0, multi = 0, tiles = 0;
  for (const st of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles[st][set]) {
    const win = windowFromSurvey(survey, key);
    const plain = evalTile(ir, key, win, { stage: st, set });
    const withW = evalTile(ir, key, win, { stage: st, set, writers: true });
    assert.equal(withW.sha, plain.sha, `${st}/${set}/${key}: the payload never changes`);
    const ck = evalTile(ir, key, win, { stage: st, set, cellOps: true });
    assert.deepEqual([...withW.cellOps], [...ck.cellOps]);
    const d = decodeWriters(encodeWriters(ir, withW));
    assert.equal(d.nCells, plain.count);
    const pos = unpack(plain.payload).cells.map((c) => `${c.x},${c.y},${c.z}`);
    for (let i = 0; i < pos.length; i++) assert.equal(d.table[d.win[i]].op, ck.cellOps[i]);
    // the reference: each op of this stage and set alone
    const by = new Map(pos.map((k) => [k, []]));
    for (const o of C.ops) {
      const pt = C.parts[o.part];
      if (pt.stage !== st || pt.set !== set) continue;
      let r;
      try { r = evalTile(only(ir, C, o.index), key, win, { stage: st, set }); } catch { continue; }
      for (const c of unpack(r.payload).cells) { const l = by.get(`${c.x},${c.y},${c.z}`); if (l) l.push(o.index); }
    }
    for (let i = 0; i < pos.length; i++) {
      const want = by.get(pos[i]).filter((x) => x !== ck.cellOps[i]);
      const got = (d.losers.get(i) ?? []).map((t) => d.table[t].op);
      // an op that reads other ops (none in region_small) could differ alone; every listed loser must be one the reference saw
      for (const g of got) assert.ok(want.includes(g), `${key} cell ${pos[i]}: loser ${g} not a writer alone`);
      assert.deepEqual(got, [...got].sort((a, b) => a - b), 'oldest first (IR op order)');
      assert.deepEqual(got.length, want.length, `${key} cell ${pos[i]}: losers ${got} vs reference ${want}`);
      if (got.length) multi++;
    }
    for (const t of d.table) assert.equal(C.parts[C.ops[t.op].part].id, t.part);
    cells += pos.length; tiles++;
  }
  assert.ok(tiles > 0 && cells > 10000, `${tiles} tiles, ${cells} cells`);
  assert.ok(multi > 0, 'region_small overlaps ops somewhere');
});

test('writers: byte-identical encodings across runs', async () => {
  const claim = { minX: 0, minZ: 0, maxX: 127, maxZ: 127, minY: -64, maxY: 319 };
  const survey = synthSurvey(claim, 'rp2');
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'region_small.mjs'), survey, claim, node: 'test' });
  const st = p.ir.stages[0];
  const key = p.ir.tiles[st].terrain[0];
  const a = encodeWriters(p.ir, evalTile(p.ir, key, windowFromSurvey(survey, key), { stage: st, set: 'terrain', writers: true }));
  const b = encodeWriters(p.ir, evalTile(p.ir, key, windowFromSurvey(survey, key), { stage: st, set: 'terrain', writers: true }));
  assert.deepEqual(a, b);
});
