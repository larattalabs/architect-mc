// (fix b5b, the GPT review's P2) tools/lib/gatebcc.mjs: a restart that loses a region's caps fails the check (it used to iterate only the caps
// the restarted world still had, so losing every cap asserted nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bccCaps } from '../../tools/lib/gatebcc.mjs';

const G = {
  same: (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort()),
  plus: (a, b) => { const o = { ...(a ?? {}) }; for (const [k, v] of Object.entries(b ?? {})) o[k] = (o[k] ?? 0) + v; return o; },
};

function harness(world) {
  const checks = [];
  const call = async (name, args) => {
    if (name === 'dev.region.quote') return { bom: { 'minecraft:dirt': 9 } };
    if (name === 'dev.stockpile.audit') return { reconciled: {} };
    if (name === 'dev.bc.cap') return world.cap(args);
    throw new Error(name);
  };
  const L = { realise: async () => 'rg1' };
  const caps = bccCaps({ call, check: (ok, msg) => checks.push({ ok: !!ok, msg }), json: JSON.stringify, G, owner: 'o', log: () => {} });
  return { caps, checks, L };
}

const capState = (createdAt, caps) => (args) => {
  const rid = args.rid ?? 0;
  const e = caps[rid];
  return { rid, createdAt, caps, maxBill: e?.maxBill ?? null, paid: {}, regionCharged: {}, drawn: {}, overshoot: {}, targets: [] };
};

test('a restart that keeps the cap passes', async () => {
  const world = { cap: capState(5, { 0: { maxBill: { 'minecraft:dirt': 9 } } }) };
  const { caps, checks, L } = harness(world);
  await caps.realise(L, 'p1');
  await caps.afterRestart('T');
  assert.ok(checks.length >= 2 && checks.every((c) => c.ok), JSON.stringify(checks));
});

test('a restart that loses every cap of the same region fails', async () => {
  const world = { cap: capState(5, { 0: { maxBill: { 'minecraft:dirt': 9 } } }) };
  const { caps, checks, L } = harness(world);
  await caps.realise(L, 'p1');
  world.cap = capState(5, {}); // the record came back without its caps
  await caps.afterRestart('T');
  assert.ok(checks.some((c) => !c.ok && /keeps every cap/.test(c.msg)), JSON.stringify(checks));
});

test('another world reusing the id is not judged by the old caps', async () => {
  const world = { cap: capState(5, { 0: { maxBill: { 'minecraft:dirt': 9 } } }) };
  const { caps, checks, L } = harness(world);
  await caps.realise(L, 'p1');
  world.cap = capState(77, {}); // a fresh world's uncapped rg1
  await caps.afterRestart('T');
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
});
