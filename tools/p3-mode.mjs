#!/usr/bin/env node
// Where the P3 rows run at the slice tier (docs/FAST-CHECKS.md "Cutover", docs/GATES.md "P3: the water and survival ledger lints").
//
//   node tools/p3-mode.mjs smoke     the impact map names each P3 step's `-smoke` id: its groups the lints cover leave the slice
//   node tools/p3-mode.mjs ingame    the impact map names the full ids again: every P3 row back in game at the slice tier
//   node tools/p3-mode.mjs --check   prints the mode (exit 1 when the impact map mixes them)
//
// The rule (Noah, 2026-10-21): a lint is trusted only while its calibration probe passes. When `p3-probe-water` or `p3-probe-ledger`
// fails (release tier, or after a Minecraft update), run `node tools/p3-mode.mjs ingame`, commit, and keep it until the lint or its
// model is fixed and the probe passes again; then `smoke`. Only the impact rules' change/slice lists change; the release tier always runs
// the full ids, and named chains are untouched. Text edit, line by line: the file's layout stays as it is.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const P3_STEPS = Object.freeze(['h-ingame', 'h-probe', 'hy-ingame', 'hy-crash', 'hy-cold', 'irr-ingame', 'kc-ingame', 'voc-survival', 'y-ingame', 'c29-ingame']);
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate-chains.json');

/** The mode of the config text: 'smoke', 'ingame' or 'mixed' (the impact rules' lists). */
export function modeOf(text) {
  const rules = text.slice(text.indexOf('"rules": ['));
  let full = 0, sm = 0;
  for (const id of P3_STEPS) {
    full += (rules.match(new RegExp(`"${id}"`, 'g')) ?? []).length;
    sm += (rules.match(new RegExp(`"${id}-smoke"`, 'g')) ?? []).length;
  }
  return full && sm ? 'mixed' : sm ? 'smoke' : 'ingame';
}

/** The config text with the impact rules' P3 ids set to `mode`. */
export function setMode(text, mode) {
  const at = text.indexOf('"rules": [');
  const head = text.slice(0, at), rules = text.slice(at);
  let out = rules;
  for (const id of P3_STEPS) out = mode === 'smoke' ? out.replace(new RegExp(`"${id}"`, 'g'), `"${id}-smoke"`) : out.replace(new RegExp(`"${id}-smoke"`, 'g'), `"${id}"`);
  return head + out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = process.argv[2];
  const text = fs.readFileSync(FILE, 'utf8');
  if (arg === '--check' || !arg) {
    const m = modeOf(text);
    console.log(`P3 rows at the slice tier: ${m}`);
    process.exit(m === 'mixed' ? 1 : 0);
  }
  if (!['smoke', 'ingame'].includes(arg)) {
    console.error('usage: node tools/p3-mode.mjs smoke|ingame|--check');
    process.exit(2);
  }
  const next = setMode(text, arg);
  JSON.parse(next);
  fs.writeFileSync(FILE, next);
  console.log(`P3 rows at the slice tier: ${modeOf(next)} (tools/gate-chains.json; commit it)`);
}
