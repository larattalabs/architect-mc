// (gate speed 3) The drivers' byte-identity loops over the shared plan store (tools/lib/corpus-plan.mjs): each driver's unchanged()
// on a few small fixtures, this checkout against itself (every fixture identical), through the store cold, then warm, then without
// it (GATE_PLAN_CACHE=0). Every check passes and the three passes print the same check lines: a driver whose extras (KC's census,
// F3's M18/M19) or signatures break on the store's lite results fails here, not in a gate run ("census is not a function").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// one cheap fixture with a body (KC's census and F3's M18/M19 run on it), one ask, one plain valid plan
const ONLY = /^(kc\/u02_lamp_on_rim|asks\/pirate_cove|valid\/v01_[a-z_]+)\.json$/;
const DRIVERS = ['gate6ckc-kit', 'gate6cs3-kit', 'gate6cf3-kit', 'gate6cirr-kit', 'gate6cfl-kit', 'gate6crs-kit', 'gate6ccoa-kit'];

async function pass(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const out = {};
    for (const d of DRIVERS) {
      const lines = [];
      const check = (ok, text) => lines.push(`${ok ? 'ok' : 'FAIL'} ${text}`);
      const m = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', `${d}.mjs`)).href);
      await m.unchanged(ROOT, { check, log: () => {}, only: ONLY, baseDir: ROOT });
      out[d] = lines;
    }
    return out;
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('the drivers\' unchanged() loops: the store cold, warm and off print the same passing checks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-plan-'));
  try {
    const cold = await pass({ GATE_PLAN_CACHE_DIR: dir, GATE_PLAN_WORKERS: '2' });
    const warm = await pass({ GATE_PLAN_CACHE_DIR: dir, GATE_PLAN_WORKERS: '1' });
    const off = await pass({ GATE_PLAN_CACHE: '0' });
    for (const d of DRIVERS) {
      assert.ok(cold[d].length >= 2, `${d}: checks ran (${cold[d].length})`);
      for (const l of cold[d]) assert.ok(l.startsWith('ok '), `${d}: ${l}`);
      assert.deepEqual(warm[d], cold[d], `${d}: warm = cold`);
      assert.deepEqual(off[d], cold[d], `${d}: off = cold`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (speed audit A) coa-unit's signatures compare the plan's artifact, which the lite record must carry: through the store, cold and
// warm, it equals the artifact of the uncached call, is not empty for a plan that makes one, and a record without it is re-planned.
test('the store\'s record carries the artifact (coa-unit compares it): cold, warm and uncached equal; an artifact-less result throws', async () => {
  const { artSig } = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'gate6ccoa-kit.mjs')).href);
  assert.throws(() => artSig({}), /no artifact/);
  assert.throws(() => artSig({ check: {}, res: {} }), /no artifact/);
  assert.doesNotThrow(() => artSig({ artifact: null }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-plan-art-'));
  const saved = { ...process.env };
  try {
    const CP = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'corpus-plan.mjs')).href);
    const { fixtures, planFixture } = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'gate6ckc-kit.mjs')).href);
    const [name, fx] = fixtures(ROOT).find(([n]) => /^valid\/v01_/.test(n));
    process.env.GATE_PLAN_CACHE_DIR = dir;
    const plain = await import(pathToFileURL(path.join(ROOT, 'kit', 'test', 'plan-helpers.mjs')).href);
    const truth = (await planFixture(plain, ROOT, fx)).r;
    assert.ok(truth.artifact, `${name}: the uncached plan makes an artifact`);
    const H = await CP.helpers(ROOT);
    for (const pass of ['cold', 'warm']) {
      const r = (await planFixture(H, ROOT, fx)).r;
      assert.ok(r.artifact, `${pass}: the artifact is there`);
      assert.deepEqual(r.artifact, truth.artifact, `${pass}: the artifact equals the uncached one`);
      assert.equal(artSig(r), artSig(truth), `${pass}: its signature equals`);
    }
    // (an entry from a store that predates the artifact has no `art`: it is not an entry)
    const zlib = await import('node:zlib');
    const files = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : /\.json\.gz$/.test(e.name) && files.push(path.join(d, e.name)); })(dir);
    assert.ok(files.length > 0, 'the store wrote entries');
    for (const f of files) { const v = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')); delete v.art; fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(v))); }
    const again = (await planFixture(await CP.helpers(ROOT, { headRoot: ROOT, derive: [] }), ROOT, fx)).r;
    assert.deepEqual(again.artifact, truth.artifact, 'an entry without art is re-planned, never served as an absent artifact');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (speed audit A) hy-unit's item 12, h-unit's item 11 and vocc-unit's item 4 over the store: each loop's per-fixture comparison, this
// checkout against itself, cold, warm and off, is the same table, every fixture the same.
test('hy, h-core and vocc-c identity loops: the store cold, warm and off give the same tables, all identical', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-plan-hy-'));
  const run = async (env) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const hy = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'gate6chy-core.mjs')).href);
      const hc = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'gate6ch-core.mjs')).href);
      const vc = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'gate6cvoc-c.mjs')).href);
      const a = await hy.unchanged(ROOT, { baseDir: ROOT, only: /^(valid\/v01_[a-z_]+|extension\/e01_[a-z_]+|asks\/pirate_cove)\.json$/ });
      const b = await hc.unchanged(ROOT, { baseDir: ROOT });
      const c = await vc.unchanged(ROOT, ROOT, { only: /^(valid\/v01_[a-z_]+|asks\/pirate_cove)\.json$/ });
      return { hy: a.fixtures, h: b.fixtures, vocc: c.fixtures };
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };
  try {
    const cold = await run({ GATE_PLAN_CACHE_DIR: dir, GATE_PLAN_WORKERS: '2' });
    const warm = await run({ GATE_PLAN_CACHE_DIR: dir, GATE_PLAN_WORKERS: '1' });
    const off = await run({ GATE_PLAN_CACHE: '0' });
    for (const k of ['hy', 'h', 'vocc']) {
      assert.ok(Object.keys(cold[k]).length >= 1, `${k}: fixtures compared (${Object.keys(cold[k]).length})`);
      for (const [n, v] of Object.entries(cold[k])) assert.ok(v.answers && v.ir && v.overall, `${k} ${n}: identical to itself (${JSON.stringify(v)})`);
      assert.deepEqual(warm[k], cold[k], `${k}: warm = cold`);
      assert.deepEqual(off[k], cold[k], `${k}: off = cold`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
