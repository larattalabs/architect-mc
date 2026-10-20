// (6c KC) The kit-only items of slice KC (docs/CONTRACT.md "Phase 6c slice KC" §8, §10 items 2 and 3): byte identity against the
// merge base (a detached worktree ../architect-mc-KC-main), the watch count, and the recorded plans' before and after. $0, no game.
//   unchanged(root)   every committed plan fixture (every dir under kit/test/fixtures/plan, the 59 asks included) through the two-plan
//                     flow (its style, its volume spec) here and on the base: answers, overall, the IR (kitVersion normalised) and the
//                     first plan's IR byte-identical, except the fixtures named in EXCEPT (each with the body and writer it met). On the
//                     base, the M25:clear census (this checkout's clearScan over the base's IR and virtual world): the fixtures where
//                     another part writes a cell of a body's hard or watch set (the watch count, §8)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** §8's named exceptions: fixture -> why it moves (the body and the writer that met it). */
export const EXCEPT = Object.freeze({
  'valid/v51_voc_forge.json': 'forge_wall (connector.wall) wrote 5 water, 5 rim and 24 watch cells of w_fount (form.fountain): now refused OVERLAP {kind: body}, wouldFit ring [4, 17]',
});

/** Every fixture file with a plan under `root`: [[dir/file, fixture]]. */
export function fixtures(root) {
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

/** Plan a fixture with a tree's helpers (h: plan-helpers.mjs of that tree). */
export async function planFixture(h, root, fx) {
  const s = fx.terrain ? h.flatSurvey(fx.terrain) : fx.on === 'asks' ? h.asksSurvey() : fx.on === 'flat' ? h.flatSurvey() : fx.on ? h.goldenSurvey(fx.on) : h.flatSurvey();
  const style = typeof fx.style === 'string' ? JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'bibles', `${fx.style}.json`), 'utf8')) : fx.style ?? null;
  const o = { survey: s.bytes, claim: s.claim, anchors: { ...h.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], regions: fx.regions ?? [], builds: fx.builds ?? [], keepOut: fx.keepOut ?? [], budget: fx.budget ?? {}, ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}), ...(style ? { style } : {}) };
  const r = await h.checkPlanVolumes(fx.plan, { volume: fx.volume ?? {}, ...o });
  return { r, s };
}

/** The base worktree at the merge base with origin/main (made or moved there). */
export function baseTree(root) {
  const dir = path.resolve(root, '..', 'architect-mc-KC-main');
  execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
  const base = execFileSync('git', ['-C', root, 'merge-base', 'HEAD', 'origin/main']).toString().trim();
  if (!fs.existsSync(path.join(dir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', dir, base]);
  else execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach', base]);
  return { dir, base };
}

export async function unchanged(root, { check, log = console.log, only = null } = {}) {
  const { dir: mainDir, base } = baseTree(root);
  const H = (d) => import(pathToFileURL(path.join(d, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(mainDir)];
  const K = (f) => import(pathToFileURL(path.join(root, 'kit', 'lib', ...f.split('/'))).href);
  const { clearScan, bodiesOf } = await K('region/checkFluids.mjs');
  const { buildVirtual } = await K('region/vworld.mjs');
  const { fillMissing } = await K('region/plan.mjs');
  const { asColumns } = await K('region/pack.mjs');
  const norm = (r) => r.res.irJson.replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"');
  const sig = (r) => ({ answers: sha256(JSON.stringify(r.check.parts)), overall: r.check.overall, ir: sha256(norm(r)), first: r.first && r.first !== r ? sha256(norm(r.first)) : null });
  const out = { base, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), fixtures: {}, watch: [], hard: [] };
  for (const [name, fx] of fixtures(root)) {
    if (only && !only.test(name)) continue;
    const existsOld = fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name));
    let a, b, err = null, census = null;
    let headRun = null;
    try { headRun = await planFixture(hNew, root, fx); a = sig(headRun.r); } catch (e) { err = `head: ${String(e.message).slice(0, 160)}`; }
    if (existsOld) {
      try {
        const { r, s } = await planFixture(hOld, mainDir, fx);
        b = sig(r);
        const ir = JSON.parse(r.res.irJson);
        if (bodiesOf(ir).length) {
          const cols = fillMissing(asColumns(s.bytes)).columns;
          const { vw } = buildVirtual({ ir, survey: cols, filled: cols, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: r.volumes.map((v) => v.decoded ?? v) });
          const sc = clearScan({ ir, vw, meta: r.res.meta });
          census = { counts: sc.counts, findings: sc.findings.map((q) => ({ body: q.body, part: q.part, set: q.set, writer: q.writer, writerPart: q.writerPart, why: q.why, count: q.count })) };
          if (sc.counts.watch) out.watch.push({ fixture: name, cells: sc.counts.watch, writers: [...new Set(sc.findings.filter((q) => q.set === 'watch').map((q) => `${q.writerPart ?? q.writer} in ${q.body}`))] });
          if (sc.counts.hard) out.hard.push({ fixture: name, cells: sc.counts.hard, writers: [...new Set(sc.findings.filter((q) => q.set !== 'watch').map((q) => `${q.writerPart ?? q.writer} in ${q.body}.${q.set}`))] });
        }
      } catch (e) { err = (err ? `${err}; ` : '') + `base: ${String(e.message).slice(0, 160)}`; }
    }
    // the head's census: M25:clear 0 on every fixture but the broken variants (kc/u*)
    if (headRun) try {
      const { r, s } = headRun;
      const ir = JSON.parse(r.res.irJson);
      if (bodiesOf(ir).length) {
        const cols = fillMissing(asColumns(s.bytes)).columns;
        const { vw } = buildVirtual({ ir, survey: cols, filled: cols, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: r.volumes.map((v) => v.decoded ?? v) });
        const sc = clearScan({ ir, vw, meta: r.res.meta });
        const broken = /^kc\/u\d/.test(name) || /^irr\/u01_/.test(name); // ((6c IRR) irrigation's M25:clear variant, u01, too)
        (out.headCensus ??= {})[name] = sc.counts;
        if (broken) check(sc.counts.hard + sc.counts.watch > 0, `${name} (a broken variant): M25:clear catches it on this head (${JSON.stringify(sc.counts)})`);
        else check(sc.counts.hard + sc.counts.watch === 0, `${name}: M25:clear 0 on this head (${JSON.stringify(sc.counts)})`);
      }
    } catch (e) { check(false, `${name}: the head's census threw (${String(e.message).slice(0, 160)})`); }
    const same = !!a && !!b && a.answers === b.answers && a.overall === b.overall && a.ir === b.ir && a.first === b.first;
    const ex = EXCEPT[name] ?? null;
    out.fixtures[name] = { existsOld, same, ...(ex ? { excepted: ex } : {}), ...(err ? { err } : {}), ...(census ? { census } : {}), ...(a && b && !same ? { head: a, base: b } : {}) };
    if (!existsOld) { log(`note ${name}: new on this branch`); continue; }
    // ((6c IRR) after KC merged, the base holds the named fixture as repaired: identical then, the exception already on the base)
    const onBase = existsOld && fs.readFileSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name), 'utf8') === fs.readFileSync(path.join(root, 'kit', 'test', 'fixtures', 'plan', name), 'utf8') && execFileSync('git', ['-C', mainDir, 'log', '-1', '--format=%H', '--', 'kit/lib/fluids/keep.mjs']).toString().trim() !== '';
    if (ex) { check(!same || onBase, `${name}: excepted by name (${ex}): ${same ? (onBase ? 'identical: the base already has KC (the exception merged)' : 'UNCHANGED (the exception did not move)') : 'differs, as named'}`); continue; }
    check(same || (!a && !b), `${name}: ${same ? 'byte-identical (answers, overall, IR, first plan)' : !a && !b ? `errors on both (${err})` : `DIFFERS ${err ?? JSON.stringify({ head: a, base: b })}`}`);
  }
  const rows = Object.entries(out.fixtures).filter(([, r]) => r.existsOld);
  out.n = rows.length;
  out.same = rows.filter(([, r]) => r.same).length;
  out.differ = rows.filter(([, r]) => !r.same && !r.excepted).map(([k]) => k);
  out.watchCount = out.watch.length;
  if (!only) check(out.n >= 230, `${out.n} committed fixtures planned (every dir, the 59 asks included)`);
  check(out.differ.length === 0, `${out.same} of ${out.n} byte-identical; the rest exactly the named exceptions (${Object.keys(EXCEPT).join(', ')})`);
  log(`watch count (recorded, §8): ${out.watch.length} committed fixture(s) where another part writes a body's watch cell on the base: ${out.watch.map((w) => `${w.fixture} (${w.cells}: ${w.writers.join(', ')})`).join('; ') || 'none'}`);
  log(`hard count (recorded): ${out.hard.length} fixture(s): ${out.hard.map((w) => `${w.fixture} (${w.cells}: ${w.writers.join(', ')})`).join('; ') || 'none'}`);
  return out;
}
