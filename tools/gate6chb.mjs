#!/usr/bin/env node
// (6c H-b) Slice H-b's items of the H gate on their own (tools/lib/gate6ch-b.mjs), for the builder's iterations and the verifier's
// re-runs of the undo and villager items without H-core's and H-a's: the same run worktree, ports, evidence directory and context as
// tools/gate6ch.mjs (whose steps run these same items after the core's).
//
//   node tools/gate6chb.mjs <unit | ingame | natural | cold | look | start [world] | stop | base> [item ...]
//     unit: hb-kit, hb-asks (hb-unchanged retired: H-core's item 11 covers it); ingame: hb-flat (items 5, 8, 9 on a flat world); natural: hb-natural (S3); cold: hb-cold
//     (the frozen site 2026101102); look: hb-look (client). Item names after the step run only those.
//
// Evidence: <GATE6CH_OUT or <main>/artifacts/gate6c-h>/hb-<step>.json. $0: no Claude call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-Hb-run');
process.env.GATE6B_OUT = process.env.GATE6CH_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-h');
process.env.GATE6B_SIDECAR_PORT ??= '8924';
process.env.GATE6B_DEV_PORT ??= '8925';
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient } = L;
const B = await import('./lib/gate6ch-b.mjs');
L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log };
const spendZero = () => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice H is $0: sim and stub only, no Claude call' }, null, 2)}\n`); };

const [step, ...only] = process.argv.slice(2);
const t0 = Date.now();
let data = {}, error;
try {
  if (step === 'start') {
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
    execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
    execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
    await startClient(only[0] ?? 'G6B H Lobby', { backend: 'sim' });
    data = { head };
  } else if (step === 'stop') {
    try { await connect(10_000); } catch { /* by PID below */ }
    await stopClient();
  } else if (step === 'base') {
    await connect();
    for (const name of ['G6B Seed Base', 'G6B Flat Base']) await L.ensureBase(name);
  } else {
    const list = B.items[step];
    if (!list) throw new Error(`usage: node tools/gate6chb.mjs <${Object.keys(B.items).filter((k) => B.items[k].length).join(' | ')} | start | stop | base> [item ...]`);
    if (step !== 'unit') await connect();
    for (const it of list) {
      if (only.length && !only.includes(it.name)) continue;
      log(`-- ${it.name}`);
      data[it.name] = await it.run(ctx);
    }
  }
} catch (e) {
  log(String(e?.stack ?? e));
  error = String(e?.stack ?? e);
  check(false, `${step}: ${String(e?.message ?? e).slice(0, 300)}`);
}
if (!['start', 'stop', 'base'].includes(step)) L.write(`hb-${step}.json`, { step, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
spendZero();
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
