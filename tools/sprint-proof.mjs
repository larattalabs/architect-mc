#!/usr/bin/env node
// The sprint proof (docs/GATES.md "Sprinted game-time waits"): the same steps run with GATE_SPRINT=0 (old: every game-time wait in
// real time) and by default (new: sprinted) print the same check lines. Per step: the ok/FAIL/rec lines of both runs with run-specific
// values masked (tools/split-proof.mjs `mask`: numbers, hex ids, paths, times), compared as sets of (masked line, status); the step
// times from each run's summary.json; the "(sprint)" lines of the new run (each wait's game time and its wall time).
//
//   node tools/sprint-proof.mjs --old <run dir> --new <run dir> [--step a,b] [--verbose] [--json out.json]
//
// A step is EQUAL when both runs print the same check names with the same statuses and the same full masked lines; SAME CHECKS when
// only values after the check's name differ (dict orders, samples); DIFFERENT otherwise. Split parts (<id>.p<k>.log) are read together.
import fs from 'node:fs';
import path from 'node:path';
import { checkLines } from './split-proof.mjs';

const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const OLD = opt('--old'), NEW = opt('--new');
if (!OLD || !NEW) { console.error('usage: node tools/sprint-proof.mjs --old <run dir> --new <run dir> [--step a,b] [--verbose] [--json out.json]'); process.exit(2); }
const verbose = argv.includes('--verbose');

const summary = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const logsOf = (dir, id) => {
  const whole = path.join(dir, `${id}.log`);
  if (fs.existsSync(whole)) return [whole];
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${id}.p`) && /^\.p\d+\.log$/.test(f.slice(id.length))).sort().map((f) => path.join(dir, f));
};
const textOf = (dir, id) => logsOf(dir, id).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
/** Map(masked line -> Set(status)) as a set of "status line" strings. */
const flat = (m) => new Set([...m].flatMap(([k, st]) => [...st].map((s) => `${s} ${k}`)));
const stepSecs = (sm, id) => {
  const s = sm.steps?.find?.((x) => x.id === id) ?? sm.steps?.[id];
  if (s?.seconds != null) return s.seconds;
  const sr = sm.splitResults?.[id];
  return sr?.wallSeconds ?? sr?.seconds ?? null;
};
const statusOf = (sm, id) => (sm.steps?.find?.((x) => x.id === id) ?? sm.steps?.[id])?.status ?? sm.splitResults?.[id]?.status ?? '?';
const fmt = (s) => (s == null ? '?' : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`);

const so = summary(OLD), sn = summary(NEW);
const allIds = (sm) => [...new Set([...(Array.isArray(sm.steps) ? sm.steps.map((x) => x.id) : Object.keys(sm.steps ?? {}))].map((id) => id.replace(/\/p\d+$/, '')))];
const ids = opt('--step')?.split(',') ?? allIds(sn).filter((id) => allIds(so).includes(id));
const report = {};
let bad = 0;
for (const id of ids) {
  const to = textOf(OLD, id), tn = textOf(NEW, id);
  if (!to || !tn) { console.log(`${id}: SKIPPED (no log in ${!to ? 'old' : 'new'})`); continue; }
  const fo = flat(checkLines(to)), fn = flat(checkLines(tn));
  const bo = flat(checkLines(to, { byName: true })), bn = flat(checkLines(tn, { byName: true }));
  const onlyOld = [...bo].filter((k) => !bn.has(k)), onlyNew = [...bn].filter((k) => !bo.has(k));
  const valOld = [...fo].filter((k) => !fn.has(k)), valNew = [...fn].filter((k) => !fo.has(k));
  const sprints = tn.split('\n').filter((l) => /\(sprint\)/.test(l)).map((l) => l.replace(/^\[\d\d:\d\d:\d\d\]\s*/, '').trim());
  const incomplete = sprints.filter((l) => /INCOMPLETE/.test(l)).length;
  const realOld = to.split('\n').filter((l) => /\(sprint\).*real time/.test(l)).length;
  const verdict = onlyOld.length || onlyNew.length ? 'DIFFERENT' : valOld.length || valNew.length ? 'SAME CHECKS (values differ)' : 'EQUAL';
  if (verdict === 'DIFFERENT') bad++;
  const oldS = stepSecs(so, id), newS = stepSecs(sn, id);
  report[id] = { verdict, checks: bo.size, old: { status: statusOf(so, id), seconds: oldS, realWaits: realOld }, new: { status: statusOf(sn, id), seconds: newS, sprints: sprints.length, incomplete }, onlyOld, onlyNew, valOld, valNew, sprintLines: sprints };
  console.log(`${id}: ${verdict}; ${bo.size} checks; old ${statusOf(so, id)} ${fmt(oldS)} (${realOld} real-time waits logged), new ${statusOf(sn, id)} ${fmt(newS)} (${sprints.length} sprinted waits${incomplete ? `, ${incomplete} INCOMPLETE` : ''}); saved ${oldS != null && newS != null ? fmt(oldS - newS) : '?'}`);
  for (const k of onlyOld) console.log(`   old only: ${k.slice(0, 220)}`);
  for (const k of onlyNew) console.log(`   new only: ${k.slice(0, 220)}`);
  if (verbose) {
    for (const k of valOld) console.log(`   old value: ${k.slice(0, 220)}`);
    for (const k of valNew) console.log(`   new value: ${k.slice(0, 220)}`);
    for (const l of sprints) console.log(`   ${l.slice(0, 200)}`);
  }
}
if (opt('--json')) fs.writeFileSync(opt('--json'), `${JSON.stringify(report, null, 1)}\n`);
process.exit(bad ? 1 : 0);
