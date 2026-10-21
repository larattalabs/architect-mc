// (6c RS) The kit-only items of slice RS (docs/CONTRACT.md "Phase 6c slice RS" §11, §13 items 2 and 3): byte identity against the merge
// base (a detached worktree ../architect-mc-RS-main at `git merge-base HEAD origin/main`), a creative realise's tile shas, and Steward's
// recorded plans before and after (fixtures/plan/rs/asks-creative.md, asks-survival.md). $0, no game.
//   unchanged(root)      every committed plan fixture (every dir under kit/test/fixtures/plan, the 59 asks included) through the two-plan
//                        flow (its style, its volume spec) here and on the base, in creative: answers, overall, the IR (kitVersion
//                        normalised) and the first plan's IR byte-identical. RS adds no exception: a creative check is unchanged.
//   creativeTiles(root)  rs02's creative IR on both trees, every tile of every stage and set evaluated over its survey: the payload shas equal
//                        (what a creative realise of rs02 writes, tile for tile)
//   asksTables(root)     the 59 asks in creative (as the base: the class table, kitVersion aside) and in survival (each part's class, which
//                        must not change, and its cost.survival); written to OUT and compared with the committed tables
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Every fixture file with a plan under `root`: [[dir/file, fixture]] (rs/'s game fixtures aside: their region is the gate's). */
export function fixtures(root) {
  const base = path.join(root, 'kit', 'test', 'fixtures', 'plan');
  const out = [];
  for (const dir of fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory()).sort()) {
    for (const f of fs.readdirSync(path.join(base, dir)).filter((x) => x.endsWith('.json')).sort()) {
      const fx = JSON.parse(fs.readFileSync(path.join(base, dir, f), 'utf8'));
      const plan = fx.plan ?? fx.answer?.plan;
      if (plan && !fx.game) out.push([`${dir}/${f}`, { ...fx, plan, on: fx.on ?? (dir === 'asks' ? 'asks' : undefined) }]);
    }
  }
  return out;
}

/** Plan a fixture with a tree's helpers (h: plan-helpers.mjs of that tree); `survival` only on this head. */
export async function planFixture(h, root, fx, { survival = false } = {}) {
  const s = fx.terrain ? h.flatSurvey(fx.terrain) : fx.on === 'asks' ? h.asksSurvey() : fx.on === 'flat' ? h.flatSurvey() : fx.on ? h.goldenSurvey(fx.on) : h.flatSurvey();
  const style = typeof fx.style === 'string' ? JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'bibles', `${fx.style}.json`), 'utf8')) : fx.style ?? null;
  const o = { survey: s.bytes, claim: s.claim, anchors: { ...h.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], regions: fx.regions ?? [], builds: fx.builds ?? [], keepOut: fx.keepOut ?? [], budget: fx.budget ?? {}, ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}), ...(style ? { style } : {}), ...(survival ? { survival: true } : {}) };
  const r = await h.checkPlanVolumes(fx.plan, { volume: fx.volume ?? {}, ...o });
  return { r, s };
}

/** The base worktree at the merge base with origin/main (made or moved there). */
export function baseTree(root) {
  const dir = path.resolve(root, '..', 'architect-mc-RS-main');
  execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
  const base = execFileSync('git', ['-C', root, 'merge-base', 'HEAD', 'origin/main']).toString().trim();
  if (!fs.existsSync(path.join(dir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', dir, base]);
  else execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach', base]);
  return { dir, base };
}

const norm = (s) => s.replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"');
const sig = (r) => ({ answers: sha256(norm(JSON.stringify(r.check.parts))), overall: r.check.overall, ir: sha256(norm(r.res.irJson)), first: r.first && r.first !== r ? sha256(norm(r.first.res.irJson)) : null });

export async function unchanged(root, { check, log = console.log, only = null } = {}) {
  const { dir: mainDir, base } = baseTree(root);
  const H = (d) => import(pathToFileURL(path.join(d, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(mainDir)];
  const out = { base, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), fixtures: {} };
  for (const [name, fx] of fixtures(root)) {
    if (only && !only.test(name)) continue;
    const existsOld = fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name));
    let a = null, b = null, err = null;
    try { a = sig((await planFixture(hNew, root, fx)).r); } catch (e) { err = `head: ${String(e.message).slice(0, 160)}`; }
    if (existsOld) try { b = sig((await planFixture(hOld, mainDir, fx)).r); } catch (e) { err = (err ? `${err}; ` : '') + `base: ${String(e.message).slice(0, 160)}`; }
    const same = !!a && !!b && a.answers === b.answers && a.overall === b.overall && a.ir === b.ir && a.first === b.first;
    out.fixtures[name] = { existsOld, same, ...(err ? { err } : {}), ...(a && b && !same ? { head: a, base: b } : {}) };
    if (!existsOld) { log(`note ${name}: new on this branch`); continue; }
    check(same || (!a && !b), `item 2: ${name}: ${same ? 'byte-identical in creative (answers, overall, IR, first plan; kitVersion normalised)' : !a && !b ? `errors on both (${err})` : `DIFFERS ${err ?? JSON.stringify({ head: a, base: b })}`}`);
  }
  const rows = Object.entries(out.fixtures).filter(([, r]) => r.existsOld);
  out.n = rows.length;
  out.same = rows.filter(([, r]) => r.same).length;
  out.differ = rows.filter(([, r]) => !r.same).map(([k]) => k);
  if (!only) check(out.n >= 230, `item 2: ${out.n} committed fixtures planned in creative on both trees (every dir, the 59 asks included)`);
  check(out.differ.length === 0, `item 2: ${out.same} of ${out.n} committed plan fixtures byte-identical in creative to the merge base ${base.slice(0, 10)}`);
  return out;
}

/** rs02's creative tiles on both trees: every tile of every stage and set over its survey, the payload shas. */
export async function creativeTiles(root, { check, log = console.log } = {}) {
  const { dir: mainDir, base } = baseTree(root);
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'kit', 'test', 'fixtures', 'plan', 'rs', 'rs02_walled.json'), 'utf8'));
  const shas = async (dir) => {
    const h = await import(pathToFileURL(path.join(dir, 'kit', 'test', 'plan-helpers.mjs')).href);
    const { evalAll } = await import(pathToFileURL(path.join(dir, 'kit', 'lib', 'plan', 'finish.mjs')).href);
    const { fillMissing } = await import(pathToFileURL(path.join(dir, 'kit', 'lib', 'region', 'plan.mjs')).href);
    const { asColumns } = await import(pathToFileURL(path.join(dir, 'kit', 'lib', 'region', 'pack.mjs')).href);
    const { r, s } = await planFixture(h, dir, fx);
    const ev = evalAll(r.res.ir, fillMissing(asColumns(s.bytes)).columns, (sha) => r.res.blobs.get(sha) ?? null);
    return ev.tiles;
  };
  const [a, b] = [await shas(root), await shas(mainDir)];
  const flat = (t) => Object.entries(t).flatMap(([st, sets]) => Object.entries(sets).flatMap(([set, keys]) => Object.entries(keys).map(([k, v]) => `${st}|${set}|${k} ${v}`))).sort();
  const fa = flat(a), fb = flat(b);
  const same = JSON.stringify(fa) === JSON.stringify(fb);
  check(same && fa.length > 0, `item 2: a creative realise of rs02 writes the same tiles as before: ${fa.length} tile payloads, their shas equal to the merge base ${base.slice(0, 10)}'s${same ? '' : ` (differ: ${fa.filter((x) => !fb.includes(x)).slice(0, 4).join('; ')})`}`);
  log(`  rs02's creative tiles: ${fa.length}`);
  return { tiles: fa.length, same };
}

/** The 59 asks' tables: creative (as the base) and survival (each part's class unchanged, its cost.survival). */
export async function asksTables(root, { check, OUT }) {
  const { dir: mainDir } = baseTree(root);
  const { asksGap } = await import(pathToFileURL(path.join(root, 'tools', 'lib', 'gate6chy-b.mjs')).href);
  const before = await asksGap(path.join(mainDir, 'kit')), after = await asksGap(path.join(root, 'kit'));
  const F = path.join(root, 'kit', 'test', 'fixtures', 'plan', 'rs');
  fs.writeFileSync(path.join(OUT, 'rs-asks-creative-base.md'), before.text);
  fs.writeFileSync(path.join(OUT, 'rs-asks-creative.md'), after.text);
  check(before.text === after.text && after.malformed === 0, `item 2 (§11): the 59 asks in creative on this head equal the merge base's table, part for part (${after.malformed} malformed)`);
  const committed = fs.existsSync(path.join(F, 'asks-creative.md')) ? fs.readFileSync(path.join(F, 'asks-creative.md'), 'utf8') : null;
  check(committed === after.text, `item 2 (§11): fixtures/plan/rs/asks-creative.md is this table${committed === null ? ' (missing)' : ''}`);
  // survival: every part's class as in creative, its cost.survival summary
  const H = await import(pathToFileURL(path.join(root, 'kit', 'test', 'plan-helpers.mjs')).href);
  const dir = path.join(root, 'kit', 'test', 'fixtures', 'plan', 'asks');
  const s = H.asksSurvey();
  const lines = [];
  const moved = [];
  let malformed = 0, refusedSurvival = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json').sort()) {
    const plan = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).answer.plan;
    const c = await H.checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: H.stewardAnchors(s.claim), volume: {} });
    const v = await H.checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: H.stewardAnchors(s.claim), volume: {}, survival: true });
    const cls = Object.fromEntries(c.check.parts.map((a) => [a.part, a.class]));
    for (const a of v.check.parts) {
      if (a.class === 'malformed') malformed++;
      if (a.reasons?.some((x) => x.code === 'SURVIVAL')) refusedSurvival++;
      if (cls[a.part] !== a.class) moved.push(`${f.replace('.json', '')}/${a.part} ${cls[a.part]} -> ${a.class}`);
      const sv = a.cost?.survival;
      lines.push(`${f.replace('.json', '')}/${a.part} ${a.block} ${a.class}${sv ? ` free ${sv.free} held ${sv.held} paid-items ${Object.values(sv.bom).reduce((x, y) => x + y, 0)}${sv.charged ? ` charged ${JSON.stringify(sv.charged)}` : ''}` : ''}`);
    }
    lines.push(`${f.replace('.json', '')} cost.bom ${Object.values(v.check.cost.bom ?? {}).reduce((x, y) => x + y, 0)} items; survival ${v.check.survival}`);
  }
  const text = `${['# 59 asks in survival (kit; the mod adds the lots\' and 4e roads\' bills): class, then free and held cells and the paid cells\' items per part',
    `# ${malformed} malformed, ${refusedSurvival} refused SURVIVAL, ${moved.length} part(s) changed class from creative`, ...lines].join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'rs-asks-survival.md'), text);
  const committedS = fs.existsSync(path.join(F, 'asks-survival.md')) ? fs.readFileSync(path.join(F, 'asks-survival.md'), 'utf8') : null;
  check(malformed === 0 && moved.length === 0 && refusedSurvival === 0, `item 2 (§11): the 59 asks in survival: 0 malformed (${malformed}), no part changes class (${moved.length}${moved.length ? `: ${moved.slice(0, 6).join('; ')}` : ''}), no SURVIVAL refusal predicted or found (${refusedSurvival})`);
  check(committedS === text, `item 2 (§11): fixtures/plan/rs/asks-survival.md is this table${committedS === null ? ' (missing)' : ''}`);
  return { moved, malformed, refusedSurvival };
}
