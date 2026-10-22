#!/usr/bin/env node
// The union proof for split steps (docs/GATES.md "Turbo": "Split steps"): the parts of a split step together print exactly the
// check lines the whole step prints. A check line is an `ok`, `FAIL` or `rec` line (also indented, as tools/scenarios.mjs prints
// them); it is compared with its run-specific values masked: numbers, hex ids and shas, paths and run dirs. Lines only a part
// prints (`part k/N: ...`, `P3 smoke: ...`) are not check lines.
//
//   node tools/split-proof.mjs --whole <run dir or .log> --parts <run dir> [--step <parent>[,<parent>...]] [--json out.json]
//
// --whole: a run in which the parent ran whole (its <parent>.log), or one log file (with a single --step). --parts: a run in which
// it ran split (its <parent>.p<k>.log files). Without --step, every split parent in the parts run's summary.json. Exit 0 when
// every compared parent's set of checks (by name: the masked text before the first ': ') is equal; statuses that differ are listed
// (a flaky check fails on one side only), a BAR line (a timing bar) that does as timing. The full masked lines are compared too and
// their value differences counted (--verbose lists them).

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** The check's name: its masked text up to the first ': ' (the values after it vary by run: dict orders, samples, optional
 * annotations), else the whole masked line. */
export const checkName = (masked) => (masked.includes(': ') ? masked.slice(0, masked.indexOf(': ')) : masked);

/** A log's check lines -> Map(masked text, or the check's name with byName -> Set(status)). */
export function checkLines(text, { byName = false } = {}) {
  const out = new Map();
  for (const raw of text.split('\n')) {
    const l = raw.replace(/^\[\d\d:\d\d:\d\d\]\s?/, '').trim();
    const m = /^(ok|FAIL|rec)\s+(.*)$/.exec(l);
    if (!m) continue;
    const key = byName ? checkName(mask(m[2])) : mask(m[2]);
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(m[1]);
  }
  return out;
}

/** Run-specific values out: paths and run dirs, hex ids and shas (6+), ISO times, numbers. */
export function mask(s) {
  return s
    .replace(/\/(?:Users|private|tmp|var)\/\S+/g, '<path>')
    .replace(/\.\.\/architect-mc[\w.-]*/g, '<dir>')
    .replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z\b/g, '<time>')
    .replace(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/g, '<h>')
    .replace(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compare a whole step's lines with its parts' together. */
export function compare(whole, parts) {
  const union = new Map();
  for (const p of parts) for (const [k, st] of p) {
    if (!union.has(k)) union.set(k, new Set());
    for (const s of st) union.get(k).add(s);
  }
  const missing = [...whole.keys()].filter((k) => !union.has(k));
  const extra = [...union.keys()].filter((k) => !whole.has(k));
  const status = [];
  const timing = [];
  for (const [k, st] of whole) {
    const u = union.get(k);
    if (!u) continue;
    const a = [...st].sort().join('/');
    const b = [...u].sort().join('/');
    if (a === b) continue;
    (/^BAR\b/.test(k) ? timing : status).push({ line: k, whole: a, parts: b });
  }
  return { lines: whole.size, unionLines: union.size, equal: !missing.length && !extra.length && !status.length, missing, extra, status, timing };
}

function main() {
  const wholeArg = opt('--whole');
  const partsDir = opt('--parts');
  if (!wholeArg || !partsDir) {
    console.error('usage: node tools/split-proof.mjs --whole <run dir|log> --parts <run dir> [--step a,b] [--json out.json]');
    process.exit(2);
  }
  let ids = opt('--step')?.split(',');
  if (!ids) {
    const sm = JSON.parse(fs.readFileSync(path.join(partsDir, 'summary.json'), 'utf8'));
    ids = Object.keys(sm.split ?? {});
  }
  const report = {};
  let bad = 0;
  for (const id of ids) {
    const wholeLog = fs.statSync(wholeArg).isFile() ? wholeArg : path.join(wholeArg, `${id}.log`);
    const partLogs = fs.readdirSync(partsDir).filter((f) => f.startsWith(`${id}.p`) && /\.p\d+\.log$/.test(f) && f.slice(id.length).match(/^\.p\d+\.log$/)).sort().map((f) => path.join(partsDir, f));
    if (!fs.existsSync(wholeLog) || !partLogs.length) {
      report[id] = { skipped: !fs.existsSync(wholeLog) ? `no whole log ${wholeLog}` : `no part logs in ${partsDir}` };
      console.log(`${id}: SKIPPED (${report[id].skipped})`);
      continue;
    }
    // the proof is by check name (every check the whole step makes, the parts make, and no other), then the statuses; the full
    // masked lines are compared too and their differences listed (values: dict orders, samples, optional annotations)
    const read = (f, o) => checkLines(fs.readFileSync(f, 'utf8'), o);
    const r = compare(read(wholeLog, { byName: true }), partLogs.map((f) => read(f, { byName: true })));
    const full = compare(read(wholeLog), partLogs.map((f) => read(f)));
    report[id] = { whole: wholeLog, parts: partLogs, ...r, fullLines: { equal: full.equal, missing: full.missing, extra: full.extra } };
    if (r.missing.length || r.extra.length) bad++;
    // a check whose values differ only in a part, e.g. "E-flat n/a" where the whole step has "E-flat 0" (a section that read
    // another section's result in the same process: 2026-10-22, scatter_demo's and S3's natural runs read their flat run's E-flat),
    // is listed for review: the check names are the same, but the parts may not have run the same check
    const valued = full.extra.filter((k) => /\bn\/a\b|\bnone\b|\bmissing\b|\bundefined\b|\bnull\b/.test(k) && !full.missing.some((w) => w === k));
    const verdict = r.missing.length || r.extra.length ? 'DIFFERENT' : valued.length ? 'SAME CHECKS, REVIEW: a part lacks a value the whole step has' : r.status.length ? 'SAME CHECKS, status differs' : 'EQUAL';
    report[id].review = valued;
    if (valued.length) bad++;
    console.log(`${id}: ${verdict}: whole ${r.lines} checks, the ${partLogs.length} parts together ${r.unionLines}${full.equal ? ' (full masked lines equal too)' : `; full masked lines: ${full.missing.length} differ in their values`}${r.timing.length ? `; ${r.timing.length} timing bar(s) ok on one side, FAIL on the other (timing, recorded)` : ''}`);
    for (const k of r.missing) console.log(`  missing from the parts: ${k.slice(0, 200)}`);
    for (const k of r.extra) console.log(`  only in the parts: ${k.slice(0, 200)}`);
    for (const s of r.status) console.log(`  status ${s.whole} whole, ${s.parts} parts: ${s.line.slice(0, 200)}`);
    for (const k of valued) console.log(`  REVIEW (only in the parts, with n/a/none/missing): ${k.slice(0, 220)}`);
    if (opt('--verbose')) for (const k of full.missing) console.log(`  (values) whole: ${k.slice(0, 220)}`);
  }
  if (opt('--json')) fs.writeFileSync(opt('--json'), `${JSON.stringify(report, null, 1)}\n`);
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
