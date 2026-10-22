#!/usr/bin/env node
// The step result cache (docs/GATES.md "Affected-only releases"; tools/lib/step-cache.mjs).
//
//   node tools/step-cache.mjs import <run dir>...     record a traced run's PASSes under the current input map (after a merge that
//                                                     widened it): each PASS whose trace stays inside its set, at the run's head
//   node tools/step-cache.mjs replay --at <commit> <run dir>...
//                                                     analysis only, writes nothing: which steps those runs' PASSes would serve
//                                                     at <commit> (keys at each run's head against keys at <commit>; old runs
//                                                     carry no trace and no toolchain record, so this never seeds the cache)
//   node tools/step-cache.mjs list [step]             the recorded entries (newest first)
//
// The cache lives in <main checkout>/artifacts/step-cache/ (untracked).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyHosts } from './lib/hosts.mjs';
import { cacheContext, judgedBenches, keyFor, record } from './lib/step-cache.mjs';
import { loadConf, loadMap } from './lib/step-inputs.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(SRC, '..', 'architect-mc');
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const runsArg = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--at' && all[i - 1] !== '--host');
const git = (...a) => execFileSync('git', ['-C', SRC, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const conf = loadConf(SRC);
const map = loadMap(SRC);
const rawCfg = JSON.parse(fs.readFileSync(path.join(SRC, 'tools', 'gate-chains.json'), 'utf8'));
const resolved = () => {
  const c = JSON.parse(JSON.stringify(rawCfg));
  applyHosts(c, opt('--host') ?? process.env.GATE_HOST ?? 'auto');
  return c;
};
const SNAP = process.env.GATE_SNAPSHOT_DIR ?? path.resolve(SRC, '..', 'architect-mc-6a-run', 'mod', 'run', 'saves');
const readSummary = (run) => JSON.parse(fs.readFileSync(path.join(run, 'summary.json'), 'utf8'));

if (cmd === 'import') {
  const cfg = resolved();
  const JB = judgedBenches(cfg);
  let stored = 0;
  let refused = 0;
  for (const run of runsArg.map((r) => path.resolve(r))) {
    const sm = readSummary(run);
    if (sm.sourceDirty) {
      console.log(`${run}: its source was dirty: nothing imported`);
      continue;
    }
    const ctx = cacheContext({ src: SRC, main: MAIN, cfg, conf, map, snapDir: SNAP, commit: sm.head, dirty: [] });
    ctx.rawCfg = rawCfg;
    const kitTree = (() => {
      try {
        return git('rev-parse', `${sm.head}:kit`);
      } catch {
        return null;
      }
    })();
    const policy = sm.timingPolicy ?? 'judged';
    for (const s of sm.steps) {
      if (s.status !== 'PASS') continue;
      const tdir = path.join(run, 'traces', s.id); // absent for a step with no node process (gradle): its classes cover it
      const k = keyFor(ctx, s.id);
      const ev = sm.shards?.find((x) => x.k === s.shard)?.evidence;
      const r = record(ctx, s.id, s, { key: k.key, why: k.why, parts: k.parts, run, ev: ev ? path.join(run, ev) : run, traceDir: tdir, traced: fs.existsSync(path.join(run, 'traces')),
        timingPolicy: policy, judgedBench: JB.has(s.id), tier: sm.tier?.name ?? sm.chain,
        ...(s.id === 'unit-kit' && fs.existsSync(path.join(run, 'kit-suite.junit.xml')) ? { junit: path.join(run, 'kit-suite.junit.xml'), kitTree } : {}) });
      if (r.stored) stored++;
      else refused++;
      console.log(`${r.stored ? 'recorded' : 'not     '} ${s.id.padEnd(22)} ${r.why}${r.outside ? `: ${r.outside.slice(0, 6).join(', ')}${r.outside.length > 6 ? ', ...' : ''}` : ''}`);
    }
  }
  console.log(`step-cache import: ${stored} recorded, ${refused} not`);
} else if (cmd === 'replay') {
  const at = opt('--at') ?? 'HEAD';
  const cfg = resolved();
  const JB = judgedBenches(cfg);
  const target = cacheContext({ src: SRC, main: MAIN, cfg, conf, map, snapDir: SNAP, commit: git('rev-parse', at), dirty: [] });
  target.rawCfg = rawCfg;
  const served = new Map();
  const seen = new Set();
  for (const run of runsArg.map((r) => path.resolve(r))) {
    let sm;
    try {
      sm = readSummary(run);
    } catch {
      continue;
    }
    if (!sm.head || sm.sourceDirty) continue;
    let ctx;
    try {
      ctx = cacheContext({ src: SRC, main: MAIN, cfg, conf, map, snapDir: SNAP, commit: sm.head, dirty: [] });
    } catch {
      continue; // a head this clone doesn't have
    }
    ctx.rawCfg = rawCfg;
    for (const s of sm.steps) {
      seen.add(s.id);
      if (s.status !== 'PASS' || s.timingRecorded?.length || JB.has(s.id) || served.has(s.id)) continue;
      let a;
      let b;
      try {
        a = keyFor(ctx, s.id);
        b = keyFor(target, s.id);
      } catch {
        continue;
      }
      if (a.key && a.key === b.key) served.set(s.id, { run: path.relative(MAIN, run), head: sm.head.slice(0, 9), at: s.startedAt });
    }
  }
  console.log(`replay at ${at} (${target.head.slice(0, 9)}): ${served.size} step(s) would be served by the PASSes of ${runsArg.length} run(s) (${seen.size} distinct steps in them)`);
  for (const [id, h] of [...served].sort()) console.log(`  ${id.padEnd(22)} PASS ${h.at} ${h.run} @ ${h.head}`);
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ at, head: target.head, runs: runsArg, served: Object.fromEntries(served), seen: [...seen] }, null, 1));
} else if (cmd === 'list') {
  const dir = path.join(MAIN, 'artifacts', 'step-cache');
  const rows = [];
  for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (argv[1] && id !== argv[1]) continue;
    for (const f of fs.readdirSync(path.join(dir, id)).filter((x) => x.endsWith('.json'))) {
      const e = JSON.parse(fs.readFileSync(path.join(dir, id, f), 'utf8'));
      rows.push(e);
    }
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : -1));
  for (const e of rows) console.log(`${e.id.padEnd(22)} ${e.key.slice(0, 12)} PASS ${e.at} ${e.tier} @ ${String(e.head).slice(0, 9)} ${path.relative(MAIN, e.run ?? '')}`);
  console.log(`${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`);
} else {
  console.error('usage: node tools/step-cache.mjs import <run dir>... | replay --at <commit> <run dir>... [--json f] | list [step]');
  process.exit(2);
}
