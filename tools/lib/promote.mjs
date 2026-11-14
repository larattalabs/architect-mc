// (7c PM) The shape-promotion pipeline's steps (docs/CONTRACT.md "Phase 7c" §3 row 14; SETTLEMENTS §13; kit/lib/forms/CANDIDATES.md),
// over one candidate generator: lint, determinism, properties, variety (the contact sheet), Noah's approval, output (a semver'd module).
// tools/promote.mjs is the CLI; kit/test/pm-promote.test.mjs holds the units. Everything here is $0 and offline: the candidate is planned
// as a region program's form part over a synthetic survey, evaluated tile by tile with the kit's own realise, and checked with the kit's
// own checker.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
const kit = (p) => pathToFileURL(path.join(REPO, 'kit', p)).href;

const { planRegion } = await import(kit('lib/region/plan.mjs'));
const { region, blockState } = await import(kit('lib/region/program.mjs'));
const { compileIR, evalTile } = await import(kit('lib/realise.mjs'));
const { makeColumns, unpack } = await import(kit('lib/region/pack.mjs'));
const { lintAuthored } = await import(kit('lib/plan/authored.mjs'));
const { encodePng } = await import(kit('lib/png.mjs'));
const { buildScene, renderIso } = await import(kit('lib/render.mjs'));

/** The steps, in order (CANDIDATES.md's columns). */
export const STEPS = Object.freeze(['lint', 'determinism', 'properties', 'variety', 'approval', 'output']);
/** Variety: pairs under this silhouette IoU ... */
export const IOU_MAX = 0.8;
/** ... at least this share of the pairs. */
export const IOU_SHARE = 0.8;
export const SEEDS = 20;
/** Eval cost: at most this many times the reference generator's per cell (report-only: a bench, docs/GATES.md "Speed rules" 9). */
export const COST_BOUND = 2;
const GROUND = 64;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const isInt = Number.isInteger;

/** A deterministic param sampler (LCG over an fnv-free 32-bit seed: plain integer maths). */
function lcg(k, salt) {
  let s = (Math.imul(k + 1, 2654435761) ^ salt) >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * The candidates. Each: its module (repo path), the record beside it, the closed import list the lint allows, the program method
 * (`r.<method>`), a one-line description, the sheet's params (seed k: the caller's fixed frame, only the seed varies), property param
 * sets (seed k: everything varies, a valley under some), the frame the silhouettes share, and the reference generator for the cost.
 */
export const CANDIDATES = Object.freeze({
  archSpan: {
    module: 'kit/lib/forms/archSpan.mjs',
    record: 'kit/lib/forms/archSpan.promotion.json',
    imports: ['../noise.mjs'],
    method: 'archSpan',
    describe: 'archSpan: a masonry arcade carrying a deck across a gap (1-2 tiers; round, segmental, pointed or elliptical arches; wall, crenel, rail or no parapet), a span for AQ',
    sheet: (k) => ({ at: [0, GROUND + 1, 0], length: 48, width: 5, seed: `pm${k}` }),
    property: (k) => {
      const r = lcg(k, 0x5eed);
      const species = ['roman', 'gothic', 'bridge', 'viaduct'][Math.floor(r() * 4)];
      const axis = r() < 0.5 ? 'x' : 'z';
      const p = { at: [-7 + Math.floor(r() * 15), GROUND + 1, -7 + Math.floor(r() * 15)], axis, length: 12 + Math.floor(r() * 85), width: 3 + Math.floor(r() * 7), species, seed: `prop${k}` };
      if (r() < 0.3) p.tiers = 1;
      if (r() < 0.3) p.parapet = ['wall', 'crenel', 'rail', 'none'][Math.floor(r() * 4)];
      if (r() < 0.25) p.bays = 1 + Math.floor(r() * 6);
      const valley = r() < 0.4 ? 4 + Math.floor(r() * 20) : 0;
      return { params: p, valley };
    },
    frame: { along: 48, below: 0, above: 52 },
    reference: async () => {
      const { crater } = await import(kit('lib/forms/crater.mjs'));
      return { name: 'crater', method: (r, id) => r.form(id, crater({ rect: { minX: -20, minZ: -20, maxX: 19, maxZ: 19 }, seed: 'ref', groundAt: (x, z) => r.survey.heightAt(x, z) })) };
    },
  },
});

export function candidateOf(name) {
  const c = CANDIDATES[name];
  if (!c) throw new Error(`promote: no candidate '${name}' (known: ${Object.keys(CANDIDATES).join(', ')})`);
  return c;
}
export async function moduleOf(c) { return import(pathToFileURL(path.join(REPO, c.module)).href); }

// ------------------------------------------------------------------ the harness

/** A survey over `claim`: flat ground at GROUND, or a valley `depth` deep across the middle third of the claim along `axis`. */
export function surveyOf(claim, { valley = 0, axis = 'x' } = {}) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const c = makeColumns(claim.minX, claim.minZ, W, D, 1);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const u = axis === 'x' ? x / W : z / D;
    const g = valley && u > 1 / 3 && u < 2 / 3 ? GROUND - valley : GROUND;
    const i = z * W + x;
    c.ground[i] = g; c.height[i] = g; c.floor[i] = g;
  }
  return c;
}
function windowOf(survey, key) {
  const [tx, tz] = key.split(',').map(Number);
  const c = makeColumns(tx * 64 - 8, tz * 64 - 8, 80, 80, 1);
  for (let z = 0; z < 80; z++) for (let x = 0; x < 80; x++) {
    const wx = tx * 64 - 8 + x - survey.minX, wz = tz * 64 - 8 + z - survey.minZ;
    const g = wx >= 0 && wz >= 0 && wx < survey.width && wz < survey.depth ? survey.ground[wz * survey.width + wx] : GROUND;
    const i = z * 80 + x;
    c.ground[i] = g; c.height[i] = g; c.floor[i] = g;
  }
  return c;
}

/** The claim round a candidate's bounds (16 of margin; y 32..200). */
export function claimFor(bounds) {
  const m = 16;
  return { minX: bounds.minX - m, minZ: bounds.minZ - m, maxX: bounds.maxX + m, maxZ: bounds.maxZ + m, minY: 20, maxY: 200 };
}

/**
 * Plan the candidate as form part `f` of a one-part region program over a synthetic survey. `bake`: the `form` option. Returns
 * {plan, gen, survey, blobs(sha)}. `call(r, id)` overrides the call (the reference generator; the pre-promotion fixture's program).
 */
export async function planForm(c, params, { valley = 0, bake = 'auto', roles, call, kitVersion = 'pm-golden' } = {}) {
  const mod = await moduleOf(c);
  const probe = mod[c.method]({ ...params });
  const claim = claimFor(probe.bounds);
  const survey = surveyOf(claim, { valley, axis: params.axis ?? 'x' });
  let gen;
  const program = { id: 'pm_form', default: (ctx) => {
    const r = region(ctx);
    r.stages(['main']);
    gen = call ? call(r, 'f') : r[c.method]('f', params, { stage: 'main', bake });
    r.anchor('entrance', [claim.minX + 2, claim.minZ + 2]);
    r.anchor('spawn', [claim.minX + 3, claim.minZ + 2]);
    return r;
  } };
  const plan = await planRegion({ program, programSource: 'pm_form', survey, claim, node: 'golden', kitVersion, ...(roles ? { roles } : {}) });
  return { plan, gen, survey, claim, blobs: (sha) => plan.blobs.get(sha) ?? null };
}

/** Every tile of an IR (stage main, both sets): {cells: Map("x,y,z" -> state), shas: ["set key sha"...], count}. */
export function tileEval(ir, survey, blobs) {
  const cells = new Map(), shas = [];
  let count = 0;
  for (const set of ['terrain', 'path']) for (const key of ir.tiles.main?.[set] ?? []) {
    const t = evalTile(ir, key, windowOf(survey, key), { stage: 'main', set, blobs });
    shas.push(`${set} ${key} ${t.sha}`);
    count += t.count;
    for (const cc of unpack(t.payload).cells) if (cc.state !== 'minecraft:air') cells.set(`${cc.x},${cc.y},${cc.z}`, cc.state);
  }
  return { cells, shas, count };
}

/** A tile-free reference evaluation of an IR's `columns` ops (absolute y), last op wins, cond IF_AIR_OR_FLUID over the survey. */
export function wholeEval(ir, survey) {
  const C = compileIR(structuredClone(ir));
  const m = new Map();
  const groundAt = (x, z) => survey.ground[(z - survey.minZ) * survey.width + (x - survey.minX)];
  for (const o of C.ops) {
    if (o.kind === 0 || !o.entries) throw new Error('wholeEval: only columns ops');
    const E = o.entries;
    for (let i = 0; i < E.length; i += 5) for (let y = E[i + 2]; y <= E[i + 3]; y++) {
      if (y <= groundAt(E[i], E[i + 1])) continue; // natural solid ground: IF_AIR_OR_FLUID keeps it
      m.set(`${E[i]},${y},${E[i + 1]}`, C.mats[E[i + 4]]);
    }
  }
  for (const [k, v] of m) if (v === 'minecraft:air') m.delete(k);
  return m;
}

// ------------------------------------------------------------------ step 1: lint

export function stepLint(c) {
  const src = fs.readFileSync(path.join(REPO, c.module), 'utf8');
  const findings = lintAuthored(src, { imports: c.imports, exports: false });
  return { pass: findings.length === 0, findings, sourceSha: sha256(src) };
}

// ------------------------------------------------------------------ step 2: determinism

/**
 * The determinism shas over the 20 sheet param sets: per seed, the sha of the generator's {ops, bounds} and of its tiles' payload shas
 * (planned and evaluated). The version string is not in either, so a version bump keeps them. `all`: the sha of the 20 lines.
 */
export async function determinismShas(c) {
  const mod = await moduleOf(c);
  const lines = [];
  for (let k = 0; k < SEEDS; k++) {
    const p = c.sheet(k);
    const g = mod[c.method]({ ...p });
    const gs = sha256(JSON.stringify({ ops: g.ops, bounds: g.bounds }));
    const { plan, survey, blobs } = await planForm(c, p);
    const ts = sha256(tileEval(plan.ir, survey, blobs).shas.join('\n'));
    lines.push(`${k} ${gs} ${ts}`);
  }
  return { lines, all: sha256(lines.join('\n')) };
}

// ------------------------------------------------------------------ step 3: properties

/** One property param set's checks: bounds, per-tile = whole, M3, materials resolve (S-THEME, canonical states), op primitives. */
export async function propertyCheck(c, k, { m3 = true } = {}) {
  const { params, valley } = c.property(k);
  const out = { k, params: JSON.stringify(params), valley, bad: [] };
  const { plan, gen, survey, blobs } = await planForm(c, params, { valley, bake: false });
  const ir = plan.ir;
  const { cells } = tileEval(ir, survey, blobs);
  if (cells.size === 0) out.bad.push('no cells');
  const b = gen.bounds;
  for (const key of cells.keys()) {
    const [x, y, z] = key.split(',').map(Number);
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ) { out.bad.push(`bounds: ${key} outside ${JSON.stringify(b)}`); break; }
  }
  const whole = wholeEval(ir, survey);
  if (whole.size !== cells.size) out.bad.push(`per-tile ${cells.size} cells, whole ${whole.size}`);
  else for (const [key, st] of whole) if (cells.get(key) !== st) { out.bad.push(`per-tile != whole at ${key}`); break; }
  for (const st of new Set(cells.values())) if (blockState(st) !== st) out.bad.push(`${st}: not a canonical state`);
  if (m3) {
    const { checkRegion } = await import(kit('lib/region/check.mjs'));
    const { buildVirtual } = await import(kit('lib/region/vworld.mjs'));
    const { themeOffenders } = await import(kit('lib/lint/theme.mjs'));
    const rep = checkRegion({ ir, survey, blobs, meta: plan.meta });
    const m3f = rep.findings.filter((f) => /^M3/.test(f.rule));
    for (const f of m3f) out.bad.push(`${f.rule} ${f.part}: ${f.message}`);
    const errs = rep.findings.filter((f) => f.severity === 'error');
    for (const f of errs) out.bad.push(`error ${f.rule} ${f.part}: ${f.message}`);
    const th = themeOffenders(ir, buildVirtual({ ir, survey, blobs }).vw, { meta: plan.meta }).offenders;
    if (th.length) out.bad.push(`S-THEME: ${JSON.stringify(th.slice(0, 3))}`);
  }
  out.cells = cells.size;
  return out;
}

/** Bibles the materials step resolves the roles through (besides the defaults). */
export const ROLE_SETS = Object.freeze({
  default: undefined,
  sandstone: { structure: 'minecraft:cut_sandstone', rail: 'minecraft:birch_fence' },
  deepslate: { structure: 'minecraft:deepslate_bricks', rail: 'minecraft:dark_oak_fence' },
});

/** The eval cost (ns per cell over every tile, 3 reps) of a planned IR. */
function costOf(ir, survey, blobs) {
  const keys = ir.tiles.main.terrain;
  const w = new Map(keys.map((k) => [k, windowOf(survey, k)]));
  evalTile(ir, keys[0], w.get(keys[0]), { stage: 'main', set: 'terrain', blobs });
  let cells = 0;
  const t = performance.now();
  for (let rep = 0; rep < 3; rep++) for (const key of keys) cells += evalTile(ir, key, w.get(key), { stage: 'main', set: 'terrain', blobs }).count;
  return ((performance.now() - t) * 1e6) / Math.max(1, cells);
}

export async function stepProperties(c, { sets = 40, m3Sets = 40 } = {}) {
  const results = [];
  for (let k = 0; k < sets; k++) results.push(await propertyCheck(c, k, { m3: k < m3Sets }));
  const failed = results.filter((r) => r.bad.length);
  // materials: the sheet's first five under each role set
  const materials = {};
  for (const [name, roles] of Object.entries(ROLE_SETS)) {
    const seen = new Set();
    for (let k = 0; k < 5; k++) {
      const { plan, survey, blobs } = await planForm(c, c.sheet(k), { roles });
      for (const st of tileEval(plan.ir, survey, blobs).cells.values()) seen.add(st);
    }
    materials[name] = [...seen].sort();
  }
  const want = (n) => Object.values(ROLE_SETS[n] ?? { structure: 'minecraft:stone_bricks', rail: 'minecraft:oak_fence' });
  const matBad = Object.entries(materials).filter(([n, sts]) => !sts.every((s) => want(n).includes(s)));
  // cost: the sheet's seed 0 against the reference generator
  const a = await planForm(c, c.sheet(0));
  const ref = await c.reference();
  const b = await planForm(c, c.sheet(0), { call: ref.method });
  const ns = costOf(a.plan.ir, a.survey, a.blobs), nsRef = costOf(b.plan.ir, b.survey, b.blobs);
  const ratio = ns / nsRef;
  return {
    pass: failed.length === 0 && matBad.length === 0,
    sets, m3Sets, failed: failed.map((r) => ({ k: r.k, params: r.params, valley: r.valley, bad: r.bad.slice(0, 5) })),
    materials, cost: { nsPerCell: Math.round(ns), reference: ref.name, refNsPerCell: Math.round(nsRef), ratio: Math.round(ratio * 100) / 100, bound: COST_BOUND, flagged: ratio > COST_BOUND },
  };
}

// ------------------------------------------------------------------ step 4: variety

/**
 * A silhouette: the side elevation in the candidate's shared frame (u along the span from its start, y from `at`'s y - below), a cell
 * set when any cell across the span is: never rescaled to the form's own bounds (so a different height or bay count is a different
 * silhouette).
 */
export function silhouette(c, params, cells) {
  const { along, below, above } = c.frame;
  const H = below + above;
  const s = new Uint8Array(along * H);
  const [ax, ay, az] = params.at;
  for (const key of cells.keys()) {
    const [x, y, z] = key.split(',').map(Number);
    const u = (params.axis ?? 'x') === 'x' ? x - ax : z - az;
    const v = y - (ay - below);
    if (u >= 0 && u < along && v >= 0 && v < H) s[v * along + u] = 1;
  }
  return s;
}
export function iou(a, b) {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; }
  return u ? i / u : 1;
}

/** Pairwise IoU over silhouettes: {pairs, below, share, median, max, min, pass, values}. */
export function varietyOf(sils) {
  const values = [];
  for (let i = 0; i < sils.length; i++) for (let j = i + 1; j < sils.length; j++) values.push(iou(sils[i], sils[j]));
  const sorted = [...values].sort((x, y) => x - y);
  const below = values.filter((v) => v < IOU_MAX).length;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return { pairs: values.length, below, share: r3(below / values.length), median: r3(sorted[sorted.length >> 1]), min: r3(sorted[0]), max: r3(sorted[sorted.length - 1]), pass: below / values.length >= IOU_SHARE, values: values.map(r3) };
}

/** A structure (the renderer's input) of a cell map. */
function structureOf(cells) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const k of cells.keys()) { const [x, y, z] = k.split(',').map(Number); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const palette = [], idx = new Map(), blocks = [];
  for (const [k, st] of [...cells].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!idx.has(st)) {
      const m = /^([^[]+)(?:\[(.*)\])?$/.exec(st);
      const properties = Object.fromEntries((m[2] ? m[2].split(',') : []).map((kv) => kv.split('=')));
      idx.set(st, palette.length); palette.push({ Name: m[1], properties });
    }
    const [x, y, z] = k.split(',').map(Number);
    blocks.push({ pos: [x - minX, y - minY, z - minZ], state: idx.get(st) });
  }
  return { DataVersion: 0, size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1], palette, blocks, entities: [] };
}

/** Draw a silhouette into an RGBA canvas at (ox, oy), `px` pixels per cell, y up. */
function drawSil(rgba, W, ox, oy, sil, along, H, px) {
  for (let v = 0; v < H; v++) for (let u = 0; u < along; u++) {
    const on = sil[v * along + u];
    for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) {
      const o = ((oy + (H - 1 - v) * px + dy) * W + ox + u * px + dx) * 4;
      const c = on ? [52, 58, 70] : [236, 238, 242];
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
    }
  }
}

/**
 * The variety step: the 20 sheet seeds planned and evaluated, their silhouettes' pairwise IoU, and the contact sheet (a 5x4 grid, seed
 * pm0 top left, row by row: each tile an iso render over its silhouette in the shared frame). Returns {variety, png (bytes), sheetSha,
 * seeds: [{k, params, species, stats}]}.
 */
export async function stepVariety(c) {
  const sils = [], isos = [], seeds = [];
  for (let k = 0; k < SEEDS; k++) {
    const p = c.sheet(k);
    const { plan, gen, survey, blobs } = await planForm(c, p);
    const { cells } = tileEval(plan.ir, survey, blobs);
    sils.push(silhouette(c, p, cells));
    isos.push(renderIso(buildScene(structureOf(cells), { front: 'south' }), { width: 300, bg: [244, 241, 234] }));
    seeds.push({ k, seed: p.seed, species: gen.species, profile: gen.params.profile, tiers: gen.params.tiers, height: gen.params.height, parapet: gen.params.parapet, stats: gen.stats.tiers });
  }
  const variety = varietyOf(sils);
  // the sheet
  const { along, below, above } = c.frame;
  const H = below + above, px = 6;
  const cellW = Math.max(300, along * px) + 16;
  const isoH = Math.max(...isos.map((i) => i.height));
  const cellH = isoH + H * px + 24;
  const cols = 5, rows = Math.ceil(SEEDS / cols);
  const W = cols * cellW, HH = rows * cellH;
  const rgba = new Uint8Array(W * HH * 4).fill(255);
  for (let k = 0; k < SEEDS; k++) {
    const cx = (k % cols) * cellW + 8, cy = Math.floor(k / cols) * cellH + 8;
    const im = isos[k];
    for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width && x < cellW - 16; x++) {
      const s = (y * im.width + x) * 4, d = ((cy + y) * W + cx + x) * 4;
      rgba[d] = im.data[s]; rgba[d + 1] = im.data[s + 1]; rgba[d + 2] = im.data[s + 2]; rgba[d + 3] = 255;
    }
    drawSil(rgba, W, cx, cy + isoH + 8, sils[k], along, H, px);
  }
  const png = encodePng(W, HH, rgba);
  return { variety, png, sheetSha: sha256(png), seeds };
}

// ------------------------------------------------------------------ the record

export function readRecord(c) {
  const f = path.join(REPO, c.record);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { generator: null, steps: {} };
}
export function writeRecord(c, rec) {
  fs.writeFileSync(path.join(REPO, c.record), `${JSON.stringify(rec, null, 1)}\n`);
}

/** Approval: the sheet at `sheet` must be the one the variety step recorded (its sha). */
export function approve(rec, { sheet, by, at, yes = true, reasons = null, via = null }) {
  const v = rec.steps?.variety;
  if (!v?.pass) throw new Error('approve: the variety step has not passed');
  const bytes = fs.readFileSync(sheet);
  const sha = sha256(bytes);
  if (sha !== v.sheetSha) throw new Error(`approve: ${sheet} is not the recorded sheet (sha ${sha.slice(0, 12)}, recorded ${v.sheetSha.slice(0, 12)}): re-run the variety step and send that sheet`);
  if (!by || typeof by !== 'string') throw new Error('approve: --by names who approved');
  if (!yes && !reasons) throw new Error('approve: a no carries its reasons');
  rec.steps.approval = { pass: yes, by, at, sheetSha: sha, ...(via ? { via } : {}), ...(reasons ? { reasons } : {}) };
  return rec;
}

/** Output: every earlier step passed (approval included) and the module stamped with `version` (semver). */
export function output(c, rec, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('output: version must be semver X.Y.Z');
  for (const s of STEPS.slice(0, -1)) if (!rec.steps?.[s]?.pass) throw new Error(`output: step '${s}' has not passed`);
  const file = path.join(REPO, c.module);
  const src = fs.readFileSync(file, 'utf8');
  const re = /^export const VERSION = '([^']*)';$/m;
  if (!re.test(src)) throw new Error('output: the module has no `export const VERSION = \'...\';` line');
  const out = src.replace(re, `export const VERSION = '${version}';`);
  fs.writeFileSync(file, out);
  rec.steps.output = { pass: true, version, module: c.module, from: re.exec(src)[1], sourceSha: sha256(out) };
  return rec;
}

/** sha256 (hex) of bytes. */
export const sha256Of = (b) => sha256(b);
/** The sha of a golden's lines (determinismShas' `all`). */
export function shaOfLines(lines) { return sha256(lines.join('\n')); }

export const _test = { lcg, isInt };
