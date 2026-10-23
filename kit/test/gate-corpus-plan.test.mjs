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
const DRIVERS = ['gate6ckc-kit', 'gate6cs3-kit', 'gate6cf3-kit', 'gate6cirr-kit', 'gate6cfl-kit'];

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
