// (fast checks P2, docs/GATES.md "Fast checks (P2)") Whether an in-game step may skip its P2-marked assertion groups (the structure and
// look lints check them at the unit tier). Only when the step runs as its slice-tier twin (GATE_P2_SMOKE=1: the `-smoke` steps in
// tools/gate-chains.json) AND the lints' calibration holds: kit/test/fixtures/lint/calibration.json (tools/gate-lint.mjs record, the
// release tier's p2-calibration step) names this checkout's Minecraft version and every probe passed. Otherwise the full in-game rows
// run, as at release: a failed or stale calibration sends every P2 row back in game until a release run passes the probes again.
//
//   import { p2Trim } from './lib/p2-trim.mjs';  if (p2Trim(log, 'pathbibles')) skip...
//   node tools/lib/p2-trim.mjs [group]           exit 0: trim (skip the group); exit 1: run it (a shell `||` in a step's command)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CALIBRATION = path.join(ROOT, 'kit', 'test', 'fixtures', 'lint', 'calibration.json');
/** The latest p2-calibration run's verdict (untracked, in the main checkout's artifacts; tools/gate-lint.mjs record writes it every run). */
export const LATEST = process.env.P2_CALIBRATION_LATEST ?? path.join(path.resolve(ROOT, '..', 'architect-mc'), 'artifacts', 'lint-calibration-latest.json');

/** {valid, why}: the calibration record against this checkout's Minecraft version. */
export function calibration() {
  const mc = /minecraft_version\s*=\s*(\S+)/.exec(fs.readFileSync(path.join(ROOT, 'mod', 'gradle.properties'), 'utf8'))?.[1] ?? null;
  let rec;
  try { rec = JSON.parse(fs.readFileSync(CALIBRATION, 'utf8')); } catch { return { valid: false, why: `no calibration record (${path.relative(ROOT, CALIBRATION)}): run p2-calibration at release`, minecraft: mc }; }
  if (rec.minecraft !== mc) return { valid: false, why: `the calibration is for Minecraft ${rec.minecraft}, this checkout is ${mc}: run p2-calibration`, minecraft: mc, rec };
  // a later run on this machine that failed wins over the committed record (a release whose probe failed, before anyone commits)
  let latest = null;
  try { latest = JSON.parse(fs.readFileSync(LATEST, 'utf8')); } catch { /* none */ }
  if (latest && latest.minecraft === mc && latest.pass !== true && String(latest.at ?? latest.date) >= String(rec.at ?? rec.date)) return { valid: false, why: `the latest p2-calibration run failed (${latest.at ?? latest.date}, ${Object.entries(latest.probes ?? {}).filter(([, v]) => !v?.pass).map(([k]) => k).join(', ') || 'missing'}; ${LATEST})`, minecraft: mc, rec, latest };
  if (rec.pass !== true) return { valid: false, why: `a calibration probe failed (${Object.entries(rec.probes ?? {}).filter(([, v]) => !v?.pass).map(([k]) => k).join(', ') || 'missing'}, ${rec.date})`, minecraft: mc, rec };
  return { valid: true, why: `calibrated on Minecraft ${mc} (${rec.date}, ${rec.head?.slice(0, 10)})`, minecraft: mc, rec };
}

/** True when the caller may skip `group` (logged either way). */
export function p2Trim(log = console.log, group = 'P2 rows') {
  if (process.env.GATE_P2_SMOKE !== '1') return false;
  const c = calibration();
  if (c.valid) { log(`  P2: ${group} skipped at the slice tier (the structure/look lints check it; ${c.why}; the release tier runs it)`); return true; }
  log(`  P2: ${group} runs in game: ${c.why}`);
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(p2Trim(console.log, process.argv[2] ?? 'P2 rows') ? 0 : 1);
