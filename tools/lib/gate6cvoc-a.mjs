// (6c VOC) VOC-a's items of the VOC gate (tools/gate6cvoc.mjs; docs/CONTRACT.md "Phase 6c slice VOC" §8): the vocabulary. Offline
// (`unit`): items 1, 3, 4 (kit), 5 (byte identity against the base this branch builds on), 12, 13 and 14; in game: item 2 (`registry`),
// item 10 (`probe`) and item 4's survival placement (`survival`). VOC-a owns this file; VOC-b's items are in gate6cvoc-b.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The phase 3 creative-only list (35, survival_items.json at v0.37.0): the bar for item 4. */
export const PHASE3_CREATIVE_ONLY = Object.freeze(['architect_mc:construction_crate', ...['bedrock', 'barrier', 'light', 'structure_block', 'structure_void', 'jigsaw', 'test_block',
  'test_instance_block', 'command_block', 'chain_command_block', 'repeating_command_block', 'spawner', 'trial_spawner', 'vault', 'budding_amethyst',
  'reinforced_deepslate', 'end_portal_frame', 'end_portal', 'end_gateway', 'nether_portal', 'petrified_oak_slab', 'infested_stone', 'infested_cobblestone',
  'infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks', 'infested_chiseled_stone_bricks', 'infested_deepslate',
  'suspicious_sand', 'suspicious_gravel', 'frogspawn', 'chorus_plant', 'player_head', 'player_wall_head'].map((b) => `minecraft:${b}`)].sort());
/** 26.3 additions to the creative-only list, each with its evidence (CONTRACT VOC §2.4, "as built"): none. */
export const CREATIVE_ONLY_ADDED = Object.freeze([]);

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

/** gen-vocab.mjs once: {code, ms, out}. */
function genVocab(root, args) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['kit/tools/gen-vocab.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 900_000 });
  return { code: r.status, ms: Date.now() - t0, out: `${r.stdout}${r.stderr}`.split('\n').filter((l) => /gen-vocab|DIFFERS|tables|error/i.test(l)).slice(-4) };
}

/** A detached worktree beside this checkout at the base this branch builds on (the merge base with origin/main: v0.37.0 and docs). */
export function baseTree(root) {
  const dir = path.resolve(root, '..', 'architect-mc-VOC-main');
  try { execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']); } catch { /* offline: the last fetched origin/main */ }
  const base = execFileSync('git', ['-C', root, 'merge-base', 'HEAD', 'origin/main']).toString().trim();
  if (!fs.existsSync(path.join(dir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', dir, base]);
  else execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach', base]);
  return { dir, base };
}

/**
 * Item 5's byte identity (§6): against the base's kit in a detached worktree, every committed plan fixture answers the same and plans
 * the same IR but its kitVersion; Steward's 59 asks answer byte for byte; every kit example's and massing's check has the same errors and
 * warnings; every built-in and scenario bible's palette() is the same; the catalogue's entries and catalogueVersion are the same (its
 * header's api and kitVersion move); the re-cut goldens differ only in irSha and kitVersion.
 */
export async function unchanged(root) {
  const { dir: mainDir, base } = baseTree(root);
  const H = (d) => import(pathToFileURL(path.join(d, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(mainDir)];
  const out = { base, fixtures: {}, asks: {}, examples: {}, palettes: {}, goldens: {} };
  const norm = (r) => r.res.irJson.replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"');
  const cmpRun = (a, b) => ({ answers: JSON.stringify(a.check.parts) === JSON.stringify(b.check.parts), ir: sha256(norm(a)) === sha256(norm(b)), overall: a.check.overall === b.check.overall });
  // the committed plan fixtures
  for (const d of ['valid', 'k1a', 'rope', 'refused', 't3a', 't3b', 'tunnel', 'h', 'extension']) {
    const fixDir = path.join(root, 'kit', 'test', 'fixtures', 'plan', d);
    if (!fs.existsSync(fixDir)) continue;
    for (const f of fs.readdirSync(fixDir).filter((x) => x.endsWith('.json')).sort()) {
      const fx = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
      if (!fx.plan || fx.volume || !fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', d, f))) continue;
      const sv = (h) => (fx.terrain ? h.flatSurvey(fx.terrain) : fx.on === 'asks' ? h.asksSurvey() : fx.on === 'flat' ? h.flatSurvey() : fx.on ? h.goldenSurvey(fx.on) : h.flatSurvey());
      const runOn = async (h) => { const s = sv(h); return h.checkPlanLocal(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...h.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}) }); };
      try { out.fixtures[`${d}/${f}`] = cmpRun(await runOn(hNew), await runOn(hOld)); } catch (e) { out.fixtures[`${d}/${f}`] = { error: String(e.message).slice(0, 200) }; }
    }
  }
  // Steward's 59 recorded plans (fixtures/plan/asks), on the asks survey
  const asksDir = path.join(root, 'kit', 'test', 'fixtures', 'plan', 'asks');
  for (const f of fs.readdirSync(asksDir).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json').sort()) {
    const fx = JSON.parse(fs.readFileSync(path.join(asksDir, f), 'utf8'));
    const runOn = async (h) => { const s = h.asksSurvey(); return h.checkPlanLocal(fx.answer.plan, { survey: s.bytes, claim: s.claim, anchors: h.stewardAnchors(s.claim) }); };
    try { out.asks[f] = cmpRun(await runOn(hNew), await runOn(hOld)); } catch (e) { out.asks[f] = { error: String(e.message).slice(0, 200) }; }
  }
  // every kit example's and massing's check: errors and warnings
  const C = async (d) => import(pathToFileURL(path.join(d, 'kit', 'lib', 'check.mjs')).href);
  const [cNew, cOld] = [await C(root), await C(mainDir)];
  for (const sub of ['examples', 'massings']) {
    const exDir = path.join(root, 'kit', sub);
    for (const id of fs.readdirSync(exDir).filter((x) => fs.statSync(path.join(exDir, x)).isDirectory()).sort()) {
      const nbt = path.join(exDir, id, `${id}.nbt`);
      const js = path.join(exDir, id, `${id}.blueprint.json`);
      if (!fs.existsSync(nbt) || !fs.existsSync(js)) continue;
      const a = cNew.checkFiles(nbt, js);
      const b = cOld.checkFiles(path.join(mainDir, 'kit', sub, id, `${id}.nbt`), path.join(mainDir, 'kit', sub, id, `${id}.blueprint.json`));
      out.examples[`${sub}/${id}`] = { errors: JSON.stringify(a.errors) === JSON.stringify(b.errors), warnings: JSON.stringify(a.warnings) === JSON.stringify(b.warnings), ok: a.ok === b.ok };
    }
  }
  // palette(): every built-in palette and every built-in and scenario bible's
  const K = async (d) => import(pathToFileURL(path.join(d, 'kit', 'lib', 'kit.mjs')).href);
  const [kNew, kOld] = [await K(root), await K(mainDir)];
  for (const n of Object.keys(kOld.PALETTES)) out.palettes[`preset:${n}`] = JSON.stringify(kNew.PALETTES[n]) === JSON.stringify(kOld.PALETTES[n]);
  for (const bdir of [path.join('kit', 'bibles'), path.join('scenarios', 'bibles')]) {
    const abs = path.join(root, bdir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.json')).sort()) {
      const bible = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf8'));
      const pal = (k) => { try { return JSON.stringify(k.paletteFromBible({ id: f.replace(/\.json$/, ''), version: 1, ...bible })); } catch (e) { return `throws ${e.message}`; } };
      out.palettes[`${bdir}/${f}`] = pal(kNew) === pal(kOld);
    }
  }
  // the catalogue: entries and catalogueVersion the same; the header's api and kitVersion move
  const cat = (d) => JSON.parse(fs.readFileSync(path.join(d, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  const [gNew, gOld] = [cat(root), cat(mainDir)];
  out.catalogue = { entries: JSON.stringify(gNew.entries) === JSON.stringify(gOld.entries), catalogueVersion: gNew.catalogueVersion === gOld.catalogueVersion, header: { api: [gOld.api, gNew.api], kitVersion: [gOld.kitVersion, gNew.kitVersion] } };
  // the scenario goldens: tiles and cells as the base's; only irSha and kitVersion may move
  const gd = path.join(root, 'scenarios', 'goldens');
  for (const f of fs.readdirSync(gd).filter((x) => x.endsWith('.json')).sort()) {
    const a = JSON.parse(fs.readFileSync(path.join(gd, f), 'utf8'));
    const bf = path.join(mainDir, 'scenarios', 'goldens', f);
    if (!fs.existsSync(bf)) continue;
    const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
    const { irSha: _a, kitVersion: _b, ...ra } = a;
    const { irSha: _c, kitVersion: _d, ...rb } = b;
    out.goldens[f] = { same: JSON.stringify(ra) === JSON.stringify(rb), recut: a.kitVersion !== b.kitVersion ? `${b.kitVersion} -> ${a.kitVersion}` : null };
  }
  const bad = (m) => Object.entries(m).filter(([, v]) => v === false || v?.error || (typeof v === 'object' && v !== null && Object.entries(v).some(([k, x]) => k !== 'recut' && x === false))).map(([k]) => k);
  out.differ = { fixtures: bad(out.fixtures), asks: bad(out.asks), examples: bad(out.examples), palettes: bad(out.palettes), goldens: bad(out.goldens) };
  out.counts = { fixtures: Object.keys(out.fixtures).length, asks: Object.keys(out.asks).length, examples: Object.keys(out.examples).length, palettes: Object.keys(out.palettes).length, goldens: Object.keys(out.goldens).length };
  out.ok = Object.values(out.differ).every((l) => l.length === 0) && out.counts.asks === 59 && out.counts.fixtures >= 40 && out.catalogue.entries && out.catalogue.catalogueVersion;
  return out;
}

// ------------------------------------------------------------------ unit (voc-unit)

const unit = [
  {
    name: 'items 1, 12, 13: gen-vocab.mjs',
    async run({ root, check }) {
      const out = {};
      out.jar1 = genVocab(root, ['--check']);
      out.jar2 = genVocab(root, ['--check']);
      out.noJar = genVocab(root, ['--check', '--no-jar']);
      check(out.jar1.code === 0 && out.jar2.code === 0, `items 1, 12: gen-vocab.mjs --check with the 26.3 jar clean twice (every derived file up to date): ${out.jar1.out.join(' ')}`, [out.jar1, out.jar2]);
      check(out.noJar.code === 0, `item 1 (the drift test's path): gen-vocab.mjs --check --no-jar clean (from the committed edges.json): ${out.noJar.out.join(' ')}`, out.noJar);
      check(true, `item 13 (recorded): gen-vocab.mjs wall time with the jar ${out.jar1.ms} ms and ${out.jar2.ms} ms, without ${out.noJar.ms} ms`);
      // the same bytes on Linux (OrbStack's docker, when it is there): the no-jar check in a node:24 container over this checkout, read-only
      const dk = spawnSync('docker', ['run', '--rm', '-v', `${root}:/w:ro`, '-w', '/w', 'node:24-slim', 'node', 'kit/tools/gen-vocab.mjs', '--check', '--no-jar', '--work', '/tmp/g'], { encoding: 'utf8', timeout: 900_000 });
      out.linux = { code: dk.status, out: `${dk.stdout ?? ''}${dk.stderr ?? ''}`.split('\n').filter(Boolean).slice(-3) };
      check(dk.status === 0, `item 1: the same bytes on Linux (docker node:24-slim, gen-vocab.mjs --check --no-jar over this checkout): ${out.linux.out.join(' ')}`, out.linux);
      return out;
    },
  },
  {
    name: 'items 1, 3, 4 (kit): the vocabulary tests',
    async run({ root, check }) {
      const r = nodeTest(root, ['kit/test/vocab.test.mjs']);
      check(r.code === 0 && r.fail === 0 && r.pass >= 12, `items 1, 3, 4 (kit): every block classified, every table row with a why, the hand families inside generated ones or each split listed with its evidence, palette() unchanged, one source (the drift test, no literal list, creativeOnly = the 35 plus the listed additions), the tiers the contract names, fitness and drift: ${r.pass} pass, ${r.fail} fail`, r.failing);
      const creative = JSON.parse(fs.readFileSync(path.join(root, 'mod', 'src', 'main', 'resources', 'data', 'architect_mc', 'survival_items.json'), 'utf8')).creativeOnly;
      const want = [...PHASE3_CREATIVE_ONLY, ...CREATIVE_ONLY_ADDED.map((a) => a.block)].sort();
      check(JSON.stringify([...creative].sort()) === JSON.stringify(want), `item 4: creativeOnly = the phase 3 list of 35 plus the listed 26.3 additions (${CREATIVE_ONLY_ADDED.length}): ${creative.length} blocks`, { creative });
      return r;
    },
  },
  {
    name: 'item 5: byte identity',
    async run({ root, check }) {
      const u = await unchanged(root);
      check(u.ok, `item 5: against the base ${u.base.slice(0, 10)}: ${u.counts.fixtures} plan fixtures answer and plan the same but kitVersion, Steward's ${u.counts.asks} asks answer byte for byte, ${u.counts.examples} kit examples and massings check with the same errors and warnings, ${u.counts.palettes} palettes the same, the catalogue's entries and catalogueVersion the same (header api ${u.catalogue.header.api.join(' -> ')}, kitVersion ${u.catalogue.header.kitVersion.join(' -> ')}), ${u.counts.goldens} goldens the same but irSha and kitVersion (re-cut: ${Object.entries(u.goldens).filter(([, v]) => v.recut).map(([k, v]) => `${k} ${v.recut}`).join(', ') || 'none'})`, u.differ);
      return u;
    },
  },
  {
    name: 'item 14 and S-VOC-5/6 (Java, sidecar): the record, the feature, vocab/1, api-compat',
    async run({ root, check }) {
      const out = {};
      out.java = await javaTests(root, ['*ApiVocTest*', '*SurvivalItemsTest*', '*ApiHTest*'], 4);
      check(out.java.ok, `S-VOC-5 (Java): BibleRequest.Rarity (the typed record, the 1.10.0 constructor kept, every copy carries it), the feature vocabulary, SurvivalItems reading the generated file: ${out.java.tests} tests, ${out.java.failures} failures`);
      const sc = spawnSync('npx', ['vitest', 'run', 'test/system-refs.test.ts', 'test/jobs.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 900_000 });
      out.sidecar = { code: sc.status, tail: `${sc.stdout}${sc.stderr}`.split('\n').filter((l) => /Tests|passed|failed/.test(l)).slice(-3) };
      check(sc.status === 0, `S-VOC-6 (sidecar): the systemRef vocab/1 and vocab/1#compact from the kit's generated document; the feature vocab: ${out.sidecar.tail.join(' ')}`, out.sidecar);
      const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', '--gate6cvoc'], { cwd: root, encoding: 'utf8', timeout: 900_000 });
      out.apicompat = { code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').slice(-8) };
      check(ac.status === 0, 'item 14: api-compat --gate6cvoc clean against the 0.37.0, 0.36.1 and 0.36.0 apitest jars and the 0.37.0 jar\'s 1.34.0 surface', out.apicompat.tail);
      return out;
    },
  },
];

export const items = { unit };
void sleep;
