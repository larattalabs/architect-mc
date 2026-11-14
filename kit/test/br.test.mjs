// (7c BR) brief runs: tools/lib/scenario-br.mjs (the request bodies never name the program, the answers read, the pick row, the golden
// key) and the format 3 Styles of the brief runs (scenarios/bibles/g7cbr_*.json: valid, the scenario fixture's roles, bands set).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIEF_STYLE, BRIEF_VIA, briefCall, briefGoldenKey, briefPlan, briefRow, briefText, briefVia, readBrief } from '../../tools/lib/scenario-br.mjs';
import { validateBible } from '../lib/bible.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sc = (id) => {
  const f = fs.readdirSync(path.join(root, 'scenarios')).find((x) => x === `${id}.json`);
  return JSON.parse(fs.readFileSync(path.join(root, 'scenarios', f), 'utf8'));
};
const SCEN = ['s1_floating_islands', 's2_ice_spikes', 's3_monastery', 's5_treehouses', 's6_cave_city'];

test('the brief call names the brief, the claim and the Style, never the program or params', () => {
  for (const id of SCEN) {
    const s = sc(id);
    const via = briefVia(s);
    assert.equal(via, BRIEF_VIA[id] ?? 'design');
    const [hook, body] = briefCall(s, [0, 0, 191, 191], via);
    assert.equal(hook, via === 'compose' ? 'dev.region.compose' : 'dev.region.design');
    const j = JSON.stringify(body);
    assert.ok(!j.includes(s.program), `${id}: the body names ${s.program}: ${j}`);
    assert.equal(body.params, undefined);
    assert.equal(body.program, undefined);
    assert.equal(body.brief, briefText(s));
    assert.deepEqual(body.claim, [0, 0, 191, 191]);
    if (s.bible) assert.equal(via === 'compose' ? body.style : body.bible, s.bible);
  }
  // S3 and S6 go the plan path (§5: at least two scenarios through Regions.compose)
  assert.deepEqual(Object.keys(BRIEF_VIA).sort(), ['s3_monastery', 's6_cave_city']);
  assert.equal(briefVia(sc('s3_monastery'), 'design'), 'design');
  assert.throws(() => briefVia(sc('s1_floating_islands'), 'plan'), /design or compose/);
  // PAY's hooks pass through
  const [, b] = briefCall(sc('s6_cave_city'), [0, 0, 1, 1], 'compose', { budgetUsd: 1.5, images: true, ext: { k: 1 }, opKey: 'x' });
  assert.deepEqual([b.budgetUsd, b.images, b.ext, b.opKey], [1.5, true, { k: 1 }, 'x']);
  const [, d] = briefCall(sc('s1_floating_islands'), [0, 0, 1, 1], 'design', { model: 'm' });
  assert.equal(d.model, 'm');
});

test('the brief text is SETTLEMENTS §16.2\'s line, without a trailing version note', () => {
  assert.equal(briefText(sc('s1_floating_islands')), 'a hamlet on floating islands, linked by rope and stone');
  assert.equal(briefText(sc('s6_cave_city')), 'a city carved inside the mountain');
  assert.equal(briefText(sc('s3_monastery')), 'a monastery that grows down its cliff');
});

test('the answers read: a planned pick goes on, everything else stops with a reason', () => {
  const picked = readBrief('design', { designId: 'd1', status: 'DONE', costUsd: 0, result: { outcome: 'PICKED', program: 'floating_islands', params: { islands: 5 }, fits: true, reason: 'r', planId: 'p1' } }, 'b');
  assert.deepEqual(briefPlan(picked), { ok: true, program: 'floating_islands', params: { islands: 5 } });
  const row = briefRow(picked, 'floating_islands');
  assert.equal(row.pass, true);
  assert.equal(row.gated, true);
  assert.match(row.value, /\(the same\)/);
  assert.match(briefRow(picked, 'ice_outpost').value, /another program/);
  // compose's PICKED nests the pick
  const cp = readBrief('compose', { designId: 's1', kind: 'SETTLEMENT', status: 'DONE', result: { outcome: 'PICKED', program: 's6_cave_city', params: {}, pick: { designId: 'd2', outcome: 'PICKED', program: 's6_cave_city', fits: true }, planId: 'p2', cost: 0 } });
  assert.equal(cp.fits, true);
  assert.equal(cp.pick.designId, 'd2');
  assert.equal(briefPlan(cp).ok, true);
  const no = (r, d = {}) => briefPlan(readBrief('design', { status: 'DONE', result: r, ...d }));
  assert.match(no({ outcome: 'NO_TEMPLATE', program: 's6_cave_city', fits: false, reason: 'no cave' }).why, /NO_TEMPLATE \(closest s6_cave_city\): no cave/);
  assert.match(no({ outcome: 'PICKED', program: 'x', fits: true, planError: 'E' }).why, /plan of the pick failed: E/);
  assert.match(no({ outcome: 'PICKED', program: 'x', fits: true }).why, /did not plan/);
  assert.match(no({ outcome: 'COMPOSED', check: { artifactSha: 'abc' } }).why, /realiseApproved/);
  assert.match(no({}, { status: 'FAILED' }).why, /ended FAILED/);
  assert.match(briefPlan(readBrief('design', { refused: 'NOT_ALLOWED' })).why, /refused: NOT_ALLOWED/);
  assert.equal(briefRow(readBrief('design', { status: 'DONE', result: { outcome: 'NO_TEMPLATE' } }), 'x').pass, false);
  assert.equal(briefGoldenKey('s3'), 's3-br');
});

test('the brief runs\' format 3 Styles: valid, settlement scope, the scenario fixture\'s roles, roleShares bands', () => {
  assert.deepEqual(Object.keys(BRIEF_STYLE).sort(), ['s2_ice_spikes', 's3_monastery']);
  for (const [id, style] of Object.entries(BRIEF_STYLE)) {
    const s = sc(id);
    const b = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'bibles', `${style}.json`), 'utf8'));
    const v = validateBible(b);
    assert.deepEqual(v.errors, [], `${style}: ${v.errors}`);
    assert.equal(v.bible.format, 3);
    assert.equal(b.scope, 'settlement');
    const own = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', s.bibleFixture), 'utf8'));
    for (const [r, st] of Object.entries(own.roles)) assert.equal(b.roles[r], st, `${style}.${r}`);
    if (own.fluids) assert.deepEqual(b.fluids, own.fluids);
    const bands = v.bible.settlement.roleShares;
    assert.ok(Object.keys(bands).length >= 3);
    for (const [r, [lo, hi]] of Object.entries(bands)) assert.ok(b.roles[r] && lo >= 0 && hi <= 1 && lo <= hi, `${style} ${r}`);
  }
});
