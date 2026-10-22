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
// every compared parent's masked line set (status included) is equal; a BAR line (a timing bar) that is `ok` on one side and
// `FAIL` on the other is reported as timing, not as a difference.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** A log's check lines -> Map(masked text -> Set(status)). */
export function checkLines(text) {
  const out = new Map();
  for (const raw of text.split('\n')) {
    const l = raw.replace(/^\[\d\d:\d\d:\d\d\]\s?/, '').trim();
    const m = /^(ok|FAIL|rec)\s+(.*)$/.exec(l);
    if (!m) continue;
    const key = mask(m[2]);
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
    .replace(/\b[0-9a-f]{6,}\b/g, '<h>')
    .replace(/-?\d+(?:\.\d+)?/g, '#')
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
    const r = compare(checkLines(fs.readFileSync(wholeLog, 'utf8')), partLogs.map((f) => checkLines(fs.readFileSync(f, 'utf8'))));
    report[id] = { whole: wholeLog, parts: partLogs, ...r };
    if (!r.equal) bad++;
    console.log(`${id}: ${r.equal ? 'EQUAL' : 'DIFFERENT'}: whole ${r.lines} check lines, the ${partLogs.length} parts together ${r.unionLines}${r.timing.length ? `; ${r.timing.length} timing bar(s) ok on one side, FAIL on the other (timing, recorded)` : ''}`);
    for (const k of r.missing) console.log(`  missing from the parts: ${k.slice(0, 200)}`);
    for (const k of r.extra) console.log(`  only in the parts: ${k.slice(0, 200)}`);
    for (const s of r.status) console.log(`  status ${s.whole} whole, ${s.parts} parts: ${s.line.slice(0, 200)}`);
  }
  if (opt('--json')) fs.writeFileSync(opt('--json'), `${JSON.stringify(report, null, 1)}\n`);
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
