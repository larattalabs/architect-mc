#!/usr/bin/env node
// node kit/build.mjs <id> [--out <dir>] [--max x,y,z] [--type <t>] [--json]
//
// Imports kit/designs/<id>.mjs (`export const id`, a default export returning the Blueprint), writes
// <out>/<id>.nbt + <out>/<id>.blueprint.json (default --out kit/out), then checks them (lib/check.mjs).
// Prints warnings and errors one per line and `check: OK` or `check: FAILED`; --json prints one JSON line instead:
// { ok, errors[], warnings[], nbt, sidecar }. Exit code 0 = OK, 1 = the check failed, 2 = the design threw or bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeBlueprint } from './lib/write.mjs';
import { checkFiles, parseMax } from './lib/check.mjs';
import { BUILDING_TYPES } from './lib/kit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DESIGNS = path.join(HERE, 'designs');
export const DEFAULT_OUT = path.join(HERE, 'out');
const USAGE = 'usage: node kit/build.mjs <id> [--out <dir>] [--max x,y,z] [--type <t>] [--json]';

export function listDesigns() {
  return fs.readdirSync(DESIGNS).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).map((f) => f.slice(0, -4)).sort();
}

/** Import and run a design; returns the Blueprint. `opts` reach the design's default export (e.g. { palette }). */
export async function loadDesign(id, opts = {}) {
  const file = path.join(DESIGNS, `${id}.mjs`);
  if (!fs.existsSync(file)) throw new Error(`no design '${id}' (kit/designs/${id}.mjs; have: ${listDesigns().join(', ') || 'none'})`);
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.default !== 'function') throw new Error(`kit/designs/${id}.mjs has no default export function`);
  if (mod.id !== undefined && mod.id !== id) throw new Error(`kit/designs/${id}.mjs exports id '${mod.id}' (must match the file name)`);
  const bp = await mod.default(opts);
  if (!bp || typeof bp.toStructure !== 'function') throw new Error(`kit/designs/${id}.mjs: the default export must return a Blueprint`);
  if (bp.id !== id) throw new Error(`kit/designs/${id}.mjs builds id '${bp.id}' (must match the file name)`);
  return bp;
}

/** Build + check one design. */
export async function buildDesign(id, { out = DEFAULT_OUT, max, type, designOpts } = {}) {
  const bp = await loadDesign(id, designOpts);
  const written = writeBlueprint(bp, out);
  const result = checkFiles(written.nbtPath, written.jsonPath, { max, type });
  return { bp, written, result };
}

function parseArgs(argv) {
  const o = { ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--out') o.out = path.resolve(val());
    else if (a === '--max') o.max = parseMax(val());
    else if (a === '--type') {
      o.type = val();
      if (!BUILDING_TYPES.includes(o.type)) throw new Error(`--type '${o.type}' must be one of ${BUILDING_TYPES.join(', ')}`);
    } else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.ids.push(a);
  }
  if (!o.help && o.ids.length !== 1) throw new Error(o.ids.length ? 'one design id at a time' : 'no design id');
  return o;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  if (o.help) { console.log(USAGE); return; }
  const id = o.ids[0];
  const fail2 = (msg) => {
    if (o.json) console.log(JSON.stringify({ ok: false, errors: [msg], warnings: [], nbt: null, sidecar: null }));
    else console.error(`error: ${msg}`);
    process.exit(2);
  };
  if (!/^[a-z0-9_]+$/.test(id)) fail2(`design id '${id}' must match [a-z0-9_]+`);
  let r;
  try {
    r = await buildDesign(id, { out: o.out ?? DEFAULT_OUT, max: o.max, type: o.type });
  } catch (e) {
    fail2(`design ${id} threw: ${e.stack ?? e.message}`);
  }
  const { bp, written, result } = r;
  if (o.json) {
    console.log(JSON.stringify({ ok: result.ok, errors: result.errors, warnings: result.warnings, nbt: written.nbtPath, sidecar: written.jsonPath }));
  } else {
    const rel = (p) => path.relative(process.cwd(), p) || p;
    console.log(`${id}: ${bp.type}, ${bp.size.x}x${bp.size.y}x${bp.size.z}, ${written.blocks} blocks, ${written.bytes} bytes gz`);
    console.log(`  ${rel(written.nbtPath)}\n  ${rel(written.jsonPath)}`);
    for (const w of result.warnings) console.log(`warning: ${w}`);
    for (const e of result.errors) console.log(`error: ${e}`);
    console.log(result.ok ? 'check: OK' : 'check: FAILED');
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
