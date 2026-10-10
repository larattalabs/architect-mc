// Slice 0b gate item 2 (variation): for every kit example with params, under every built-in bible, copies #2 and #3 of an
// archetype differ from it and from each other in at least 2 levers, and lib/diff.mjs finds at least 10% of the written
// cells changed. A recipe that does not build is retried with the next (as the sidecar's copy stage does, up to 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDesign, listDesigns, importDesign, loadDesign } from '../build.mjs';
import { BUILTIN_BIBLES, builtinBible } from '../lib/bible.mjs';
import { chooseRecipe, leversBetween, mirroredOrdinal, paramOptions, seedOf, shiftOptions } from '../lib/variation.mjs';
import { diffFiles } from '../lib/diff.mjs';

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-copies-'));
const share = (d, a) => (d.added + d.removed + d.changed) / a;

async function build(id, roles, values, mirror, tag) {
  const out = path.join(OUT, tag);
  const r = await buildDesign(id, { out, palette: { bible: { id: 'gbible', version: 1, roles } }, values, mirror });
  return { ok: r.result.ok, nbt: r.written.nbtPath, cells: r.bp.cells.size, errors: r.result.errors };
}

test('the recipe helpers', () => {
  const roles = builtinBible('rustic').roles;
  assert.ok(shiftOptions(roles).length >= 2);
  assert.deepEqual(paramOptions({ w: { type: 'int', min: 7, max: 13, default: 9 } }, { w: 7 }), [{ name: 'w', value: 8 }]);
  assert.deepEqual(paramOptions({ b: { type: 'bool', default: true } }), [{ name: 'b', value: false }]);
  assert.deepEqual(paramOptions({ e: { type: 'enum', options: ['a', 'b'], default: 'b' } }), [{ name: 'e', value: 'a' }]);
  assert.equal(mirroredOrdinal(1), true);
  assert.equal(mirroredOrdinal(2), false);
  assert.notEqual(seedOf('g1', 'a'), seedOf('g1', 'b'));
  assert.deepEqual(leversBetween(null, { shift: { name: 's' }, param: { name: 'p', value: 1 }, mirror: true }), ['shift', 'param', 'mirror']);
});

for (const id of listDesigns()) {
  test(`${id}: copies #2 and #3 meet 2 levers and 10% under every built-in bible`, async () => {
    const mod = await importDesign(id);
    if (!mod.params || !Object.keys(mod.params).length) return;
    const bad = [];
    const rows = [];
    for (const bible of BUILTIN_BIBLES) {
      const roles = builtinBible(bible).roles;
      const values = Object.fromEntries(Object.entries(mod.params).map(([k, p]) => [k, p.default]));
      const arch = await build(id, roles, values, false, `${id}-${bible}-a`);
      assert.ok(arch.ok, `${id} ${bible}: the archetype does not build: ${arch.errors.join('; ')}`);
      const seed = seedOf('g_gate', id);
      const bibleObj = { id: 'gbible', version: 1, roles };
      const load = (r, v, m) => loadDesign(id, { palette: { bible: { id: 'gbible', version: 1, roles: r } }, values: v, mirror: m });
      const copies = [];
      for (const ordinal of [1, 2]) {
        let got;
        for (let attempt = 0; attempt < 3 && !got; attempt++) {
          const r = await chooseRecipe({ load, bible: bibleObj, params: mod.params, values, seed, ordinal, siblings: copies.map((c) => c.r), attempt });
          const b = await build(id, r.roles, r.values, r.mirror, `${id}-${bible}-c${ordinal}-${attempt}`);
          if (b.ok) got = { r, b };
        }
        if (!got) { bad.push(`${bible} #${ordinal + 1}: no recipe of 3 builds`); continue; }
        // the bar on effective levers (a lever counts only when its single-lever build changes a cell)
        if (!got.r.bar) bad.push(`${bible} #${ordinal + 1}: the recipe misses the bar (${got.r.minLevers} effective levers, ${(100 * got.r.minShare).toFixed(1)}%)`);
        // a second run chooses the same recipe (deterministic)
        const again = await chooseRecipe({ load, bible: bibleObj, params: mod.params, values, seed, ordinal, siblings: copies.map((c) => c.r), attempt: got.r.attempt });
        assert.deepEqual(again, got.r);
        copies.push(got);
      }
      if (copies.length < 2) continue;
      const [c2, c3] = copies;
      for (const [label, a, b, ra, rb] of [['#2 vs archetype', arch, c2.b, null, c2.r], ['#3 vs archetype', arch, c3.b, null, c3.r], ['#3 vs #2', c2.b, c3.b, c2.r, c3.r]]) {
        const levers = rb.levers && !ra ? rb.levers : leversBetween(ra, rb);
        const d = diffFiles(a.nbt, b.nbt);
        const s = share(d, a.cells);
        rows.push(`${bible} ${label}: ${levers.join('+')} ${(100 * s).toFixed(0)}%`);
        if (levers.length < 2) bad.push(`${bible} ${label}: ${levers.length} lever(s) (${levers.join(', ')})`);
        if (s < 0.1) bad.push(`${bible} ${label}: ${(100 * s).toFixed(1)}% of the cells changed`);
      }
    }
    if (process.env.COPIES_REPORT) fs.writeFileSync(process.env.COPIES_REPORT.replace('%s', id), rows.join('\n') + '\n');
    assert.deepEqual(bad, []);
  });
}
