// (6c FL) The kit-only items of slice FL (docs/CONTRACT.md "Phase 6c slice FL" §8, §9, §10 items 4, 8, 11, 12): byte identity against the
// merge base with origin/main (a detached worktree ../architect-mc-FL-main), the untouched files, the asks before and after, the timing
// and the compact plan/0's size. Offline and $0.
//   unchanged(root)   every committed plan fixture (every dir under kit/test/fixtures/plan, the 59 asks included) through the two-plan
//                     flow here and on the base: answers, overall, the IR and the first plan's IR byte-identical, the IR normalised for
//                     kitVersion and for the street roads' new ext (S-FL-5: `roads[].ext["architect_mc:street"]`, every V, D1, D2 and FL
//                     street; asserted separately in kit/test/fl.test.mjs), except the fixtures named in EXCEPT
//   untouched(root)   village.mjs, followEmit.mjs, districtsEmit.mjs and plan_v0.mjs are the base's, byte for byte (§8)
//   asks(root)        the 59 asks' every part, before (the base) and after (this head): fixtures/plan/fl/asks-before.md, asks-after.md
//   timing(root)      plan time of each layout on a 256 x 256 claim with 40 lots (median of 3), the candidates evaluated (item 11)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fixtures, planFixture } from './gate6ckc-kit.mjs';
import { SIBLING_FILES } from './batch-0410.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** §8's named exceptions: fixture -> why it moves. */
export const EXCEPT = Object.freeze({
  'asks/around_my_tree.json': 'layout.ring supported: grove answers fits (a ring of 9 lots, the hall in the hub)',
  'asks/nomad_camp.json': 'layout.ring supported: camp answers fits (11 lots, the council tent and the fire in the hub)',
  'asks/ring_city.json': 'layout.ring supported: ring_town answers blocked (its explicit dependency on crater_lake, form.crater until 7c), no longer unsupported',
  'asks/grid_city.json': 'layout.grid supported: grid_city answers fits (3 x 3 blocks round the plaza)',
  'asks/organic_hamlet.json': 'layout.organic supported: hamlet answers fits (lanes from the well green)',
  'extension/e07_ring_layout.json': 'layout.ring supported: the ring answers fits (the fixture moved by name)',
  'extension/e14_sketch_outline.json': 'sketch.outline supported: the outline answers fits (the fixture moved by name)',
  'extension/e15_every_reserved_a.json': 'the six FL ids supported: z2-z5, z7 and z11 answer (they left the reserved list)',
  'extension/e16_every_reserved_b.json': 'named by §8 (its reserved list); judged as any other: it may stay byte-identical',
});

/** The base worktree at the merge base with origin/main (made or moved there). */
export function baseTree(root) {
  const dir = path.resolve(root, '..', 'architect-mc-FL-main');
  execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
  const base = execFileSync('git', ['-C', root, 'merge-base', 'HEAD', 'origin/main']).toString().trim();
  if (!fs.existsSync(path.join(dir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', dir, base]);
  else execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach', base]);
  return { dir, base };
}

/** An IR's JSON normalised: kitVersion, and the street roads' S-FL-5 ext (dropped, with ext itself when nothing else is in it). */
export function normIr(json) {
  const ir = JSON.parse(json.replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"'));
  for (const r of ir.roads ?? []) {
    if (!r.ext) continue;
    delete r.ext['architect_mc:street'];
    if (!Object.keys(r.ext).length) delete r.ext;
  }
  return JSON.stringify(ir);
}

export async function unchanged(root, { check, log = console.log, only = null } = {}) {
  const { dir: mainDir, base } = baseTree(root);
  const H = (d) => import(pathToFileURL(path.join(d, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(mainDir)];
  const sig = (r) => ({ answers: sha256(JSON.stringify(r.check.parts)), overall: r.check.overall, ir: sha256(normIr(r.res.irJson)), first: r.first && r.first !== r ? sha256(normIr(r.first.res.irJson)) : null });
  const out = { base, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), fixtures: {}, added: [], streetsMarked: 0 };
  for (const [name, fx] of fixtures(root)) {
    if (only && !only.test(name)) continue;
    if (!fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name))) { out.added.push(name); continue; }
    // a fixture this branch moved by name is planned from its base copy on the base (its old expectation) and its own here
    const oldFx = JSON.parse(fs.readFileSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name), 'utf8'));
    const oldPlan = { ...oldFx, plan: oldFx.plan ?? oldFx.answer?.plan, on: oldFx.on ?? (name.startsWith('asks/') ? 'asks' : undefined) };
    let a, b, err = null;
    try { const { r } = await planFixture(hNew, root, fx); a = sig(r); out.streetsMarked += (JSON.parse(r.res.irJson).roads ?? []).filter((x) => x.ext?.['architect_mc:street']).length; } catch (e) { err = `head: ${String(e.message).slice(0, 160)}`; }
    try { b = sig((await planFixture(hOld, mainDir, oldPlan)).r); } catch (e) { err = (err ? `${err}; ` : '') + `base: ${String(e.message).slice(0, 160)}`; }
    const same = !!a && !!b && a.answers === b.answers && a.overall === b.overall && a.ir === b.ir && a.first === b.first;
    const named = EXCEPT[name];
    out.fixtures[name] = { same, ...(err ? { err } : {}), ...(a && b && !same ? { head: a, base: b } : {}), ...(named ? { named } : {}) };
    if (named) { check(true, `${name}: ${same ? 'byte-identical' : 'differs'} (named: ${named})`); continue; }
    check(same || (!a && !b), `${name}: ${same ? 'byte-identical (answers, overall, IR, first plan; kitVersion and the street ext normalised)' : !a && !b ? `errors on both (${err})` : `DIFFERS ${err ?? JSON.stringify({ head: a, base: b })}`}`);
  }
  const rows = Object.entries(out.fixtures);
  out.n = rows.length;
  out.same = rows.filter(([, r]) => r.same).length;
  out.differ = rows.filter(([, r]) => !r.same && !r.named && !/errors on both/.test(r.err ?? '')).map(([k]) => k);
  out.namedMoved = rows.filter(([, r]) => !r.same && r.named).map(([k]) => k);
  if (!only) check(out.n >= 230, `${out.n} committed fixtures planned on both (every dir, the 59 asks included)`);
  check(out.differ.length === 0, `${out.same} of ${out.n} byte-identical; moved, all named: ${out.namedMoved.join(', ') || 'none'}; new on this branch (not compared): ${out.added.length}`);
  return out;
}

/** §8: the files FL leaves untouched (the diff against the merge base is empty for each). */
export function untouched(root, { check }) {
  const base = execFileSync('git', ['-C', root, 'merge-base', 'HEAD', 'origin/main']).toString().trim();
  const files = ['kit/lib/region/village.mjs', 'kit/lib/region/followEmit.mjs', 'kit/lib/region/districtsEmit.mjs', 'kit/regions/plan_v0.mjs'];
  const out = {};
  for (const f of files) {
    const d = execFileSync('git', ['-C', root, 'diff', '--stat', base, 'HEAD', '--', f]).toString().trim();
    out[f] = d === '' ? 'unchanged' : d;
    // ((batch v0.41.0) a file a sibling slice changes is that slice's: FL's own commits must leave it alone)
    if (d !== '' && SIBLING_FILES[f]) {
      let fl = null;
      try { fl = execFileSync('git', ['-C', root, 'log', '--format=%h %s', `${base}..origin/slice/FL`, '--', f], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no slice/FL ref */ }
      check(fl === '' || fl === null, `item 4: ${f} untouched by FL's own commits${fl === null ? ' (no origin/slice/FL ref to read: not judged)' : ''} (changed since the merge base ${base.slice(0, 8)}: ${SIBLING_FILES[f]})`);
      continue;
    }
    check(d === '', `item 4: ${f} untouched since the merge base ${base.slice(0, 8)}`);
  }
  return out;
}

/** The 59 asks' every part, as KC's asks-before.md lists them, over a tree's helpers. */
async function asksTable(h) {
  const dir = path.join(h.FIX, 'asks');
  const tally = {}, gaps = {}, rows = [];
  const S = h.asksSurvey();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json').sort()) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const r = await h.checkPlanLocal(fx.answer.plan, { survey: S.bytes, claim: S.claim, anchors: h.stewardAnchors(S.claim) });
    for (const a of r.check.parts) {
      tally[a.class] = (tally[a.class] ?? 0) + 1;
      if (a.class === 'unsupported') gaps[a.block] = (gaps[a.block] ?? 0) + 1;
      rows.push(`${f.replace('.json', '')}/${a.part} ${a.block} ${a.class}${a.reasons?.[0]?.code ? ` ${a.reasons[0].code}` : ''}${a.class === 'unsupported' && a.reasons?.[0]?.until ? ` until ${a.reasons[0].until}` : ''}`);
    }
  }
  const head = `# 59 asks: ${Object.entries(tally).sort().map(([k, v]) => `${k} ${v}`).join(', ')}`;
  const g = Object.entries(gaps).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `  ${k.padEnd(24)} ${v}`);
  return { text: [head, '# gap table (unsupported parts per block id):', ...g, '# every part:', ...rows, ''].join('\n'), tally, gaps, rows };
}

/** §9: the asks before (the base) and after (this head), written to fixtures/plan/fl/; the five free zones and the gap table. */
export async function asks(root, { check, write = true }) {
  const { dir } = baseTree(root);
  const H = (d) => import(pathToFileURL(path.join(d, 'kit', 'test', 'plan-helpers.mjs')).href);
  const before = await asksTable(await H(dir)), after = await asksTable(await H(root));
  if (write) {
    fs.writeFileSync(path.join(root, 'kit', 'test', 'fixtures', 'plan', 'fl', 'asks-before.md'), before.text);
    fs.writeFileSync(path.join(root, 'kit', 'test', 'fixtures', 'plan', 'fl', 'asks-after.md'), after.text);
  }
  const moved = after.rows.filter((r) => !before.rows.includes(r));
  const five = ['around_my_tree/grove', 'nomad_camp/camp', 'ring_city/ring_town', 'grid_city/grid_city', 'organic_hamlet/hamlet'];
  check(moved.every((r) => five.some((p) => r.startsWith(`${p} `))) && five.every((p) => moved.some((r) => r.startsWith(`${p} `))), `item 8: exactly the five free zones change class: ${moved.join('; ')}`);
  check(!['layout.ring', 'layout.grid', 'layout.organic'].some((k) => after.gaps[k]) && before.gaps['layout.ring'] === 3 && before.gaps['layout.grid'] === 1 && before.gaps['layout.organic'] === 1, `item 8: the gap table's layout.ring ${before.gaps['layout.ring']}, layout.grid ${before.gaps['layout.grid']}, layout.organic ${before.gaps['layout.organic']} become 0; 0 malformed (${after.tally.malformed ?? 0})`);
  check(!after.tally.malformed, 'item 8: 0 malformed');
  return { before: before.tally, after: after.tally, moved };
}

/** Item 11 (recorded): plan time of each layout on a 256 x 256 claim with 40 lots (median of 3), with the candidates evaluated. */
export async function timing(root) {
  const h = await import(pathToFileURL(path.join(root, 'kit', 'test', 'plan-helpers.mjs')).href);
  const s = h.flatSurvey({ W: 256, D: 256, x0: 1000, z0: 2000, y: 64 });
  const sizes = [[9, 9], [9, 9], [13, 11], [9, 9], [11, 9]];
  const lots = Array.from({ length: 40 }, (_, i) => ({ id: `t${i + 1}`, type: 'house', size: sizes[i % sizes.length], ...(i < 2 ? { placement: 'central' } : {}) }));
  const out = {};
  for (const layout of ['ring', 'spiral', 'grid', 'organic']) {
    const ms = [];
    let r = null;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      r = await h.checkPlanLocal({ schemaVersion: 'plan/0', zones: [{ id: 'z', program: { layout, lots } }] }, { survey: s.bytes, claim: s.claim, anchors: h.stewardAnchors(s.claim) });
      ms.push(Math.round(performance.now() - t0));
    }
    ms.sort((a, b) => a - b);
    const a = r.check.parts[0];
    out[layout] = { medianMs: ms[1], ms, class: a.class, lots: a.geometry?.lots?.length ?? 0, unplaced: a.geometry?.unplaced?.length ?? null, notes: a.notes ?? [] };
  }
  return out;
}
