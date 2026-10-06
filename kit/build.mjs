#!/usr/bin/env node
// node kit/build.mjs <id> [--out <dir>] [--max x,y,z] [--type <t>] [--profile <rules>] [--palette <preset>|<json> | --bible <file|name>]
//                        [--values <json>] [--restraint <bible.json>] [--json]
//
// Imports kit/designs/<id>.mjs (`export const id`, `export const params` (optional), a default export taking
// `{ palette, ...values }` and returning the Blueprint), writes
// <out>/<id>.nbt + <out>/<id>.blueprint.json (default --out kit/out), then checks them (lib/check.mjs).
// Prints warnings and errors one per line and `check: OK` or `check: FAILED`; --json prints one JSON line instead:
// { ok, errors[], warnings[], nbt, sidecar, metrics } (metrics: lib/check.mjs computeMetrics, null when the check could not
// compute them). Exit code 0 = OK, 1 = the check failed, 2 = the design threw or bad usage
// (an unknown palette, a value outside its param's domain).
// --palette: a preset name (lib/kit.mjs PALETTE_PRESETS) or JSON { preset?, wood?, stone?, roof?, accent? }; without it
// the design's own default palette. --values: JSON { name: value } over the params' defaults. The sidecar JSON records
// `palette` (inputs), `params` and `values`.
// --bible (phase 4b): a style bible's bible.json, or a built-in bible name (the palette presets): the palette comes from its
// roles (lib/kit.mjs palette({ bible })), and the sidecar records `palette: { bible: { id, version, roles } }` and `bible`.
// --type takes a preset or an open type (`hellish_lair`); --profile <rule,rule,...> is the profile the request asked for
// (an open type's checker rules; the design must declare the same `profile`), or `massing` (phase 4c: the request is a
// massing; the design must build one, lib/massing.mjs).
// --massing <massing.blueprint.json> (phase 4c): the massing this design details; adds massing conformance (errors: the
// size cap, at most the massing's size + 2; warnings `massing: ...`: part names, boxes within 1, size, roof forms) and,
// with --json, `conformance: { ok, errors[], issues[] }`.
// --restraint <bible.json|name> (phase 5a): checks the metrics against the bible's restraint (lib/bible.mjs restraintOf):
// warnings `restraint: ...` when accentShare, windowsMin or detailNoise break it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeBlueprint } from './lib/write.mjs';
import { checkFiles, parseMax } from './lib/check.mjs';
import { BUILDING_TYPES, TYPE_RE, parseProfile, resolvePalette } from './lib/kit.mjs';
import { readBibleArg, restraintOf } from './lib/bible.mjs';
import { readMassingArg } from './lib/massing.mjs';
import { resolveValues, validateParams } from './lib/params.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DESIGNS = path.join(HERE, 'designs');
export const DEFAULT_OUT = path.join(HERE, 'out');
const USAGE = 'usage: node kit/build.mjs <id> [--out <dir>] [--max x,y,z] [--type <t>] [--profile <rules>|massing] [--massing <massing.blueprint.json>] [--palette <preset>|<json> | --bible <file|name>] [--values <json>] [--restraint <bible.json>] [--json]';

/** A request the design cannot build (bad palette or values): exit 2, but not the design's fault. */
export class UsageError extends Error {}

export function listDesigns(dir = DESIGNS) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).map((f) => f.slice(0, -4)).sort();
}

/** Import a design module and check its exports (`id`, `params`, the default export). */
export async function importDesign(id, dir = DESIGNS) {
  const file = path.join(dir, `${id}.mjs`);
  if (!fs.existsSync(file)) throw new UsageError(`no design '${id}' (${path.relative(path.dirname(HERE), file)}; have: ${listDesigns(dir).join(', ') || 'none'})`);
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.default !== 'function') throw new Error(`kit/designs/${id}.mjs has no default export function`);
  if (mod.id !== undefined && mod.id !== id) throw new Error(`kit/designs/${id}.mjs exports id '${mod.id}' (must match the file name)`);
  try { validateParams(mod.params); } catch (e) { throw new Error(`kit/designs/${id}.mjs: ${e.message}`); }
  return mod;
}

/**
 * Import and run a design; returns the Blueprint. `opts.palette` is a preset name or palette inputs (resolvePalette),
 * `opts.values` the param values over the defaults; both throw a UsageError when invalid. Without a palette the design
 * uses its own default.
 */
export async function loadDesign(id, { palette, values, dir } = {}) {
  const mod = await importDesign(id, dir);
  let p;
  let v;
  try {
    p = palette === undefined ? undefined : resolvePalette(palette);
    v = resolveValues(mod.params ?? {}, values ?? {});
  } catch (e) {
    throw new UsageError(e.message);
  }
  const bp = await mod.default({ ...(p ? { palette: p } : {}), ...v });
  if (!bp || typeof bp.toStructure !== 'function') throw new Error(`kit/designs/${id}.mjs: the default export must return a Blueprint`);
  if (bp.id !== id) throw new Error(`kit/designs/${id}.mjs builds id '${bp.id}' (must match the file name)`);
  if (p && bp.p !== p) throw new Error(`kit/designs/${id}.mjs ignores the palette it is given (pass \`palette\` to the Blueprint)`);
  if (mod.params && Object.keys(mod.params).length) {
    bp.params = mod.params;
    bp.values = v;
  }
  return bp;
}

/** Build + check one design. */
export async function buildDesign(id, { out = DEFAULT_OUT, max, type, profile, palette, values, massing, restraint, dir } = {}) {
  const bp = await loadDesign(id, { palette, values, dir });
  const written = writeBlueprint(bp, out);
  const result = checkFiles(written.nbtPath, written.jsonPath, { max, type, ...(profile !== undefined ? { profile } : {}), ...(massing !== undefined ? { massing } : {}), ...(restraint ? { restraint } : {}) });
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
      if (!TYPE_RE.test(o.type)) throw new Error(`--type '${o.type}' must be a preset (${BUILDING_TYPES.join(', ')}) or an open type matching ${TYPE_RE}`);
    } else if (a === '--profile') {
      const v = val();
      o.profile = v === 'massing' ? 'massing' : parseProfile(v).list;
    } else if (a === '--massing') {
      o.massing = readMassingArg(val());
    } else if (a === '--bible') {
      if (o.palette !== undefined) throw new Error('--bible and --palette exclude each other');
      o.palette = { bible: readBibleArg(val()) };
    } else if (a === '--palette') {
      if (o.palette !== undefined) throw new Error('--bible and --palette exclude each other');
      const v = val();
      if (v.trim().startsWith('{')) {
        try { o.palette = JSON.parse(v); } catch (e) { throw new Error(`--palette: bad JSON (${e.message})`); }
      } else o.palette = v;
    } else if (a === '--values') {
      try { o.values = JSON.parse(val()); } catch (e) { throw new Error(`--values: bad JSON (${e.message})`); }
    } else if (a === '--restraint') {
      o.restraint = restraintOf(readBibleArg(val()));
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
  const argv = process.argv.slice(2);
  try { o = parseArgs(argv); } catch (e) {
    // still one JSON line under --json, so a caller gets the reason
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, errors: [e.message], warnings: [], nbt: null, sidecar: null, metrics: null }));
    console.error(`${e.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (o.help) { console.log(USAGE); return; }
  const id = o.ids[0];
  const fail2 = (msg) => {
    if (o.json) console.log(JSON.stringify({ ok: false, errors: [msg], warnings: [], nbt: null, sidecar: null, metrics: null }));
    else console.error(`error: ${msg}`);
    process.exitCode = 2;
  };
  if (!/^[a-z0-9_]+$/.test(id)) return fail2(`design id '${id}' must match [a-z0-9_]+`);
  // --json: stdout carries exactly one line, so whatever the design logs goes to stderr
  const saved = { log: console.log, info: console.info, debug: console.debug };
  if (o.json) console.log = console.info = console.debug = console.error;
  let r;
  try {
    r = await buildDesign(id, { out: o.out ?? DEFAULT_OUT, max: o.max, type: o.type, profile: o.profile, palette: o.palette, values: o.values, massing: o.massing, restraint: o.restraint });
  } catch (e) {
    Object.assign(console, saved);
    if (e instanceof UsageError) return fail2(e.message);
    return fail2(`design ${id} threw: ${e.stack ?? e.message}`);
  }
  Object.assign(console, saved);
  const { bp, written, result } = r;
  if (o.json) {
    console.log(JSON.stringify({ ok: result.ok, errors: result.errors, warnings: result.warnings, nbt: written.nbtPath, sidecar: written.jsonPath, metrics: result.metrics ?? null, ...(result.conformance ? { conformance: result.conformance } : {}) }));
  } else {
    const rel = (p) => path.relative(process.cwd(), p) || p;
    console.log(`${id}: ${bp.type}, ${bp.size.x}x${bp.size.y}x${bp.size.z}, ${written.blocks} blocks, ${written.bytes} bytes gz`);
    console.log(`  ${rel(written.nbtPath)}\n  ${rel(written.jsonPath)}`);
    for (const w of result.warnings) console.log(`warning: ${w}`);
    for (const e of result.errors) console.log(`error: ${e}`);
    console.log(result.ok ? 'check: OK' : 'check: FAILED');
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
