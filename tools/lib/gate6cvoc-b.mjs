// (6c VOC) VOC-b's items of the VOC gate (tools/gate6cvoc.mjs; docs/CONTRACT.md "Phase 6c slice VOC" §8): budgets and rules. VOC-b owns
// this file. A map of the driver's step -> named items `{name, async run(ctx)}`, run after VOC-a's items of the same step
// (tools/lib/gate6cvoc-a.mjs). `ctx`: {L (tools/lib/run6b.mjs), OUT, KIT, imp(kit path), json, root, check, log}.
//
//   unit      (voc-unit)      items 6 and 7 (kit: kit/test/vocab-rules.test.mjs; sidecar: test/vocb.test.ts; Java: WireVocbTest), item 13's
//                             timing (recorded): the compile-time M27/M20 pass per valid/ plan, M26/M27 on mega_bench A; the census of
//                             committed plans the new rules fire on (M20 (b), cost.rarity, cost.creativeOnly: expected none)
//   ingame    (voc-ingame)    item 8 (headless, flat, exact rules): v50 and v51 through Regions.checkPlan and realiseApproved with their
//                             bibles' rarity through the sidecar, the realised world against the virtual one, M26/M27/M20 recomputed on it,
//                             cost.bom and cost.rarity against the realised cells, cost.creativeOnly in an approved artifact (v50's
//                             light-block twin), Regions.remove E-flat 0; the same with a bible made by BibleRequest + rarity through the
//                             stub sidecar; a malformed rarity refused FIELD_LIMIT; r01 (VOCAB) and r03 (FIRE) refused in game
//   natural   (voc-natural)   item 9 (headless): v50n on S3's pinned site, realiseApproved then remove under the exact rules (E-normal); the
//                             drift probe (default rules) on the copper hall's unwaxed cells, recorded
//   survival  (voc-survival)  item 11 (headless, the survival toggle on): voc_shrine and voc_copper_hall as construction sites: bomFull lists
//                             the beacon and the copper items; fed exactly through a hopper chain each builds identical to an instant
//                             placement; deconstructed under the exact rules, the refund equals the items of the blocks standing
//   look      (6cvoc-look)    item 15 (client, recorded not judged): the four VOC bibles on v50's village and the four designs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const OWNER = 'test:vocb';
const FLAT = 'G6B Flat Base';
const FLAT_CLAIM = [7000, 7000, 7239, 7159];
/** The flat base world's ground (its surface blocks at y 64; a building stands from 65). */
const FLAT_Y = 64;
const S3_SEED = '2026100906';
const LOOK_BIBLES = ['g6cvoc_modern', 'g6cvoc_grotto', 'g6cvoc_forge', 'g6cvoc_copper'];
const j = (o) => JSON.stringify(o ?? null).replaceAll(' ', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sortObj = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
/** A canonical form (keys sorted at every depth): an artifact's JSON is canonical, a kit object keeps its build order. */
const canon = (o) => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? sortObj(v) : v));

function nodeTest(root, files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}

async function javaTests(root, patterns, minTests) {
  const { srcGradle } = await import('./src-gradle.mjs');
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const args = ['test', '--offline', '-q', ...patterns.flatMap((p) => ['--tests', p])];
  const g = srcGradle(root, () => spawnSync('./gradlew', args, { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 }));
  const dir = path.join(root, 'mod', 'build', 'test-results', 'test');
  let tests = 0, failures = 0;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.xml') || !patterns.some((p) => f.includes(p.replaceAll('*', '')))) continue;
    const m = /tests="(\d+)" skipped="\d+" failures="(\d+)" errors="(\d+)"/.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (m) { tests += +m[1]; failures += +m[2] + +m[3]; }
  }
  return { code: g.status, tests, failures, ok: g.status === 0 && tests >= minTests && failures === 0 };
}

/** A plan fixture with its style (a scenario bible's JSON, or the fixture's inline bible). */
function fixture(root, ...p) {
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'kit', 'test', 'fixtures', 'plan', ...p), 'utf8'));
  const style = typeof fx.style === 'string' ? JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'bibles', `${fx.style}.json`), 'utf8')) : fx.style ?? null;
  return { ...fx, styleJson: style };
}

// ------------------------------------------------------------------ unit (voc-unit): items 6, 7, 13

/** Item 13 (recorded) and the census: every committed valid/ plan and the 59 asks checked; which answers gained a cost member, which
 * reports an M20 (b), M26 or M27 finding, and the compile pass's time per plan. */
async function census(ctx) {
  const H = await ctx.imp('test/plan-helpers.mjs');
  const { checkRegion } = await ctx.imp('lib/region/check.mjs');
  const out = { plans: {}, costRarity: [], creativeOnly: [], natural: [], m26: [], m27: {}, compileMs: {} };
  const runs = [];
  for (const d of ['valid', 'k1a', 'rope', 't3a', 't3b', 'tunnel', 'h', 'extension']) {
    const dir = path.join(ctx.root, 'kit', 'test', 'fixtures', 'plan', d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const fx = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!fx.plan || /^v5[01]_voc/.test(f)) continue;
      runs.push({ id: `${d}/${f}`, fx, plan: fx.plan });
    }
  }
  const asksDir = path.join(ctx.root, 'kit', 'test', 'fixtures', 'plan', 'asks');
  for (const f of fs.readdirSync(asksDir).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json').sort()) runs.push({ id: `asks/${f}`, fx: { on: 'asks' }, plan: JSON.parse(fs.readFileSync(path.join(asksDir, f), 'utf8')).answer.plan });
  for (const r of runs) {
    const sv = r.fx.terrain ? H.flatSurvey(r.fx.terrain) : r.fx.on === 'asks' ? H.asksSurvey() : r.fx.on === 'flat' ? H.flatSurvey() : r.fx.on ? H.goldenSurvey(r.fx.on) : H.flatSurvey();
    try {
      const c = await H.checkPlanVolumes(r.plan, { survey: sv.bytes, claim: sv.claim, anchors: { ...H.stewardAnchors(sv.claim), ...(r.fx.anchors ?? {}) }, protected: r.fx.protected ?? [], builds: r.fx.builds ?? [], volume: r.fx.volume ?? {} });
      const v = c.res.meta.planCheck?.vocab;
      out.compileMs[r.id] = v ? (v.first?.ms ?? 0) + v.ms : null;
      for (const a of c.check.parts) {
        if (a.cost?.rarity) out.costRarity.push(`${r.id}:${a.part}`);
        if (a.cost?.creativeOnly) out.creativeOnly.push(`${r.id}:${a.part}`);
      }
      const rep = checkRegion({ ir: c.res.ir, survey: sv.bytes, blobs: (s) => c.res.blobs.get(s) ?? null, meta: c.res.meta, volumes: (c.volumes ?? []).map((x) => x.decoded), prefix: false, rules: ['M20', 'M26', 'M27'] });
      for (const f of rep.findings) {
        if (f.rule === 'M20:natural') out.natural.push(`${r.id}:${f.part}`);
        else if (f.rule === 'M26') out.m26.push(`${r.id}: ${f.message}`);
        else if (f.rule.startsWith('M27')) (out.m27[f.rule] ??= []).push(`${r.id}:${f.part ?? '-'} ${f.count}`);
      }
      out.plans[r.id] = c.check.overall;
    } catch (e) { out.plans[r.id] = `error ${String(e.message).slice(0, 160)}`; }
  }
  const ms = Object.values(out.compileMs).filter((x) => x !== null);
  out.compileStats = { plans: ms.length, max: Math.max(0, ...ms), total: ms.reduce((a, b) => a + b, 0) };
  return out;
}

async function megaTiming(ctx) {
  const { planRegion } = await ctx.imp('lib/region/plan.mjs');
  const { synthSurvey } = await ctx.imp('lib/region/synth.mjs');
  const { checkRegion } = await ctx.imp('lib/region/check.mjs');
  const CLAIM = { minX: -500, minZ: -500, maxX: 499, maxZ: 499, minY: -64, maxY: 319 };
  const survey = synthSurvey(CLAIM, 'golden');
  const p = await planRegion({ programFile: path.join(ctx.KIT, 'regions', 'mega_bench.mjs'), survey, claim: CLAIM, node: 'golden' });
  const t0 = performance.now();
  const rep = checkRegion({ ir: p.ir, survey, blobs: (s) => p.blobs.get(s) ?? null, meta: p.meta, prefix: false, rules: ['M26', 'M27'] });
  return { wallMs: Math.round(performance.now() - t0), build: rep.ms.build, perRule: rep.ms.perRule, findings: rep.findings.map((f) => `${f.rule} ${f.count}`) };
}

const unit = [
  {
    name: 'items 6, 7 (kit): the building rules, the region rules, the refusals, the bibles',
    async run({ root, check }) {
      const r = nodeTest(root, ['kit/test/vocab-rules.test.mjs']);
      check(r.code === 0 && r.fail === 0 && r.pass >= 9, `items 6, 7 (kit): each broken variant caught by its rule with its cells; _unsafe.natLavaFence a warning; r01-r03 refused VOCAB, VOCAB, FIRE with evidence and nothing written; M26 on v50 0 findings and on its over-budget twin 1; the opted-in bibles' designs warn, their twins don't (metrics.rarity.over); v50's cost.rarity equals M26 (the batch test); format-2 bibles with and without rarity validate, a bad rarity names its path, built-in bibles 0 errors: ${r.pass} pass, ${r.fail} fail`, r.failing);
      return r;
    },
  },
  {
    name: 'item 7 (sidecar, Java): BibleRequest.rarity, FIELD_LIMIT, the stub bible copying it, the wire',
    async run({ root, check }) {
      const out = {};
      const sc = spawnSync('npx', ['vitest', 'run', 'test/vocb.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 900_000 });
      out.sidecar = { code: sc.status, tail: `${sc.stdout}${sc.stderr}`.split('\n').filter((l) => /Tests|passed|failed|×/.test(l)).slice(-4) };
      check(sc.status === 0, `item 7 (sidecar): a malformed BibleRequest.rarity refused FIELD_LIMIT (detail rarity, naming the path) before any job, bible.estimate too; the stub bible job copies it byte for byte into the made bible, a revise keeps it; metrics.rarity/drift kept out of the agent's files unless opted in; the feature bible.rarity: ${out.sidecar.tail.join(' ')}`, out.sidecar);
      out.java = await javaTests(root, ['*WireVocbTest*', '*ApiVocTest*', '*Wire4bTest*'], 6);
      check(out.java.ok, `item 7 (Java): Wire4b writes rarity only when set (a 1.10.0-shaped request sends its old bytes), the record's toJson as the request's rarity; the feature rarityBudgets: ${out.java.tests} tests, ${out.java.failures} failures`, out.java);
      return out;
    },
  },
  {
    name: 'item 13 (recorded) and the census: the compile pass per plan, M26/M27 on mega_bench A; which committed plans the new rules touch',
    async run(ctx) {
      const out = await census(ctx);
      fs.writeFileSync(path.join(ctx.OUT, 'vocb-census.json'), `${JSON.stringify(out, null, 1)}\n`);
      ctx.check(out.costRarity.length === 0 && out.creativeOnly.length === 0, `§6: no committed plan's part gains cost.rarity or cost.creativeOnly (${Object.keys(out.plans).length} plans: valid/, K1, T3, H and the 59 asks): ${j([...out.costRarity, ...out.creativeOnly])}`);
      ctx.check(true, `M20 (b) fires on ${out.natural.length} committed plan part(s) (a warning, listed): ${j(out.natural)}; M26 on ${out.m26.length}; M27 warnings ${j(Object.fromEntries(Object.entries(out.m27).map(([k, v]) => [k, v.length])))} (recorded)`, { natural: out.natural, m27: out.m27 });
      ctx.check(true, `item 13 (recorded): the compile-time M27/M20 pass on ${out.compileStats.plans} plans: max ${out.compileStats.max} ms, total ${out.compileStats.total} ms`);
      try {
        out.mega = await megaTiming(ctx);
        ctx.check(true, `item 13 (recorded): M26/M27 on mega_bench A: ${out.mega.perRule.M27 ?? '?'} ms (the virtual world ${out.mega.build} ms; ${out.mega.findings.length} finding(s): ${out.mega.findings.slice(0, 6).join(', ')})`, out.mega);
      } catch (e) { ctx.check(true, `item 13 (recorded): mega_bench A not timed (${String(e.message).slice(0, 160)})`); }
      return out;
    },
  },
];

// ------------------------------------------------------------------ in game helpers

function installBibles(ctx, ids) {
  for (const id of ids) {
    const dst = path.join(ctx.L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(path.join(ctx.root, 'scenarios', 'bibles', `${id}.json`), path.join(dst, 'bible.json'));
  }
}

/** The four VOC designs as library entries (voc-designs.mjs, each in its bible's palette). */
async function installDesigns(ctx) {
  const D = await ctx.imp('test/fixtures/vocab/voc-designs.mjs');
  const { writeBlueprint } = await ctx.imp('lib/write.mjs');
  for (const [id, mk] of Object.entries(D.DESIGNS)) writeBlueprint(mk(), path.join(ctx.L.LIBRARY, id));
  return Object.keys(D.DESIGNS);
}

const planDirOf = (ctx, planId) => path.join(ctx.L.SIDECAR_DATA, 'regions', 'plans', planId);

/** The kit's stewardAnchors over an in-game claim. */
async function anchorsOf(ctx, claim) {
  const H = await ctx.imp('test/plan-helpers.mjs');
  return H.stewardAnchors({ minX: claim[0], minZ: claim[1], maxX: claim[2], maxZ: claim[3] });
}

/**
 * (fix/voc-natural) Item 9's world class for S3's own fluids still settling: F2's `distant` rule (tools/scenarios.mjs `distantOf`)
 * restricted to flowing fluid. S3's fresh chunks carry worldgen springs (a cave stream at x 3752-3760, y 37-48, z -924..-914; lava at
 * y -2, x 3787-3789) whose flow front can cross the snapshot: with no region at all the same cells go air -> flowing water within 15 s
 * of a snapshot. An unclassified (`none`) mismatch is classed `farfluid` only when
 *   - kind: was and now are each air, cave air, or a non-source water or lava (level 1-15), and at least one side is that fluid
 *     (a source block on either side, or any other block, is never classed);
 *   - place: a cell the plan never writes, in no lot box, and 8 or more (Manhattan) from every written cell (the undo writes only the
 *     journal's cells, which are the written cells and what stood on them).
 * Pure: `written` is a Set of "x,y,z" keys, `lots` the IR's lots. Returns the diff with the moved cells' class and the counts updated.
 */
export function farFluidOf(diff, { written, lots = [] }) {
  if (!diff || !(diff.classes?.none > 0)) return diff;
  const empty = (st) => /^minecraft:(air|cave_air)$/.test(String(st));
  const flowing = (st) => /^minecraft:(water|lava)\[level=([1-9]|1[0-5])\]$/.test(String(st));
  const kind = (m) => (empty(m.was) || flowing(m.was)) && (empty(m.now) || flowing(m.now)) && (flowing(m.was) || flowing(m.now));
  const inLot = (x, y, z) => lots.some((l) => x >= l.box.minX && x <= l.box.maxX && y >= l.box.minY && y <= l.box.maxY && z >= l.box.minZ && z <= l.box.maxZ);
  const near = (x, y, z) => {
    for (let dx = -7; dx <= 7; dx++) for (let dy = -7 + Math.abs(dx); dy <= 7 - Math.abs(dx); dy++) {
      const r = 7 - Math.abs(dx) - Math.abs(dy);
      for (let dz = -r; dz <= r; dz++) if (written.has(`${x + dx},${y + dy},${z + dz}`)) return true;
    }
    return false;
  };
  const moved = new Set((diff.list ?? []).filter((m) => {
    if (m.class !== 'none' || !kind(m)) return false;
    const [x, y, z] = String(m.pos).split(',').map(Number);
    return !written.has(`${x},${y},${z}`) && !inLot(x, y, z) && !near(x, y, z);
  }));
  if (!moved.size) return diff;
  const classes = { ...diff.classes, none: diff.classes.none - moved.size, farfluid: (diff.classes.farfluid ?? 0) + moved.size };
  if (!classes.none) delete classes.none;
  return { ...diff, classes, list: diff.list.map((m) => (moved.has(m) ? { ...m, class: 'farfluid' } : m)) };
}

/** Regions.checkPlan in game (the two-plan flow, chunks generated). */
async function checkIn(ctx, tag, { plan, claim, anchors, bible }) {
  const { L, OUT } = ctx;
  const c = await L.call('dev.region.checkPlan', { plan, claim, owner: OWNER, anchors, load: 'generate', ...(bible ? { bible } : {}) }, 900_000);
  fs.writeFileSync(path.join(OUT, `vocb-${tag}-check.json`), `${JSON.stringify(c, null, 1)}\n`);
  return c;
}

/** The realised world against the virtual one over every written cell outside the lot boxes (gate6cp0's rule: `kept` cells held what
 * they held before, 4e road cells follow the realised ground). */
async function realisedVsVirtual(ctx, pdir, vw, ir, after, before) {
  const { centreCells } = await ctx.imp('lib/region/geom.mjs');
  const b = after.box;
  const inLot = (x, y, z) => ir.lots.some((l) => x >= l.box.minX && x <= l.box.maxX && y >= l.box.minY && y <= l.box.maxY && z >= l.box.minZ && z <= l.box.maxZ);
  const roadCols = new Set();
  for (const r of ir.roads ?? []) for (const c of centreCells(r.points.map((q) => [q[0], q[2]])).cells) for (let dx = -2 - (r.width >> 1); dx <= 2 + (r.width >> 1); dx++) for (let dz = -2 - (r.width >> 1); dz <= 2 + (r.width >> 1); dz++) roadCols.add(`${c.x + dx},${c.z + dz}`);
  const parse = (st) => { const m = /^([^[]+)(?:\[(.*)\])?$/.exec(st); return { name: m[1], props: Object.fromEntries((m[2] ? m[2].split(',') : []).map((kv) => kv.split('='))) }; };
  const same = (want, got) => { if (want === got) return true; const a = parse(want), q = parse(got); return a.name === q.name && Object.entries(a.props).every(([k, v]) => q.props[k] === v); };
  let written = 0, differ = 0, kept = 0, road = 0;
  const first = [];
  vw.eachWritten((x, y, z, idx) => {
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ || inLot(x, y, z)) return;
    written++;
    const want = vw.pal.states[idx], got = after.palette[after.cells[after.at(x, y, z)]];
    if (same(want, got)) return;
    if (before && before.palette[before.cells[before.at(x, y, z)]] === got) { kept++; return; }
    if (roadCols.has(`${x},${z}`)) { road++; return; }
    differ++;
    if (first.length < 12) first.push({ pos: [x, y, z], want, got });
  });
  void pdir;
  return { written, differ, kept, road, first };
}

/**
 * Item 8's realise run: checkPlan (READY), the bible's rarity in the plan's ctx (the plan dir's bible.json and meta.vocab), the
 * artifact's cost members, realiseApproved, the realised world against the virtual one, M20/M26/M27 recomputed on it, cost.bom and
 * cost.rarity against the realised cells, Regions.remove and the box against its snapshot. Returns the evidence.
 */
async function realiseRun(ctx, tag, { claim, plan, bible = null, rarityWant = undefined, remove = 'E-flat', rules = 'exact', expectReady = true, keep = false, expectEmpty = false }) {
  const { L, OUT, check } = ctx;
  const out = { tag, claim };
  await L.setRules(rules);
  const [cx, cz] = [(claim[0] + claim[2]) >> 1, (claim[1] + claim[3]) >> 1];
  await L.tp(cx, 200, cz);
  const anchors = await anchorsOf(ctx, claim);
  const c = await checkIn(ctx, tag, { plan, claim, anchors, bible });
  out.check = { overall: c.check?.overall ?? null, refused: c.refused ?? null, parts: (c.check?.parts ?? []).map((a) => ({ part: a.part, class: a.class, reasons: a.reasons, cost: a.cost })) };
  if (expectReady) check(c.check?.overall === 'READY' && !!c.check.artifactSha, `${tag}: Regions.checkPlan READY with an artifact (${out.check.parts.map((a) => `${a.part} ${a.class}`).join(', ')}${c.refused ? `; refused ${j(c.refused)}` : ''})`);
  if (!c.check?.artifactSha) return out;
  const pdir = planDirOf(ctx, c.check.checkId);
  out.planDir = pdir;
  const ir = JSON.parse(fs.readFileSync(path.join(pdir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(pdir, 'meta.json'), 'utf8'));
  const bibleFile = path.join(pdir, 'bible.json');
  const planBible = fs.existsSync(bibleFile) ? JSON.parse(fs.readFileSync(bibleFile, 'utf8')) : null;
  out.vocab = meta.vocab ?? null;
  if (rarityWant !== undefined) {
    const { validateRarity } = await ctx.imp('lib/vocab/rarity.mjs');
    const filled = validateRarity(rarityWant).rarity;
    check(canon(planBible?.rarity) === canon(rarityWant) && meta.vocab?.opted === true && canon(meta.vocab.rarity) === canon(filled),
      `${tag}: the bible's rarity reached the plan through the sidecar (the plan dir's bible.json carries it; the kit's ctx.rarity, recorded as meta.vocab: opted, ${j(meta.vocab?.rarity)})`, { planBible: planBible?.rarity, vocab: meta.vocab?.rarity });
  }
  const art = (await L.call('dev.region.artifact', { sha: c.check.artifactSha, body: true })).artifact;
  out.artifactCost = Object.fromEntries((art?.body?.parts ?? []).map((p) => [p.part, { rarity: p.cost?.rarity ?? null, creativeOnly: p.cost?.creativeOnly ?? null, bom: p.cost?.bom ?? null }]));
  // the box: the claim grown by 8, the IR's y range
  const box = [claim[0] - 8, ir.claim.minY, claim[1] - 8, claim[2] + 8, ir.claim.maxY, claim[3] + 8];
  out.box = box;
  await L.cmd('/kill @e[type=!minecraft:player]');
  await L.settle(rules === 'exact' ? 5000 : 15_000);
  const beforeF = path.join(OUT, `vocb-${tag}-before.arwd.gz`), afterF = path.join(OUT, `vocb-${tag}-after.arwd.gz`), snapF = path.join(OUT, `vocb-${tag}-snap.gz`);
  await L.call('dev.region.dump', { box, file: beforeF, light: false }, 1_800_000);
  await L.call('dev.region.hash', { box, mode: 'snap', file: snapF }, 4 * 3_600_000);
  const rr = await L.call('dev.region.realiseApproved', { sha: c.check.artifactSha }, 300_000);
  if (rr.refused) { check(false, `${tag}: realiseApproved refused (${j(rr.refused)})`); return out; }
  const st = await L.waitRegion(rr.region, 3 * 3_600_000, async (s) => { if (s.view?.waiting?.reason === 'OCCUPIED' || s.waiting?.OCCUPIED) await L.cmd('/kill @e[type=!minecraft:player]'); });
  out.realise = { region: rr.region, state: st.view.state, cells: st.record?.cellsWritten ?? st.view.cellsWritten, irSha: st.view.irSha, items: st.items ?? null };
  // (a plan whose lots have no library entry ends PARTIAL: every tile and road placed, the lots left as their pads)
  const noEntries = (art.body.lots ?? []).length > 0 && (art.body.lots ?? []).every((l) => !l.entry);
  const allPlaced = Object.entries(st.items ?? {}).every(([k]) => /:PLACED$/.test(k));
  const placed = st.view.state === 'PLACED' || (st.view.state === 'PARTIAL' && noEntries && allPlaced);
  check(placed && st.view.irSha === art.body.region.irSha, `${tag}: realiseApproved ${st.view.state} from the approved artifact (irSha equal; ${out.realise.cells} cells written; items ${j(st.items)}; lots ${j(Object.fromEntries((art.body.lots ?? []).map((l) => [l.id, l.entry ?? null])))}${st.view.state === 'PARTIAL' ? ': PARTIAL is a plan whose lots have no entry, every item placed' : ''})`);
  await L.settle(4000);
  await L.call('dev.region.dump', { box, file: afterF, light: false }, 1_800_000);
  // ---- the realised world against the virtual one; the rules recomputed on it
  const V = await ctx.imp('lib/region/vworld.mjs');
  const { checkRegion } = await ctx.imp('lib/region/check.mjs');
  const blobs = (s) => { const f = path.join(pdir, 'blobs', `${s}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const survey = fs.readFileSync(path.join(pdir, 'survey.bin'));
  const { vw } = V.buildVirtual({ ir, survey, blobs });
  const before = await V.decodeArwd(fs.readFileSync(beforeF)), after = await V.decodeArwd(fs.readFileSync(afterF));
  out.virtual = await realisedVsVirtual(ctx, pdir, vw, ir, after, before);
  if (expectEmpty) check(out.virtual.written === 0 && out.realise.cells === 0, `${tag}: the refused part wrote nothing (the plan's only part: ${out.virtual.written} planned cells, ${out.realise.cells} written)`);
  else check(out.virtual.written > 0 && out.virtual.differ === 0, `${tag}: the realised world equals the virtual world over every written cell outside the lots (${out.virtual.written} cells; ${out.virtual.kept} kept by their op's condition, ${out.virtual.road} on 4e ground roads; ${out.virtual.differ} unclassified)`, out.virtual.first);
  const RULES = ['M20', 'M26', 'M27'];
  const repV = checkRegion({ ir, survey, blobs, meta, prefix: false, rules: RULES });
  const world = V.dumpWorld(before, after, ir.claim, { virtual: vw, lots: ir.lots });
  const repR = checkRegion({ ir, meta, world, prefix: false, blobs, rules: RULES });
  const fl = (rep) => rep.findings.map((f) => `${f.rule}|${f.severity}|${f.part ?? '-'}|${f.count}`).sort();
  out.rules = { virtual: fl(repV), realised: fl(repR), m26v: repV.metrics.M26, m26r: repR.metrics.M26 };
  check(j(out.rules.virtual) === j(out.rules.realised) && canon(repV.metrics.M26) === canon(repR.metrics.M26), `${tag}: M20, M26 and M27 recomputed on the realised world equal the plan's (${out.rules.virtual.join(', ') || 'no findings'}; M26 ${repR.metrics.M26.cells} cells, shares ${j(repR.metrics.M26.shares)}, over ${repR.metrics.M26.over.length})`, out.rules);
  // ---- cost.bom and cost.rarity per part against the realised cells of the IR parts it owns
  const { bomOf } = await ctx.imp('lib/connectors/bom.mjs');
  const { measureRarity } = await ctx.imp('lib/vocab/budget.mjs');
  const { metaStyle } = await ctx.imp('lib/region/checkVocab.mjs');
  const { BLOCKS } = await ctx.imp('lib/blocks.mjs');
  const { tierOf } = await ctx.imp('lib/vocab.mjs');
  const pc = meta.planCheck;
  const style = metaStyle(meta) ?? { opted: false, own: new Set() };
  const NAT = new Set(['ROCK', 'SOIL', 'LOOSE', 'SNOW', 'ICE']);
  const measured = (st) => { const n = st.replace(/\[.*$/, ''); if (/^minecraft:(air|cave_air|void_air|water|lava|bubble_column)$/.test(n) || !BLOCKS[n]) return null; return NAT.has(BLOCKS[n].v) && tierOf(n) === 'common' ? null : n; };
  out.costs = {};
  for (const a of art.body.parts) {
    if (!a.cost) continue;
    const mine = new Set(Object.entries(pc.partOf).filter(([, o]) => o === a.part || (o && o.startsWith('routes:') && o.slice(7).split(',').includes(a.part))).map(([k]) => k));
    const idx = new Set(ir.parts.map((p, i) => (mine.has(p.id) ? i : -1)).filter((i) => i >= 0));
    const states = [], vstates = [], hist = {};
    vw.eachWritten((x, y, z, vi, _f, pi) => {
      if (!idx.has(pi)) return;
      const got = after.palette[after.cells[after.at(x, y, z)]];
      states.push(got);
      vstates.push(vw.pal.states[vi]);
      const n = measured(got);
      if (n) hist[n] = (hist[n] ?? 0) + 1;
    });
    const o = { cells: states.length };
    const notAir = (q) => !/^minecraft:(air|cave_air)$/.test(q.replace(/\[.*$/, ''));
    if (a.cost.bom) {
      // the items standing in the part's cells, realised against planned (judged); cost.bom is K1's/H's bill of what the part emits, so
      // a cell a later part overwrites (a gate's cut, a lamp on a coping) counts there and not here: listed, not judged
      o.bom = bomOf(states.filter(notAir));
      o.bomPlanned = bomOf(vstates.filter(notAir));
      o.bomEqual = canon(o.bom) === canon(o.bomPlanned);
      const keys = [...new Set([...Object.keys(a.cost.bom), ...Object.keys(o.bom)])].sort();
      o.costBomDiff = Object.fromEntries(keys.filter((k) => (a.cost.bom[k] ?? 0) !== (o.bom[k] ?? 0)).map((k) => [k, { costBom: a.cost.bom[k] ?? 0, standing: o.bom[k] ?? 0 }]));
    }
    if (a.cost.rarity) { const m = measureRarity(hist, style, 'region'); o.rarityEqual = canon(m) === canon(a.cost.rarity); o.rarity = m; }
    out.costs[a.part] = o;
    if (a.cost.bom) check(o.bomEqual, `${tag}: ${a.part}: the items of its realised cells equal its planned cells' (${Object.values(o.bom).reduce((p, q) => p + q, 0)} items standing; cost.bom ${Object.values(a.cost.bom).reduce((p, q) => p + q, 0)}, differing where a later part overwrites its cells: ${j(o.costBomDiff)})`, { standing: o.bom, planned: o.bomPlanned, costBom: a.cost.bom });
    if (a.cost.rarity) check(o.rarityEqual, `${tag}: ${a.part}'s cost.rarity equals the counts of its realised cells (${a.cost.rarity.cells} cells, uncommon ${a.cost.rarity.uncommon}, rare ${a.cost.rarity.rare}, precious ${a.cost.rarity.precious})`, { want: a.cost.rarity, got: o.rarity });
  }
  out.snapF = snapF;
  if (keep) return out;
  // ---- Regions.remove and the box against its snapshot
  await L.cmd('/kill @e[type=!minecraft:player]');
  await L.settle(4000);
  const rm = await L.call('dev.region.remove', { region: rr.region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(rules === 'exact' ? 6000 : 15_000);
  const diff = await L.call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
  out.remove = { removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes ?? null, list: (diff.list ?? []).slice(0, 60) };
  fs.writeFileSync(path.join(OUT, `vocb-${tag}-remove.json`), `${JSON.stringify({ ...out.remove, list: diff.list ?? [] }, null, 1)}\n`);
  if (remove === 'E-flat') check(rm.removed && diff.mismatches === 0, `${tag}: Regions.remove restores the box exactly: E-flat ${diff.mismatches} (${rm.restored} cells restored)`, out.remove.list.slice(0, 12));
  out.diffList = diff.list ?? [];
  out.vw = vw;
  out.ir = ir;
  return out;
}

// ------------------------------------------------------------------ ingame (voc-ingame): item 8 and the in-game refusals

const ingame = [{
  name: 'item 8: v50 and v51 through checkPlan and realiseApproved, the BibleRequest path, the refusals in game',
  async run(ctx) {
    const { L, root, check } = ctx;
    const out = {};
    installBibles(ctx, ['g6cvoc_modern', 'g6cvoc_forge']);
    out.designs = await installDesigns(ctx);
    const v50 = fixture(root, 'valid', 'v50_voc_village.json');
    const v51 = fixture(root, 'valid', 'v51_voc_forge.json');
    // ---- v50: a bible's rarity from bible.json through the sidecar into ctx; cost.rarity in an approved artifact
    await L.fresh('G6B VOCb v50', FLAT);
    out.v50 = await realiseRun(ctx, 'v50', { claim: FLAT_CLAIM, plan: v50.plan, bible: 'g6cvoc_modern', rarityWant: v50.styleJson.rarity });
    check(Object.values(out.v50.artifactCost ?? {}).some((c) => c.rarity), `v50: the approved artifact's parts carry cost.rarity (${j(Object.fromEntries(Object.entries(out.v50.artifactCost ?? {}).map(([k, v]) => [k, v.rarity ? { cells: v.rarity.cells, over: v.rarity.over.length } : null])))})`);
    // ---- v50 with a creative-only light block in its square's pattern: cost.creativeOnly in an approved artifact, realised and removed
    const lit = { ...v50.styleJson, patterns: { path: { mix: [{ w: 30, mat: 'path' }, { w: 1, mat: 'minecraft:light[level=15,waterlogged=false]' }], seedLabel: 'vocb_light' } } };
    fs.mkdirSync(path.join(L.GAME_DIR, 'architect', 'bibles', 'g6cvoc_modern_light', 'versions', '1'), { recursive: true });
    fs.writeFileSync(path.join(L.GAME_DIR, 'architect', 'bibles', 'g6cvoc_modern_light', 'versions', '1', 'bible.json'), `${JSON.stringify({ ...lit, name: 'G6C-VOC modern (light)' }, null, 1)}\n`);
    await L.fresh('G6B VOCb v50c', FLAT);
    out.v50c = await realiseRun(ctx, 'v50c', { claim: FLAT_CLAIM, plan: { ...v50.plan, planId: 'voc_v50c' }, bible: 'g6cvoc_modern_light' });
    check(Object.values(out.v50c.artifactCost ?? {}).some((c) => c.creativeOnly && c.creativeOnly['minecraft:light'] > 0), `v50c: the approved artifact carries cost.creativeOnly for the light blocks its square writes (${j(Object.fromEntries(Object.entries(out.v50c.artifactCost ?? {}).map(([k, v]) => [k, v.creativeOnly])))}; regions stay INSTANT)`);
    // ---- v51: the forge's wall keeps its cost.bom against the realised cells
    await L.fresh('G6B VOCb v51', FLAT);
    out.v51 = await realiseRun(ctx, 'v51', { claim: FLAT_CLAIM, plan: v51.plan, bible: 'g6cvoc_forge', rarityWant: v51.styleJson.rarity });
    // ---- BibleRequest.rarity through the stub sidecar into a bible, then a plan
    const bad = await L.call('dev.vocab.bibleRequest', { prompt: 'VOC-b gate: a bad budget', name: 'Vocb Bad', rarity: { rareShareMax: 2 } }, 120_000);
    out.badRequest = bad;
    check(bad.code === 'FIELD_LIMIT' && /rarity/.test(`${bad.detail} ${bad.refused}`), `BibleRequest with a malformed rarity: refused FIELD_LIMIT before any job (${bad.code} ${bad.detail}: ${String(bad.refused).slice(0, 160)})`, bad);
    const req = await L.call('dev.vocab.bibleRequest', { prompt: 'VOC-b gate: a white concrete town', name: 'Vocb Modern', scope: 'settlement', rarity: v50.styleJson.rarity }, 120_000);
    out.request = req;
    check(!req.refused && canon(req.wire?.rarity) === canon(v50.styleJson.rarity), `BibleRequest.rarity on the wire (Wire4b): ${j(req.wire?.rarity)}${req.refused ? `; refused ${req.refused}` : ''}`);
    let job = req;
    for (let i = 0; i < 120 && req.jobId && !['DONE', 'FAILED', 'CANCELLED'].includes(job.status); i++) { await sleep(2000); job = await L.call('dev.vocab.bibleJob', { jobId: req.jobId }); }
    out.job = { status: job.status, error: job.error ?? null, bibleId: job.bibleId };
    const bf = path.join(L.GAME_DIR, 'architect', 'bibles', job.bibleId ?? 'none', 'bible.json');
    const made = fs.existsSync(bf) ? JSON.parse(fs.readFileSync(bf, 'utf8')) : null;
    check(job.status === 'DONE' && canon(made?.rarity) === canon(v50.styleJson.rarity) && canon(made?.rarity) === canon(req.wire?.rarity), `the stub sidecar's bible job copied BibleRequest.rarity into ${job.bibleId}'s bible.json byte for byte (${job.status}; ${j(made?.rarity)})`, { made: made?.rarity });
    if (made) {
      await L.fresh('G6B VOCb v50r', FLAT);
      out.v50r = await realiseRun(ctx, 'v50r', { claim: FLAT_CLAIM, plan: { ...v50.plan, planId: 'voc_v50r' }, bible: job.bibleId, rarityWant: v50.styleJson.rarity });
    }
    // ---- the refusals in game: r01 (VOCAB, M27:state) and r03 (FIRE, M20) through Regions.checkPlan; what realises writes none of them
    out.refusals = {};
    for (const f of ['r01_state_waterlogged_slab.json', 'r03_fire_pattern.json']) {
      const fx = fixture(root, 'voc', f);
      const id = `g6cvoc_${f.slice(0, 3)}`;
      fs.mkdirSync(path.join(L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1'), { recursive: true });
      fs.writeFileSync(path.join(L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1', 'bible.json'), `${JSON.stringify({ ...fx.styleJson, name: `G6C-VOC ${f.slice(0, 3)}` }, null, 1)}\n`);
      await L.fresh(`G6B VOCb ${f.slice(0, 3)}`, FLAT);
      const r = await realiseRun(ctx, f.slice(0, 3), { claim: FLAT_CLAIM, plan: fx.plan, bible: id, expectReady: false, expectEmpty: true });
      const a = (r.check.parts ?? []).find((p) => p.part === fx.expect.part);
      out.refusals[f] = { overall: r.check.overall, answer: a ?? null, realise: r.realise ?? null };
      check(a?.class === 'refused' && a.reasons?.[0]?.code === fx.expect.code && a.reasons[0].evidence?.rule === fx.expect.rule && (a.reasons[0].evidence?.cells ?? []).length > 0,
        `${f}: in game, Regions.checkPlan answers ${fx.expect.part} refused ${fx.expect.code} {rule ${a?.reasons?.[0]?.evidence?.rule}, block ${a?.reasons?.[0]?.evidence?.block}, ${(a?.reasons?.[0]?.evidence?.cells ?? []).length} cells} (overall ${r.check.overall})`, a);
    }
    return out;
  },
}];

// ------------------------------------------------------------------ natural (voc-natural): item 9

const natural = [{
  name: 'item 9: v50n on S3 (E-normal), the drift probe',
  async run(ctx) {
    const { L, root, check } = ctx;
    const out = {};
    installBibles(ctx, ['g6cvoc_modern']);
    await installDesigns(ctx);
    const fx = fixture(root, 'voc', 'v50n_natural.json');
    const S3 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'route_demo.json'), 'utf8'));
    const claim = [...S3.fixture.claim];
    await L.fresh('G6B VOCb S3', await L.seedBase(S3_SEED));
    await L.setRules('exact');
    await L.tp((claim[0] + claim[2]) >> 1, S3.fixture.yRange[1], (claim[1] + claim[3]) >> 1);
    await L.settle(30_000);
    const anchors = { stone: [S3.params.hallX + 4, 100, S3.params.hallZ + 4] };
    const c = await checkIn(ctx, 'v50n', { plan: fx.plan, claim, anchors, bible: 'g6cvoc_modern' });
    out.check = { overall: c.check?.overall, parts: (c.check?.parts ?? []).map((a) => `${a.part}:${a.class}`) };
    check(c.check?.overall === 'READY' && !!c.check.artifactSha, `item 9: v50n on S3's pinned site: ${c.check?.overall} (${out.check.parts.join(' ')})`);
    if (!c.check?.artifactSha) return out;
    const pdir = planDirOf(ctx, c.check.checkId);
    const ir = JSON.parse(fs.readFileSync(path.join(pdir, 'ir.json'), 'utf8'));
    const box = [claim[0] - 8, ir.claim.minY, claim[1] - 8, claim[2] + 8, ir.claim.maxY, claim[3] + 8];
    await L.cmd('/kill @e[type=!minecraft:player]');
    await L.settle(5000);
    const snapF = path.join(ctx.OUT, 'vocb-v50n-snap.gz');
    await L.call('dev.region.hash', { box, mode: 'snap', file: snapF }, 4 * 3_600_000);
    const rr = await L.call('dev.region.realiseApproved', { sha: c.check.artifactSha }, 300_000);
    if (rr.refused) { check(false, `item 9: realiseApproved refused (${j(rr.refused)})`); return out; }
    const st = await L.waitRegion(rr.region, 3 * 3_600_000, async (s) => { if (s.view?.waiting?.reason === 'OCCUPIED' || s.waiting?.OCCUPIED) await L.cmd('/kill @e[type=!minecraft:player]'); });
    check(st.view.state === 'PLACED', `item 9: realiseApproved ${st.view.state} (${st.view.cellsWritten} cells; the copper hall in lot c1)`);
    // the written non-common cells (the virtual world) for the 6-cell rule
    const V = await ctx.imp('lib/region/vworld.mjs');
    const { tierOf } = await ctx.imp('lib/vocab.mjs');
    const blobs = (s) => { const f = path.join(pdir, 'blobs', `${s}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
    const { vw } = V.buildVirtual({ ir, survey: fs.readFileSync(path.join(pdir, 'survey.bin')), blobs });
    const rare = [];
    const written = new Set();
    vw.eachWritten((x, y, z, idx) => { written.add(`${x},${y},${z}`); const n = vw.pal.states[idx].replace(/\[.*$/, ''); const t = tierOf(n); if (t && t !== 'common') rare.push([x, y, z]); });
    for (const l of ir.lots) rare.push([l.box.minX, l.box.minY, l.box.minZ], [l.box.maxX, l.box.maxY, l.box.maxZ]);
    await L.cmd('/kill @e[type=!minecraft:player]');
    await L.settle(5000);
    const rm = await L.call('dev.region.remove', { region: rr.region, requester: OWNER }, 4 * 3_600_000);
    await L.settle(10_000);
    // S3's own fluids settling far from the plan are the world's (farFluidOf); every other unclassified cell still fails
    const diff = farFluidOf(await L.call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000), { written, lots: ir.lots ?? [] });
    const near = (x, y, z) => rare.some(([a, b, q]) => Math.max(Math.abs(a - x), Math.abs(b - y), Math.abs(q - z)) <= 6);
    const BRIDGE = new Set(['growth', 'grazed']);
    const bad = (diff.list ?? []).filter((m) => { const [x, y, z] = String(m.pos).split(',').map(Number); return near(x, y, z) && !BRIDGE.has(m.class); });
    out.remove = { removed: rm.removed, mismatches: diff.mismatches, classes: diff.classes ?? null, nearNonCommon: bad.slice(0, 20) };
    fs.writeFileSync(path.join(ctx.OUT, 'vocb-v50n-remove.json'), `${JSON.stringify({ ...out.remove, list: diff.list ?? [] }, null, 1)}\n`);
    check(rm.removed && (diff.classes ? diff.classes.none ?? 0 : diff.mismatches) === 0 && bad.length === 0, `item 9: Regions.remove under the exact rules: E-normal ${diff.mismatches} mismatches, ${diff.classes ? diff.classes.none ?? 0 : diff.mismatches} unclassified (${j(diff.classes ?? {})}; farfluid: S3's own fluids settling far from the plan), ${bad.length} within 6 of a non-common written cell outside T3's bridge classes`, bad.slice(0, 8));
    // ---- the drift probe (default rules, separate): the copper hall's unwaxed cells, ticked until each weathers once
    await L.cmd('/gamerule random_tick_speed 3');
    const c2 = await checkIn(ctx, 'v50n-drift', { plan: { ...fx.plan, planId: 'voc_v50n_drift' }, claim, anchors, bible: 'g6cvoc_modern' });
    const rr2 = c2.check?.artifactSha ? await L.call('dev.region.realiseApproved', { sha: c2.check.artifactSha }, 300_000) : { refused: 'no artifact' };
    if (rr2.refused) { check(true, `item 9 (drift probe, recorded): not run (${j(rr2.refused)})`); return out; }
    await L.waitRegion(rr2.region, 3_600_000);
    const lot = ir.lots.find((l) => l.id === 'c1');
    const b2 = lot ? [lot.box.minX - 1, lot.box.minY - 1, lot.box.minZ - 1, lot.box.maxX + 1, lot.box.maxY + 1, lot.box.maxZ + 1] : box;
    const dF = path.join(ctx.OUT, 'vocb-v50n-hall.arwd.gz');
    await L.call('dev.region.dump', { box: b2, file: dF, light: false }, 900_000);
    const d = await V.decodeArwd(fs.readFileSync(dF));
    const cells = [];
    for (let x = d.box.minX; x <= d.box.maxX; x++) for (let z = d.box.minZ; z <= d.box.maxZ; z++) for (let y = d.box.minY; y <= d.box.maxY; y++) {
      const s = d.palette[d.cells[d.at(x, y, z)]];
      if (/^minecraft:(copper_block|cut_copper|copper_bulb|copper_lantern)(\[|$)/.test(s)) cells.push([x, y, z]);
    }
    const weathered = new Set();
    for (let round = 0; round < 60 && weathered.size < cells.length; round++) {
      const left = cells.filter((q) => !weathered.has(q.join(',')));
      for (let i = 0; i < left.length; i += 64) {
        const r = await L.call('dev.vocab.tick', { cells: left.slice(i, i + 64), n: 50 }, 120_000);
        for (const t of r.cells ?? []) if (t.before !== t.after) weathered.add(t.at.join(','));
      }
    }
    await L.settle(2000);
    const rm2 = await L.call('dev.region.remove', { region: rr2.region, requester: OWNER }, 4 * 3_600_000);
    await L.settle(10_000);
    const diff2 = await L.call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
    // (what the undo kept: the cells inside the hall's lot box that differ from the snapshot; the diff classes them `growth`)
    const inHall = (diff2.list ?? []).filter((m) => { const [x, y, z] = String(m.pos).split(',').map(Number); return x >= b2[0] && x <= b2[3] && y >= b2[1] && y <= b2[4] && z >= b2[2] && z <= b2[5]; });
    const kept = inHall.length || (diff2.classes?.growth ?? 0);
    out.drift = { cells: cells.length, weathered: weathered.size, rounds: 'n 50 per call', removed: rm2.removed, kept, mismatches: diff2.mismatches, classes: diff2.classes ?? null };
    check(true, `item 9 (drift probe, recorded): ${weathered.size} of ${cells.length} unwaxed copper cells of the hall weathered under dev.vocab.tick; after Regions.remove an undo kept ${kept} weathered cell(s) standing (StillOurs needs the same block: the queued §10 item's evidence; ${diff2.mismatches} mismatches ${j(diff2.classes ?? {})})`, out.drift);
    return out;
  },
}];

// ------------------------------------------------------------------ survival (voc-survival): item 11

const survival = [{
  name: 'item 11: voc_shrine and voc_copper_hall as construction sites, fed exactly, against instant, deconstructed',
  async run(ctx) {
    const { L, check } = ctx;
    const out = {};
    await installDesigns(ctx);
    const api = async (args) => {
      const r = await L.cmd(`/apitest ${args}`);
      const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
      if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 300)}`);
      return JSON.parse(line);
    };
    const result = async (pending, timeoutMs = 120_000) => {
      if (!pending?.pending) return pending;
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) { const r = await api(`get ${pending.pending}`); if (r.value !== undefined && r.value !== null) return r.value; await sleep(500); }
      throw new Error(`timed out waiting for ${pending.pending}`);
    };
    const box6 = (s) => String(s).replace(/[^-0-9,]/g, ' ').trim().split(/[\s,]+/).map(Number);
    const hash = async (b) => L.call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] }, 300_000);
    const at = [7100, FLAT_Y + 1, 7100];
    for (const [k, id] of ['voc_shrine', 'voc_copper_hall'].entries()) {
      const o = {};
      out[id] = o;
      const x = at[0] + 40 * k, y = at[1], z = at[2];
      await L.fresh(`G6B VOCb Surv ${k}`, FLAT);
      await L.setRules('exact');
      await L.call('dev.survival.set', { on: true });
      await L.tp(x + 4, FLAT_Y + 20, z + 4);
      const v = await api(`check ${id} ${x} ${y} ${z} CONSTRUCTION owned actor`);
      o.verdict = { ok: v.ok, construction: v.construction, bomFull: v.bomFull, bomExact: v.bomExact, restoreBox: v.restoreBox, refusals: v.refusals };
      const want = id === 'voc_shrine' ? ['minecraft:beacon', 'minecraft:iron_block'] : ['minecraft:copper_block', 'minecraft:cut_copper', 'minecraft:copper_bulb'];
      check(v.ok && want.every((w) => (v.bomFull?.[w] ?? 0) > 0), `item 11 (${id}): bomFull lists ${want.join(', ')} (${j(sortObj(v.bomFull))})`, o.verdict);
      // the restore box's cells before the site (the blocks standing after it are the ones that changed)
      const rb0 = box6(v.restoreBox);
      const cells0 = await L.call('dev.box.hash', { min: [rb0[0], rb0[1], rb0[2]], max: [rb0[3], rb0[4], rb0[5]], cells: true }, 300_000);
      const placed = await result(await api(`place ${id} ${x} ${y} ${z} CONSTRUCTION owned actor 0`));
      o.place = placed;
      const site = placed?.siteId;
      if (!site) { check(false, `item 11 (${id}): no construction site (${j(placed)})`); continue; }
      const sites = await api('sites');
      const s = (sites.all ?? []).find((q) => q.id === site) ?? {};
      const st0 = await L.call('dev.site.state', { site });
      o.site = { restoreBox: s.restoreBox, crate: st0.crate, bom: st0.bom, bomTotal: st0.bomTotal };
      const rb = box6(s.restoreBox ?? v.restoreBox);
      const crate = [st0.crate?.x, st0.crate?.y, st0.crate?.z];
      if (crate.some((n) => !Number.isFinite(n))) { check(false, `item 11 (${id}): the site's crate is not known (${j(st0.crate)})`); continue; }
      check(canon(st0.bom) === canon(v.bomFull), `item 11 (${id}): the placed site's bill equals the check's bomFull (${st0.bomTotal} items)`, { site: st0.bom, bomFull: v.bomFull });
      // a hopper chain into the crate, fed exactly the bill (no equivalents)
      const free = (px, py, pz) => !(px >= rb[0] && px <= rb[3] && py >= rb[1] && py <= rb[4] && pz >= rb[2] && pz <= rb[5]);
      const feeds = [];
      const [cx, cy, cz] = crate;
      if (free(cx, cy + 1, cz) && free(cx, cy + 2, cz)) feeds.push({ hopper: [cx, cy + 1, cz], facing: 'down', chest: [cx, cy + 2, cz] });
      for (const [dx, dz, f] of [[1, 0, 'west'], [-1, 0, 'east'], [0, 1, 'north'], [0, -1, 'south']]) if (free(cx + dx, cy, cz + dz) && free(cx + dx, cy + 1, cz + dz)) feeds.push({ hopper: [cx + dx, cy, cz + dz], facing: f, chest: [cx + dx, cy + 1, cz + dz] });
      for (const f of feeds) { await L.cmd(`/setblock ${f.hopper.join(' ')} minecraft:hopper[facing=${f.facing}]`); await L.cmd(`/setblock ${f.chest.join(' ')} minecraft:chest`); }
      const bill = st0.bom ?? v.bomFull ?? {};
      const stacks = [];
      for (const [item, n] of Object.entries(bill)) { let left = n; const max = /_door$|sign$/.test(item) ? 16 : /bed$|banner$/.test(item) ? 1 : 64; while (left > 0) { const q = Math.min(max, left); stacks.push([item, q]); left -= q; } }
      const per = Math.max(1, Math.ceil(stacks.length / Math.max(1, feeds.length)));
      for (const [i, [item, n]] of stacks.entries()) await L.cmd(`/item replace block ${feeds[Math.floor(i / per)].chest.join(' ')} container.${i % per} with ${item} ${n}`);
      o.feeds = { hoppers: feeds.length, stacks: stacks.length, items: Object.values(bill).reduce((p, q) => p + q, 0) };
      await L.cmd('/tick sprint 24000');
      const end = Date.now() + 25 * 60_000;
      let state = null;
      while (Date.now() < end) { state = await L.call('dev.site.state', { site }); if (state.state === 'built') break; await sleep(3000); }
      await L.cmd('/tick sprint stop');
      o.state = { state: state?.state, built: state?.built, queue: state?.queue, percent: state?.percent };
      check(state?.state === 'built', `item 11 (${id}): the site built from a hopper chain fed exactly its bill (${o.feeds.items} items in ${o.feeds.stacks} stacks, no equivalents; ${state?.state}, ${state?.built}/${state?.queue} cells)`, o.state);
      o.survivalHash = (await hash(rb)).sha256;
      // deconstructed under the exact rules: the refund equals the items of the blocks standing
      const cellsBefore = await L.call('dev.box.hash', { min: [rb[0], rb[1], rb[2]], max: [rb[3], rb[4], rb[5]], cells: true }, 300_000);
      const { bomOf } = await ctx.imp('lib/connectors/bom.mjs');
      const siteCells = await L.call('dev.site.cells', { site }).catch(() => null);
      // the blocks standing: every cell of the restore box that changed since before the site (dev.box.hash cells: "x,y,z state[ be=nbt]")
      // (the hash's state is the block state's NBT, {id:"minecraft:x",properties:{k:"v"}} in 26.3 (Name/Properties before): as
      // "minecraft:x[k=v,...]"; quotes of either kind or none)
      const asState = (nbt) => {
        const bs = /^Block\{([a-z0-9_.-]+:[a-z0-9_./-]+)\}(\[[^\]]*\])?/.exec(nbt);
        if (bs) return `${bs[1]}${bs[2] ?? ''}`;
        const n = /(?:Name|id)\s*:\s*["']?([a-z0-9_.-]+:[a-z0-9_./-]+)/i.exec(nbt)?.[1];
        if (!n) return nbt;
        const pm = /properties\s*:\s*\{([^}]*)\}/i.exec(nbt)?.[1];
        const props = pm ? [...pm.matchAll(/["']?([a-z0-9_]+)["']?\s*:\s*["']?([a-z0-9_]+)["']?/g)].map((m) => `${m[1]}=${m[2]}`).sort() : [];
        return props.length ? `${n}[${props.join(',')}]` : n;
      };
      const cellMap = (h) => new Map((h.cells ?? []).map((l) => { const sp = l.indexOf(' '); return [l.slice(0, sp), asState(l.slice(sp + 1).split(' be=')[0])]; }));
      const was = cellMap(cells0), now = cellMap(cellsBefore);
      const standing = [];
      for (const [pos, st] of now) if (was.get(pos) !== st && !/^minecraft:(air|cave_air)$/.test(st.replace(/\[.*$/, ''))) standing.push(st);
      const targets = siteCells && typeof siteCells === 'object' ? Object.keys(siteCells).length : 0;
      void targets;
      const dec = await L.call('dev.site.deconstruct', { site }, 120_000);
      o.deconstruct = { removed: dec.removed, refund: dec.tally?.refund ?? null };
      const expect = bomOf(standing);
      check(dec.removed && canon(dec.tally?.refund ?? {}) === canon(expect) && canon(expect) === canon(bill), `item 11 (${id}): deconstructed under the exact rules, the refund equals the items of the ${standing.length} blocks standing (${Object.values(expect).reduce((p, q) => p + q, 0)} items, the fed bill)`, { refund: dec.tally?.refund, expect, bill, sample: (cellsBefore.cells ?? []).slice(0, 3) });
      // the instant reference at the same spot
      await L.fresh(`G6B VOCb SurvRef ${k}`, FLAT);
      await L.setRules('exact');
      await L.tp(x + 4, FLAT_Y + 20, z + 4);
      const ref = await result(await api(`place ${id} ${x} ${y} ${z} INSTANT unowned noactor 0 force`));
      o.instant = { placed: ref?.placed, hash: (await hash(rb)).sha256 };
      check(ref?.placed && o.instant.hash === o.survivalHash, `item 11 (${id}): the built site is identical to an instant placement over its restore box (block entities included): ${o.survivalHash.slice(0, 12)} vs ${o.instant.hash.slice(0, 12)}`);
    }
    return out;
  },
}];

// ------------------------------------------------------------------ look (6cvoc-look): item 15

async function shot(ctx, name, eye, lookAt) {
  const { L, OUT } = ctx;
  await L.call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: lookAt[0], y: lookAt[1], z: lookAt[2] }, mode: 'spectator', fov: 70 }, 60_000);
  await L.call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  await L.settle(1500);
  const r = await L.call('dev.screenshot', { name: `vocb_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
  const dir = path.join(OUT, 'look-vocb');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, eye, lookAt, file: dst };
}

const look = [{
  name: 'item 15: the four VOC bibles on v50\'s village and the four designs (recorded, not judged)',
  async run(ctx) {
    const { L, root, check } = ctx;
    const out = { shots: [], bibles: {} };
    installBibles(ctx, LOOK_BIBLES);
    const ids = await installDesigns(ctx);
    const v50 = fixture(root, 'valid', 'v50_voc_village.json');
    for (const bible of LOOK_BIBLES) {
      await L.fresh(`G6B VOCb Look ${bible}`, FLAT);
      await L.setRules('exact');
      const r = await realiseRun(ctx, `look-${bible}`, { claim: FLAT_CLAIM, plan: { ...v50.plan, planId: `voc_look_${bible}` }, bible, expectReady: false, keep: true });
      out.bibles[bible] = { overall: r.check?.overall ?? null, state: r.realise?.state ?? null, rarity: Object.values(r.artifactCost ?? {})[0]?.rarity ?? null };
      if (r.realise?.state !== 'PLACED') { check(true, `look (${bible}): not realised (${r.check?.overall}; recorded)`); continue; }
      await L.cmd('/time set 6000');
      const geo = r.check.parts.find((a) => a.part === 'village');
      const pdir = r.planDir;
      const art = JSON.parse(fs.readFileSync(path.join(pdir, 'plancheck.json'), 'utf8'));
      const rect = art.parts.find((a) => a.part === 'village')?.geometry?.rect ?? [FLAT_CLAIM[0] + 90, FLAT_CLAIM[1] + 60, FLAT_CLAIM[0] + 140, FLAT_CLAIM[1] + 100];
      void geo;
      const [x0, z0, x1, z1] = rect;
      const mx = (x0 + x1) >> 1, mz = (z0 + z1) >> 1;
      const gy = FLAT_Y;
      out.shots.push(await shot(ctx, `${bible}_village`, [mx - 30, gy + 34, z1 + 34], [mx, gy + 2, mz]));
      out.shots.push(await shot(ctx, `${bible}_square`, [mx + 10, gy + 12, mz + 16], [mx, gy + 1, mz]));
    }
    // the four designs, side by side, in their bibles
    await L.fresh('G6B VOCb Look designs', FLAT);
    await L.setRules('exact');
    const api = async (args) => { const r = await L.cmd(`/apitest ${args}`); const line = (r.messages ?? []).find((m) => m.startsWith('{')); return line ? JSON.parse(line) : null; };
    for (const [i, id] of ids.entries()) {
      const x = 7100 + 18 * i, z = 7100;
      await L.tp(x, FLAT_Y + 20, z);
      await api(`place ${id} ${x} ${FLAT_Y + 1} ${z} INSTANT unowned noactor 0 force`);
      await sleep(3000);
      out.shots.push(await shot(ctx, `design_${id}`, [x + 12, FLAT_Y + 12, z + 22], [x + 4, FLAT_Y + 4, z + 4]));
    }
    out.shots.push(await shot(ctx, 'designs_row', [7100 + 27, FLAT_Y + 26, 7100 + 46], [7100 + 27, FLAT_Y + 3, 7100 + 4]));
    fs.writeFileSync(path.join(ctx.OUT, 'look-vocb', 'shots.json'), `${JSON.stringify(out, null, 1)}\n`);
    check(true, `item 15 (recorded, not judged: Noah's call, N-VOC-5): ${out.shots.length} screenshots in look-vocb/ (the four bibles on v50's village, the four designs)`, out.shots.map((s) => s.name));
    return out;
  },
}];

export const items = { unit, ingame, natural, survival, look };
void pathToFileURL;
