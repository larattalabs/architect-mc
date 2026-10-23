// (6c VOC-c) VOC-c's items of the VOC gate (tools/gate6cvoc.mjs; docs/CONTRACT.md "Phase 6c slice VOC-c" §9): `rule.palette` measured.
// Offline (`vocc-unit`): items 1, 2, 7, 8 (kit/test/vocc.test.mjs and the suites it touches), 3 (the 59 asks against the committed before
// and after tables), 4 (byte identity against the base: every committed plan fixture without a palette rule, the named exceptions), 9
// (api-compat --gate6cvocc), the Java and sidecar tests. In game (`vocc-ingame`, headless): item 5 (v64 and v65 through checkPlan and
// realiseApproved; r03's PALETTE refusal, nothing written, then PLACED with a copper entry; a non-required rule's ext row), item 6 (the
// mod's measure equals the kit's for each entry), Steward's pre-check (S-VOCc-2: Regions.checkPalette) and the delta re-judge
// (S-VOCc-3). VOC-c owns this file.
import fs from 'node:fs';
import { firstAsk } from './asks-first.mjs'; // (6c close-out A) the asks as the earlier slices judged them
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { FL_MOVED, FL_MOVED_ASKS, normIrJson, flAsksFilter } from './fl-norm.mjs'; // (6c FL) the street ext normalised, FL's named movers
import { syncBaseTree } from './base-tree.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const j = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Item 4's named exceptions (§6 "Byte identity"): the fixtures whose answers VOC-c changes by name. The 7 asks with a palette rule (their
 * rule's answer only), extension/e16 (its r_palette left the reserved list: refused NO_FEATURE now) and extension/e05 (its reserved rule is
 * rule.shape's draft now: a palette rule is supported). New VOC-c fixtures have no counterpart on the base.
 */
const t0 = new Set(['extension/e16_every_reserved_b.json']); // ((6c FL) FL's movers appended, none listed twice)
export const UNCHANGED_EXCEPTIONS = Object.freeze(['asks/desert_jungle_wall.json', 'asks/hidden_village.json', 'asks/mage_exiles.json', 'asks/old_new_town.json',
  'asks/one_block.json', 'asks/rival_families.json', 'asks/row_houses.json', 'extension/e05_reserved_rule.json', 'extension/e16_every_reserved_b.json', ...FL_MOVED.filter((n) => !t0.has(n))]);

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

/** A detached worktree beside this checkout at the base this branch builds on (the merge base with origin/main). */
export function baseTree(root) {
  const dir = path.resolve(root, '..', 'architect-mc-VOCc-main');
  return syncBaseTree(root, dir, { fetchOptional: true }); // (turbo) one fetch and checkout at a time; left alone at the base
}

/**
 * The 59 recorded asks' answers as a table (§7's record): per ask its overall, then per part its block, class and first reason code;
 * a palette rule's measure (cells, family, share) after it. `kitDir`: a checkout whose kit runs (this one, or the base's).
 */
export async function asksTable(kitDir) {
  // ((gate speed 3) the 59 plans from the run's shared store (corpus-plan.mjs), prewarmed on every core; GATE_PLAN_CACHE=0: as before)
  const CP = await import('./corpus-plan.mjs');
  await CP.prewarmAsks(kitDir, [kitDir], 'checkPlanLocal', { fxAnchors: true });
  const H = await CP.helpers(kitDir);
  const sv = H.asksSurvey();
  const dir = path.join(kitDir, 'kit', 'test', 'fixtures', 'plan', 'asks');
  const lines = [];
  let malformed = 0;
  const counts = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json').sort()) {
    const fx = JSON.parse(fs.readFileSync(firstAsk(dir, f), 'utf8')); // ((6c close-out A) the first recordings)
    const plan = fx.answer?.plan ?? fx.plan;
    const r = await H.checkPlanLocal(plan, { survey: sv.bytes, claim: sv.claim, anchors: { ...H.stewardAnchors(sv.claim), ...(fx.anchors ?? {}) } });
    const ask = f.replace(/\.json$/, '');
    lines.push(`${ask} ${r.check.overall}`);
    for (const a of r.check.parts) {
      counts[a.class] = (counts[a.class] ?? 0) + 1;
      if (a.class === 'malformed') malformed++;
      const m = a.measured ? ` measured ${a.measured.family}/${a.measured.cells}` : '';
      lines.push(`  ${a.part} ${a.block} ${a.class}${a.reasons?.[0] ? ` ${a.reasons[0].code}` : ''}${m}`);
    }
  }
  const head = `# 59 asks (${Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join(', ')}); ${malformed} malformed\n`;
  return { text: `${head}${lines.join('\n')}\n`, malformed };
}

/**
 * Item 4: every committed plan fixture (every dir of kit/test/fixtures/plan, the asks too) without a palette rule answers and plans as on
 * the base but its kitVersion; the exceptions by name. The base's kit in `mainDir` (baseTree). A fixture with a frozen volume runs the
 * two-plan harness on both sides; a palette fixture new in VOC-c has no counterpart (skipped, counted).
 */
export async function unchanged(root, mainDir) {
  // ((gate speed 3) both sides' plans from the run's shared store (corpus-plan.mjs); GATE_PLAN_CACHE=0: as before)
  const CP = await import('./corpus-plan.mjs');
  const [hNew, hOld] = [await CP.helpers(root), await CP.helpers(mainDir)];
  const out = { fixtures: {} };
  let same = 0, skipped = 0;
  const base = path.join(root, 'kit', 'test', 'fixtures', 'plan');
  for (const dir of fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory()).sort()) {
    for (const f of fs.readdirSync(path.join(base, dir)).filter((x) => x.endsWith('.json')).sort()) {
      const name = `${dir}/${f}`;
      const fx = JSON.parse(fs.readFileSync(path.join(base, dir, f), 'utf8'));
      const plan = fx.plan ?? fx.answer?.plan;
      if (!plan) continue;
      if (!fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', dir, f))) { skipped++; continue; }
      const old = JSON.parse(fs.readFileSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', dir, f), 'utf8'));
      const oldPlan = old.plan ?? old.answer?.plan;
      const on = fx.on ?? (dir === 'asks' ? 'asks' : undefined);
      const sv = (h) => (fx.terrain ? h.flatSurvey(fx.terrain) : on === 'asks' ? h.asksSurvey() : on === 'flat' ? h.flatSurvey() : on ? h.goldenSurvey(on) : h.flatSurvey());
      const runOn = async (h, p) => {
        const s = sv(h);
        const o = { survey: s.bytes, claim: s.claim, anchors: { ...h.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}) };
        return fx.volume !== undefined && h.checkPlanVolumes ? h.checkPlanVolumes(p, { ...o, volume: fx.volume }) : h.checkPlanLocal(p, o);
      };
      let a, b;
      try { a = await runOn(hNew, plan); b = await runOn(hOld, oldPlan); } catch (e) { out.fixtures[name] = { error: String(e.message).slice(0, 200) }; continue; }
      const norm = (r) => normIrJson(r.res?.irJson);
      const answers = (r) => JSON.stringify(r.check?.parts ?? r.check?.malformed ?? null);
      const eq = { answers: answers(a) === answers(b), ir: sha256(norm(a)) === sha256(norm(b)), overall: a.check?.overall === b.check?.overall };
      out.fixtures[name] = eq;
      if (eq.answers && eq.ir && eq.overall) same++;
    }
  }
  out.same = same; out.n = Object.keys(out.fixtures).length; out.skipped = skipped;
  const differing = Object.entries(out.fixtures).filter(([, v]) => !(v.answers && v.ir && v.overall));
  out.excepted = differing.map(([k]) => k).filter((k) => UNCHANGED_EXCEPTIONS.includes(k));
  out.differ = differing.filter(([k]) => !UNCHANGED_EXCEPTIONS.includes(k)).map(([k, v]) => [k, v]);
  out.ok = out.n >= 150 && out.differ.length === 0 && out.same + out.excepted.length === out.n;
  return out;
}

// ------------------------------------------------------------------ unit (vocc-unit)

const unit = [
  {
    name: 'items 1, 2, 7, 8 (kit): the def and its lenient read, groups, the measure, the no-X re-plan, every refusal with its re-checked wouldFit, the artifact rows, catalogue 9, vocab/1, determinism; the suites it touches',
    async run({ root, check }) {
      const r = nodeTest(root, ['kit/test/vocc.test.mjs']);
      check(r.code === 0 && r.fail === 0 && r.pass >= 10, `items 1, 2, 7, 8 (kit/test/vocc.test.mjs): ${r.pass} pass, ${r.fail} fail`, r.failing);
      const s = nodeTest(root, ['kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/hy-core.test.mjs', 'kit/test/h-foundation.test.mjs', 'kit/test/t3-foundation.test.mjs', 'kit/test/vocab.test.mjs', 'kit/test/vocab-rules.test.mjs']);
      check(s.code === 0 && s.fail === 0 && s.pass >= 30, `the suites VOC-c touches (P0's catalogue and fixtures, HY's and H's catalogue tests re-pointed to catalogue-hy.json, the VOC tests): ${s.pass} pass, ${s.fail} fail`, s.failing);
      return { vocc: r, suites: s };
    },
  },
  {
    name: 'item 3: the 59 recorded asks: before and after tables (fixtures/plan/vocc/asks-before.txt, asks-after.txt), 0 malformed, only the palette rules moved, no until RC for rule.palette',
    async run({ root, check, OUT }) {
      const { dir, base } = baseTree(root);
      const before = await asksTable(dir), after = await asksTable(root);
      fs.writeFileSync(path.join(OUT, 'vocc-asks-before.txt'), before.text);
      fs.writeFileSync(path.join(OUT, 'vocc-asks-after.txt'), after.text);
      const cb = fs.readFileSync(path.join(root, 'kit', 'test', 'fixtures', 'plan', 'vocc', 'asks-before.txt'), 'utf8');
      const ca = fs.readFileSync(path.join(root, 'kit', 'test', 'fixtures', 'plan', 'vocc', 'asks-after.txt'), 'utf8');
      // ((6c FL) FL's five free asks and the tally are FL's (its item 8: tools/lib/fl-norm.mjs flAsksFilter); and the base may be VOC-c's own
      // after table once VOC-c is on main)
      const bl = flAsksFilter(before.text).split('\n'), al = flAsksFilter(after.text).split('\n');
      const moved = al.map((l, i) => [l, bl[i]]).filter(([x, y]) => x !== y && !/^# /.test(x ?? '')).map(([x, y]) => `${y} -> ${x}`);
      const nonPalette = moved.filter((m) => !/ rule\.palette /.test(m) && !/^[a-z_]+ [A-Z_]+ -> /.test(m));
      const overallMoved = moved.filter((m) => /^[a-z_]+ [A-Z_]+ -> /.test(m));
      check((flAsksFilter(before.text) === flAsksFilter(cb) || flAsksFilter(before.text) === flAsksFilter(ca)) && flAsksFilter(after.text) === flAsksFilter(ca), `item 3: the asks' tables equal the committed ones (before at the base ${base.slice(0, 8)}, after at HEAD; FL's five free asks aside)`, { moved });
      check(after.malformed === 0 && nonPalette.length === 0 && overallMoved.length === 0 && !/until RC/.test(after.text.split('\n').filter((l) => /rule\.palette/.test(l)).join('\n')), `item 3: 0 malformed; only the 7 palette rules' answers moved (${moved.length}: ${moved.join('; ')}); no ask's overall moved`, { nonPalette, overallMoved });
      return { moved, base };
    },
  },
  {
    name: 'item 4: byte identity: every committed plan fixture without a palette rule answers and plans as on the base (the named exceptions only)',
    async run({ root, check, OUT }) {
      const { dir, base } = baseTree(root);
      const out = await unchanged(root, dir);
      fs.writeFileSync(path.join(OUT, 'vocc-unchanged.json'), `${JSON.stringify(out, null, 1)}\n`);
      check(out.ok, `item 4: ${out.same} of ${out.n} fixtures unchanged but kitVersion against the base ${base.slice(0, 8)} (${out.skipped} new, skipped); the named exceptions that moved: ${out.excepted.join(', ')}; differing otherwise: ${j(out.differ)}`, out.differ);
      return { same: out.same, n: out.n, excepted: out.excepted, differ: out.differ };
    },
  },
  {
    name: 'items 7, 9 (sidecar, Java, API): vocab/1 in both forms and the append-only ref list, lotBlocks on the wire; PaletteRulesTest, the HY version pins; api-compat --gate6cvocc',
    async run({ root, check }) {
      const out = {};
      const sc = spawnSync('npx', ['vitest', 'run', 'test/system-refs.test.ts', 'test/jobs.test.ts', 'test/vocc.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 900_000 });
      out.sidecar = { code: sc.status, tail: `${sc.stdout}${sc.stderr}`.split('\n').filter((l) => /Tests|passed|failed|×/.test(l)).slice(-4) };
      check(sc.status === 0, `items 7 (sidecar): the systemRef list append-only, vocab/1's groups and compact.palette in both forms, the feature plan.rules, a check's lotBlocks to the plan CLI's --lot-blocks: ${out.sidecar.tail.join(' ')}`, out.sidecar);
      out.java = await javaTests(root, ['*PaletteRulesTest*', '*RegionFluidsHYTest*', '*ApiVocTest*', '*ApiHTest*'], 10);
      check(out.java.ok, `Java: PaletteRules' measure (the pre-check, the refusal, the ext rows, a non-required rule never refuses), PALETTE appended, checkPalette a default method, RegionRefused's detail, the feature rulePalette: ${out.java.tests} tests, ${out.java.failures} failures`, out.java);
      const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', '--gate6cvocc'], { cwd: root, encoding: 'utf8', timeout: 1_800_000, env: { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` } });
      out.apicompat = { code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').slice(-8) };
      check(ac.status === 0, 'item 9: api-compat --gate6cvocc clean against the 0.39.0, 0.38.0 and 0.37.1 apitest jars and the 0.39.0 jar\'s 1.36.0 surface', out.apicompat.tail);
      return out;
    },
  },
];

// ------------------------------------------------------------------ in game (vocc-ingame, headless)

const OWNER = 'test:vocc';
const FLAT = 'G6B Flat Base';
/** A flat claim per run (the flatSurvey claim's shape: 240 x 160). */
const CLAIM = [9600, 9000, 9839, 9159];

/** A plan fixture with its style JSON. */
function fixture(root, ...p) {
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'kit', 'test', 'fixtures', 'plan', ...p), 'utf8'));
  const style = typeof fx.style === 'string' ? JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'bibles', `${fx.style}.json`), 'utf8')) : fx.style ?? null;
  return { ...fx, styleJson: style };
}

function installBible(ctx, id, json) {
  const dst = path.join(ctx.L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, 'bible.json'), `${JSON.stringify(json, null, 1)}\n`);
}

/** VOC-c's two cabins as library entries; returns the kit's histograms of each (what lotBlocks sends). */
async function installDesigns(ctx) {
  const D = await ctx.imp('test/fixtures/vocab/vocc-designs.mjs');
  const { writeBlueprint } = await ctx.imp('lib/write.mjs');
  const hist = {};
  // (each entry fresh: a run worktree reused from an earlier run may hold the oak version 2 the delta check installs)
  for (const [id, mk] of Object.entries(D.VOCC_DESIGNS)) { const bp = mk(); fs.rmSync(path.join(ctx.L.LIBRARY, id), { recursive: true, force: true }); writeBlueprint(bp, path.join(ctx.L.LIBRARY, id)); hist[id] = D.blueprintBlocks(bp); }
  return hist;
}

async function anchorsOf(ctx, claim) {
  const H = await ctx.imp('test/plan-helpers.mjs');
  return H.stewardAnchors({ minX: claim[0], minZ: claim[1], maxX: claim[2], maxZ: claim[3] });
}

/** checkPlan in game (the two-plan flow, chunks generated), then the artifact's body. */
async function checkIn(ctx, tag, { plan, claim, bible }) {
  const { L, OUT } = ctx;
  const anchors = await anchorsOf(ctx, claim);
  const c = await L.call('dev.region.checkPlan', { plan, claim, owner: OWNER, anchors, load: 'generate', ...(bible ? { bible } : {}) }, 900_000);
  fs.writeFileSync(path.join(OUT, `vocc-${tag}-check.json`), `${JSON.stringify(c, null, 1)}\n`);
  const art = c.check?.artifactSha ? (await L.call('dev.region.artifact', { sha: c.check.artifactSha, body: true })).artifact : null;
  return { c, art };
}

/** The box a realise writes (the claim grown by 8, the plan's y range) and a snapshot of it. */
async function snap(ctx, tag, c, claim) {
  const { L, OUT } = ctx;
  const pdir = path.join(L.SIDECAR_DATA, 'regions', 'plans', c.check.checkId);
  const ir = JSON.parse(fs.readFileSync(path.join(pdir, 'ir.json'), 'utf8'));
  const box = [claim[0] - 8, ir.claim.minY, claim[1] - 8, claim[2] + 8, ir.claim.maxY, claim[3] + 8];
  const snapF = path.join(OUT, `vocc-${tag}-snap.gz`);
  await L.cmd('/kill @e[type=!minecraft:player]');
  await L.settle(4000);
  await L.call('dev.region.hash', { box, mode: 'snap', file: snapF }, 4 * 3_600_000);
  return { box, snapF, ir };
}

async function diffSnap(ctx, s) {
  await ctx.L.settle(4000);
  return ctx.L.call('dev.region.hash', { box: s.box, mode: 'diff', file: s.snapF }, 4 * 3_600_000);
}

async function realise(ctx, sha, lotEntries) {
  const { L } = ctx;
  const rr = await L.call('dev.region.realiseApproved', { sha, ...(lotEntries ? { lotEntries } : {}) }, 300_000);
  if (rr.refused) return { refused: rr.refused, reason: rr.reason };
  const st = await L.waitRegion(rr.region, 3 * 3_600_000, async (s) => { if (s.view?.waiting?.reason === 'OCCUPIED' || s.waiting?.OCCUPIED) await L.cmd('/kill @e[type=!minecraft:player]'); });
  return { region: rr.region, state: st.view.state, record: st.record ?? null, items: st.items ?? null };
}

async function removeRegion(ctx, region) {
  await ctx.L.cmd('/kill @e[type=!minecraft:player]');
  await ctx.L.settle(4000);
  return ctx.L.call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
}

const ingame = [{
  name: 'items 5, 6, S-VOCc-2, S-VOCc-3: v64 and v65 through checkPlan and realiseApproved, r03\'s PALETTE refusal and its copper re-bind, the pre-check, the Java measure against the kit\'s, the delta re-judge',
  async run(ctx) {
    const { L, root, check, OUT } = ctx;
    const out = {};
    const kitHist = await installDesigns(ctx);
    out.kitHist = kitHist;
    for (const id of ['g6cvocc_copper', 'g6cvocc_spruce']) installBible(ctx, id, JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'bibles', `${id}.json`), 'utf8')));
    const { measureLot, unmeasuredBlocks } = await ctx.imp('lib/plan/palette.mjs');
    const { resolvePalette } = await ctx.imp('lib/vocab/groups.mjs');
    // a fresh flat world per run, exact rules (no random ticks, mobs or fire), the bot over the claim
    const freshFlat = async (name) => { await L.fresh(name, FLAT); await L.setRules('exact'); await L.tp((CLAIM[0] + CLAIM[2]) >> 1, 200, (CLAIM[1] + CLAIM[3]) >> 1); };

    // (order: r03 and v65 bind vocc_copper_cabin's version 1; v64 runs last, since its delta check installs the oak version 2 of that
    // entry, which a realise then places as the entry's current template)
    // ---- r03: a required rule over a provisional lot: READY (pending); realiseApproved with the oak entry refuses PALETTE, nothing written; then the copper entry: PLACED
    const r03 = fixture(root, 'vocc', 'r03_entry.json');
    await freshFlat('G6B VOCc r03');
    // ---- item 6: the mod's histogram of each entry equals the kit's (the blueprint the gate installed)
    out.hist = {};
    for (const id of Object.keys(kitHist)) {
      const h = await L.call('dev.vocc.histogram', { entry: id });
      out.hist[id] = h;
      check(j(h.blocks) === j(kitHist[id]), `item 6: ${id}: the mod's block histogram of the entry (what lotBlocks and the realise measure) equals the kit's (${Object.values(kitHist[id]).reduce((a, b) => a + b, 0)} blocks: ${j(kitHist[id])})`, { mod: h.blocks, kit: kitHist[id] });
    }

    const k03 = await checkIn(ctx, 'r03', { plan: r03.plan, claim: CLAIM, bible: 'g6cvocc_copper' });
    const a03 = (k03.c.check?.parts ?? []).find((a) => a.part === 'copper_only');
    out.r03 = { overall: k03.c.check?.overall, answer: a03 };
    check(k03.c.check?.overall === 'READY' && a03?.class === 'fits' && j(a03.measured?.pendingLots) === j(['hall']), `item 5 (r03): READY, copper_only fits over the parts with hall pending (R11 amended: verified at realiseApproved): ${j(a03?.measured)}`, out.r03);
    if (k03.c.check?.artifactSha) {
      const s = await snap(ctx, 'r03', k03.c, CLAIM);
      const bad = await realise(ctx, k03.c.check.artifactSha, { hall: 'vocc_oak_cabin' });
      out.r03oak = bad;
      const d0 = await diffSnap(ctx, s);
      out.r03oakDiff = { mismatches: d0.mismatches };
      const ev = /\{.*\}$/.exec(String(bad.refused ?? ''));
      let evidence = null;
      try { evidence = ev ? JSON.parse(ev[0]) : null; } catch { evidence = null; }
      out.r03evidence = evidence;
      check(bad.reason === 'PALETTE' && evidence?.lot === 'hall' && evidence?.entry === 'vocc_oak_cabin' && evidence?.rule === 'copper_only' && evidence?.family === 'copper' && Array.isArray(evidence?.share) && typeof evidence?.measured === 'number' && evidence?.cells > 0 && d0.mismatches === 0,
        `item 5 (r03): realiseApproved with hall bound to vocc_oak_cabin refuses PALETTE, evidence {rule ${evidence?.rule}, lot ${evidence?.lot}, entry ${evidence?.entry}, family ${evidence?.family}, share ${j(evidence?.share)}, measured ${evidence?.measured}, cells ${evidence?.cells}}; nothing written (E-flat ${d0.mismatches} against the snapshot)`, { bad, evidence });
      const good = await realise(ctx, k03.c.check.artifactSha, { hall: 'vocc_copper_cabin' });
      out.r03copper = { ...good, record: undefined };
      check(good.state === 'PLACED', `item 5 (r03): the same artifact with hall bound to vocc_copper_cabin: PLACED (${good.state ?? `refused ${good.reason}: ${good.refused}`})`, out.r03copper);
      if (good.region) {
        const rm = await removeRegion(ctx, good.region);
        const d = await diffSnap(ctx, s);
        out.r03remove = { removed: rm.removed, mismatches: d.mismatches };
        check(rm.removed && d.mismatches === 0, `item 5 (r03): Regions.remove restores the box exactly: E-flat ${d.mismatches}`, (d.list ?? []).slice(0, 12));
      }
    }

    // ---- v65: "no wood" re-planned (adjusted); realiseApproved with its lots bound to the copper cabin (no wood): PLACED; the realised
    // world holds no wood block in the plan's written cells; a non-required rule's ext row; and an oak lot never refuses it
    const v65 = fixture(root, 'valid', 'v65_vocc_nowood.json');
    await freshFlat('G6B VOCc v65');
    const k65 = await checkIn(ctx, 'v65', { plan: v65.plan, claim: CLAIM, bible: 'g6cvocc_spruce' });
    const a65 = (k65.c.check?.parts ?? []).find((a) => a.part === 'no_wood');
    out.v65 = { overall: k65.c.check?.overall, answer: a65 };
    const others = (k65.c.check?.parts ?? []).filter((a) => a.part !== 'no_wood');
    check(k65.c.check?.overall === 'READY' && a65?.class === 'adjusted' && (a65.deviations ?? []).every((d) => d.what === 'material' && d.value > 0) && a65.measured?.family === 0 && others.every((a) => a.class === 'fits'),
      `item 5 (v65): Regions.checkPlan READY; no_wood adjusted, re-planned with the wood group excluded (${(a65?.deviations ?? []).map((d) => `${d.from.replace('minecraft:', '')} -> ${d.to.replace('minecraft:', '')} ${d.value}`).join(', ')}); measured wood ${a65?.measured?.family} of ${a65?.measured?.cells}; every other part fits`, out.v65);
    if (k65.c.check?.artifactSha) {
      const s = await snap(ctx, 'v65', k65.c, CLAIM);
      const lots = Object.fromEntries((k65.art?.body?.lots ?? []).map((l) => [l.id, 'vocc_oak_cabin']));
      const pre = await L.call('dev.vocc.checkPalette', { sha: k65.c.check.artifactSha, lotEntries: lots });
      out.v65preOak = pre;
      check(pre.paletteOk === true && pre.rules?.[0]?.fits === false && pre.rules[0].required === false, `item 5 (v65): the pre-check with every lot bound to the oak cabin: the non-required no_wood measures ${pre.rules?.[0]?.measured} (outside [0, 0]) but the check is ok: a non-required rule never refuses`, pre);
      // a non-required rule never refuses: realised with every lot bound to the oak cabin (wood in the lots), its ext row records the miss
      // (the artifact pinned: removing the oak region would otherwise sweep it, C36, before the copper realise below)
      await L.call('dev.region.pinArtifact', { sha: k65.c.check.artifactSha, owner: OWNER });
      const oakRun = await realise(ctx, k65.c.check.artifactSha, lots);
      out.v65oak = { ...oakRun, record: undefined };
      if (oakRun.region) {
        const ext = await L.call('dev.vocc.regionPalette', { region: oakRun.region });
        out.v65oakExt = ext;
        check(oakRun.state === 'PLACED' && ext.palette?.[0]?.rule === 'no_wood' && ext.palette[0].fits === false && ext.palette[0].measured > 0, `item 5 (v65): realiseApproved with every lot bound to the oak cabin: ${oakRun.state} (the non-required no_wood never refuses); its ext row records measured ${ext.palette?.[0]?.measured} over ${ext.palette?.[0]?.cells} cells, fits ${ext.palette?.[0]?.fits}`, { oakRun: out.v65oak, ext });
        const rm0 = await removeRegion(ctx, oakRun.region);
        const d0 = await diffSnap(ctx, s);
        check(rm0.removed && d0.mismatches === 0, `item 5 (v65, oak lots): Regions.remove restores the box exactly: E-flat ${d0.mismatches}`, (d0.list ?? []).slice(0, 12));
      } else check(false, `item 5 (v65): realiseApproved with oak lots refused (${oakRun.reason}: ${oakRun.refused}): a non-required rule must never refuse`);
      const rr = await realise(ctx, k65.c.check.artifactSha, Object.fromEntries(Object.keys(lots).map((l) => [l, 'vocc_copper_cabin'])));
      out.v65realise = { ...rr, record: undefined };
      check(rr.state === 'PLACED', `item 5 (v65): realiseApproved with its lots bound to the copper cabin: PLACED (${rr.state ?? `refused ${rr.reason}: ${rr.refused}`})`, out.v65realise);
      if (rr.region) {
        const ext = await L.call('dev.vocc.regionPalette', { region: rr.region });
        out.v65ext = ext;
        check(Array.isArray(ext.palette) && ext.palette[0]?.rule === 'no_wood' && ext.palette[0].required === false && ext.palette[0].fits === true, `item 5 (v65): the realise's ext architect_mc:palette row: no_wood (not required) measured ${ext.palette?.[0]?.measured} over ${ext.palette?.[0]?.cells} cells, fits`, ext);
        // the realised world: no wood block in any cell the plan's IR parts write (the virtual world's written cells, outside the lots)
        const V = await ctx.imp('lib/region/vworld.mjs');
        const pdir = path.join(L.SIDECAR_DATA, 'regions', 'plans', k65.c.check.checkId);
        const blobs = (sh) => { const f = path.join(pdir, 'blobs', `${sh}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
        const { vw } = V.buildVirtual({ ir: s.ir, survey: fs.readFileSync(path.join(pdir, 'survey.bin')), blobs });
        const afterF = path.join(OUT, 'vocc-v65-after.arwd.gz');
        await L.settle(4000);
        await L.call('dev.region.dump', { box: s.box, file: afterF, light: false }, 1_800_000);
        const after = await V.decodeArwd(fs.readFileSync(afterF));
        const wood = new Set(resolvePalette('wood').blocks);
        const inLot = (x, y, z) => s.ir.lots.some((l) => x >= l.box.minX && x <= l.box.maxX && y >= l.box.minY && y <= l.box.maxY && z >= l.box.minZ && z <= l.box.maxZ);
        let written = 0, woodCells = 0;
        const first = [];
        vw.eachWritten((x, y, z) => {
          if (inLot(x, y, z)) return;
          written++;
          const got = after.palette[after.cells[after.at(x, y, z)]].replace(/\[.*$/, '');
          if (wood.has(got)) { woodCells++; if (first.length < 8) first.push([x, y, z, got]); }
        });
        out.v65world = { written, woodCells, first };
        check(written > 0 && woodCells === 0, `item 5 (v65): the realised world holds no wood block in the ${written} cells the plan writes outside its lots`, first);
        await L.call('dev.region.pinArtifact', { sha: k65.c.check.artifactSha, owner: OWNER, on: false });
        const rm = await removeRegion(ctx, rr.region);
        const d = await diffSnap(ctx, s);
        out.v65remove = { removed: rm.removed, mismatches: d.mismatches };
        check(rm.removed && d.mismatches === 0, `item 5 (v65): Regions.remove restores the box exactly: E-flat ${d.mismatches}`, (d.list ?? []).slice(0, 12));
      }
    }
    // ---- v64: "only copper", the bound lot measured at check time from the mod's lotBlocks; realiseApproved PLACED; the pre-check
    const v64 = fixture(root, 'valid', 'v64_vocc_copper.json');
    await freshFlat('G6B VOCc v64');
    const k64 = await checkIn(ctx, 'v64', { plan: v64.plan, claim: CLAIM, bible: 'g6cvocc_copper' });
    const a64 = (k64.c.check?.parts ?? []).find((a) => a.part === 'copper_only');
    out.v64 = { overall: k64.c.check?.overall, answer: a64, refused: k64.c.refused ?? null };
    const copper = new Set(resolvePalette('copper').blocks);
    const kitLot = measureLot(kitHist.vocc_copper_cabin, copper);
    check(k64.c.check?.overall === 'READY' && a64?.class === 'fits' && j(a64.measured?.lots?.hall) === j([kitLot.family, kitLot.cells]) && (a64.measured?.pendingLots ?? []).length === 0,
      `item 5 (v64): Regions.checkPlan READY, copper_only fits with the bound lot measured at check time from the mod's lotBlocks (hall ${j(a64?.measured?.lots?.hall)}, the kit's own ${j([kitLot.family, kitLot.cells])}; ${a64?.measured?.cells} cells, share ${a64?.measured?.share})`, out.v64);
    const row64 = (k64.art?.body?.palette ?? []).find((r) => r.rule === 'copper_only');
    check(row64 && row64.blocks.length === copper.size && j(row64.natural) === j(unmeasuredBlocks()) && j(row64.lotCounts) === j({ hall: [kitLot.family, kitLot.cells] }), `item 5 (v64): the artifact's palette row carries the family's ${row64?.blocks?.length} blocks, the ${row64?.natural?.length} unmeasured blocks, the parts' counts (${row64?.partsFamily}/${row64?.partsCells}) and the bound lot's (${j(row64?.lotCounts)})`, row64 ? { ...row64, blocks: row64.blocks.length, natural: row64.natural.length } : null);
    if (k64.c.check?.artifactSha) {
      const pre = await L.call('dev.vocc.checkPalette', { sha: k64.c.check.artifactSha });
      out.v64pre = pre;
      const pr = pre.rules?.[0];
      check(pre.paletteOk === true && pr?.fits && pr.lots?.hall?.cells === kitLot.cells && pr.lots.hall.familyCells === kitLot.family && pr.cells === row64.partsCells + kitLot.cells, `S-VOCc-2 (the pre-check, v64): Regions.checkPalette ok, copper_only fits; the mod's lot count equals the kit's at check time (item 6: ${pr?.lots?.hall?.familyCells}/${pr?.lots?.hall?.cells}), ${pr?.cells} cells in all`, pre);
      const preOak = await L.call('dev.vocc.checkPalette', { sha: k64.c.check.artifactSha, lotEntries: { hall: 'vocc_oak_cabin' } });
      out.v64preOak = preOak;
      check(preOak.paletteOk === false && preOak.rules?.[0]?.worstLot === 'hall' && !preOak.rules[0].fits, `S-VOCc-2 (the pre-check): with the hall re-bound to vocc_oak_cabin, checkPalette answers not ok, worst lot hall (${preOak.rules?.[0]?.familyCells}/${preOak.rules?.[0]?.cells}, share ${preOak.rules?.[0]?.measured}): Steward re-binds one lot before any realise`, preOak);
      const s = await snap(ctx, 'v64', k64.c, CLAIM);
      const rr = await realise(ctx, k64.c.check.artifactSha);
      out.v64realise = { ...rr, record: undefined };
      check(rr.state === 'PLACED', `item 5 (v64): realiseApproved PLACED (${rr.state ?? `refused ${rr.reason}: ${rr.refused}`})`, out.v64realise);
      if (rr.region) {
        const ext = await L.call('dev.vocc.regionPalette', { region: rr.region });
        out.v64ext = ext;
        check(Array.isArray(ext.palette) && ext.palette[0]?.rule === 'copper_only' && ext.palette[0].fits === true && ext.palette[0].lots?.hall?.[1] === kitLot.cells, `item 5 (v64): the realise's ext architect_mc:palette row: copper_only fits, hall ${j(ext.palette?.[0]?.lots?.hall)} (item 6: the realise's count equals the kit's ${kitLot.cells})`, ext);
        // ---- S-VOCc-3: the hall's entry gets a version 2 in oak: a delta to it breaks the required rule (checkDelta refuses PALETTE, applyDelta writes nothing)
        const site = (rr.items && Object.keys(rr.items).length) ? null : null;
        void site;
        const st = await L.call('dev.region.state', { region: rr.region }).catch(() => null);
        const hallSite = st?.view?.lots?.find?.((l) => l.lot === 'hall' || l.id === 'hall')?.siteId ?? st?.record?.lots?.hall?.siteId ?? null;
        out.hallSite = hallSite;
        if (hallSite) {
          const vdir = path.join(OUT, 'vocc-v2');
          const D = await ctx.imp('test/fixtures/vocab/vocc-designs.mjs');
          const { writeBlueprint } = await ctx.imp('lib/write.mjs');
          const oak = D.voccOakCabin();
          oak.id = 'vocc_copper_cabin';
          fs.rmSync(vdir, { recursive: true, force: true });
          writeBlueprint(oak, vdir);
          const inst = await L.call('dev.entry.installVersion', { entry: 'vocc_copper_cabin', dir: vdir, summary: 'VOC-c gate: the cabin in oak' }, 60_000);
          out.installVersion = inst;
          const ver = inst.version ?? 2;
          const cd = await L.call('dev.vocc.delta', { site: hallSite, version: ver, owner: OWNER });
          out.deltaCheck = cd;
          check(cd.verdictOk === false && (cd.refusals ?? []).some((x) => x.reason === 'PALETTE' && /copper_only/.test(x.message)), `S-VOCc-3: a delta of the hall to its oak version ${ver} (a versionOf): Sites.checkDelta refuses PALETTE for the required copper_only (${(cd.refusals ?? []).map((x) => `${x.reason}: ${String(x.message).slice(0, 120)}`).join('; ')})`, cd);
          const ad = await L.call('dev.vocc.delta', { site: hallSite, version: ver, owner: OWNER, apply: true }, 120_000);
          out.deltaApply = ad;
          check(ad.applied === false && ad.written === 0 && (ad.refusals ?? []).some((x) => x.reason === 'PALETTE'), `S-VOCc-3: Sites.applyDelta to it refuses PALETTE and writes nothing (applied ${ad.applied}, written ${ad.written})`, ad);
        } else check(false, `S-VOCc-3: the hall's site was not found in the region's state (${j(st)?.slice(0, 300)})`);
        const rm = await removeRegion(ctx, rr.region);
        const d = await diffSnap(ctx, s);
        out.v64remove = { removed: rm.removed, mismatches: d.mismatches };
        check(rm.removed && d.mismatches === 0, `item 5 (v64): Regions.remove restores the box exactly: E-flat ${d.mismatches}`, (d.list ?? []).slice(0, 12));
      }
    }

    fs.writeFileSync(path.join(OUT, 'vocc-ingame.json'), `${JSON.stringify(out, null, 1)}\n`);
    return out;
  },
}];

export const items = { 'vocc-unit': unit, 'vocc-ingame': ingame };
void sleep;
