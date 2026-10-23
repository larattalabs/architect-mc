#!/usr/bin/env node
// The P3 lints' calibration probes (docs/FAST-CHECKS.md "4. Water lint", "5. Survival ledger lint"; release tier and every Minecraft
// update): the lints are trusted only while the game agrees with their models. They read the evidence the full in-game steps of the same
// run wrote (no game time of their own) and judge it against the models:
//
//   node tools/p3-probe.mjs water   [--run <dir>] [--record]   waitFor h-ingame, hy-ingame, h-probe (the full ids)
//     h_core_demo: every body's census equal to its prediction (0 per-body diff), settled within its bound, the single breach of every
//     body within the recorded reach; hy_core_demo's course census; the riffle table p01/p01b/p02 (every body's census == prediction);
//     h-probe's fire-reach posts within M20's FIRE_REACH. --record writes the measured settles into kit/lint/water-calibration.json.
//   node tools/p3-probe.mjs ledger  [--run <dir>]               waitFor y-ingame, cu-survival (the full ids)
//     y store: the model's ledger for the run's events (place six targets, feed, build; a delta; a revert) against the measured ledger at
//     each: consumed == the bills, a delta's and a revert's build consume exactly their outstanding, one credit key each, the refunds in;
//     cu-survival: weathering while waiting charged nothing; the deconstruct's measured refund == the Java model's refund of the same
//     standing blocks (LedgerProbeTest over the recorded states, -Dledger.probe).
//
// A FAIL is a calibration mismatch: the rule (Noah, 2026-10-21; docs/GATES.md "P3") sends the P3 rows back in game at the slice tier
// (node tools/p3-mode.mjs ingame) until the lint or its model is fixed and the probe passes again.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const kind = argv[0];
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const RECORD = argv.includes('--record');
let fails = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log(`ok   ${msg}`);
  else { fails++; console.log(`FAIL ${msg}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 600)}` : ''}`); }
};
const json = (x) => JSON.stringify(x);

/** The run's evidence dir: --run, else P3_RUN (the step's ${OUT}); a shard's or an offline lane's dir (…/s2, …/o2: turbo) climbs to the run. */
function runDir() {
  let d = opt('--run') ?? process.env.P3_RUN;
  if (!d) throw new Error('no run dir: --run <dir> or P3_RUN');
  d = path.resolve(d);
  if (/\/[so]\d+$/.test(d)) d = path.dirname(d);
  return d;
}

/** The newest file at `rel` (e.g. gate6c-h/ingame.json) in the run dir or any of its shard dirs, also under a split step's part
 * dirs (gate6c-h/p<k>/ingame.json: docs/GATES.md "Turbo"), that satisfies `has` (a split step's parts each hold their share). */
function evidence(rel, has = () => true) {
  const base = runDir();
  const dirs = [base, ...fs.readdirSync(base).filter((x) => /^[so]\d+$/.test(x)).map((s) => path.join(base, s))];
  const parts = (d) => {
    const pd = path.join(d, path.dirname(rel));
    try {
      return fs.readdirSync(pd).filter((x) => /^p\d+$/.test(x)).map((x) => path.join(pd, x, path.basename(rel)));
    } catch {
      return [];
    }
  };
  const cands = dirs.flatMap((d) => [path.join(d, rel), ...parts(d)]).filter((f) => fs.existsSync(f));
  cands.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of cands) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (has(j)) return j;
  }
  return null;
}

const sub = (a = {}, b = {}) => { const o = {}; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const v = (a[k] ?? 0) - (b[k] ?? 0); if (v) o[k] = v; } return o; };
const same = (a = {}, b = {}) => json(Object.entries(a).filter(([, v]) => v).sort()) === json(Object.entries(b).filter(([, v]) => v).sort());
const geq = (a = {}, b = {}) => Object.entries(b).every(([k, v]) => (a[k] ?? 0) >= v);

async function water() {
  const h = evidence('gate6c-h/ingame.json', (j) => typeof j?.data?.core === 'object');
  ok(!!h?.data?.core, 'h_core_demo: the full h-ingame evidence of this run', h ? Object.keys(h.data ?? {}) : null);
  if (h?.data?.core) {
    const c = h.data.core;
    const census = Object.entries(c.census ?? {});
    ok(census.length >= 4 && census.every(([, v]) => v.ok && v.ticks === 0 && (v.mismatch ?? []).length === 0), `h_core_demo: every body's census equals its prediction (per-body diff 0, no tick left): ${json(census.map(([k, v]) => [k, (v.mismatch ?? []).length]))}`);
    const bound = new Map((c.plan?.bodies ?? []).map((b) => [b[0], b[4]]));
    const fl = c.realise?.fluids ?? [];
    ok(fl.length >= 4 && fl.every((x) => x.settledAt <= bound.get(x.body)), `h_core_demo: every body settled within its settleTicks (${json(fl.map((x) => [x.body, x.settledAt, bound.get(x.body)]))})`);
    const br = Object.entries(c.breach ?? {});
    ok(br.length >= 4 && br.every(([, v]) => v.opened && v.n === 0), `h_core_demo: the single breach of every body (${br.length}) reached nothing past its cells, spill and recorded reach (the water lint's W3)`, br.map(([k, v]) => [k, v.n]));
    if (RECORD && fl.length) {
      const f = path.join(ROOT, 'kit', 'lint', 'water-calibration.json');
      const cal = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const x of fl) cal.settles[`demo/h_core_demo#${x.body}`] = x.settledAt;
      cal.recorded = { head: h.head, at: new Date().toISOString().slice(0, 10) };
      fs.writeFileSync(f, `${JSON.stringify(cal, null, 1)}\n`);
      console.log(`recorded ${fl.length} settle(s) into ${path.relative(ROOT, f)}`);
    }
  }
  const hy = evidence('gate6c-hy/ingame.json', (j) => typeof j?.data?.core === 'object');
  ok(!!hy?.data?.core, 'hy_core_demo: the full hy-ingame evidence of this run');
  // the riffle table: HY-b's item 18 (c), in the core's evidence when whole, in its own part's when split
  const hyRif = evidence('gate6c-hy/ingame.json', (j) => Object.keys(j?.data?.halves ?? {}).some((k) => /item 18 \(c\)/.test(k)));
  if (hy?.data?.core) {
    const census = Object.entries(hy.data.core.census ?? {});
    ok(census.length >= 4 && census.every(([, v]) => v.ok && v.ticks === 0), `hy_core_demo: every reach's census equals its prediction (lips, columns, landings, films): ${json(census.map(([k, v]) => [k, (v.mismatch ?? []).length]))}`);
    const rif = Object.entries(hyRif?.data?.halves ?? {}).find(([k]) => /item 18 \(c\)/.test(k))?.[1];
    const rows = rif && !rif.skipped ? Object.entries(rif).flatMap(([tag, bodies]) => (bodies.error ? [[tag, 'error', bodies.error]] : Object.entries(bodies).map(([b, v]) => [`${tag}/${b}`, v.ok && v.mismatch === 0 && v.outside === 0]))) : [];
    ok(rows.length >= 9 && rows.every((r) => r[1] === true), `the riffle table (riffles 2/4/6 per drop at 1-3 drops, p01/p01b/p02): every body's census equals its prediction (${rows.filter((r) => r[1] === true).length}/${rows.length})`, rows.filter((r) => r[1] !== true));
  }
  const pr = evidence('gate6c-h/probe.json');
  const fire = pr?.data?.core?.fire;
  ok(!!fire, "h-probe's fire-reach posts: the full h-probe evidence of this run");
  if (fire) {
    const R = { side: 3, below: 1, above: 3 }; // kit/lib/region/checkFluids.mjs FIRE_REACH
    const { FIRE_REACH } = await import(path.join(ROOT, 'kit', 'lib', 'region', 'checkFluids.mjs')).catch(() => ({ FIRE_REACH: R }));
    ok(fire.direct > 0 && fire.farthest.side <= FIRE_REACH.side && fire.farthest.above <= FIRE_REACH.above && fire.farthest.below >= -FIRE_REACH.below, `M20's FIRE_REACH ${json(FIRE_REACH)} covers what the lava lit itself in game (${fire.direct} posts, farthest ${json(fire.farthest)})`);
  }
}

function ledger() {
  const y = evidence('gate6c-y1/store.json')?.data?.probe;
  ok(!!y?.start && !!y?.built, 'y store: the ledger at each event of the full y-ingame run');
  if (y?.start && y?.built) {
    ok(same(sub(y.built.ledger.consumed, y.start.ledger.consumed), y.start.outstanding), `y store: six targets fed and BUILT: consumed == the bills placed (${json(sub(y.built.ledger.consumed, y.start.ledger.consumed)).slice(0, 200)})`, { consumed: sub(y.built.ledger.consumed, y.start.ledger.consumed), bills: y.start.outstanding });
    if (y.delta && y.deltaBuilt) {
      ok(same(sub(y.deltaBuilt.ledger.consumed, y.delta.after.consumed), y.delta.outstanding), 'y store: the delta v1 -> v3 built consumed exactly its outstanding (the added and changed cells)', { consumed: sub(y.deltaBuilt.ledger.consumed, y.delta.after.consumed), outstanding: y.delta.outstanding });
      ok(geq(sub(y.delta.after.returned, y.delta.before.returned), y.delta.refund) && y.delta.keys[1] === y.delta.keys[0] + 1, 'y store: the delta\'s removed cells credited under one key (returned >= the refund; swaps add as they happen)', y.delta);
    }
    if (y.revert && y.revertBuilt) {
      ok(same(sub(y.revertBuilt.ledger.consumed, y.revert.after.consumed), y.revert.outstanding), 'y store: the revert (a paid forward delta) built consumed exactly its outstanding', { consumed: sub(y.revertBuilt.ledger.consumed, y.revert.after.consumed), outstanding: y.revert.outstanding });
      ok(geq(sub(y.revert.after.returned, y.revert.before.returned), y.revert.refund) && y.revert.keys[1] === y.revert.keys[0] + 1, 'y store: the revert\'s removed cells credited under one key', y.revert);
    }
  }
  const cu = evidence('gate6c-cu/survival.json')?.data;
  ok(!!cu?.a && !!cu?.b?.standing, 'cu-survival: the full run\'s evidence with the standing blocks');
  if (cu?.a) ok(same(cu.a.after.outstanding, cu.a.waiting.outstanding) && cu.a.after.built === cu.a.waiting.built, 'cu-survival 8a: weathering while the build waited re-queued nothing and charged nothing', cu.a);
  if (cu?.b?.standing) {
    const f = path.join(runDir(), 'p3-ledger-probe.json');
    fs.writeFileSync(f, `${JSON.stringify({ standing: cu.b.standing, returned: cu.b.returned }, null, 1)}\n`);
    const mod = path.join(process.env.P3_REPO ?? ROOT, 'mod');
    const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25' };
    for (const k of Object.keys(env)) if (/^(ANTHROPIC|CLAUDE)/.test(k)) delete env[k];
    const r = spawnSync('./gradlew', ['--offline', '--no-daemon', '-q', 'test', '--tests', 'dev.larattalabs.architect.site.LedgerProbeTest', `-Dledger.probe=${f}`], { cwd: mod, env, encoding: 'utf8', timeout: 1_200_000 });
    const res = path.join(mod, 'build', 'test-results', 'test', 'TEST-dev.larattalabs.architect.site.LedgerProbeTest.xml');
    const xml = fs.existsSync(res) ? fs.readFileSync(res, 'utf8') : '';
    const failure = /<failure message="([^"]*)"/.exec(xml)?.[1];
    ok(r.status === 0 && /tests="1"/.test(xml) && !/skipped="1"/.test(xml), `cu-survival 8b: the deconstruct's measured refund equals the Java model's refund of the same ${cu.b.standing.length} standing blocks (LedgerProbeTest)`, failure ?? r.stderr?.slice(-400));
  }
}

if (kind === 'water') await water();
else if (kind === 'ledger') ledger();
else {
  console.error('usage: node tools/p3-probe.mjs water|ledger [--run <dir>] [--record]');
  process.exit(2);
}
if (fails) console.log(`FAIL P3 calibration: ${fails} mismatch(es): the ${kind === 'water' ? 'water' : 'survival ledger'} lint's rows go back in game at the slice tier: node tools/p3-mode.mjs ingame (docs/GATES.md "P3")`);
else console.log(`ok   P3 ${kind} probe: the game agrees with the lint's model`);
process.exit(fails ? 1 : 0);
