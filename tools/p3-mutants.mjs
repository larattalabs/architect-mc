#!/usr/bin/env node
// The P3 lints' mutation evidence (docs/FAST-CHECKS.md "4. Water lint", "5. Survival ledger lint"): each mutant puts one historical bug
// (or a rule's negation) back into the production code, in a scratch worktree at HEAD, and runs the lint's tests there; the lint must go
// red. Not a gate step (minutes of compiles); run it when a lint or the code under it changes, and record the table in FAST-CHECKS.
//
//   node tools/p3-mutants.mjs [--only id,id] [--dir <scratch worktree>] [--keep]
//
// Writes artifacts/p3-mutants/<UTC stamp>.json (untracked) and prints a table. The scratch worktree is detached at HEAD (commit first);
// its .gradle-home is an APFS clone of the main checkout's; it is removed at the end unless --keep (git worktree remove, never --force).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const only = opt('--only')?.split(',') ?? null;
const DIR = path.resolve(opt('--dir') ?? path.join(ROOT, '..', `${path.basename(ROOT)}-p3mut`));

const J = 'mod/src/main/java/dev/larattalabs/architect';
const LEDGER = ['dev.larattalabs.architect.site.LedgerLintTest'];
const WATER = ['dev.larattalabs.architect.region.RegionFluidsLintTest'];
/** id, what it puts back, the file, [find, replace] pairs (each must match exactly once), the tests that must go red. */
export const MUTANTS = [
  { id: 'S-Y-1', what: 'a wholly unloaded target reserves (FeedOrder.reserves without frontierLoaded)', file: `${J}/site/FeedOrder.java`,
    edits: [['return building && !paused && anyUnbuilt && frontierLoaded;', 'return building && !paused && anyUnbuilt;']], tests: LEDGER },
  { id: 'C29-leaving', what: 'a target being removed stays in the feed (feedPass ignores leaving)', file: `${J}/site/Stockpiles.java`,
    edits: [['if (v.leaving(t)) {', 'if (false && v.leaving(t)) {']], tests: LEDGER },
  { id: 'C29/Y-once', what: 'a refund credited again under its key (StockLedger.credit without the credited check)', file: `${J}/survival/StockLedger.java`,
    edits: [['public Credit credit(String key, Map<String, Integer> items, int capacityStacks, ToIntFunction<String> maxStack) {\n\t\tif (credited.contains(key)) {',
      'public Credit credit(String key, Map<String, Integer> items, int capacityStacks, ToIntFunction<String> maxStack) {\n\t\tif (false) {']], tests: LEDGER },
  { id: 'CU-refund', what: 'a refund pays the planned block, not the one standing (pre-CU Run.refundCost)', file: `${J}/site/Builder.java`,
    edits: [['return now.is(target[i].getBlock()) ? cost.get(i) : Cells.cost(now);', 'return cost.get(i);']], tests: LEDGER },
  { id: 'CU-requeue', what: 'a weathered cell is no longer built (pre-CU Run.matches by block only)', file: `${J}/site/Builder.java`,
    edits: [['return Copper.is(now, target[i].getBlock());', 'return now.is(target[i].getBlock());']], tests: LEDGER },
  { id: 'dissolve', what: 'the dissolve hands out nothing (reserved stock left in the books)', file: `${J}/site/Stockpiles.java`,
    edits: [['Map<String, Integer> out = new TreeMap<>(l.stock());\n\t\tfor (var e : out.entrySet()) {\n\t\t\tif (give != null) {',
      'Map<String, Integer> out = new TreeMap<>();\n\t\tfor (var e : out.entrySet()) {\n\t\t\tif (give != null) {']], tests: LEDGER },
  { id: 'PT2-adopted-removed', what: 'a delta refunds an adopted (never paid) block it removes', file: `${J}/site/Builder.java`,
    edits: [['if (wasPaid && old != null && !old.isAir()) {', 'if (old != null && !old.isAir()) {']], tests: LEDGER },
  { id: 'PT2-undo-same', what: "an adopted site's removal refunds a block its undo writes back (no PT2 rule)", file: `${J}/site/Builder.java`,
    edits: [['if (adopted && o == Refunds.Outcome.REFUND && asSnapshot) {', 'if (false && adopted && o == Refunds.Outcome.REFUND && asSnapshot) {']], tests: LEDGER },
  { id: 'Y-capacity', what: 'a credit enters past capacity (giveBack without room)', file: `${J}/survival/StockLedger.java`,
    edits: [['int fit = Math.min(n, room(e.getKey(), capacityStacks, maxStack));', 'int fit = n;']], tests: LEDGER },
  { id: 'V-free-set', what: "rooted dirt drops out of the road's free set", file: `${J}/site/RoadBuilder.java`,
    edits: [['before.is(Blocks.MYCELIUM) || before.is(Blocks.ROOTED_DIRT));', 'before.is(Blocks.MYCELIUM));']], tests: LEDGER },
  { id: 'c170b161', what: "IRR's breach sweep before the fix: every connected cell of the fluid, sources included, no feeder test", file: `${J}/region/RegionFluids.java`,
    edits: [['return c != null && c.liquid() && !c.source();', 'return c != null;'], ['if (c == null || fedFromOutside(p, c, set, own, at)) {', 'if (c == null) {']], tests: WATER },
  { id: 'bcdc7097-strays', what: "the H drain's stray pass before the fix: the whole watch box (a player's water taken)", file: `${J}/region/RegionFluids.java`,
    edits: [['LongOpenHashSet c = new LongOpenHashSet(bs.escapedCells);', 'LongOpenHashSet c = new LongOpenHashSet(b.watchSet());']], tests: WATER },
  { id: 'bcdc7097-level', what: "the H drain before the fix: a watched cell holding the fluid before is skipped, its level not restored", file: `${J}/region/RegionFluids.java`,
    edits: [['if (now == was) {', 'if (!was.getFluidState().isEmpty() && was.getFluidState().getType().isSame(f.getType())) {']], tests: WATER },
];

function git(...a) {
  return execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim();
}

function failures(dir, tests) {
  const res = path.join(dir, 'mod', 'build', 'test-results', 'test');
  const out = [];
  if (!fs.existsSync(res)) return out;
  for (const f of fs.readdirSync(res).filter((x) => x.endsWith('.xml'))) {
    const x = fs.readFileSync(path.join(res, f), 'utf8');
    if (!tests.some((t) => f.includes(t))) continue;
    for (const m of x.matchAll(/<testcase name="([^"]+)"[^>]*>\s*<failure message="([^"]{0,240})/g)) out.push(`${m[1]}: ${m[2].replace(/&#10;|&quot;|&lt;|&gt;|&amp;/g, ' ')}`);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const head = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain', '--untracked-files=no')) console.warn('note: the working tree has uncommitted changes; the mutants run on HEAD');
  if (!fs.existsSync(DIR)) {
    git('worktree', 'add', '--detach', DIR, head);
    execFileSync('cp', ['-c', '-R', path.join(ROOT, '..', 'architect-mc', '.gradle-home'), path.join(DIR, '.gradle-home')]);
  } else {
    execFileSync('git', ['-C', DIR, 'checkout', '-q', '--detach', head]);
  }
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(DIR, '.gradle-home') };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC|CLAUDE)/.test(k)) delete env[k];
  const run = (tests) => spawnSync('./gradlew', ['--offline', '--no-daemon', '-q', 'test', ...tests.flatMap((t) => ['--tests', t])], { cwd: path.join(DIR, 'mod'), env, encoding: 'utf8', timeout: 1_200_000 });
  const rows = [];
  // the baseline: the tests pass unmutated
  const all = [...new Set(MUTANTS.flatMap((m) => m.tests))];
  const t0 = Date.now();
  const base = run(all);
  rows.push({ id: 'baseline', what: 'HEAD as committed', red: base.status !== 0, failing: failures(DIR, all), seconds: Math.round((Date.now() - t0) / 1000) });
  for (const m of MUTANTS) {
    if (only && !only.includes(m.id)) continue;
    const f = path.join(DIR, m.file);
    const orig = fs.readFileSync(f, 'utf8');
    let text = orig;
    for (const [a, b] of m.edits) {
      const n = text.split(a).length - 1;
      if (n !== 1) throw new Error(`${m.id}: '${a.slice(0, 60)}' matches ${n} times in ${m.file}`);
      text = text.replace(a, b);
    }
    fs.writeFileSync(f, text);
    const t1 = Date.now();
    let r;
    try {
      r = run(m.tests);
    } finally {
      fs.writeFileSync(f, orig);
    }
    rows.push({ id: m.id, what: m.what, red: r.status !== 0, failing: failures(DIR, m.tests), seconds: Math.round((Date.now() - t1) / 1000) });
    console.log(`${m.id.padEnd(22)} ${r.status !== 0 ? 'RED  ' : 'GREEN'} ${rows.at(-1).failing.slice(0, 2).join(' | ').slice(0, 220)}`);
  }
  const outDir = path.join(ROOT, 'artifacts', 'p3-mutants');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ head, rows }, null, 1)}\n`);
  const ok = rows[0].red === false && rows.slice(1).every((r) => r.red);
  console.log(`baseline ${rows[0].red ? 'RED (fix first)' : 'green'}; ${rows.slice(1).filter((r) => r.red).length}/${rows.length - 1} mutants red -> ${file}`);
  if (!argv.includes('--keep')) {
    const st = spawnSync('git', ['-C', ROOT, 'worktree', 'remove', DIR], { encoding: 'utf8' });
    if (st.status !== 0) console.warn(`the scratch worktree stays at ${DIR}: ${st.stderr.trim()}`);
  }
  process.exit(ok ? 0 : 1);
}
