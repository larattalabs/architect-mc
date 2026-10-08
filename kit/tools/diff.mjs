#!/usr/bin/env node
// node kit/tools/diff.mjs <a.nbt> <b.nbt> [--parts-a f] [--parts-b f] [--frame-a x,y,z] [--frame-b x,y,z] [--scope p,q]
//                         [--new-parts n] [--max-share 0.5] [--max x,y,z] [--cells] [--json]
//
// Phase 5b: the blueprint delta of two versions of one entry (lib/diff.mjs; docs/HANDOFF-5b.md "Pinned cross-language
// formats"). Next to each .nbt it reads <base>.blueprint.json (front, groundY, frame.origin, parts boxes, params,
// palette, values) and <base>.parts.nbt (the exact part map) when present; the flags override them. Without a usable
// parts.nbt a side is labelled by box and the delta is `approximate`.
//
// --json prints one line: { ok, frameKept, approximate, parts: {name: {status, added, removed, changed, boxFrom, boxTo}},
// added, removed, changed, unchanged, notes[], violations[], frameHint?, cells? }. --cells adds cells: {added, removed,
// changed}, each a list of [x,y,z] design coordinates sorted y, z, x.
// --scope p,q turns on the scope check (polish: "edit, don't rebuild"); violations are { kind, part?, cells?, message }
// with kinds outside_scope, part_removed, too_many_new_parts, frame_changed, inputs_changed, too_large,
// too_many_changes. The allowed set = the --scope names + B's new part names when there are at most --new-parts (2) of
// them. Without --scope there are no violations (ok is true).
// Exit code 0 = no violation, 1 = violations, 2 = bad usage (or an unreadable file).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffFiles } from '../lib/diff.mjs';

const USAGE = 'usage: node kit/tools/diff.mjs <a.nbt> <b.nbt> [--parts-a f] [--parts-b f] [--frame-a x,y,z] [--frame-b x,y,z] [--scope p,q] [--new-parts n] [--max-share 0.5] [--max x,y,z] [--cells] [--json]';

const triple = (s, what) => {
  const v = String(s).split(',').map((x) => Number(x.trim()));
  if (v.length !== 3 || !v.every(Number.isInteger)) throw new Error(`${what}: expected x,y,z integers (got '${s}')`);
  return v;
};

export function parseDiffArgs(argv) {
  const o = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--parts-a') o.partsA = val();
    else if (a === '--parts-b') o.partsB = val();
    else if (a === '--frame-a') o.frameA = triple(val(), a);
    else if (a === '--frame-b') o.frameB = triple(val(), a);
    else if (a === '--scope') o.scope = val().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--new-parts') {
      o.newParts = Number(val());
      if (!Number.isInteger(o.newParts) || o.newParts < 0) throw new Error('--new-parts: a whole number >= 0');
    } else if (a === '--max-share') {
      o.maxShare = Number(val());
      if (!(o.maxShare > 0 && o.maxShare <= 1)) throw new Error('--max-share: a number in (0, 1]');
    } else if (a === '--max') o.max = triple(val(), a);
    else if (a === '--cells') o.cells = true;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.files.push(a);
  }
  if (!o.help && o.files.length !== 2) throw new Error('two .nbt files');
  return o;
}

function main() {
  const argv = process.argv.slice(2);
  let o;
  try {
    o = parseDiffArgs(argv);
  } catch (e) {
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: e.message }));
    console.error(`${e.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (o.help) {
    console.log(USAGE);
    return;
  }
  let r;
  try {
    for (const f of o.files) if (!fs.existsSync(f)) throw new Error(`no such file: ${f}`);
    r = diffFiles(path.resolve(o.files[0]), path.resolve(o.files[1]), o);
  } catch (e) {
    if (o.json) console.log(JSON.stringify({ ok: false, error: e.message }));
    else console.error(`error: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (o.json) console.log(JSON.stringify(r));
  else {
    console.log(`${r.added} added, ${r.removed} removed, ${r.changed} changed, ${r.unchanged} unchanged${r.approximate ? ' (approximate part labels)' : ''}; frame ${r.frameKept ? 'kept' : 'CHANGED'}`);
    for (const [n, p] of Object.entries(r.parts)) console.log(`  ${p.status.padEnd(9)} ${n}: +${p.added} -${p.removed} ~${p.changed}`);
    for (const n of r.notes) console.log(`note: ${n}`);
    for (const v of r.violations) console.log(`violation: ${v.kind}: ${v.message}`);
    if (o.scope) console.log(r.ok ? 'scope: OK' : 'scope: VIOLATIONS');
  }
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
