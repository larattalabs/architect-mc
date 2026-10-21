#!/usr/bin/env node
// Fast checks P2 (docs/FAST-CHECKS.md "### 2. Structure lint", "### 3. Look lint"): the in-game structure and look assertions moved to
// the unit tier, over the virtual worlds of committed fixtures (never a live seed). $0, offline, no game.
//
//   node tools/lint.mjs structure [--only a,b] [--jobs N] [--kit DIR] [--json FILE]   the structure lint (kit/lib/lint/structure.mjs)
//   node tools/lint.mjs look      [--only a,b] [--jobs N] [--kit DIR] [--json FILE]   the look lint (kit/lib/lint/look.mjs)
//   node tools/lint.mjs mutations [--only id] [--json FILE]                           each historical bug reproduced (a reverted kit
//                                                                                      hunk in a scratch copy, or the lint's own model
//                                                                                      of a Java fix reverted): the lint must FAIL it
//   node tools/lint.mjs list                                                          the cases and what in-game rows each covers
//   node tools/lint.mjs one <lint> <case> [--kit DIR]                                  one case (the worker the others spawn)
//
// Cases (tools/lib/lint-cases.mjs): the scenarios' plans re-planned by this checkout's kit over their pinned surveys (natural and
// flat), S7's four path bibles, the plan/0 corpus (Steward-shaped plans, the broken variants), the even-width fuzz and the historical
// bugs' fixtures. A case FAILs on the gate of kit/lib/lint/structure.mjs (or look.mjs) less its recorded baseline (a known finding
// with its reason, kit/test/fixtures/lint/baseline.json: an exact count, so a new instance fails), and on its own case bars.
// Plans are cached per kit content (artifacts/lint-cache/ in the main checkout; untracked; a miss only costs the plan).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const KITDIR = path.resolve(opt('--kit') ?? path.join(ROOT, 'kit'));
process.env.LINT_KIT_DIR = KITDIR;
const C = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'lint-cases.mjs')).href);

async function runOne(lint, id) {
  const t0 = Date.now();
  const cs = C.cases(lint).find((c) => c.id === id);
  if (!cs) throw new Error(`no ${lint} case ${id}`);
  const out = await cs.run();
  return { id, lint, ms: Date.now() - t0, ...out };
}

function spawnOne(lint, id) {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [fileURLToPath(import.meta.url), 'one', lint, id, '--kit', KITDIR], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let so = '', se = '';
    ch.stdout.on('data', (d) => { so += d; });
    ch.stderr.on('data', (d) => { se += d; });
    ch.on('close', (code) => {
      const line = so.split('\n').filter((l) => l.startsWith('{"id"')).pop();
      if (line) resolve(JSON.parse(line));
      else resolve({ id, lint, fails: [`the case crashed (exit ${code}): ${se.trim().split('\n').slice(-3).join(' / ')}`], ok: [] });
    });
  });
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

async function runLint(lint) {
  const t0 = Date.now();
  const only = opt('--only')?.split(',');
  const list = C.cases(lint).filter((c) => !only || only.includes(c.id));
  const jobs = Number(opt('--jobs') ?? Math.max(2, Math.min(10, Math.floor(os.cpus().length / 2))));
  console.log(`${lint} lint: ${list.length} case(s), ${jobs} job(s), kit ${path.relative(process.cwd(), KITDIR) || '.'}`);
  const res = await pool(list.map((c) => c.id), jobs, (id) => spawnOne(lint, id));
  let fail = 0;
  for (const r of res) {
    const c = list.find((q) => q.id === r.id);
    for (const l of r.ok ?? []) console.log(`ok   ${r.id}: ${l}`);
    for (const l of r.recorded ?? []) console.log(`rec  ${r.id}: ${l}`);
    for (const l of r.warn ?? []) console.log(`WARN ${r.id}: ${l}`);
    for (const l of r.fails ?? []) { console.log(`FAIL ${r.id}: ${l}`); fail++; }
    if (!(r.fails ?? []).length && !(r.ok ?? []).length) console.log(`ok   ${r.id}: clean (${c?.covers?.join(', ') ?? ''})`);
  }
  const wall = Date.now() - t0;
  const summary = { lint, cases: res.length, failed: res.filter((r) => (r.fails ?? []).length).map((r) => r.id), failLines: fail, wallMs: wall, results: res };
  if (opt('--json')) fs.writeFileSync(opt('--json'), `${JSON.stringify(summary, null, 1)}\n`);
  console.log(`== ${lint} lint: ${res.length} case(s), ${summary.failed.length} failing (${fail} FAIL lines), ${(wall / 1000).toFixed(1)} s wall`);
  return fail ? 1 : 0;
}

const cmd = argv[0];
if (cmd === 'one') {
  const r = await runOne(argv[1], argv[2]);
  process.stdout.write(`${JSON.stringify(r)}\n`);
  process.exit(0);
} else if (cmd === 'structure' || cmd === 'look') {
  process.exit(await runLint(cmd));
} else if (cmd === 'mutations') {
  const M = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'lint-mutations.mjs')).href);
  process.exit(await M.runMutations({ only: opt('--only')?.split(','), json: opt('--json') }));
} else if (cmd === 'list') {
  for (const lint of ['structure', 'look']) for (const c of C.cases(lint)) console.log(`${lint.padEnd(9)} ${c.id.padEnd(34)} ${c.covers?.join(', ') ?? ''}`);
} else {
  console.error('usage: node tools/lint.mjs <structure|look|mutations|list|one> ...');
  process.exit(2);
}
