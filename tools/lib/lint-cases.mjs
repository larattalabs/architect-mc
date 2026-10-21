// (fast checks P2) The lints' cases (tools/lint.mjs). Every case builds its plan(s) from committed inputs with the kit at
// LINT_KIT_DIR (this checkout's, or a mutated scratch copy) and returns {ok, fails, recorded, warn, metrics}. `covers`: the in-game
// assertion rows (docs/FAST-CHECKS.md "Every step, every assertion group": `<step> #<row>`) the case stands in for; the coverage map
// tools/lint-coverage.json is checked against these.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KIT = process.env.LINT_KIT_DIR ?? path.join(ROOT, 'kit');
const kimp = (rel) => import(pathToFileURL(path.join(KIT, rel)).href);
const GOLD = path.join(ROOT, 'scenarios', 'goldens');
const LINTFIX = path.join(ROOT, 'kit', 'test', 'fixtures', 'lint');
const PREFIX = Object.fromEntries((process.env.LINT_PREFIX ?? '').split(',').filter(Boolean).map((kv) => kv.split(':')));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------ the plan cache (per kit content; a miss only costs the plan)

let kitHashMemo = null;
function kitHash() {
  if (kitHashMemo) return kitHashMemo;
  const h = createHash('sha256');
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = path.join(d, e.name); if (e.isDirectory()) { if (p !== path.join(KIT, 'lib', 'lint')) walk(p); } else if (/\.(mjs|json)$/.test(e.name)) { h.update(path.relative(KIT, p)); h.update(fs.readFileSync(p)); } } };
  for (const d of ['lib', 'regions', 'vocab']) if (fs.existsSync(path.join(KIT, d))) walk(path.join(KIT, d));
  // (kit/lib/lint is the lints' own code: no plan reads it, so editing a rule keeps the plans cached)
  for (const f of ['voxel_classes.json']) if (fs.existsSync(path.join(KIT, f))) h.update(fs.readFileSync(path.join(KIT, f)));
  h.update(process.version);
  kitHashMemo = h.digest('hex').slice(0, 24);
  return kitHashMemo;
}
const CACHE = path.join(path.resolve(ROOT, '..', 'architect-mc'), 'artifacts', 'lint-cache');
async function cachedPlan(input, plan) {
  const key = sha256(JSON.stringify(['lint-cache-2', kitHash(), input]));
  const f = path.join(CACHE, `${key}.json`);
  if (fs.existsSync(f) && process.env.LINT_NO_CACHE !== '1') {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const blobs = new Map(Object.entries(j.blobs).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
      return { ir: JSON.parse(j.irJson), irJson: j.irJson, meta: j.meta, blobs, cached: true };
    } catch { /* re-plan */ }
  }
  const res = await plan();
  try {
    fs.mkdirSync(CACHE, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ irJson: res.irJson, meta: res.meta, blobs: Object.fromEntries([...(res.blobs ?? new Map())].map(([k, v]) => [k, Buffer.from(v).toString('base64')])) }));
    fs.renameSync(tmp, f);
  } catch { /* a cache */ }
  return { ir: res.ir, irJson: res.irJson, meta: res.meta, blobs: res.blobs ?? new Map(), cached: false };
}

// ------------------------------------------------------------------ inputs

async function flatSurveyBytes(claim, y = 64) {
  const { makeColumns, encodeColumns } = await kimp('lib/region/pack.mjs');
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const c = makeColumns(claim.minX, claim.minZ, W, D, 1);
  for (let k = 0; k < W * D; k++) { c.ground[k] = y; c.height[k] = y; c.floor[k] = y; c.flags[k] = 0; }
  return Buffer.from(encodeColumns(c));
}
const bibleOf = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'bibles', `${id}.json`), 'utf8'));

/** A scenario golden's committed inputs planned by this kit (`flat`: over a flat claim at 64, no volumes; `bible`: its roles). */
async function goldenCase(name, { flat = false, bible = null } = {}) {
  const { loadPlanDir } = await kimp('lib/lint/vworld-fixtures.mjs');
  const G = loadPlanDir(path.join(GOLD, name));
  const g = G.ir;
  const survey = flat ? await flatSurveyBytes(g.claim) : G.survey;
  // (the golden's committed frozen volumes, as scenarios.mjs's golden row passes them: {sha, box, bytes, decoded})
  const { decodeArvx } = await kimp('lib/region/volume.mjs');
  const vols = flat ? [] : Object.values(g.volumes ?? {}).map((v) => { const b = G.blobs(g.blobs?.[v.blob]?.sha ?? v.sha); if (!b) return null; const decoded = decodeArvx(b); return { sha: decoded.sha, box: decoded.box, bytes: Uint8Array.from(b), decoded }; }).filter(Boolean);
  const roles = bible ? { ...bibleOf(bible).roles } : g.roles;
  const input = { name, flat, bible, program: g.id, params: g.params, seed: g.seed, roles, keepOut: g.keepOut ?? [], surveySha: sha256(survey), vols: vols.map((v) => v.sha) };
  const { planRegion } = await kimp('lib/region/plan.mjs');
  const res = await cachedPlan(input, () => planRegion({ programFile: path.join(KIT, 'regions', `${g.id}.mjs`), params: g.params, survey, seed: g.seed, claim: { ...g.claim, minY: -64, maxY: 319 }, roles, keepOut: g.keepOut ?? [], ...(vols.length ? { volumes: vols } : {}) }));
  return { name: `${name}${flat ? '-flat' : ''}${bible ? `@${bible}` : ''}`, ir: res.ir, meta: res.meta, survey, blobs: (sha) => res.blobs.get(sha) ?? G.blobs(sha), volumes: vols.map((v) => v.decoded), protected: [], builds: [] };
}

/** A plan/0 fixture through the kit's own plan check (kit/test/plan-p0-shared.mjs run). */
async function p0Case(dir, name) {
  const S = await kimp('test/plan-p0-shared.mjs');
  const fx = { name, ...JSON.parse(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'plan', dir, name), 'utf8')) };
  return p0Of(fx, S);
}
async function p0Of(fx, S) {
  S ??= await kimp('test/plan-p0-shared.mjs');
  const sv = S.svOf(fx);
  const { decodeArvx } = await kimp('lib/region/volume.mjs');
  // the plan check's result, cached per kit content and fixture (a cold cache costs the kit's own plan check once)
  const key = sha256(JSON.stringify(['lint-p0-1', kitHash(), fx]));
  const f = path.join(CACHE, `p0-${key}.json`);
  let j = null;
  if (fs.existsSync(f) && process.env.LINT_NO_CACHE !== '1') { try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { j = null; } }
  if (!j) {
    const r = await S.run(fx);
    const blobs = r.res?.blobs instanceof Map ? r.res.blobs : new Map();
    j = { check: r.check ?? null, irJson: r.res?.ir ? JSON.stringify(r.res.ir) : null, meta: r.res?.meta ?? null, blobs: Object.fromEntries([...blobs].map(([k, v]) => [k, Buffer.from(v).toString('base64')])), volumes: (r.volumes ?? []).map((v) => (v.bytes ? Buffer.from(v.bytes).toString('base64') : null)).filter(Boolean) };
    try { fs.mkdirSync(CACHE, { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(j)); fs.renameSync(tmp, f); } catch { /* a cache */ }
  }
  const blobs = new Map(Object.entries(j.blobs ?? {}).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  const volumes = (j.volumes ?? []).map((b) => decodeArvx(Buffer.from(b, 'base64')));
  return { fx, check: j.check, c: j.irJson ? { name: fx.name, ir: JSON.parse(j.irJson), meta: j.meta, survey: sv.bytes, blobs: (sha) => blobs.get(sha) ?? null, volumes, protected: fx.protected ?? [], builds: fx.builds ?? [], plan: fx.plan, answers: j.check?.parts ?? [] } : null };
}

// ------------------------------------------------------------------ the lint and its verdict

const BASELINE = (() => { try { return JSON.parse(fs.readFileSync(path.join(LINTFIX, 'baseline.json'), 'utf8')).entries ?? []; } catch { return []; } })();
/** Gate lines less the baseline's known findings (an entry {lint, case, rule, count, why}: exact count, else it FAILs). */
function applyBaseline(lint, caseName, rep, lines) {
  const out = { fails: [], recorded: [] };
  const counts = {};
  for (const f of rep.findings) counts[f.rule] = (counts[f.rule] ?? 0) + f.count;
  for (const l of lines) {
    const rule = l.split(' ')[0];
    const b = BASELINE.find((e) => e.lint === lint && e.case === caseName && e.rule === rule);
    if (b && counts[rule] === b.count) { if (!out.recorded.some((q) => q.startsWith(`baseline ${rule}`))) out.recorded.push(`baseline ${rule} x${b.count} (${b.why})`); }
    else out.fails.push(l + (b ? ` [baseline says ${b.count}: the count moved]` : ''));
  }
  return out;
}

async function structure(c, bars = {}) {
  const S = await kimp('lib/lint/structure.mjs');
  const rep = S.structureLint(c, { preFix: PREFIX });
  const lines = S.gate(rep, bars);
  const v = applyBaseline('structure', c.name, rep, lines);
  return { rep, ...v };
}
const summary = (rep) => {
  const by = {};
  for (const f of rep.findings) by[f.rule] = (by[f.rule] ?? 0) + f.count;
  const m = rep.metrics;
  return `M2 ${m.M2?.reached}/${m.M2?.nodes}; M5 ${m.M5 ? (100 * m.M5.share).toFixed(2) : '-'}% of ${m.M5?.walkArea ?? '-'}; lanterns ${m.lanterns?.posts ?? 0}; findings ${JSON.stringify(by)}`;
};

// ------------------------------------------------------------------ structure cases

const SCEN = {
  s1: ['6b-scenario-s1 #5'], s2: ['6c-scenario-s2 #5', '6c-scenario-s2 #8'], s7: ['6cv-scenario-s7 #5'], relief_demo: ['6ct1-scenario-relief #5'],
  route_demo: ['6ct2-scenario-route #5', 't2-ingame #2', 't2-ingame #5'], forms_demo: ['6cf1-scenario-forms #5', '6cf1-scenario-forms #6', '6cf1-scenario-forms #7'],
  scatter_demo: ['6cf2-scenario-scatter #6', '6cf2-scenario-scatter #7'], districts_demo: ['6cd-scenario-districts #5'],
  crossings_demo_flat: ['t3a-ingame #3', 't3b-ingame #4'], links_demo: ['k1b-ingame #4'], links_demo_flat: ['k1b-ingame #4'],
};
const FLATS = ['s1', 's7', 'relief_demo', 'route_demo', 'districts_demo'];
// M5 gated where the scenario's own `safety` row is gated in game (S1, S7 and S2's natural run: < 1% of the walk area); recorded elsewhere
const M5BAR = { s1: { m5: 0.01 }, 's1-flat': { m5: 0.01 }, s7: { m5: 0.01 }, 's7-flat': { m5: 0.01 }, s2: { m5: 0.01 } };

function structureCases() {
  const out = [];
  for (const [name, covers] of Object.entries(SCEN)) {
    out.push({ id: `g:${name}`, covers, run: async () => { const c = await goldenCase(name); const r = await structure(c, M5BAR[name] ?? { m5: null }); return { ok: [summary(r.rep)], fails: r.fails, recorded: r.recorded, metrics: r.rep.metrics }; } });
  }
  for (const name of FLATS) out.push({ id: `g:${name}-flat`, covers: SCEN[name], run: async () => { const c = await goldenCase(name, { flat: true }); const r = await structure(c, M5BAR[`${name}-flat`] ?? { m5: null }); return { ok: [summary(r.rep)], fails: r.fails, recorded: r.recorded }; } });
  out.push({ id: 'pathbibles', covers: ['w-ingame #8', 'w-ingame #9'], run: pathBibles });
  for (const [dir, n] of [['kc', 1], ['irr', 1], ['rope', 1], ['tunnel', 2], ['t3a', 2], ['k1a', 1], ['refused', 1], ['voc', 1], ['vocc', 1], ['h', 2], ['hy', 3], ['valid', 6]]) {
    for (let k = 0; k < n; k++) out.push({ id: `p0:${dir}${n > 1 ? `/${k + 1}` : ''}`, covers: P0COVERS[dir] ?? [], run: () => corpus(dir, k, n) });
  }
  for (const w of ['bridge', 'rope', 'tunnel']) out.push({ id: `even:${w}`, covers: EVENCOVERS[w], run: () => evenFuzz(w) });
  for (const h of HIST) out.push({ id: `hist:${h.id}`, covers: h.covers, run: h.run });
  return out;
}

const P0COVERS = {
  kc: ['kc-ingame #6', 'voc-ingame (wall through the fountain)'], k1a: ['k1a-natural #4', 'k1a-target #5'], refused: ['4d-all #16', 'v-ingame #7 (refusal half)', 'd2-ingame #12'],
  t3a: ['t3a-ingame #3', 't3a-natural #4', 't3a-frozen #4'], tunnel: ['t3b-ingame #4'], rope: ['k1b-ingame #4'], voc: ['voc-ingame #5', 'voc-ingame #10'],
  vocc: ['vocc-ingame #3', 'vocc-ingame #8', 'vocc-ingame #9'], irr: ['irr-ingame #1'], h: ['h-ingame #23'], valid: ['Steward-shaped plans (risk 6)'],
};
const EVENCOVERS = { bridge: ['even-width bridges (c4f1c8f9)'], rope: ['even-width ropes (9ba60b79)'], tunnel: ['even-width tunnels (9ba60b79)'] };

// (the corpus gates the lint's own S- rules and error findings; the connector re-reads are gated on the scenario plans and the fuzz)
const CONNECTOR_DIRS = new Set([]);
/** The corpus: every fixture of a plan/0 dir (the k-th of n slices); broken variants must be caught, refusals must be the expected code. */
async function corpus(dir, k, n) {
  const files = fs.readdirSync(path.join(KIT, 'test', 'fixtures', 'plan', dir)).filter((f) => f.endsWith('.json') && f !== 'SOURCE.json').sort().filter((_, i) => i % n === k);
  const S = await kimp('test/plan-p0-shared.mjs');
  const res = { ok: [], fails: [], recorded: [] };
  for (const f of files) {
    const fx = { name: f, ...JSON.parse(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'plan', dir, f), 'utf8')) };
    if (!fx.on && !fx.terrain) { fx.on = 'flat'; fx.volume ??= {}; } // (h/farm_hamlet: h-batch.test.mjs plans it over flatSurvey() in the two-plan flow)
    let p;
    try { p = await p0Of(fx, S); } catch (e) { res.fails.push(`${f}: the plan check threw ${String(e.message).slice(0, 200)}`); continue; }
    // a broken variant the plan check passes and the region check must catch (KC's u01-u04: ext architect_mc:unsafe)
    const broken = (/^u\d+_/.test(f) || /broken variant/.test(fx.about ?? '') || fx.expect?.clearRule === true) && !fx.expect?.code;
    // fixtures whose kit test runs them its own way (a `loose` volume spec, a bible object as `style`): their refusals stay the kit test's
    const ownRunner = !!fx.volume?.loose || (fx.style && typeof fx.style === 'object');
    // the refusal set: a fixture that expects a refused part answers that code (and the refused part writes nothing)
    if (fx.expect?.part && fx.expect?.code && ownRunner) res.recorded.push(`${f}: refusal ${fx.expect.code} judged by its own kit test (its runner)`);
    else if (fx.expect?.part && fx.expect?.code) {
      const a = (p.check?.parts ?? []).find((q) => q.part === fx.expect.part);
      const code = a?.reasons?.[0]?.code ?? null;
      if (a?.class === 'refused' && code === fx.expect.code) res.ok.push(`${f}: refused ${code} (the refusal set)`);
      else if (fx.expect.class && a?.class === fx.expect.class) res.ok.push(`${f}: ${a.class}`);
      else res.fails.push(`${f}: ${fx.expect.part} answered ${a?.class} ${code ?? ''}, expected refused ${fx.expect.code}`);
    }
    if (!p.c) { if (!fx.expect?.code) res.recorded.push(`${f}: no plan (${p.check?.overall ?? JSON.stringify(p.check?.malformed ?? '?')})`); continue; }
    if (ownRunner) continue;
    const r = await structure({ ...p.c, name: `p0:${dir}/${f}` }, { corpus: true, connectors: CONNECTOR_DIRS.has(dir) });
    if (broken) {
      if (r.fails.length) res.ok.push(`${f}: broken variant caught (${[...new Set(r.fails.map((l) => l.split(' ')[0]))].join(', ')})`);
      else res.fails.push(`${f}: a broken variant the lint did not catch`);
    } else {
      // a refused part writes nothing: its cells are no finding of an answered part; the parts that fit must be clean
      for (const l of r.fails) res.fails.push(`${f}: ${l}`);
      res.recorded.push(...r.recorded.map((l) => `${f}: ${l}`));
    }
  }
  if (!res.fails.length) res.ok.unshift(`${files.length} fixture(s) of plan/${dir} clean (broken variants caught, refusals as expected)`);
  return res;
}

// ------------------------------------------------------------------ S7's path bibles (w-ingame item 5)

async function pathBibles() {
  const S = await kimp('lib/lint/structure.mjs');
  const { blockLight } = await kimp('lib/region/check.mjs');
  const { F_WALK } = await kimp('lib/region/vworld.mjs');
  const out = { ok: [], fails: [], recorded: [] };
  const counts = {};
  for (const [blk, bible] of [['coarse_dirt', 'g6cv_village'], ['packed_mud', 'g6cw_path_packed_mud'], ['stone_bricks', 'g6cw_path_stone_bricks'], ['oak_planks', 'g6cw_path_oak_planks']]) {
    const c = await goldenCase('s7', { flat: true, bible });
    const rep = S.structureLint(c, { preFix: PREFIX });
    const { vw, lant } = rep.world;
    // walkDark (scenario-village.mjs): the village's walk cells (street, verges, lanes, square: walk-flagged), dark when the floor is
    // spawnable and the block light at the feet is 0 (a post or prop standing on it: not a walk cell)
    const light = blockLight(vw);
    const P = vw.pal;
    let n = 0, dark = 0;
    const sample = [];
    const seen = new Set();
    vw.eachWritten((x, y, z, idx, f) => {
      if (!(f & F_WALK) || seen.has(`${x},${z}`)) return;
      seen.add(`${x},${z}`);
      if (!P.passable[vw.get(x, y + 1, z)] || !P.passable[vw.get(x, y + 2, z)]) return;
      n++;
      if (P.spawn[vw.get(x, y, z)] && light.at(x, y + 1, z) === 0) { dark++; if (sample.length < 6) sample.push([x, y + 1, z]); }
    });
    counts[blk] = lant.posts.length;
    const lines = S.gate(rep);
    out.fails.push(...lines.map((l) => `${blk}: ${l}`));
    if (dark === 0) out.ok.push(`${blk}: M5 over the street, verges, lanes and square 0.00% (0 of ${n} walk cells; ${lant.posts.length} road lanterns, ${lant.skipped} skipped)`);
    else out.fails.push(`${blk}: ${dark} of ${n} walk cells dark and spawnable ${JSON.stringify(sample)}`);
  }
  const ref = counts.coarse_dirt;
  for (const blk of ['packed_mud', 'stone_bricks', 'oak_planks']) (counts[blk] === ref ? out.ok : out.fails).push(`road lanterns with a ${blk} path ${counts[blk]} = the coarse-dirt bible's ${ref}`);
  return out;
}

// ------------------------------------------------------------------ the even-width fuzz (every writer that offsets by rightOf)

/** The fixture turned 90 degrees about its claim's origin (even-width-hk3.test.mjs transposed). */
function transposed(f) {
  const t = f.terrain, x0 = t.x0, z0 = t.z0;
  const terrain = { ...t, W: t.D, D: t.W, bands: (t.bands ?? []).map((b) => ({ ...b, x0: x0 + (b.z0 - z0), x1: x0 + (b.z1 - z0), z0: z0 + (b.x0 - x0), z1: z0 + (b.x1 - x0) })) };
  const anchors = Object.fromEntries(Object.entries(f.anchors).map(([k, [x, y, z]]) => [k, [x0 + (z - z0), y, z0 + (x - x0)]]));
  return { terrain, anchors };
}
async function evenFuzz(writer) {
  const file = { bridge: ['t3a', 'w01_even_width.json'], rope: ['even', 'ew01_rope_even_width.json'], tunnel: ['even', 'ew02_tunnel_even_width.json'] }[writer];
  const f = JSON.parse(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'plan', file[0], file[1]), 'utf8'));
  const S = await kimp('test/plan-p0-shared.mjs');
  const conn = f.plan.connectors.findIndex((q) => q.from?.anchor && q.to?.anchor);
  const [a, b] = [f.plan.connectors[conn].from.anchor, f.plan.connectors[conn].to.anchor];
  const tr = transposed(f);
  const swap = (an) => ({ ...an, [a]: an[b], [b]: an[a] });
  const heads = [{ terrain: f.terrain, anchors: f.anchors }, { terrain: f.terrain, anchors: swap(f.anchors) }, { terrain: tr.terrain, anchors: tr.anchors }, { terrain: tr.terrain, anchors: swap(tr.anchors) }];
  const out = { ok: [], fails: [], recorded: [] };
  const widths = f.expect?.widths ?? [2, 4];
  let runs = 0;
  const kinds = new Set();
  for (const width of widths) for (const h of heads) {
    const plan = JSON.parse(JSON.stringify(f.plan));
    plan.connectors[conn].width = width;
    const fx = { ...f, terrain: h.terrain, anchors: h.anchors, plan, name: `${file[1]} w${width}`, volume: f.volume ?? {} };
    const p = await p0Of(fx, S);
    if (!p.c) { out.fails.push(`w${width}: no plan`); continue; }
    const recs = [...(p.c.meta?.bridges ?? []), ...(p.c.meta?.ropes ?? []), ...(p.c.meta?.tunnels ?? [])];
    if (!recs.length) { out.recorded.push(`w${width} ${JSON.stringify(h.anchors[a])}: no ${writer} planned (${JSON.stringify((p.check?.parts ?? []).map((q) => [q.part, q.class, q.reasons?.[0]?.code ?? null]))})`); continue; }
    for (const q of recs) kinds.add(JSON.stringify(q.dir));
    runs++;
    const r = await structure({ ...p.c, name: `even:${writer}` }, { corpus: true, connectors: true });
    out.fails.push(...r.fails.map((l) => `w${width} dir ${JSON.stringify(recs[0].dir)}: ${l}`));
  }
  if (runs && !out.fails.length) out.ok.push(`${writer}: widths ${widths.join(', ')} on both axes, both ways (${runs} plans, headings ${[...kinds].join(' ')}): landings on the walk's footprint (S-LAND), the checker's connector rules clean`);
  if (!runs) out.fails.push(`${writer}: no even-width ${writer} planned at all`);
  return out;
}

// ------------------------------------------------------------------ the historical bugs' own fixtures (the Java-side fixes, modelled)

const HIST = [
  {
    id: 'sand', covers: ['sand vanish (70fc0dd0): tile-gravity #2 stays KEEP-INGAME'],
    run: async () => {
      const r = await histFixture('sand_vanish');
      // and crossings_demo flat's ridge with its sand band (T3b's world): recorded
      const c = await goldenCase('crossings_demo_flat');
      const g = await structure(c, { m5: null });
      r.recorded.push(`crossings_demo flat: ${g.rep.metrics.gravityKept} supported gravity block(s) on a later stage's changed cells (S-GRAV ${g.fails.filter((l) => l.startsWith('S-GRAV')).length ? 'FAIL' : 'clean'})`);
      r.fails.push(...g.fails.map((l) => `crossings_demo flat: ${l}`));
      return r;
    },
  },
  {
    id: 'felling', covers: ['C31 felling (5cc0d7f1): c31-felling #1 stays KEEP-INGAME'],
    run: async () => histFixture('c31_felling'),
  },
  {
    id: 'door', covers: ['C34/C34b claim-box door (f5204066, a0530bc3)'],
    run: async () => histFixture('c34_door'),
  },
  {
    id: 'lamp-path', covers: ['lamp on dirt path (52cc9606, c494ddab)'],
    run: async () => histFixture('lamp_path'),
  },
  {
    id: 'farm-hamlet', covers: ['farm typed lot (65d61b0b): Steward-shaped'],
    run: async () => {
      const fx = { name: 'farm_hamlet', ...JSON.parse(fs.readFileSync(path.join(LINTFIX, 'plans', 'farm_hamlet.json'), 'utf8')) };
      const p = await p0Of(fx);
      if (!p.c) return { fails: ['no plan'] };
      const r = await structure({ ...p.c, name: 'hist:farm-hamlet' });
      const ponds = (p.c.meta?.waters ?? []).filter((w) => w.kind === 'farm_pond').length;
      return { ok: [`${ponds} farm pond(s) for the farm lot whose villager use its type implies; ${summary(r.rep)}`], fails: r.fails, recorded: r.recorded };
    },
  },
];

/**
 * A historical fixture of kit/test/fixtures/lint/hist/<name>.json: a plan/0 request over a flat claim, with `volume` (frozen cells:
 * {box, blocks: [[x0, y0, z0, x1, y1, z1, block]]} -> an ARVX v2 with block ids and classes) and `builds` (build records).
 */
async function histFixture(name) {
  const fx = { name, ...JSON.parse(fs.readFileSync(path.join(LINTFIX, 'hist', `${name}.json`), 'utf8')) };
  const H = await kimp('lib/lint/hist.mjs');
  const one = async (f) => { const p = await H.histPlan(f, KIT); return structure({ ...p, blockBase: !!f.blockBase, name: `hist:${name}` }, { m5: null }); };
  const r = await one(fx);
  const out = { ok: [`${fx.about.split(':')[0]}: the fixed fixture clean; ${summary(r.rep)}${r.rep.metrics.gravityKept ? `; ${r.rep.metrics.gravityKept} supported gravity block(s) kept` : ''}`], fails: r.fails, recorded: r.recorded };
  if (fx.expectKept !== undefined && r.rep.metrics.gravityKept !== fx.expectKept) out.fails.push(`S-GRAV: ${r.rep.metrics.gravityKept} supported gravity block(s) kept, expected ${fx.expectKept} (the rule is not exercised)`);
  // the broken variants (the record or plan as it was before the fix): each must FAIL on its rule
  for (const v of fx.variants ?? []) {
    const f = JSON.parse(JSON.stringify(fx));
    for (const [k, idxs] of Object.entries(v.patch)) for (const [i, patch] of Object.entries(idxs)) Object.assign(f[k][Number(i)], patch);
    const rv = await one(f);
    const hit = rv.fails.filter((l) => l.startsWith(v.expect));
    (hit.length ? out.ok : out.fails).push(`broken variant ${v.name}: ${hit.length ? `caught (${hit[0].slice(0, 160)})` : `NOT caught by ${v.expect} (${rv.fails.join(' | ').slice(0, 200) || 'clean'})`}`);
  }
  return out;
}

// ------------------------------------------------------------------ look cases (kit/lib/lint/look.mjs)

async function lookCases() {
  const L = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'lint-look-cases.mjs')).href);
  return L.lookCases({ goldenCase, p0Of, kimp, LINTFIX, PREFIX, applyBaseline });
}

let lookList = null;
export function cases(lint) {
  if (lint === 'structure') return structureCases();
  if (lint === 'look') return lookList ?? [];
  return [];
}
export async function loadLook() { lookList = await lookCases(); return lookList; }
export { goldenCase, p0Of, structure, flatSurveyBytes };
