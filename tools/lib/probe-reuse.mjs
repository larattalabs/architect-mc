#!/usr/bin/env node
// (speed audit A) A calibration probe's verdict from the step that already ran it in this gate run. p2-calibration re-ran t3a-probe's
// in-game probe (about a minute of a client) only to leave probe.json where `gate-lint.mjs record` reads it; when t3a-probe passed in
// this run on this head, its own probe.json is that file.
//   node tools/lib/probe-reuse.mjs <step id> <evidence file, relative to the step's evidence dir> <destination dir>
// The runner hands every step the evidence dirs of the steps that passed so far (GATE_STEP_EVIDENCE, a JSON map id -> dir). Reused only
// when the step passed, its file is complete (a step name, results all ok, no error) and was written on this checkout's HEAD. The file
// is copied as is, and its check lines are printed as the probe printed them (ok/FAIL <check>), so this step's log keeps the probe's
// lines. Exit 1 (and says why) when it can't: the caller then runs the probe itself.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [id, rel, dest] = process.argv.slice(2);
const no = (why) => { console.log(`probe: not reused (${why}): running it here`); process.exit(1); };
if (!id || !rel || !dest) no('usage: probe-reuse.mjs <step> <file> <dest dir>');
let map = {};
try { map = JSON.parse(process.env.GATE_STEP_EVIDENCE ?? '{}'); } catch { /* none */ }
const ev = map[id];
if (!ev) no(`${id} did not pass in this run before this step`);
const file = path.join(ev, rel);
let j;
try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { no(`${file} can't be read (${e.message})`); }
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
const res = Object.entries(j.results ?? {});
if (j.error) no(`${id}'s file records an error`);
if (!res.length) no(`${id}'s file has no checks`);
if (!res.every(([, r]) => r.ok)) no(`${id}'s file has a failed check`);
if (j.head !== head) no(`${id} ran on ${String(j.head).slice(0, 10)}, this checkout is ${head.slice(0, 10)}`);
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(file, path.join(dest, path.basename(rel)));
for (const [m, r] of res) console.log(`[${new Date().toISOString().slice(11, 19)}] ${r.ok ? 'ok  ' : 'FAIL'} ${m}`);
console.log(`probe: reused from this run's ${id} (${res.length} checks, head ${head.slice(0, 10)}): not run again`);
