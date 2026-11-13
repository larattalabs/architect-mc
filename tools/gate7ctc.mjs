#!/usr/bin/env node
// Slice TC gate (7c template catalogue; docs/CONTRACT.md "Phase 7c" §3 row 7, "Slice TC as built") against the headless server of the TC
// run worktree (GATE6B_RUN, default `../architect-mc-TC-run`; the sim sidecar, no Claude). Ports 8896 (sidecar) / 8897 (DevBridge) by
// default. $0: no Claude call anywhere; the pick is the sim's stand-in (keywords), so these steps show the listing, the mod's claim volume,
// the land check and the outcomes, not a model's pick accuracy.
//
//   node tools/gate7ctc.mjs <step>
//     unit   (tc-unit)   offline: kit/test/tc.test.mjs (the catalogue's scenario programs, claim ranges, pickable params, needs in AF's
//                        kinds; the land fixtures byte for byte; the needs met by the sculpted land only; a picked flat village with no
//                        lot list; a picked cave city finding the sculpted hall) and the sidecar's test/regions-tc.test.ts with the real kit
//                        (each scenario's one-line brief over its land PICKED on its program; a cave city over plains NO_TEMPLATE with
//                        s6_cave_city the closest)
//     pick   (tc-pick)   in game (headless, the flat base): Regions.design through the public API (dev.region.design) on a 160x160 claim:
//                        (a) "a cave city" over the flat land: NO_TEMPLATE, s6_cave_city the closest, the reason naming the missing cave
//                        counted in the claim's land (so the mod froze and sent the claim's volume and the helper analysed it); (b) a stone
//                        hill with an enclosed hall (60x8x12) built by /fill: S6's brief PICKED on s6_cave_city (the mod then plans it);
//                        (c) S5's brief over the same land: NO_TEMPLATE, s5_treehouses the closest (no tall trunk)
//     report             REPORT.md over the step JSONs
//
// Evidence: artifacts/gate-runs-tc/... (the runner's out dir; GATE7CTC_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-TC-run');
process.env.GATE6B_OUT = process.env.GATE7CTC_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7c-tc');
process.env.GATE6B_SIDECAR_PORT ??= '8896';
process.env.GATE6B_DEV_PORT ??= '8897';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, log, results, root, state } = L;

L.refuseKeys();
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const FLAT = 'G6B Flat Base';
const brief = (f) => JSON.parse(fs.readFileSync(path.join(root, 'scenarios', `${f}.json`), 'utf8')).brief;

const steps = {};
async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== ${name}`);
  try {
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (name !== 'report') L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice TC is $0: sim only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 1_800_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
function vitest(files, timeout = 1_800_000) {
  const r = spawnSync('npx', ['vitest', 'run', ...files], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(t);
  return { code: r.status, pass: m ? Number(m[2]) : -1, fail: m ? Number(m[1] ?? 0) : -1, failing: t.split('\n').filter((l) => /^\s*(×|FAIL)/.test(l)).slice(0, 20) };
}
steps.unit = async () => {
  spendZero();
  const out = {};
  out.kit = nodeTest(['kit/test/tc.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 6, `the kit (kit/test/tc.test.mjs): the catalogue's scenario programs, the land fixtures, the needs on the sculpted land only, a picked flat village, a picked cave city finding its hall: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  out.sidecar = vitest(['test/regions-tc.test.ts']);
  check(out.sidecar.code === 0 && out.sidecar.fail === 0 && out.sidecar.pass >= 13, `the sidecar with the real kit (test/regions-tc.test.ts): each scenario's brief over its land PICKED on its program, a cave city over plains NO_TEMPLATE with s6_cave_city the closest: ${out.sidecar.pass} pass, ${out.sidecar.fail} fail`, out.sidecar.failing);
  return out;
};

// ------------------------------------------------------------------ in game

const CLAIM = [0, 0, 159, 159];
/** The hill and its hall over the flat base's ground `g` (measured: the top solid cell of the claim's middle column). */
const HILL = (g) => ({ x0: 40, x1: 119, y0: g + 1, y1: g + 16, z0: 60, z1: 99 });
const HALL = (g) => ({ x0: 50, x1: 109, y0: g + 3, y1: g + 10, z0: 74, z1: 85 });
/** The top ROCK or SOIL cell of column (80, 80), read from a frozen volume of it (Survey.volume). */
async function groundY() {
  const v = await call('dev.survey.volume', { box: [80, -64, 80, 80, 200, 80], load: 'loaded' }, 600_000);
  if (v.refused) throw new Error(`Survey.volume refused: ${v.refused}`);
  const { decodeArvx, VC } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'region', 'volume.mjs')).href);
  const d = decodeArvx(fs.readFileSync(path.resolve(L.GAME_DIR, v.file)));
  for (let j = d.height - 1; j >= 0; j--) if ([VC.ROCK, VC.SOIL].includes(d.classes[j])) return d.box.minY + j;
  throw new Error('no ground in column 80,80');
}

async function design(tag, b, over = {}) {
  const d = await call('dev.region.design', { brief: b, claim: CLAIM, wait: true, ...over }, 1_800_000);
  log(`  ${tag}: ${d.status} ${json(d.result ?? d.error ?? d.refused)} $${(d.costUsd ?? 0).toFixed(4)} in ${((d.ms ?? 0) / 1000).toFixed(0)} s`);
  return d;
}

steps.pick = async () => {
  await ensure();
  spendZero();
  const out = {};
  await L.fresh('G6B TC Pick', FLAT);
  await L.setRules('exact');
  await cmd(`/forceload add ${CLAIM[0]} ${CLAIM[1]} ${CLAIM[2]} ${CLAIM[3]}`);
  await L.tp(80, 0, 80);
  await L.settle(3000);
  // (a) a cave city over the flat land
  const a = await design('a', 'a cave city');
  out.a = { status: a.status, result: a.result, refused: a.refused };
  check(a.status === 'DONE' && a.result?.outcome === 'NO_TEMPLATE' && a.result?.program === 's6_cave_city' && /s6_cave_city needs 1 cave \(floorArea >= 400, ceiling >= 6\) in the claim's land; it has 0/.test(a.result?.reason ?? ''),
    `(a) "a cave city" over the flat land: ${a.result?.outcome} closest ${a.result?.program}; the reason counts the claim's caves (the mod sent its volume, the helper analysed it): ${String(a.result?.reason ?? a.error ?? a.refused).slice(0, 300)}`);
  // (b) a stone hill with an enclosed hall, on the measured ground
  const g = await groundY();
  const hill = HILL(g), hall = HALL(g);
  out.ground = g;
  for (let y = hill.y0; y <= hill.y1; y += 8) out.fills = [...(out.fills ?? []), await cmd(`/fill ${hill.x0} ${y} ${hill.z0} ${hill.x1} ${Math.min(hill.y1, y + 7)} ${hill.z1} stone`)];
  out.fills.push(await cmd(`/fill ${hall.x0} ${hall.y0} ${hall.z0} ${hall.x1} ${hall.y1} ${hall.z1} air`));
  await L.settle(3000);
  const b = await design('b', brief('s6_cave_city'));
  out.b = { status: b.status, result: b.result, error: b.error, refused: b.refused };
  check(b.result?.outcome === 'PICKED' && b.result?.program === 's6_cave_city' && b.result?.fits === true,
    `(b) S6's brief ("${brief('s6_cave_city')}") over the hill with its hall: ${b.result?.outcome} ${b.result?.program} (${String(b.result?.reason ?? b.error ?? b.refused).slice(0, 200)}); the mod's plan: ${b.result?.planId ?? b.result?.planError ?? 'none'}`);
  // (c) S5's brief over the same land
  const c = await design('c', brief('s5_treehouses'));
  out.c = { status: c.status, result: c.result, refused: c.refused };
  check(c.result?.outcome === 'NO_TEMPLATE' && c.result?.program === 's5_treehouses' && /s5_treehouses needs 6 trunk \(height >= 24\) in the claim's land; it has 0/.test(c.result?.reason ?? ''),
    `(c) S5's brief over the hill: ${c.result?.outcome} closest ${c.result?.program}: ${String(c.result?.reason ?? c.error ?? c.refused).slice(0, 300)}`);
  await cmd(`/forceload remove ${CLAIM[0]} ${CLAIM[1]} ${CLAIM[2]} ${CLAIM[3]}`).catch(() => {});
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const lines = ['# Slice TC gate', ''];
  for (const s of ['unit', 'pick']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { lines.push(`- ${s}: not run`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rs = Object.entries(j.results ?? {});
    lines.push(`## ${s} (${j.seconds.toFixed(0)} s, head ${j.head.slice(0, 8)})`, '', ...rs.map(([m, r]) => `- ${r.ok ? 'PASS' : 'FAIL'} ${m}`), '');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { lines: lines.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7ctc.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
