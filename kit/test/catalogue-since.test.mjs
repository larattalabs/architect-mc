// Every plan-catalogue entry's sinceApi is a real semver (no "P0"/slice-name placeholder) and not newer than the catalogue's api;
// tools/catalogue-since-check.mjs is the check, so a merge-time renumber that forgets to stamp a new entry fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sinceApiProblems, checkAll } from '../../tools/catalogue-since-check.mjs';

test('catalogue sinceApi: the committed catalogue and golden are fully stamped', async () => {
  assert.deepEqual(await checkAll(), []);
});

test('catalogue sinceApi: placeholders and future versions are reported', () => {
  const cat = { api: '1.32.0', entries: [{ id: 'a', sinceApi: '1.23.0' }, { id: 'b', sinceApi: 'P0' }, { id: 'c', sinceApi: 'D1' }, { id: 'd', sinceApi: '1.33.0' }, { id: 'e' }] };
  const p = sinceApiProblems(cat);
  assert.equal(p.length, 4);
  assert.ok(p[0].startsWith('b:') && p[1].startsWith('c:') && p[2].startsWith('d:') && p[2].includes('newer') && p[3].startsWith('e:'));
});
