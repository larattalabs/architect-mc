#!/usr/bin/env node
// One-command release versioning (docs/GATES.md "Release versions: one command at merge"). The coordinator runs it once per
// batch at merge; slices never set version numbers, they stamp the NEXT placeholder.
//
//   node tools/release-version.mjs --api X.Y.Z --mod A.B.C --kit K.L.M [--catalogue N]   set every version, stamp placeholders,
//                                                                                        re-cut and verify the goldens, summary
//   node tools/release-version.mjs --check [--api ..] [--mod ..] [--kit ..] [--catalogue N]   verify only, write nothing
//   [--root dir]            the checkout (default: this one)
//   [--goldens a,b]         the goldens that track the kit (default: every scenarios/goldens/<id>.json whose kitVersion is at or
//                           above the baseline: the last v* tag's KIT_VERSION, or this tree's when there is no tag)
//   [--no-goldens]          skip the golden re-cut and re-plan (not for a real release)
//   [--allow-lower]         allow a version lower than the tree's (tests, a rollback)
//   [--lenient]             --check only: NEXT placeholders allowed (what the kit test does off a release branch)
//   [--json]                the summary as one JSON line
//   [--steward-rc S]        (TJ) the release's Steward RC state in docs/RELEASES.json: pass, pending (default), none, after-release, not-needed
//   node tools/release-version.mjs --sync    docs/STEWARD-SYNC.md's generated half again from docs/RELEASES.json (after a hand edit)
//
// (TJ REL-table) A set also writes the release row of docs/RELEASES.json (mod, API, kit, catalogue, date, the feature names added
// over the last tag, the Steward RC state, the package state), regenerates the "Architect ships" block of docs/STEWARD-SYNC.md and
// rolls tools/api-baselines.json (the release first, main's latest three); --check holds the three in step with the tree.
//
// What it sets (chore 1): ArchitectApi.VERSION, mod_version, PLAN_API, the catalogue golden's api and kitVersion, KIT_VERSION,
// EVAL_KIT_VERSION, IrStale.KIT_VERSION, catalogueVersion (plan.json's x-catalogue and the golden; with --catalogue). Every edit is a
// text replacement anchored on the line patterns of gate-chains.json's impact.versionConstants, exactly one match per file, so a
// bump stays a version-only diff.
// Placeholders: `"sinceApi": "NEXT"` (kit/schemas/plan.json, the catalogue golden) and (TJ HK-api) every NEXT in a Java comment or
// string literal (javaNextOffsets: `Since NEXT`, `(API NEXT)`, "needs Architect API NEXT"; never a code identifier or `{@link #NEXT}`)
// (Java under mod/src/main and mod/src/client) become the API version. Legacy semver placeholders (an in-flight slice's own guess,
// e.g. sinceApi 1.38.0 over a v0.40.0 tag at API 1.37.0) are stamped too: any sinceApi or "Since x.y.z" above the last tag's API.
// Goldens (chore 2): each tracked golden is re-planned by `kit/tools/region.mjs plan` (a fresh process, after the constants are
// written) over its committed survey, params, seed, claim, roles and keepOut, with its frozen volumes passed by --volumes under
// their ARVX sha (the IR's volumes[].sha, not the blob sha they are stored under: without them crossings_demo_flat drops its
// tunnels), and with --node set to the Node major the golden records (the IR's `node`), so any Node re-cuts it alike. The re-cut must differ from the committed IR in kitVersion (and programSha) only; its blobs byte for byte, its tile
// shas (1 = 4 workers) and cells equal the golden header's. Anything else fails, and every file the run wrote is put back.
// Not a tracked golden: the GR parity fixture (kit/test/fixtures/gr/land.json, also read by the mod's DistrictLandGrTest) pins its
// IRs' kitVersion and node (kit/test/gr-parity.mjs PIN), so a release leaves it unchanged; the kit test gr-parity.test.mjs guards it.
// Exit 0 ok, 1 a mismatch or a refused re-cut, 2 usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatBaselines, rollBaselines } from './api-baselines.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^(\d{1,4})\.(\d{1,5})\.(\d{1,6})$/;
const V = '(\\d+\\.\\d+\\.\\d+)';
export const PLACEHOLDER = 'NEXT';

export const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * The version constants: file, which number it holds, and the anchored line (group 1 before the value, 2 the value, 3 after).
 * The line shapes are gate-chains.json's impact.versionConstants (a test holds the two lists together).
 */
export const TARGETS = [
  { id: 'ArchitectApi.VERSION', kind: 'api', file: 'mod/src/main/java/dev/larattalabs/architect/api/ArchitectApi.java', re: new RegExp(`^(\\tString VERSION = ")${V}(";)$`, 'm') },
  { id: 'PLAN_API', kind: 'api', file: 'kit/lib/plan/catalogue.mjs', re: new RegExp(`^(export const PLAN_API = ')${V}(';)$`, 'm') },
  { id: 'golden api', kind: 'api', file: 'kit/schemas/plan-catalogue.golden.json', re: new RegExp(`^( "api": ")${V}(",)$`, 'm') },
  { id: 'mod_version', kind: 'mod', file: 'mod/gradle.properties', re: new RegExp(`^(mod_version=)${V}()$`, 'm') },
  { id: 'KIT_VERSION', kind: 'kit', file: 'kit/lib/region/plan.mjs', re: new RegExp(`^(export const KIT_VERSION = ')${V}(';)$`, 'm') },
  { id: 'EVAL_KIT_VERSION', kind: 'kit', file: 'kit/lib/realise.mjs', re: new RegExp(`^(export const EVAL_KIT_VERSION = ')${V}(';)$`, 'm') },
  { id: 'IrStale.KIT_VERSION', kind: 'kit', file: 'mod/src/main/java/dev/larattalabs/architect/region/IrStale.java', re: new RegExp(`^(\\tpublic static final String KIT_VERSION = ")${V}(";)$`, 'm') },
  { id: 'golden kitVersion', kind: 'kit', file: 'kit/schemas/plan-catalogue.golden.json', re: new RegExp(`^( "kitVersion": ")${V}(",)$`, 'm') },
  { id: 'catalogueVersion', kind: 'catalogue', file: 'kit/schemas/plan.json', re: /^(    "catalogueVersion": )(\d+)(,)$/m },
  { id: 'golden catalogueVersion', kind: 'catalogue', file: 'kit/schemas/plan-catalogue.golden.json', re: /^( "catalogueVersion": )(\d+)(,)$/m },
];

/** Where placeholders may stand: catalogue JSON (sinceApi) and the Java sources (javadoc). */
const SINCE_JSON = ['kit/schemas/plan.json', 'kit/schemas/plan-catalogue.golden.json'];
const JAVA_DIRS = ['mod/src/main/java', 'mod/src/client/java'];
const SINCE_JSON_RE = /("sinceApi": ")(NEXT|\d+\.\d+\.\d+)(")/g;
const SINCE_JAVA_RE = /(@since |\b[Ss]ince )(NEXT\b|\d+\.\d+\.\d+)()/g; // (an empty group 3: both have pre, value, post)
/** (TJ HK-api) Resources that ship in the mod jar: any NEXT left in them is a placeholder (reported, never stamped: no fixed shape). */
const SHIPPED_RES = ['mod/src/main/resources', 'mod/src/client/resources'];
const RES_EXT = /\.(json|json5|md|txt|mcmeta|properties|lang)$/;

/**
 * (TJ HK-api) Every NEXT in a Java file's comments and string literals (javadoc, `// (API NEXT)`, "needs Architect API NEXT"): the
 * offsets of the word. A NEXT in code (an identifier such as a constant `NEXT`) or a javadoc reference to one (`{@link #NEXT}`,
 * `Foo.NEXT`) is not a placeholder. A small lexer: line and block comments, string, char and text-block literals.
 */
export function javaNextOffsets(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  const word = (from, to) => { // NEXT as a whole word inside [from, to), not after # or .
    const seg = text.slice(from, to);
    for (const m of seg.matchAll(/(?<![\w#.$])NEXT(?![\w$])/g)) out.push(from + m.index);
  };
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '/') { const e = text.indexOf('\n', i); const end = e < 0 ? n : e; word(i, end); i = end; }
    else if (c === '/' && d === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; word(i, end); i = end; }
    else if (c === '"' && text.startsWith('"""', i)) { const e = text.indexOf('"""', i + 3); const end = e < 0 ? n : e + 3; word(i, end); i = end; }
    else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      word(i, j + 1); i = j + 1;
    } else i++;
  }
  return out;
}

class Usage extends Error {}
class Refused extends Error {}

const rd = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.java')) out.push(p);
  }
  return out;
}

/** The tree's version values: [{id, kind, file, value}]; throws Refused when a line is missing or matches more than once. */
export function readVersions(root) {
  return TARGETS.map((t) => {
    const text = rd(root, t.file);
    const all = text.match(new RegExp(t.re.source, 'gm')) ?? [];
    if (all.length !== 1) throw new Refused(`${t.file}: ${all.length} lines match the ${t.id} pattern ${t.re} (want exactly 1)`);
    return { id: t.id, kind: t.kind, file: t.file, value: t.re.exec(text)[2] };
  });
}

/** The last v* tag reachable from HEAD and its API and kit (null when git or a tag is unavailable: a shallow CI clone, a temp tree). */
export function lastTag(root) {
  try {
    const tag = execFileSync('git', ['-C', root, 'describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const show = (f) => execFileSync('git', ['-C', root, 'show', `${tag}:${f}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const api = /^\tString VERSION = "(\d+\.\d+\.\d+)";$/m.exec(show(TARGETS[0].file))?.[1] ?? null;
    const kit = /^export const KIT_VERSION = '(\d+\.\d+\.\d+)';$/m.exec(show(TARGETS[4].file))?.[1] ?? null;
    return api && kit ? { tag, api, kit } : null;
  } catch { return null; }
}

/**
 * Placeholders still in the tree: [{file, line, text, value}]. `aboveApi`: also report semver stamps above that API (the legacy
 * slice placeholders); without it only NEXT counts.
 */
export function findPlaceholders(root, { aboveApi = null } = {}) {
  const out = [];
  const scan = (rel, text, re) => {
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      for (const m of l.matchAll(new RegExp(re.source, 'g'))) {
        const v = m[2];
        if (v === PLACEHOLDER || (aboveApi && SEMVER.test(v) && cmp(v, aboveApi) > 0)) out.push({ file: rel, line: i + 1, value: v, text: l.trim().slice(0, 140) });
      }
    });
  };
  for (const f of SINCE_JSON) scan(f, rd(root, f), SINCE_JSON_RE);
  for (const d of JAVA_DIRS) for (const f of walk(path.join(root, d))) {
    const rel = path.relative(root, f), text = fs.readFileSync(f, 'utf8');
    // the legacy semver stamps above the tag (Since x.y.z) and (TJ HK-api) every NEXT in a comment or string, not only `Since NEXT`
    if (aboveApi) scan(rel, text.replace(/NEXT/g, 'N3XT'), SINCE_JAVA_RE);
    const starts = lineStarts(text);
    for (const o of javaNextOffsets(text)) {
      const ln = lineOf(starts, o);
      out.push({ file: rel, line: ln + 1, value: PLACEHOLDER, text: text.slice(starts[ln], starts[ln + 1] ?? text.length).trim().slice(0, 140) });
    }
  }
  // (TJ HK-api) the shipped resources: any NEXT word
  for (const d of SHIPPED_RES) for (const f of walkAll(path.join(root, d)).filter((x) => RES_EXT.test(x))) {
    const rel = path.relative(root, f);
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (/(?<![\w#.$])NEXT(?![\w$])/.test(l)) out.push({ file: rel, line: i + 1, value: PLACEHOLDER, text: l.trim().slice(0, 140) }); });
  }
  return out;
}

const lineStarts = (text) => { const s = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') s.push(i + 1); return s; };
const lineOf = (starts, o) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= o) lo = m; else hi = m - 1; } return lo; };
function walkAll(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walkAll(p, out); else out.push(p); }
  return out;
}

/** The goldens with a kitVersion: [{name, kitVersion}] (scenarios/goldens/<name>.json and <name>/ir.json). */
export function goldensWithKit(root) {
  const G = path.join(root, 'scenarios', 'goldens');
  if (!fs.existsSync(G)) return [];
  return fs.readdirSync(G).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const h = JSON.parse(fs.readFileSync(path.join(G, f), 'utf8'));
    return { name: f.slice(0, -5), kitVersion: h.kitVersion ?? null };
  }).filter((g) => g.kitVersion && fs.existsSync(path.join(G, g.name, 'ir.json')));
}

/** The goldens that track the kit: kitVersion at or above `baseline` (or the named ones). */
export function trackedGoldens(root, { baseline, names = null }) {
  const all = goldensWithKit(root);
  if (names) {
    const miss = names.filter((n) => !all.some((g) => g.name === n));
    if (miss.length) throw new Usage(`--goldens: no golden with a kitVersion named ${miss.join(', ')}`);
    return all.filter((g) => names.includes(g.name));
  }
  return all.filter((g) => SEMVER.test(g.kitVersion) && cmp(g.kitVersion, baseline) >= 0);
}

// ------------------------------------------------------------------------------------------------------------- the golden re-cut

/** Every path where two JSON values differ, `ignore` keys skipped at the top level. */
export function jsonDiff(a, b, { ignore = [], at = '$', out = [], max = 20 } = {}) {
  if (out.length >= max) return out;
  if (a === b) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${at}: ${JSON.stringify(a)?.slice(0, 60)} -> ${JSON.stringify(b)?.slice(0, 60)}`);
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${at}: length ${a.length} -> ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < max; i++) jsonDiff(a[i], b[i], { at: `${at}[${i}]`, out, max });
    return out;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    if (at === '$' && ignore.includes(k)) continue;
    if (!(k in a)) out.push(`${at}.${k}: added`);
    else if (!(k in b)) out.push(`${at}.${k}: removed`);
    else jsonDiff(a[k], b[k], { at: `${at}.${k}`, out, max });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The verifier (pure): the committed golden against its re-cut. Only kitVersion and programSha may differ in the IR, only irSha
 * and kitVersion in the header; blobs byte for byte; tiles and cells exactly. Returns {ok, problems, programShaMoved}.
 */
export function verifyRecut({ oldIr, newIr, oldBlobs, newBlobs, header, tiles, kitVersion }) {
  const problems = [];
  if (newIr.kitVersion !== kitVersion) problems.push(`the re-cut IR's kitVersion is ${newIr.kitVersion}, want ${kitVersion}`);
  const d = jsonDiff(oldIr, newIr, { ignore: ['kitVersion', 'programSha'] });
  if (d.length) problems.push(`the IR changed beyond kitVersion and programSha: ${d.join('; ')}`);
  const ks = (m) => [...m.keys()].sort();
  if (JSON.stringify(ks(oldBlobs)) !== JSON.stringify(ks(newBlobs))) problems.push(`blobs differ: committed [${ks(oldBlobs).map((s) => s.slice(0, 8))}] re-cut [${ks(newBlobs).map((s) => s.slice(0, 8))}]`);
  else for (const k of ks(oldBlobs)) if (!Buffer.from(oldBlobs.get(k)).equals(Buffer.from(newBlobs.get(k)))) problems.push(`blob ${k.slice(0, 12)}: bytes differ`);
  if (tiles) {
    if (!tiles.workersSame) problems.push('tile shas: 1 worker != 4 workers shuffled');
    if (tiles.cells !== header.cells) problems.push(`cells ${header.cells} -> ${tiles.cells}`);
    const td = jsonDiff(header.tiles, tiles.tiles, { at: 'tiles', max: 10 });
    if (td.length) problems.push(`tile shas differ: ${td.join('; ')}`);
  }
  return { ok: problems.length === 0, problems, programShaMoved: oldIr.programSha !== newIr.programSha };
}

function readBlobs(dir) {
  const m = new Map();
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) if (/^[0-9a-f]{64}\.bin$/.test(f)) m.set(f.slice(0, 64), fs.readFileSync(path.join(dir, f)));
  return m;
}

/**
 * Re-plan one golden through the kit CLI in a fresh process (it reads the tree's KIT_VERSION as written now) into a temp dir.
 * `paramsOver` (tests: a deliberate non-version change) and `noVolumes` (tests: the quirk) change the inputs. Returns the temp
 * dir with ir.json, blobs/ and the golden's survey.bin.
 */
export function replanGolden(root, name, { paramsOver = null, noVolumes = false, tmp = null } = {}) {
  const gDir = path.join(root, 'scenarios', 'goldens', name);
  const ir = JSON.parse(fs.readFileSync(path.join(gDir, 'ir.json'), 'utf8'));
  const t = tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), `reltool-${name}-`));
  const inDir = path.join(t, 'in'), volDir = path.join(t, 'volumes'), out = path.join(t, 'out');
  fs.mkdirSync(inDir, { recursive: true });
  fs.mkdirSync(volDir, { recursive: true });
  fs.writeFileSync(path.join(inDir, 'params.json'), JSON.stringify({ ...ir.params, ...(paramsOver ?? {}) }));
  fs.writeFileSync(path.join(inDir, 'roles.json'), JSON.stringify(ir.roles ?? {}));
  fs.writeFileSync(path.join(inDir, 'keep-out.json'), JSON.stringify(ir.keepOut ?? []));
  // the frozen volumes, each named by its ARVX sha (ir.volumes[].sha), copied from the blob it is stored under
  const vols = Object.entries(ir.volumes ?? {});
  if (!noVolumes) for (const [vn, v] of vols) {
    const blob = ir.blobs?.[v.blob];
    if (!blob?.sha) throw new Refused(`${name}: volume ${vn} names blob ${v.blob}, which the IR does not list`);
    const src = path.join(gDir, 'blobs', `${blob.sha}.bin`);
    if (!fs.existsSync(src)) throw new Refused(`${name}: volume ${vn}'s blob ${blob.sha.slice(0, 12)} is not committed in ${path.relative(root, gDir)}/blobs`);
    fs.copyFileSync(src, path.join(volDir, `${v.sha}.bin`));
  }
  const c = ir.claim;
  const program = path.join(root, 'kit', 'regions', `${ir.id}.mjs`);
  if (!fs.existsSync(program)) throw new Refused(`${name}: no program kit/regions/${ir.id}.mjs`);
  const args = [path.join(root, 'kit', 'tools', 'region.mjs'), 'plan', program, '--params', path.join(inDir, 'params.json'), '--roles', path.join(inDir, 'roles.json'),
    '--survey', path.join(gDir, 'survey.bin'), '--seed', String(ir.seed), '--claim', [c.minX, c.minZ, c.maxX, c.maxZ, c.minY, c.maxY].join(','),
    '--keep-out', path.join(inDir, 'keep-out.json'), '--out', out, '--blobs-out', path.join(out, 'blobs'), '--json'];
  if (vols.length && !noVolumes) args.push('--volumes', volDir);
  // (6c S3) a golden whose plan read the biome grid or the bible's fluid slots commits them (scenarios.mjs golden): the re-cut reads
  // them too (the roles stay the IR's: --roles wins over the bible's)
  for (const [f, flag] of [['biomes.json', '--biomes'], ['bible.json', '--bible']]) if (fs.existsSync(path.join(gDir, f))) args.push(flag, path.join(gDir, f));
  // the IR records the planning Node's major (in game: the sidecar's); the re-cut keeps the golden's, whatever node runs this
  if (typeof ir.node === 'string' && /^\d{1,3}$/.test(ir.node)) args.push('--node', ir.node);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Refused(`${name}: kit/tools/region.mjs plan exit ${r.status}: ${errLines(r.stderr || r.stdout)}`);
  fs.copyFileSync(path.join(gDir, 'survey.bin'), path.join(out, 'survey.bin'));
  return { dir: out, tmp: t, args: args.slice(1) };
}

/** A child's error, without its stack frames. */
const errLines = (text) => String(text).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('at ') && !/^Node\.js v/.test(l)).slice(0, 4).join(' | ');

/** Run an ES module's source in a fresh node (a temp file, not --input-type: worker threads inherit execArgv). */
function runModule(code) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reltool-js-'));
  try {
    fs.writeFileSync(path.join(d, 'run.mjs'), code);
    return spawnSync(process.execPath, [path.join(d, 'run.mjs')], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

/** tileShas (tools/scenarios.mjs, 1 worker = 4 workers shuffled) of a plan dir, in a fresh process of the tree's own tools. */
export function tileShasOf(root, planDir) {
  const code = `const { tileShas } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'tools', 'scenarios.mjs')).href)}); const r = await tileShas(${JSON.stringify(planDir)}); console.log(JSON.stringify({ irSha: r.irSha, tiles: r.tiles, cells: r.cells, workersSame: r.workersSame }));`;
  const r = runModule(code);
  if (r.status !== 0) throw new Refused(`tileShas ${planDir}: exit ${r.status}: ${errLines(r.stderr)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/**
 * Re-cut one golden for `kitVersion` (the tree must already hold it) and verify it. With `write`, the golden's ir.json and its
 * header's irSha and kitVersion lines are replaced. Returns {name, from, to, ok, problems, programShaMoved, written}.
 */
export function recutGolden(root, name, { kitVersion, write = false, tiles = true, ...replanOpts }) {
  const gDir = path.join(root, 'scenarios', 'goldens', name), hFile = path.join(root, 'scenarios', 'goldens', `${name}.json`);
  const oldText = fs.readFileSync(path.join(gDir, 'ir.json'), 'utf8');
  const header = JSON.parse(fs.readFileSync(hFile, 'utf8'));
  const rp = replanGolden(root, name, replanOpts);
  try {
    const newText = fs.readFileSync(path.join(rp.dir, 'ir.json'), 'utf8');
    const ts = tiles ? tileShasOf(root, rp.dir) : null;
    const v = verifyRecut({ oldIr: JSON.parse(oldText), newIr: JSON.parse(newText), oldBlobs: readBlobs(path.join(gDir, 'blobs')), newBlobs: readBlobs(path.join(rp.dir, 'blobs')), header, tiles: ts, kitVersion });
    const newSha = sha256(newText);
    if (ts && ts.irSha !== newSha) v.problems.push(`tileShas read IR ${ts.irSha.slice(0, 12)}, the re-cut is ${newSha.slice(0, 12)}`);
    if (header.irSha !== sha256(oldText)) v.problems.push(`the header's irSha ${String(header.irSha).slice(0, 12)} is not the committed ir.json's ${sha256(oldText).slice(0, 12)}`);
    const res = { name, kitFrom: header.kitVersion, kitTo: kitVersion, irShaFrom: header.irSha, irShaTo: newSha, ok: v.problems.length === 0, problems: v.problems, programShaMoved: v.programShaMoved, identical: newText === oldText, written: false };
    if (write && res.ok && !res.identical) {
      const hText = fs.readFileSync(hFile, 'utf8');
      const reSha = /^( "irSha": ")([0-9a-f]{64})(",)$/m, reKit = new RegExp(`^( "kitVersion": ")${V}(",)$`, 'm');
      if ((hText.match(new RegExp(reSha.source, 'gm')) ?? []).length !== 1 || (hText.match(new RegExp(reKit.source, 'gm')) ?? []).length !== 1) throw new Refused(`${name}.json: want exactly one irSha and one kitVersion header line`);
      fs.writeFileSync(path.join(gDir, 'ir.json'), newText);
      fs.writeFileSync(hFile, hText.replace(reSha, `$1${newSha}$3`).replace(reKit, `$1${kitVersion}$3`));
      res.written = true;
    }
    return res;
  } finally {
    fs.rmSync(rp.tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------------------------- consistency

/** The catalogue golden against planCatalogue() and the sinceApi stamps, in a fresh process of the tree's kit. */
function catalogueProblems(root, { lenient }) {
  const code = `
    const { planCatalogue } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'kit/lib/plan/catalogue.mjs')).href)});
    const { sinceApiProblems } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'tools/catalogue-since-check.mjs')).href)});
    const fs = await import('node:fs');
    const text = fs.readFileSync(${JSON.stringify(path.join(root, 'kit/schemas/plan-catalogue.golden.json'))}, 'utf8');
    const want = JSON.stringify(planCatalogue(), null, 1) + '\\n';
    const p = [];
    if (text !== want) p.push('kit/schemas/plan-catalogue.golden.json is not planCatalogue() (regenerate it: JSON.stringify(planCatalogue(), null, 1))');
    for (const x of sinceApiProblems(planCatalogue(), { allowNext: ${lenient} })) p.push('catalogue ' + x);
    console.log(JSON.stringify(p));`;
  const r = runModule(code);
  if (r.status !== 0) return [`the catalogue check failed to run: ${errLines(r.stderr)}`];
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/**
 * Every consistency problem of the tree (empty = consistent): the four API values equal, the four kit values equal, the two
 * catalogueVersions equal, semvers, the expected values when given, no placeholder (unless lenient), the golden equal to
 * planCatalogue() with every sinceApi at or below its api, and each tracked golden at the tree's kit, re-planning byte for byte.
 */
export function checkTree(root, { want = {}, lenient = false, goldens = true, goldenNames = null, tag = undefined } = {}) {
  const problems = [];
  let vals;
  try { vals = readVersions(root); } catch (e) { return { problems: [e.message], versions: null, goldens: [] }; }
  const by = (k) => vals.filter((v) => v.kind === k);
  for (const k of ['api', 'mod', 'kit', 'catalogue']) {
    const vs = by(k);
    const distinct = [...new Set(vs.map((v) => v.value))];
    if (distinct.length > 1) problems.push(`${k} versions differ: ${vs.map((v) => `${v.id} ${v.value}`).join(', ')}`);
    if (want[k] !== undefined && vs.some((v) => v.value !== String(want[k]))) problems.push(`${k}: want ${want[k]}, the tree has ${vs.map((v) => `${v.id} ${v.value}`).join(', ')}`);
  }
  const versions = Object.fromEntries(['api', 'mod', 'kit', 'catalogue'].map((k) => [k, by(k)[0].value]));
  const T = tag === undefined ? lastTag(root) : tag;
  if (T && cmp(versions.api, T.api) < 0) problems.push(`api ${versions.api} is below the last tag ${T.tag}'s ${T.api}`);
  if (T && cmp(versions.kit, T.kit) < 0) problems.push(`kit ${versions.kit} is below the last tag ${T.tag}'s ${T.kit}`);
  const ph = findPlaceholders(root);
  if (ph.length && !lenient) problems.push(...ph.map((p) => `placeholder ${p.value} left: ${p.file}:${p.line}: ${p.text}`));
  problems.push(...releaseDocProblems(root, versions)); // (TJ REL-table)
  problems.push(...catalogueProblems(root, { lenient }));
  const tracked = goldens ? trackedGoldens(root, { baseline: T ? T.kit : versions.kit, names: goldenNames }) : [];
  const gres = [];
  for (const g of tracked) {
    if (g.kitVersion !== versions.kit) { problems.push(`golden ${g.name} records kit ${g.kitVersion}, the tree is kit ${versions.kit}: re-cut it (tools/release-version.mjs)`); continue; }
    try {
      const r = recutGolden(root, g.name, { kitVersion: versions.kit, tiles: false });
      gres.push(r);
      if (!r.identical) problems.push(`golden ${g.name}: its committed inputs no longer re-plan to its ir.json: ${r.problems.join('; ') || 'bytes differ'}`);
    } catch (e) { problems.push(`golden ${g.name}: ${e.message}`); }
  }
  return { problems, versions, tag: T, placeholders: ph, goldens: gres };
}

// ------------------------------------------------------------------------------------------------------------- (TJ REL-table)

export const RELEASES_FILE = 'docs/RELEASES.json';
export const SYNC_FILE = 'docs/STEWARD-SYNC.md';
export const SYNC_BEGIN = '<!-- architect-ships:begin (generated by tools/release-version.mjs from docs/RELEASES.json; do not edit by hand) -->';
export const SYNC_END = '<!-- architect-ships:end -->';
export const RC_STATES = ['pass', 'pending', 'none', 'after-release', 'not-needed'];
const APIRULES = 'mod/src/main/java/dev/larattalabs/architect/apiimpl/ApiRules.java';

/** The feature names ApiRules.java can advertise: JAVA_FEATURES, the sidecar mappings (-> "x"), out.add("x") and the camelCase aliases. */
export function featureNames(text) {
  const out = new Set();
  const code = text.replace(/\/\/[^\n]*/g, ''); // (comments name calls such as CompositeInfo.of(entry);)
  const jf = /JAVA_FEATURES\s*=\s*java\.util\.Set\.of\(([\s\S]*?)\);/.exec(code);
  if (jf) for (const m of jf[1].matchAll(/"([^"]+)"/g)) out.add(m[1]);
  for (const m of text.matchAll(/->\s*"([^"]+)";/g)) out.add(m[1]);
  for (const m of text.matchAll(/out\.add\("([^"]+)"\)/g)) out.add(m[1]);
  const al = /CAMEL_ALIASES\s*=\s*java\.util\.Map\.of\(([\s\S]*?)\);/.exec(code);
  if (al) { const v = [...al[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]); for (let i = 1; i < v.length; i += 2) out.add(v[i]); }
  return [...out].sort();
}

/** The release row for docs/RELEASES.json: versions, date, the feature names added over the last tag, the Steward RC state. */
export function releaseEntry(root, { mod, api, kit, catalogue, tag, stewardRc = 'pending', date = new Date().toISOString().slice(0, 10), featuresBefore = null }) {
  let before = featuresBefore ?? [];
  if (tag && !featuresBefore) { try { before = featureNames(execFileSync('git', ['-C', root, 'show', `${tag.tag}:${APIRULES}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { before = []; } }
  const now = fs.existsSync(path.join(root, APIRULES)) ? featureNames(rd(root, APIRULES)) : [];
  const featuresAdded = tag || featuresBefore ? now.filter((f) => !before.includes(f)) : [];
  return { tag: `v${mod}`, mod, api, kit, catalogue: catalogue === null || catalogue === undefined ? null : Number(catalogue), date, featuresAdded, stewardRc, publish: 'unverified' };
}

/** RELEASES.json with `entry` first (a row of the same mod version replaced). Pure. */
export function updateReleases(doc, entry) {
  return { ...doc, releases: [entry, ...(doc.releases ?? []).filter((r) => r.mod !== entry.mod)] };
}
export function formatReleases(doc) {
  return `{\n "$comment": ${JSON.stringify(doc.$comment ?? '')},\n "releases": [\n${doc.releases.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n ]\n}\n`;
}

const RC_WORDS = { pass: 'RC passed', pending: 'RC pending', none: 'no RC', 'after-release': 'pin run after release (DEV MODE)', 'not-needed': 'not needed', unrecorded: 'see ARCHITECT-ASKS' };

/** STEWARD-SYNC's generated half: one row per release, newest first. Pure. */
export function syncBlock(doc) {
  const rows = doc.releases.map((r) => `| ${r.tag} | ${r.date ?? ''} | ${r.api} | ${r.kit ?? ''} | ${r.catalogue ?? ''} | ${r.featuresAdded?.length ? r.featuresAdded.map((f) => `\`${f}\``).join(', ') : ''} | ${RC_WORDS[r.stewardRc] ?? r.stewardRc ?? ''} | ${r.publish ?? ''} |`);
  return [SYNC_BEGIN, '', '| Release | Date | API | Kit | Catalogue | Feature names added | Steward | Package |', '|---|---|---|---|---|---|---|---|', ...rows, '', SYNC_END].join('\n');
}
/** The doc with its generated half replaced (throws Refused when the markers are missing or out of order). */
export function replaceSyncBlock(text, block) {
  const a = text.indexOf(SYNC_BEGIN), b = text.indexOf(SYNC_END);
  if (a < 0 || b < a) throw new Refused(`${SYNC_FILE}: no generated block (${SYNC_BEGIN} ... ${SYNC_END})`);
  return text.slice(0, a) + block + text.slice(b + SYNC_END.length);
}

/** The release docs' problems (empty = in step): RELEASES.json and the baselines head the tree's mod, the sync block is RELEASES.json's. */
export function releaseDocProblems(root, versions) {
  const p = [];
  const has = (f) => fs.existsSync(path.join(root, f));
  if (has(RELEASES_FILE)) {
    let doc = null;
    try { doc = JSON.parse(rd(root, RELEASES_FILE)); } catch (e) { p.push(`${RELEASES_FILE}: not JSON (${e.message})`); }
    if (doc) {
      const top = doc.releases?.[0];
      if (!top || top.mod !== versions.mod || top.api !== versions.api || top.kit !== versions.kit) p.push(`${RELEASES_FILE}: its newest row is ${top ? `${top.mod} (API ${top.api}, kit ${top.kit})` : 'missing'}, the tree is ${versions.mod} (API ${versions.api}, kit ${versions.kit}): tools/release-version.mjs writes it`);
      if (has(SYNC_FILE)) {
        const t = rd(root, SYNC_FILE);
        try { if (replaceSyncBlock(t, syncBlock(doc)) !== t) p.push(`${SYNC_FILE}: its generated block is not ${RELEASES_FILE}'s (regenerate: tools/release-version.mjs --sync)`); } catch (e) { p.push(e.message); }
      }
    }
  }
  if (has('tools/api-baselines.json')) {
    const b = JSON.parse(rd(root, 'tools/api-baselines.json'));
    if (b.releases?.[0]?.mod !== versions.mod) p.push(`tools/api-baselines.json: its newest baseline is ${b.releases?.[0]?.mod}, the tree is ${versions.mod}: tools/release-version.mjs rolls it`);
  }
  return p;
}

// ------------------------------------------------------------------------------------------------------------- set

/**
 * Set every version, stamp the placeholders, re-cut the goldens. Transactional: on any refusal every file written is restored.
 * Returns the summary {from, to, edits, stamped, goldens, ms}.
 */
export function setVersions(root, { api, mod, kit, catalogue = null, goldens = true, goldenNames = null, allowLower = false, tag = undefined, recutOpts = {}, stewardRc = 'pending', date = undefined, featuresBefore = null }) {
  const t0 = Date.now();
  const before = readVersions(root);
  const from = Object.fromEntries(['api', 'mod', 'kit', 'catalogue'].map((k) => [k, before.find((v) => v.kind === k).value]));
  const to = { api, mod, kit, catalogue: catalogue === null ? null : String(catalogue) };
  if (!allowLower) for (const k of ['api', 'mod', 'kit']) for (const v of before.filter((x) => x.kind === k)) if (cmp(to[k], v.value) < 0) throw new Refused(`${v.id} ${v.value} -> ${to[k]} would go down (--allow-lower)`);
  if (to.catalogue !== null && !allowLower) for (const v of before.filter((x) => x.kind === 'catalogue')) if (Number(to.catalogue) < Number(v.value)) throw new Refused(`${v.id} ${v.value} -> ${to.catalogue} would go down`);
  const T = tag === undefined ? lastTag(root) : tag;
  const tracked = goldens ? trackedGoldens(root, { baseline: T ? T.kit : from.kit, names: goldenNames }) : [];

  const saved = new Map(); // file -> original text (the rollback)
  const write = (rel, text) => { const f = path.join(root, rel); if (!saved.has(f)) saved.set(f, fs.readFileSync(f)); fs.writeFileSync(f, text); };
  const edits = [], stamped = [];
  try {
    // 1. the constants
    const texts = new Map();
    for (const t of TARGETS) {
      const value = to[t.kind];
      if (value === null) continue;
      const text = texts.get(t.file) ?? rd(root, t.file);
      const old = t.re.exec(text)[2];
      texts.set(t.file, text.replace(t.re, `$1${value}$3`));
      edits.push({ id: t.id, file: t.file, from: old, to: value });
    }
    // 2. the placeholders: NEXT, and legacy semver stamps above the last tag's API
    const above = T ? T.api : null;
    const stampText = (rel, text, re) => text.split('\n').map((l, i) => l.replace(new RegExp(re.source, 'g'), (m, pre, v, post) => {
      if (v === PLACEHOLDER || (above && SEMVER.test(v) && cmp(v, above) > 0 && v !== api)) { stamped.push({ file: rel, line: i + 1, from: v, to: api }); return `${pre}${api}${post}`; }
      return m;
    })).join('\n');
    for (const f of SINCE_JSON) texts.set(f, stampText(f, texts.get(f) ?? rd(root, f), SINCE_JSON_RE));
    for (const d of JAVA_DIRS) for (const abs of walk(path.join(root, d))) {
      const rel = path.relative(root, abs);
      const text = texts.get(rel) ?? fs.readFileSync(abs, 'utf8');
      // (TJ HK-api) first every NEXT in a comment or string (javaNextOffsets: never a code identifier), then the legacy semver stamps
      const offs = javaNextOffsets(text);
      let t1 = text;
      if (offs.length) {
        const starts = lineStarts(text);
        for (const o of offs) stamped.push({ file: rel, line: lineOf(starts, o) + 1, from: PLACEHOLDER, to: api });
        for (const o of [...offs].reverse()) t1 = t1.slice(0, o) + api + t1.slice(o + PLACEHOLDER.length);
      }
      const n = stampText(rel, t1.replace(/NEXT/g, '\u0000N3XT\u0000'), SINCE_JAVA_RE).replace(/\u0000N3XT\u0000/g, 'NEXT');
      if (n !== text || texts.has(rel)) texts.set(rel, n);
    }
    for (const [rel, text] of texts) if (text !== rd(root, rel)) write(rel, text);
    // 2b. (TJ REL-table) the release row, the generated half of STEWARD-SYNC and the api baselines' roll (each only where the tree has it)
    const docs = [];
    const catNow = catalogue === null ? from.catalogue : String(catalogue);
    if (fs.existsSync(path.join(root, RELEASES_FILE))) {
      const doc = updateReleases(JSON.parse(rd(root, RELEASES_FILE)), releaseEntry(root, { mod, api, kit, catalogue: catNow, tag: T, stewardRc, date, featuresBefore }));
      write(RELEASES_FILE, formatReleases(doc));
      docs.push(RELEASES_FILE);
      if (fs.existsSync(path.join(root, SYNC_FILE))) { write(SYNC_FILE, replaceSyncBlock(rd(root, SYNC_FILE), syncBlock(doc))); docs.push(SYNC_FILE); }
    }
    let baselines = null;
    if (fs.existsSync(path.join(root, 'tools/api-baselines.json'))) {
      const nb = rollBaselines(JSON.parse(rd(root, 'tools/api-baselines.json')), { mod, api });
      write('tools/api-baselines.json', formatBaselines(nb));
      docs.push('tools/api-baselines.json');
      baselines = nb.releases.map((r) => r.tag);
    }
    // 3. the goldens (fresh processes read the constants just written)
    const gres = [];
    for (const g of tracked) {
      const hFile = path.join(root, 'scenarios', 'goldens', `${g.name}.json`), irFile = path.join(root, 'scenarios', 'goldens', g.name, 'ir.json');
      for (const f of [hFile, irFile]) if (!saved.has(f)) saved.set(f, fs.readFileSync(f));
      const r = recutGolden(root, g.name, { kitVersion: kit, write: true, ...recutOpts });
      gres.push(r);
      if (!r.ok) throw new Refused(`golden ${g.name}: the re-cut for kit ${kit} changed more than its version: ${r.problems.join('; ')}`);
    }
    // 4. the result must be consistent (placeholders aside, there are none left by construction)
    const c = checkTree(root, { want: { api, mod, kit, ...(to.catalogue !== null ? { catalogue: to.catalogue } : {}) }, goldens: false, tag: T });
    if (c.problems.length) throw new Refused(`after the write the tree is not consistent:\n  ${c.problems.join('\n  ')}`);
    return { from, to, tag: T, edits, stamped, goldens: gres, tracked: tracked.map((g) => g.name), docs, baselines, ms: Date.now() - t0 };
  } catch (e) {
    for (const [f, b] of saved) fs.writeFileSync(f, b);
    e.restored = [...saved.keys()].map((f) => path.relative(root, f));
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const spec = { api: 1, mod: 1, kit: 1, catalogue: 1, root: 1, goldens: 1, 'steward-rc': 1, check: 0, sync: 0, 'no-goldens': 0, 'allow-lower': 0, lenient: 0, json: 0, help: 0 };
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || !(a.slice(2) in spec)) throw new Usage(`unknown argument ${a}`);
    const k = a.slice(2);
    if (spec[k]) { if (i + 1 >= argv.length) throw new Usage(`--${k} needs a value`); o[k] = argv[++i]; } else o[k] = true;
  }
  for (const k of ['api', 'mod', 'kit']) if (o[k] !== undefined && !SEMVER.test(o[k])) throw new Usage(`--${k} ${o[k]}: not a semver X.Y.Z`);
  if (o.catalogue !== undefined && !/^\d{1,4}$/.test(o.catalogue)) throw new Usage(`--catalogue ${o.catalogue}: not an integer`);
  if (o['steward-rc'] !== undefined && !RC_STATES.includes(o['steward-rc'])) throw new Usage(`--steward-rc ${o['steward-rc']}: one of ${RC_STATES.join(', ')}`);
  if (!o.check && !o.help && !o.sync && !(o.api && o.mod && o.kit)) throw new Usage('set needs --api, --mod and --kit (or --check, --sync)');
  if (o.lenient && !o.check) throw new Usage('--lenient is for --check');
  return o;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 21).map((l) => l.slice(3)).join('\n')); return 0; }
  const root = path.resolve(o.root ?? HERE);
  const goldenNames = o.goldens ? o.goldens.split(',').filter(Boolean) : null;
  if (o.sync) {
    // (TJ REL-table) after a hand edit of docs/RELEASES.json (a Steward RC passed, a publish verified): the generated half of STEWARD-SYNC again
    const doc = JSON.parse(rd(root, RELEASES_FILE));
    fs.writeFileSync(path.join(root, RELEASES_FILE), formatReleases(doc));
    fs.writeFileSync(path.join(root, SYNC_FILE), replaceSyncBlock(rd(root, SYNC_FILE), syncBlock(doc)));
    console.log(`${SYNC_FILE}: the generated block rewritten from ${RELEASES_FILE} (${doc.releases.length} releases)`);
    return 0;
  }
  if (o.check) {
    const t0 = Date.now();
    const r = checkTree(root, { want: { api: o.api, mod: o.mod, kit: o.kit, catalogue: o.catalogue }, lenient: !!o.lenient, goldens: !o['no-goldens'], goldenNames });
    const ms = Date.now() - t0;
    if (o.json) console.log(JSON.stringify({ ok: r.problems.length === 0, ...r, goldens: r.goldens.map((g) => ({ name: g.name, identical: g.identical })), ms }));
    else {
      if (r.versions) console.log(`versions: API ${r.versions.api}, mod ${r.versions.mod}, kit ${r.versions.kit}, catalogue ${r.versions.catalogue}${r.tag ? ` (last tag ${r.tag.tag}: API ${r.tag.api}, kit ${r.tag.kit})` : ' (no tag)'}`);
      console.log(`goldens tracking the kit: ${r.goldens.map((g) => `${g.name} ${g.identical ? 're-plans byte for byte' : 'DIFFERS'}`).join(', ') || 'none checked'}`);
      if (r.placeholders.length) console.log(`placeholders: ${r.placeholders.length}${o.lenient ? ' (allowed: --lenient)' : ''}`);
      console.log(r.problems.length ? `FAILED (${r.problems.length}):\n  ${r.problems.join('\n  ')}` : `consistent (${ms} ms)`);
    }
    return r.problems.length ? 1 : 0;
  }
  let s;
  try {
    s = setVersions(root, { api: o.api, mod: o.mod, kit: o.kit, catalogue: o.catalogue ?? null, goldens: !o['no-goldens'], goldenNames, allowLower: !!o['allow-lower'], stewardRc: o['steward-rc'] ?? 'pending' });
  } catch (e) {
    if (e.restored) console.error(`restored ${e.restored.length} file(s): ${e.restored.join(', ') || 'none written'}`);
    throw e;
  }
  if (o.json) { console.log(JSON.stringify({ ok: true, ...s })); return 0; }
  console.log(`release versions: API ${s.from.api} -> ${s.to.api}, mod ${s.from.mod} -> ${s.to.mod}, kit ${s.from.kit} -> ${s.to.kit}${s.to.catalogue !== null ? `, catalogue ${s.from.catalogue} -> ${s.to.catalogue}` : `, catalogue ${s.from.catalogue} (kept)`}${s.tag ? ` (last tag ${s.tag.tag})` : ''}`);
  for (const e of s.edits) console.log(`  ${e.from === e.to ? '=' : '*'} ${e.id.padEnd(24)} ${e.from} -> ${e.to}   ${e.file}`);
  console.log(`placeholders stamped: ${s.stamped.length}`);
  for (const p of s.stamped) console.log(`  ${p.file}:${p.line}  ${p.from} -> ${p.to}`);
  console.log(`goldens tracking the kit: ${s.tracked.join(', ') || 'none'}`);
  for (const g of s.goldens) console.log(`  ${g.name}: kit ${g.kitFrom} -> ${g.kitTo}, irSha ${g.irShaFrom.slice(0, 8)} -> ${g.irShaTo.slice(0, 8)}${g.identical ? ' (unchanged)' : ''}; tiles, cells and blobs identical${g.programShaMoved ? '; NOTE programSha moved (the program file changed)' : ''}`);
  if (s.docs?.length) console.log(`release docs written: ${s.docs.join(', ')}${s.baselines ? ` (api baselines now ${s.baselines.join(', ')})` : ''}`);
  console.log(`done in ${s.ms} ms. Next: the kit, sidecar and mod suites; then commit (a version-only diff plus the re-cut goldens and the release docs).`);
  // (TJ CG, PUB-verify) what only exists once the tag does
  console.log(`After the tag v${s.to.mod} is pushed and Publish ran:`);
  console.log(`  node tools/api-baselines-build.mjs build v${s.to.mod}       # the new apijars / api-compat baseline (into the main checkout's artifacts/)`);
  console.log(`  GITHUB_TOKEN=$(gh auth token) node tools/pub-verify.mjs ${s.to.mod}   # jar, sources, pom, module (Publish runs it too)`);
  console.log(`  then set its "publish" (and later "stewardRc") in ${RELEASES_FILE} and run: node tools/release-version.mjs --sync`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    console.error(e instanceof Usage ? `usage: ${e.message}` : `release-version: ${e.message}`);
    process.exit(e instanceof Usage ? 2 : 1);
  });
}
