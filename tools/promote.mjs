#!/usr/bin/env node
// (7c PM) The shape-promotion pipeline (docs/CONTRACT.md "Phase 7c" §3 row 14; kit/lib/forms/CANDIDATES.md). $0, offline.
//
//   node tools/promote.mjs <candidate> run [--no-linux]     steps 1-4 (lint, determinism, properties, variety) into the record, the sheet
//                                                          into <main checkout>/artifacts/promote/<candidate>/ (never committed)
//   node tools/promote.mjs <candidate> lint|determinism|properties|variety     one step (recorded)
//   node tools/promote.mjs <candidate> approve --by <who> --sheet <png> [--no --reasons <text>] [--via <how>] [--at <iso time>]
//   node tools/promote.mjs <candidate> output --version X.Y.Z                 step 6: the module stamped (every earlier step passed)
//   node tools/promote.mjs <candidate> check [--no-linux]   re-run steps 1-4 against the record, write nothing (the gate step pm-promote)
//   node tools/promote.mjs <candidate> status | shas [--json]                 the record's state | this Node's determinism shas
//
// Determinism's legs: 3 runs on this Node, one on the other Node major (mise exec node@22 or node@24), and Linux in throwaway OrbStack
// containers named pm-determinism-* (node:22 linux/amd64, node:24-slim native; no network, the kit and tools mounted read-only).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as P from './lib/promote.mjs';

const argv = process.argv.slice(2);
const name = argv[0], cmd = argv[1] ?? 'status';
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
if (!name || name.startsWith('-')) { console.error('usage: node tools/promote.mjs <candidate> <run|lint|determinism|properties|variety|approve|output|check|status|shas>'); process.exit(2); }
const c = P.candidateOf(name);
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function mainCheckout() {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: P.REPO, encoding: 'utf8' });
  if (r.status !== 0) return P.REPO;
  return path.dirname(r.stdout.trim());
}
const sheetDir = () => opt('--sheet-dir') ?? path.join(mainCheckout(), 'artifacts', 'promote', name);

/** One determinism leg: `cmd args` printing the shas JSON. */
function leg(label, command, args) {
  const r = spawnSync(command, args, { cwd: P.REPO, encoding: 'utf8', maxBuffer: 16 << 20, timeout: 15 * 60_000 });
  if (r.status !== 0) return { label, ok: false, error: (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').slice(-3).join(' | ') };
  try {
    const j = JSON.parse(r.stdout.trim().split('\n').pop());
    return { label, ok: true, node: j.node, platform: j.platform, arch: j.arch, all: j.all };
  } catch (e) { return { label, ok: false, error: `unreadable output: ${e.message}` }; }
}

async function stepDeterminism({ linux = true } = {}) {
  const here = await P.determinismShas(c);
  const self = ['tools/promote.mjs', name, 'shas', '--json'];
  const legs = [];
  for (let i = 1; i <= 3; i++) legs.push(leg(`run ${i} (this Node)`, process.execPath, self));
  const major = Number(process.versions.node.split('.')[0]);
  const other = major === 22 ? 24 : 22;
  legs.push(leg(`node@${other} (mise)`, 'mise', ['exec', `node@${other}`, '--', 'node', ...self]));
  if (linux) {
    const mount = ['-v', `${path.join(P.REPO, 'kit')}:/w/kit:ro`, '-v', `${path.join(P.REPO, 'tools')}:/w/tools:ro`, '-w', '/w'];
    const run = (i, extra, image) => leg(`linux ${image}${extra.length ? ` ${extra.join(' ')}` : ''}`, 'docker', ['run', '--rm', '--name', `pm-determinism-${process.pid}-${i}`, '--network', 'none', ...extra, ...mount, image, 'node', ...self]);
    legs.push(run(1, ['--platform', 'linux/amd64'], 'node:22'));
    legs.push(run(2, [], 'node:24-slim'));
  }
  const rec = P.readRecord(c);
  const golden = rec.steps?.determinism?.golden ?? null;
  const all = legs.every((l) => l.ok && l.all === here.all) && (!golden || P.shaOfLines(golden) === here.all);
  return {
    pass: all && linux, golden: here.lines, all: here.all,
    legs, ...(linux ? {} : { note: 'the Linux legs were skipped (--no-linux): not a pass' }),
    ...(golden && P.shaOfLines(golden) !== here.all ? { drift: 'this Node\'s shas differ from the recorded golden' } : {}),
  };
}

function writeCandidatesMd(rec) {
  const f = path.join(P.REPO, 'kit', 'lib', 'forms', 'CANDIDATES.md');
  const src = fs.readFileSync(f, 'utf8');
  const a = `<!-- promote:${name} -->`, b = `<!-- /promote:${name} -->`;
  const s = rec.steps;
  const cell = (k, txt) => (s[k] ? `${s[k].pass ? 'PASS' : 'FAIL'}${txt ? `: ${txt}` : ''}` : 'open');
  const v = s.variety, d = s.determinism, pr = s.properties, ap = s.approval;
  const rows = [
    `| lint | ${cell('lint', s.lint ? `${s.lint.findings.length} findings` : '')} |`,
    `| determinism | ${cell('determinism', d ? `${d.legs.filter((l) => l.ok && l.all === d.all).length}/${d.legs.length} legs equal (${d.legs.map((l) => l.label).join('; ')}); 20 seeds, all ${d.all.slice(0, 12)}` : '')} |`,
    `| properties | ${cell('properties', pr ? `${pr.sets} param sets (M3 on ${pr.m3Sets}), ${pr.failed.length} failed; materials under ${Object.keys(pr.materials).join(', ')}; eval ${pr.cost.nsPerCell} ns/cell, ${pr.cost.ratio}x ${pr.cost.reference}${pr.cost.flagged ? ' (FLAG)' : ''}` : '')} |`,
    `| variety | ${cell('variety', v ? `${v.below}/${v.pairs} pairs under IoU ${P.IOU_MAX} (${Math.round(v.share * 100)}%; median ${v.median}, max ${v.max}); sheet ${v.sheetSha.slice(0, 12)}` : '')} |`,
    `| approval | ${ap ? `${ap.pass ? 'YES' : 'NO'}: ${ap.by}, ${ap.at}, sheet ${ap.sheetSha.slice(0, 12)}${ap.reasons ? `; ${ap.reasons}` : ''}` : 'open'} |`,
    `| output | ${s.output ? `PASS: ${s.output.module} ${s.output.version}` : 'open'} |`,
  ];
  const block = `${a}\n**${name}** (\`${c.module}\`, record \`${c.record}\`): ${c.describe}.\n\n| Step | Result |\n|---|---|\n${rows.join('\n')}\n${b}`;
  const i = src.indexOf(a), j = src.indexOf(b);
  fs.writeFileSync(f, i >= 0 && j > i ? `${src.slice(0, i)}${block}${src.slice(j + b.length)}` : `${src.trimEnd()}\n\n${block}\n`);
}

function save(rec) {
  rec.generator = name; rec.module = c.module; rec.describe = c.describe;
  P.writeRecord(c, rec);
  writeCandidatesMd(rec);
}

async function step(s, rec, { write = true } = {}) {
  let r;
  if (s === 'lint') r = P.stepLint(c);
  else if (s === 'determinism') r = await stepDeterminism({ linux: !flag('--no-linux') });
  else if (s === 'properties') r = await P.stepProperties(c);
  else if (s === 'variety') {
    const v = await P.stepVariety(c);
    const { values, ...nums } = v.variety;
    r = { ...nums, sheetSha: v.sheetSha, seeds: v.seeds, iou: values };
    if (write) {
      fs.mkdirSync(sheetDir(), { recursive: true });
      const png = path.join(sheetDir(), 'sheet.png');
      fs.writeFileSync(png, v.png);
      fs.writeFileSync(path.join(sheetDir(), 'sheet.json'), `${JSON.stringify({ candidate: name, sheetSha: v.sheetSha, layout: '5 x 4, seed pm0 top left, row by row; each tile an iso render over its side silhouette in the shared frame', ...nums, seeds: v.seeds }, null, 1)}\n`);
      r.sheet = png;
    } else r._png = v.png;
  }
  r.at = now();
  if (s === 'properties' && r.cost) {
    const { bench } = await import('./lib/bench-report.mjs');
    bench({ id: `promote/${name}/eval-cost-ratio`, value: r.cost.ratio, bound: P.COST_BOUND, better: 'lower', unit: 'x', note: `${r.cost.nsPerCell} ns/cell vs ${r.cost.reference} ${r.cost.refNsPerCell}` });
  }
  console.log(`${s}: ${r.pass ? 'PASS' : 'FAIL'}${s === 'variety' ? ` ${r.below}/${r.pairs} pairs under ${P.IOU_MAX} (median ${r.median}, max ${r.max})` : ''}${s === 'properties' ? ` ${r.failed.length} of ${r.sets} failed; cost ${r.cost.ratio}x ${r.cost.reference}${r.cost.flagged ? ' FLAG' : ''}` : ''}${s === 'determinism' ? ` ${r.legs.map((l) => `${l.label}: ${l.ok ? (l.all === r.all ? 'equal' : 'DIFFERS') : `error ${l.error}`}`).join('; ')}` : ''}${s === 'lint' && r.findings.length ? ` ${JSON.stringify(r.findings.slice(0, 5))}` : ''}`);
  if (write) { rec.steps[s] = r; for (const later of P.STEPS.slice(P.STEPS.indexOf(s) + 1)) if (rec.steps[later] && !(s === 'output')) delete rec.steps[later]; save(rec); }
  return r;
}

const rec = P.readRecord(c);
rec.steps ??= {};
if (cmd === 'shas') {
  const d = await P.determinismShas(c);
  const out = { node: process.versions.node, platform: process.platform, arch: process.arch, all: d.all, lines: d.lines };
  console.log(flag('--json') ? JSON.stringify(out) : d.lines.join('\n') + `\nall ${d.all}`);
} else if (cmd === 'status') {
  for (const s of P.STEPS) console.log(`${s}: ${rec.steps[s] ? (rec.steps[s].pass ? 'PASS' : 'FAIL') : 'open'}${rec.steps[s]?.at ? ` (${rec.steps[s].at})` : ''}`);
} else if (['lint', 'determinism', 'properties', 'variety'].includes(cmd)) {
  const r = await step(cmd, rec);
  process.exit(r.pass ? 0 : 1);
} else if (cmd === 'run') {
  let ok = true;
  for (const s of ['lint', 'determinism', 'properties', 'variety']) { const r = await step(s, rec); if (!r.pass) { ok = false; if (s !== 'determinism' || !flag('--no-linux')) break; } }
  console.log(ok ? `run: steps 1-4 PASS; the sheet: ${path.join(sheetDir(), 'sheet.png')} (for approval)` : 'run: FAIL');
  process.exit(ok ? 0 : 1);
} else if (cmd === 'check') {
  // steps 1-4 again, against the record: the same lint sha, golden, properties, IoU numbers and sheet sha
  const bad = [];
  const l = await step('lint', rec, { write: false });
  if (!l.pass) bad.push('lint');
  const wantSrc = rec.steps.output?.sourceSha ?? rec.steps.lint?.sourceSha;
  if (wantSrc && l.sourceSha !== wantSrc) bad.push('lint: the module changed since its record (re-run the pipeline)');
  const d = await step('determinism', rec, { write: false });
  if (!d.pass) bad.push('determinism');
  if (rec.steps.determinism && d.all !== rec.steps.determinism.all) bad.push(`determinism: all ${d.all.slice(0, 12)} != recorded ${rec.steps.determinism.all.slice(0, 12)}`);
  const pr = await step('properties', rec, { write: false });
  if (!pr.pass) bad.push('properties');
  const v = await step('variety', rec, { write: false });
  if (!v.pass) bad.push('variety');
  if (rec.steps.variety && v.sheetSha !== rec.steps.variety.sheetSha) bad.push(`variety: sheet ${v.sheetSha.slice(0, 12)} != recorded ${rec.steps.variety.sheetSha.slice(0, 12)} (the approval named the recorded one)`);
  if (rec.steps.approval && rec.steps.variety && rec.steps.approval.sheetSha !== rec.steps.variety.sheetSha) bad.push('approval: names another sheet');
  console.log(bad.length ? `check: FAIL ${bad.join('; ')}` : `check: PASS (approval ${rec.steps.approval ? (rec.steps.approval.pass ? 'yes' : 'no') : 'open'}, output ${rec.steps.output?.version ?? 'open'}) on ${os.platform()} node ${process.versions.node}`);
  process.exit(bad.length ? 1 : 0);
} else if (cmd === 'approve') {
  const yes = !flag('--no');
  P.approve(rec, { sheet: opt('--sheet') ?? path.join(sheetDir(), 'sheet.png'), by: opt('--by'), at: opt('--at') ?? now(), yes, reasons: opt('--reasons') ?? null, via: opt('--via') ?? null });
  save(rec);
  console.log(`approval: ${yes ? 'YES' : 'NO'} by ${rec.steps.approval.by} at ${rec.steps.approval.at}, sheet ${rec.steps.approval.sheetSha.slice(0, 12)}`);
} else if (cmd === 'output') {
  P.output(c, rec, opt('--version') ?? '1.0.0');
  rec.steps.output.at = now();
  save(rec);
  console.log(`output: ${c.module} VERSION ${rec.steps.output.version}`);
} else { console.error(`promote: unknown command '${cmd}'`); process.exit(2); }
