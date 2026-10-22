// (6c VOC) VOC-a's items of the VOC gate (tools/gate6cvoc.mjs; docs/CONTRACT.md "Phase 6c slice VOC" §8): the vocabulary. Offline
// (`unit`): items 1, 3, 4 (kit), 5 (byte identity against the base this branch builds on), 12, 13 and 14; in game: item 2 (`registry`),
// item 10 (`probe`) and item 4's survival placement (`survival`). VOC-a owns this file; VOC-b's items are in gate6cvoc-b.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { FL_MOVED, FL_MOVED_ASKS, normIrJson } from './fl-norm.mjs'; // (6c FL) the street ext normalised, FL's named movers

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

/** A detached worktree beside this checkout at the base this branch builds on (the merge base with origin/main: v0.37.1 since the VOC batch). */
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
/**
 * (6c VOC-c) What later slices change by name (each slice's own identity item holds the rest): the 7 asks with a palette rule and
 * extension/e05 and e16 (rule.palette supported, VOC-c), and the catalogue entries they flip (rule.palette; the catalogueVersion moves).
 */
export const LATER_EXCEPTIONS = Object.freeze({ fixtures: ['extension/e05_reserved_rule.json', 'extension/e16_every_reserved_b.json', ...FL_MOVED.filter((n) => !n.startsWith('asks/'))],
  asks: ['desert_jungle_wall.json', 'hidden_village.json', 'mage_exiles.json', 'old_new_town.json', 'one_block.json', 'rival_families.json', 'row_houses.json', ...FL_MOVED_ASKS],
  // ((batch v0.41.0) F3's catalogue changes too: form.giant_tree flipped, four forms added, the tunnel's volume flag)
  catalogue: ['rule.palette', 'layout.ring', 'layout.spiral', 'layout.grid', 'layout.organic', 'locator.around', 'sketch.outline', 'form.giant_tree',
    'form.giant_mushroom', 'form.coral', 'form.roots', 'form.stalactites', 'connector.tunnel'] });

export async function unchanged(root) {
  const { dir: mainDir, base } = baseTree(root);
  const H = (d) => import(pathToFileURL(path.join(d, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(mainDir)];
  const out = { base, fixtures: {}, asks: {}, examples: {}, palettes: {}, goldens: {} };
  const norm = (r) => normIrJson(r.res?.irJson);
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
  const kept = (g) => JSON.stringify(g.entries.filter((e) => !LATER_EXCEPTIONS.catalogue.includes(e.id)));
  const flipped = LATER_EXCEPTIONS.catalogue.some((id) => JSON.stringify(gNew.entries.find((e) => e.id === id)) !== JSON.stringify(gOld.entries.find((e) => e.id === id)));
  out.catalogue = { entries: kept(gNew) === kept(gOld), catalogueVersion: gNew.catalogueVersion === gOld.catalogueVersion || flipped, header: { api: [gOld.api, gNew.api], kitVersion: [gOld.kitVersion, gNew.kitVersion] }, later: flipped ? LATER_EXCEPTIONS.catalogue : [] };
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
  out.differ = { fixtures: bad(out.fixtures).filter((k) => !LATER_EXCEPTIONS.fixtures.includes(k)), asks: bad(out.asks).filter((k) => !LATER_EXCEPTIONS.asks.includes(k)), examples: bad(out.examples), palettes: bad(out.palettes), goldens: bad(out.goldens) };
  out.later = { fixtures: bad(out.fixtures).filter((k) => LATER_EXCEPTIONS.fixtures.includes(k)), asks: bad(out.asks).filter((k) => LATER_EXCEPTIONS.asks.includes(k)) };
  out.counts = { fixtures: Object.keys(out.fixtures).length, asks: Object.keys(out.asks).length, examples: Object.keys(out.examples).length, palettes: Object.keys(out.palettes).length, goldens: Object.keys(out.goldens).length };
  out.ok = Object.values(out.differ).every((l) => l.length === 0) && out.counts.asks === 59 && out.counts.fixtures >= 40 && out.catalogue.entries && out.catalogue.catalogueVersion;
  return out;
}

// ------------------------------------------------------------------ unit (voc-unit)

const unit = [
  {
    key: 'genvocab',
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
    key: 'vocab-tests',
    name: 'items 1, 3, 4 (kit): the vocabulary tests',
    async run({ root, check }) {
      const r = nodeTest(root, ['kit/test/vocab.test.mjs']);
      check(r.code === 0 && r.fail === 0 && r.pass >= 11, `items 1, 3, 4 (kit): every block classified, every table row with a why, the hand families inside generated ones or each split listed with its evidence, palette() unchanged, one source (the drift test, no literal list, creativeOnly = the 35 plus the listed additions), the tiers the contract names, fitness and drift: ${r.pass} pass, ${r.fail} fail`, r.failing);
      const creative = JSON.parse(fs.readFileSync(path.join(root, 'mod', 'src', 'main', 'resources', 'data', 'architect_mc', 'survival_items.json'), 'utf8')).creativeOnly;
      const want = [...PHASE3_CREATIVE_ONLY, ...CREATIVE_ONLY_ADDED.map((a) => a.block)].sort();
      check(JSON.stringify([...creative].sort()) === JSON.stringify(want), `item 4: creativeOnly = the phase 3 list of 35 plus the listed 26.3 additions (${CREATIVE_ONLY_ADDED.length}): ${creative.length} blocks`, { creative });
      return r;
    },
  },
  {
    key: 'identity',
    name: 'item 5: byte identity',
    async run({ root, check }) {
      const u = await unchanged(root);
      check(u.ok, `item 5: against the base ${u.base.slice(0, 10)}: ${u.counts.fixtures} plan fixtures answer and plan the same but kitVersion, Steward's ${u.counts.asks} asks answer byte for byte, ${u.counts.examples} kit examples and massings check with the same errors and warnings, ${u.counts.palettes} palettes the same, the catalogue's entries and catalogueVersion the same (header api ${u.catalogue.header.api.join(' -> ')}, kitVersion ${u.catalogue.header.kitVersion.join(' -> ')}), ${u.counts.goldens} goldens the same but irSha and kitVersion (re-cut: ${Object.entries(u.goldens).filter(([, v]) => v.recut).map(([k, v]) => `${k} ${v.recut}`).join(', ') || 'none'})`, u.differ);
      return u;
    },
  },
  {
    key: 'java',
    name: 'item 14 and S-VOC-5/6 (Java, sidecar): the record, the feature, vocab/1, api-compat',
    async run({ root, check }) {
      const out = {};
      out.java = await javaTests(root, ['*ApiVocTest*', '*SurvivalItemsTest*', '*ApiHTest*'], 4);
      check(out.java.ok, `S-VOC-5 (Java): BibleRequest.Rarity (the typed record, the 1.10.0 constructor kept, every copy carries it), the feature vocabulary, SurvivalItems reading the generated file: ${out.java.tests} tests, ${out.java.failures} failures`);
      const sc = spawnSync('npx', ['vitest', 'run', 'test/system-refs.test.ts', 'test/jobs.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 900_000 });
      out.sidecar = { code: sc.status, tail: `${sc.stdout}${sc.stderr}`.split('\n').filter((l) => /Tests|passed|failed/.test(l)).slice(-3) };
      check(sc.status === 0, `S-VOC-6 (sidecar): the systemRef vocab/1 and vocab/1#compact from the kit's generated document; the feature vocab: ${out.sidecar.tail.join(' ')}`, out.sidecar);
      const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', '--gate6cvoc'], { cwd: root, encoding: 'utf8', timeout: 900_000, env: { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` } });
      out.apicompat = { code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').slice(-8) };
      check(ac.status === 0, 'item 14: api-compat --gate6cvoc clean against the 0.37.1, 0.37.0 and 0.36.1 apitest jars and the 0.37.1 jar\'s 1.34.0 surface', out.apicompat.tail);
      return out;
    },
  },
];


// ------------------------------------------------------------------ in game: shared

/** A fresh copy of the flat base world, the bot a spectator over (x, z), the given rules. */
async function flatWorld(L, name, x, z, rules) {
  await L.fresh(name, 'G6B Flat Base');
  await L.tp(x + 0.5, 110, z + 0.5);
  for (const r of rules) await L.cmd(`/gamerule ${r}`);
  await L.cmd('/weather clear');
  await L.cmd('/time set 6000');
}

/** Item 2's comparison: the live registry dump against the kit's block table and the generator's digests -> the differences. */
export async function compareRegistry(dump, KIT) {
  const B = await import(pathToFileURL(path.join(KIT, 'lib', 'blocks.mjs')).href);
  const edges = JSON.parse(fs.readFileSync(path.join(KIT, 'vocab', 'edges.json'), 'utf8'));
  const diff = [];
  const d = (id, what, live, kit) => diff.push({ block: id, what, live, kit });
  const parse = (s) => {
    const m = /^([a-z0-9_:]+)(?:\[([^\]]*)\])?$/.exec(s);
    return { name: m[1], props: Object.fromEntries((m[2] ?? '').split(',').filter(Boolean).map((kv) => kv.split('='))) };
  };
  const kitIds = Object.keys(B.BLOCKS).filter((k) => k.startsWith('minecraft:'));
  for (const id of kitIds) if (!dump.blocks[id]) d(id, 'missing in game', null, 'present');
  for (const [id, o] of Object.entries(dump.blocks)) {
    const k = B.BLOCKS[id];
    if (!k) { d(id, 'missing in the kit', 'present', null); continue; }
    // property names in any order (the report's and the state definition's orders differ for chests); values in vanilla's order
    const sorted = (m) => JSON.stringify(Object.keys(m).sort().map((x) => [x, m[x]]));
    if (sorted(o.props) !== sorted(k.props)) d(id, 'property domains', o.props, k.props);
    if (sorted(o.defaults) !== sorted(k.defaults)) d(id, 'default state', o.defaults, k.defaults);
    // light per state, from the table's own `L` (emissionOf counts minecraft:light as 0 on purpose): every lit state the game lists
    // gives the table's level, and the table has as many lit states
    const lvl = (props) => (!k.L ? 0 : typeof k.L === 'number' ? k.L : k.L.v[k.L.by.map((p) => props[p] ?? k.defaults[p]).join(',')] ?? 0);
    let kitLit = 0;
    const names = Object.keys(k.props);
    const walk = (i, props) => {
      if (i === names.length) { if (lvl(props) > 0) kitLit++; return; }
      for (const v of k.props[names[i]]) walk(i + 1, { ...props, [names[i]]: v });
    };
    walk(0, {});
    for (const [s, l] of o.light) { const kv = lvl(parse(s).props); if (kv !== l) d(id, `light ${s}`, l, kv); }
    if (o.light.length !== kitLit) d(id, 'lit states', o.light.length, kitLit);
    if (o.rt !== !!k.rt) d(id, 'random ticking', o.rt, !!k.rt);
    const item = B.itemOf(id) || 'minecraft:air';
    if (o.item !== item) d(id, 'item', o.item, item);
    if (o.g !== B.isGravity(id)) d(id, 'falling', o.g, B.isGravity(id));
    if (o.fs !== B.isFluidStopping(id)) d(id, 'fluid-stopping', o.fs, B.isFluidStopping(id));
    if (o.fl !== B.isFlammable(id)) d(id, 'flammable', o.fl, B.isFlammable(id));
    if (JSON.stringify(o.ff) !== JSON.stringify(k.ff ?? [])) d(id, 'required features', o.ff, k.ff ?? []);
  }
  const dig = [];
  for (const kk of ['recipe', 'loot_table', 'tags/block', 'tags/item', 'blockTagsResolved']) if (dump.digests?.[kk]?.sha256 !== edges.digests[kk].sha256) dig.push({ kind: kk, live: dump.digests?.[kk], gen: edges.digests[kk] });
  for (const kk of ['recipes', 'lootTables']) if (dump.loaded?.[kk]?.sha256 !== edges.digests.loaded[kk].sha256) dig.push({ kind: `loaded ${kk}`, live: dump.loaded?.[kk], gen: edges.digests.loaded[kk] });
  const ffNeeded = [...new Set(kitIds.flatMap((id) => B.BLOCKS[id].ff ?? []))];
  return { diff, digests: dig, other: dump.other, features: dump.features, ffMissing: ffNeeded.filter((f) => !dump.features.includes(f)), blocks: Object.keys(dump.blocks).length };
}

// ------------------------------------------------------------------ registry (voc-registry): item 2

const registry = [{
  name: 'item 2: the registry step',
  async run({ L, KIT, check, json, OUT }) {
    await flatWorld(L, 'G6B VOC Registry', 0, 0, []);
    const r = await L.call('dev.vocab.registry', {}, 300_000);
    const dump = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    fs.copyFileSync(r.file, path.join(OUT, 'vocab-registry.json'));
    const c = await compareRegistry(dump, KIT);
    check(c.blocks === 1286 && c.diff.length === 0, `item 2: dev.vocab.registry: ${c.blocks} minecraft: blocks; ids, property domains, default states, light per state, random ticking, items, falling, fluid-stopping, flammable and required features equal kit/lib/blocks.mjs: ${c.diff.length} difference(s)`, c.diff.slice(0, 20));
    check(true, `item 2 (listed, not judged): other namespaces ${json(c.other)}; the enabled features ${json(c.features)}`);
    check(c.ffMissing.length === 0, `item 2: every ff block's feature flag enabled in the gate world (${c.ffMissing.length} missing; no 26.3 block needs one)`, c.ffMissing);
    check(c.digests.length === 0, `item 2: the vanilla pack's recipe, loot_table, tags/block and tags/item bytes, the resolved block tags and the loaded recipe and loot table ids equal what gen-vocab.mjs recorded (${json(Object.fromEntries(['recipe', 'loot_table', 'tags/block', 'tags/item'].map((k) => [k, dump.digests[k].files])))} files)`, c.digests);
    // the negative control: a doctored copy (one property value removed, one rt flipped) is reported naming both
    const bad = JSON.parse(JSON.stringify(dump));
    bad.blocks['minecraft:oak_stairs'].props.facing = bad.blocks['minecraft:oak_stairs'].props.facing.slice(0, -1);
    bad.blocks['minecraft:stone'].rt = !bad.blocks['minecraft:stone'].rt;
    const n = await compareRegistry(bad, KIT);
    const named = n.diff.map((x) => `${x.block} ${x.what}`);
    check(named.includes('minecraft:oak_stairs property domains') && named.includes('minecraft:stone random ticking') && n.diff.length === 2, `item 2 (negative control): a doctored dump (oak_stairs' facing missing a value, stone's rt flipped) is reported naming both: ${json(named)}`);
    return { file: r.file, sha256: r.sha256, compare: c, control: named };
  },
}];

// ------------------------------------------------------------------ probe (voc-probe): item 10

const AT = (i) => [64 * (i % 6), 100, 64 * Math.floor(i / 6)];
/** The fire posts: [kind, d, expect caught] (fire's reach from FireBlock.tick: air within 1 aside and -1..+4 up gets fire next to a flammable). */
/**
 * The fire posts: [kind, d, axis, expect caught], each post floating alone. Fire (FireBlock.tick): an air cell within 1 aside and
 * -1..+4 up catches next to a flammable block, so a block 2 aside, 2 below or 5 above it burns. Soul fire spreads nothing. Lava
 * (LavaFluid.randomTick): one or two steps up, each at most one aside, light air next to a flammable block, so a block 3 aside at +2
 * or 3 above burns (H's FIRE_REACH, M20).
 */
const FIRE_POSTS = [
  ['fire', [2, 0, 0], 'side', true], ['fire', [3, 0, 0], 'side', false],
  // (fire lights a cell 4 up at about 1 in 200 of its ticks: four trials of each high post)
  ['fire', [1, 5, 0], 'above', true], ['fire', [1, 5, 0], 'above', true], ['fire', [1, 5, 0], 'above', true], ['fire', [1, 5, 0], 'above', true],
  ['fire', [1, 6, 0], 'above', false], ['fire', [1, 6, 0], 'above', false], ['fire', [1, 6, 0], 'above', false], ['fire', [1, 6, 0], 'above', false],
  ['fire', [1, -2, 0], 'below', true], ['fire', [1, -3, 0], 'below', false],
  ['soul_fire', [1, 0, 0], 'side', false], ['soul_fire', [1, 1, 0], 'above', false],
  ['lava', [3, 2, 0], 'side', true], ['lava', [4, 2, 0], 'side', false], ['lava', [2, 3, 0], 'above', true], ['lava', [2, 4, 0], 'above', false],
];

const probe = [{
  name: 'item 10: the hazards.json rows in game',
  async run({ L, KIT, check, json }) {
    const out = {};
    const H = JSON.parse(fs.readFileSync(path.join(KIT, 'vocab', 'hazards.json'), 'utf8'));
    const row = (k) => H.rows.find((r) => r.kind === k);
    await flatWorld(L, 'G6B VOC Probe', 160, 64, ['random_tick_speed 3', 'fire_spread_radius_around_player 128', 'advance_weather false', 'mob_griefing false']);
    const P = (kind, at, extra = {}) => L.call('dev.vocab.probe', { kind, at, phase: 'setup', ...extra }, 60_000);
    const R = (kind, at, extra = {}) => L.call('dev.vocab.probe', { kind, at, phase: 'read', ...extra }, 60_000);
    const near = async (at) => { await L.cmd(`/tp @s ${at[0] + 0.5} ${at[1] + 12} ${at[2] + 0.5}`); await L.call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {}); };
    // concrete powder: the powder beside the water sets; the one 2 away doesn't
    let at = AT(0); await near(at);
    await P('concrete_powder', at); await L.settle(1500);
    const cp = await R('concrete_powder', at);
    out.concrete = cp.states;
    check(cp.states[0] === 'minecraft:white_concrete' && cp.states[1] === 'minecraft:white_concrete_powder' && row('concrete_powder').reach.face === 1, `item 10 (concrete_powder): powder face-adjacent to water becomes ${cp.states[0]}; powder 2 from it stays ${cp.states[1]} (hazards.json: face)`, cp);
    // the sponge's reach: a trench of 9 sources; read in the next call (before the water flows back: 5 ticks a step)
    at = AT(1); await near(at);
    const spr = await L.call('dev.vocab.probe', { kind: 'sponge', at, phase: 'both', n: 9 }, 60_000);
    const sp = spr;
    const trench = spr.states.slice(1);
    const reach = trench.findIndex((s) => s === 'minecraft:water[level=0]');
    out.sponge = { setup: sp.states, read: spr.states, reach };
    check(spr.states[0] === 'minecraft:wet_sponge' && reach === row('sponge').reach.taxicab, `item 10 (sponge): a dry sponge at the head of a trench of 9 sources turns (read in the same tick) ${spr.states[0]} and drains the first ${reach} (hazards.json reach: taxicab ${row('sponge').reach.taxicab})`, trench);
    // the sponge's count cap: a 242-source pool beside it
    at = AT(2); await near(at);
    const cap = await L.call('dev.vocab.probe', { kind: 'sponge_cap', at, phase: 'both' }, 60_000);
    const drained = cap.states.slice(1).filter((s) => s === 'minecraft:air').length;
    out.spongeCap = drained;
    check(cap.states[0] === 'minecraft:wet_sponge' && drained === row('sponge').reach.max, `item 10 (sponge cap): a sponge inside an 11 x 7 x 11 pool drains ${drained} (hazards.json max: ${row('sponge').reach.max ?? 'none'})`);
    // magma and soul sand under water: their bubble columns
    for (const [i, k, drag] of [[3, 'magma', 'true'], [4, 'soul_sand', 'false']]) {
      at = AT(i); await near(at);
      await P(k, at); await L.settle(3000);
      const m = await R(k, at);
      out[k] = m.states;
      check(m.states[1] === `minecraft:bubble_column[drag=${drag}]` && row(k).becomes === `minecraft:bubble_column[drag=${drag}]`, `item 10 (${k}): water directly above becomes ${m.states[1]} (hazards.json: ${row(k).becomes})`, m.states);
    }
    // fire, soul fire and lava: one post per case, every case at once, then 6,000 game ticks (lava's ignition is a random tick: random_tick_speed 1000)
    await L.cmd('/gamerule random_tick_speed 1000');
    // a compact grid (16 apart) around the bot, inside the simulation distance and the fire spread radius
    const F0 = [0, 100, 400];
    const cases = FIRE_POSTS.map(([kind, d, axis, expect], j) => ({ kind, d, axis, expect, at: [F0[0] + 16 * (j % 4), F0[1], F0[2] + 16 * Math.floor(j / 4)] }));
    await near([F0[0] + 24, F0[1], F0[2] + 16]);
    // fire ticks only near a player who is not a spectator (26.3's fire_spread_radius_around_player): the bot plays in creative
    await L.cmd('/gamemode creative');
    for (const c of cases) await P(c.kind, c.at, { d: c.d });
    // wait in game ticks, not wall time (a loaded box falls behind): 12,000 ticks;
    // at most 30 minutes of wall time
    const gt = async () => Number(/(\d+)/.exec((await L.cmd('/time query gametime')).messages?.join(' ') ?? '')?.[1] ?? 0);
    const t0 = await gt();
    const w0 = Date.now();
    let ticks = 0;
    for (;;) {
      await L.settle(20_000);
      // a fire's spread odds fall with its age (it reaches 15 in about 900 ticks and stays, on netherrack): relight each source young
      for (const c of cases.filter((x) => x.kind === 'fire')) await L.cmd(`/setblock ${c.at[0]} ${c.at[1]} ${c.at[2]} minecraft:fire[age=0]`);
      for (const c of cases) { const r = await R(c.kind, c.at, { d: c.d }); c.post = r.states[1]; c.source = r.states[0]; c.caught = r.states[1] !== 'minecraft:oak_planks'; }
      ticks = (await gt()) - t0;
      if (ticks >= 12000 || Date.now() - w0 > 1_800_000) break;
    }
    out.fireTicks = ticks;
    out.fire = cases.map(({ kind, d, expect, caught, post, source }) => ({ kind, d, expect, caught, post, source }));
    const reachOf = (kind) => {
      const cs = cases.filter((c) => c.kind === kind && c.caught);
      const m = (axis, f) => Math.max(0, ...cs.filter((c) => c.axis === axis).map(f));
      return { side: m('side', (c) => Math.abs(c.d[0])), below: m('below', (c) => -c.d[1]), above: m('above', (c) => c.d[1]) };
    };
    for (const k of ['fire', 'soul_fire', 'lava']) {
      // a post position is lit when any of its trials caught
      const byPos = new Map();
      for (const c of cases.filter((x) => x.kind === k)) {
        const key = json(c.d);
        const g = byPos.get(key) ?? { d: c.d, expect: c.expect, caught: false, trials: 0 };
        g.caught ||= c.caught; g.trials++;
        byPos.set(key, g);
      }
      const mine = [...byPos.values()];
      const r = reachOf(k);
      const want = row(k).reach.fire;
      // lava's `below` is H's margin (vanilla lights nothing under the lava's level): not probed
      const same = r.side === want.side && r.above === want.above && (k === 'lava' || r.below === want.below);
      check(mine.every((c) => c.caught === c.expect) && same, `item 10 (${k}, ${out.fireTicks} game ticks): the posts ${mine.map((c) => `${json(c.d)}:${c.caught ? 'lit' : 'not'}`).join(' ')}; measured reach ${json(r)} (hazards.json: ${json(want)})`, mine);
    }
    return out;
  },
}];

// ------------------------------------------------------------------ survival (voc-survival): item 4 in game

/** Item 4's fixtures: a small hut with one cell of `block` on its roof (bedrock; reinforced_deepslate, another generated member; none). */
async function writeFixtures(KIT, lib) {
  const K = await import(pathToFileURL(path.join(KIT, 'lib', 'kit.mjs')).href);
  const W = await import(pathToFileURL(path.join(KIT, 'lib', 'write.mjs')).href);
  const out = {};
  for (const [id, block] of [['voc_bedrock', 'minecraft:bedrock'], ['voc_reinforced', 'minecraft:reinforced_deepslate'], ['voc_plain', 'minecraft:stone_bricks']]) {
    const bp = new K.Blueprint({ id, name: id, description: 'VOC gate item 4 fixture', type: 'custom', size: [5, 6, 5], groundY: 1, front: 'south', palette: K.PALETTES.rustic, profile: ['no_floating'] });
    bp.part('main', () => {
      bp.floor(0, 0, 4, 4, 0, 'minecraft:stone_bricks');
      bp.walls(0, 0, 4, 3, 1, 3, { block: 'minecraft:stone_bricks' });
      bp.floor(0, 0, 4, 3, 4, 'minecraft:stone_bricks');
      bp.lantern(2, 3, 2, true);
      bp.carve([2, 1, 3, 2, 2, 3]);
      bp.door(2, 1, 3, 'south');
      bp.spot('entrance', 2, 4, 180);
      bp.spot('spawn', 2, 4, 180);
    });
    bp.part('cap', () => bp.set(2, 5, 2, block));
    W.writeBlueprint(bp, path.join(lib, id));
    out[id] = block;
  }
  return out;
}

const survival = [{
  name: 'item 4 in game: the generated creative-only list read by survival placement',
  async run({ L, KIT, check, json }) {
    const fx = await writeFixtures(KIT, L.LIBRARY);
    await flatWorld(L, 'G6B VOC Survival', 300, 300, []);
    await L.call('dev.survival.set', { on: true });
    const api = async (args) => {
      const r = await L.cmd(`/apitest ${args}`);
      const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('['));
      if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 300)}`);
      return JSON.parse(line);
    };
    const out = {};
    for (const [i, id] of Object.keys(fx).entries()) {
      const v = await api(`check ${id} ${300 + 12 * i} -60 300 CONSTRUCTION owned noactor`);
      out[id] = { ok: v.ok, construction: v.construction, refusals: v.refusals };
    }
    const reasons = (id) => (out[id].refusals ?? []).map((r) => r.reason ?? r.code ?? r);
    const creative = (id) => (out[id].refusals ?? []).find((r) => (r.reason ?? r.code) === 'CREATIVE_ONLY_BLOCK');
    check(!!creative('voc_bedrock') && /bedrock/.test(creative('voc_bedrock').message ?? ''), `item 4: in survival a design with bedrock is refused CREATIVE_ONLY_BLOCK as before (${json(creative('voc_bedrock')?.message)})`, out.voc_bedrock);
    check(!!creative('voc_reinforced') && /reinforced_deepslate/.test(creative('voc_reinforced').message ?? ''), `item 4: one with reinforced_deepslate (another member of the generated list; there are no 26.3 additions) refused the same way (${json(creative('voc_reinforced')?.message)})`, out.voc_reinforced);
    check(!creative('voc_plain'), `item 4: the same hut without them is not refused CREATIVE_ONLY_BLOCK (${json(reasons('voc_plain'))})`, out.voc_plain);
    return out;
  },
}];

export const items = { unit, registry, probe, survival };
void sleep;
