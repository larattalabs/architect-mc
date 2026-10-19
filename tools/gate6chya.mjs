#!/usr/bin/env node
// (6c HY-a) The hydrology pass's own checks (docs/CONTRACT.md "Phase 6c slice HY" §14 items 1, 12 for the pass, 17 for the pass).
// Kit-only, $0, no game. Evidence in artifacts/gate6c-hy/hya/ (local, never committed).
//   node tools/gate6chya.mjs unchanged   every committed plan fixture (every dir under kit/test/fixtures/plan, the 59 asks included),
//                                        planned here and on origin/main (a detached worktree ../architect-mc-HYa-main), through the
//                                        two-plan flow: answers, overall and IR (kitVersion normalised) byte-identical, except the
//                                        fixtures with a course, race or ditch part (named in the output)
//   node tools/gate6chya.mjs timing      the pass alone, median of 3: the 1024 x 1024 synthetic claim (resolution 4: 256 x 256
//                                        cells), a 1024 x 1024-cell synthetic grid (a 4096 claim at resolution 4), and every committed
//                                        golden survey (S1 the largest), plus plan_v0 with and without a course part (recorded)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts', 'gate6c-hy', 'hya');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

/** Every fixture file with a plan: [dir/file, fixture]. */
function fixtures(root) {
  const base = path.join(root, 'kit', 'test', 'fixtures', 'plan');
  const out = [];
  for (const dir of fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory()).sort()) {
    for (const f of fs.readdirSync(path.join(base, dir)).filter((x) => x.endsWith('.json')).sort()) {
      const fx = JSON.parse(fs.readFileSync(path.join(base, dir, f), 'utf8'));
      const plan = fx.plan ?? fx.answer?.plan;
      if (plan) out.push([`${dir}/${f}`, { ...fx, plan, on: fx.on ?? (dir === 'asks' ? 'asks' : undefined) }]);
    }
  }
  return out;
}

/** A course, race or ditch part (compile.mjs isCoursePart on the raw plan). */
const hasCourse = (plan) => (plan.connectors ?? []).some((c) => c && c.kind === 'channel' && (c.from !== undefined || c.to !== undefined || c.via !== undefined || c.where?.along !== undefined));

async function unchanged() {
  const mainDir = path.resolve(ROOT, '..', 'architect-mc-HYa-main');
  execFileSync('git', ['-C', ROOT, 'fetch', '-q', 'origin', 'main']);
  const base = execFileSync('git', ['-C', ROOT, 'merge-base', 'HEAD', 'origin/main']).toString().trim();
  if (!fs.existsSync(path.join(mainDir, '.git'))) execFileSync('git', ['-C', ROOT, 'worktree', 'add', '-q', '--detach', mainDir, base]);
  else execFileSync('git', ['-C', mainDir, 'checkout', '-q', '--detach', base]);
  const H = (dir) => import(pathToFileURL(path.join(dir, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(ROOT), await H(mainDir)];
  const out = { base, head: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim(), fixtures: {} };
  const runOn = async (h, fx) => {
    const s = fx.terrain ? h.flatSurvey(fx.terrain) : fx.on === 'asks' ? h.asksSurvey() : fx.on === 'flat' ? h.flatSurvey() : fx.on ? h.goldenSurvey(fx.on) : h.flatSurvey();
    const o = { survey: s.bytes, claim: s.claim, anchors: { ...h.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], regions: fx.regions ?? [], builds: fx.builds ?? [], keepOut: fx.keepOut ?? [], budget: fx.budget ?? {}, ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}) };
    return h.checkPlanVolumes(fx.plan, { volume: fx.volume ?? {}, ...o });
  };
  const norm = (r) => r.res.irJson.replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"');
  const sig = (r) => ({ answers: sha256(JSON.stringify(r.check.parts)), overall: r.check.overall, ir: sha256(norm(r)), first: r.first && r.first !== r ? sha256(norm(r.first)) : null, passes: (r.res.meta.passes ?? []).map((p) => p.name) });
  const all = fixtures(ROOT);
  for (const [name, fx] of all) {
    const course = hasCourse(fx.plan);
    const existsOld = fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name));
    let a, b, err = null;
    try { a = sig(await runOn(hNew, fx)); } catch (e) { err = `head: ${String(e.message).slice(0, 160)}`; }
    try { b = sig(await runOn(hOld, fx)); } catch (e) { err = (err ? `${err}; ` : '') + `main: ${String(e.message).slice(0, 160)}`; }
    const same = !!a && !!b && a.answers === b.answers && a.overall === b.overall && a.ir === b.ir && a.first === b.first;
    const bothErr = !a && !b;
    out.fixtures[name] = { course, existsOld, same, ...(err ? { err } : {}), ...(a ? { passesHead: a.passes } : {}), ...(a && b && !same ? { head: a, main: b } : {}) };
    if (!course) check(same || (bothErr && err), `${name}: ${same ? 'byte-identical (answers, overall, IR)' : bothErr ? `errors on both (${err})` : `DIFFERS ${err ?? JSON.stringify({ head: a, main: b })}`}`);
    else console.log(`note ${name}: a course part (excepted): ${same ? 'identical' : 'differs'}; hydrology ran: ${!!a?.passes.includes('hydrology')}`);
    if (!course && a) check(!a.passes.includes('hydrology'), `${name}: the hydrology pass did not run`);
  }
  const rows = Object.values(out.fixtures);
  out.n = rows.length; out.same = rows.filter((r) => r.same).length; out.excepted = Object.entries(out.fixtures).filter(([, r]) => r.course).map(([k]) => k);
  out.differ = Object.entries(out.fixtures).filter(([, r]) => !r.course && !r.same && !r.err).map(([k]) => k);
  check(out.n >= 190, `${out.n} fixtures planned (every dir, the 59 asks included)`);
  check(out.differ.length === 0, `0 fixtures without a course part differ (${out.same} identical; excepted: ${out.excepted.join(', ') || 'none'})`);
  return out;
}

async function timing() {
  const K = (f) => import(pathToFileURL(path.join(ROOT, 'kit', 'lib', ...f.split('/'))).href);
  const { hydrologyPass } = await K('region/passes/hydrology.mjs');
  const { decodeColumns } = await K('region/pack.mjs');
  const { synthSurvey, synthColumns } = await K('region/synth.mjs');
  const med = (xs) => [...xs].sort((p, q) => p - q)[1];
  const time = (c, intent) => { const ms = []; let data; for (let i = 0; i < 3; i++) { const t = performance.now(); const o = hydrologyPass(c, [], intent); ms.push(Math.round((performance.now() - t) * 10) / 10); data = o.data; } return { ms, median: med(ms), cells: c.width * c.depth, res: c.resolution, courses: data.courses?.length ?? null, maxAccumulation: data.maxAccumulation }; };
  const out = { pass: {}, plan: {} };
  out.pass.synth_claim_1024 = time(synthSurvey({ minX: 0, minZ: 0, maxX: 1023, maxZ: 1023 }), { channelAt: 400 });
  out.pass.synth_grid_1024 = time(synthColumns({ minX: 0, minZ: 0, width: 1024, depth: 1024, resolution: 4 }), { channelAt: 400 });
  const gdir = path.join(ROOT, 'scenarios', 'goldens');
  for (const d of fs.readdirSync(gdir).sort()) {
    const f = path.join(gdir, d, 'survey.bin');
    if (fs.existsSync(f)) out.pass[`golden_${d}`] = time(decodeColumns(fs.readFileSync(f)), { channelAt: 400 });
  }
  for (const [k, v] of Object.entries(out.pass)) console.log(`note timing (recorded): ${k} ${v.cells} cells (res ${v.res}): median ${v.median} ms of [${v.ms.join(', ')}]`);
  // plan_v0 on the asks claim with a course part (the pass runs) and the same plan without it
  const h = await import(pathToFileURL(path.join(ROOT, 'kit', 'test', 'plan-helpers.mjs')).href);
  const s = h.asksSurvey();
  const anchors = h.stewardAnchors(s.claim);
  const course = { schemaVersion: 'plan/0', planId: 'hya_timing', connectors: [{ id: 'brook', kind: 'channel', from: { anchor: 'street_w' }, to: { feature: { water: 'any' } } }] };
  const plain = { schemaVersion: 'plan/0', planId: 'hya_timing', connectors: [{ id: 'lane', kind: 'path', from: { anchor: 'street_w' }, to: { anchor: 'street_e' } }] };
  for (const [k, plan] of [['with_course', course], ['without', plain]]) {
    const ms = [];
    let passMs = null;
    for (let i = 0; i < 3; i++) { const t = performance.now(); const r = await h.checkPlanLocal(plan, { survey: s.bytes, claim: s.claim, anchors }); ms.push(Math.round(performance.now() - t)); passMs = (r.res.meta.passes ?? []).find((p) => p.name === 'hydrology')?.ms ?? null; }
    out.plan[k] = { ms, median: med(ms), hydrologyMs: passMs };
    console.log(`note plan_v0 on the asks claim (320 x 320) ${k}: median ${med(ms)} ms of [${ms.join(', ')}]; the pass ${passMs ?? '-'} ms`);
  }
  return out;
}

const cmd = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const res = cmd === 'unchanged' ? await unchanged() : cmd === 'timing' ? await timing() : null;
if (!res) { console.error('usage: node tools/gate6chya.mjs unchanged|timing'); process.exit(2); }
fs.writeFileSync(path.join(OUT, `${cmd}.json`), JSON.stringify({ ...res, ms: Date.now() - t0 }, null, 2));
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
