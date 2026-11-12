#!/usr/bin/env node
// node kit/check.mjs <file.nbt> <sidecar.json> [--max x,y,z] [--type <t>] [--profile massing] [--massing <massing.blueprint.json> [--massing-cap x,y,z]] [--imported] [--restraint <bible.json>] [--json]
//
// Checks a template + sidecar pair that has no design source (an import, a library entry) with lib/check.mjs: the
// same rules and output as build.mjs (warning/error lines and `check: OK` / `check: FAILED`, or with --json one line
// { ok, errors[], warnings[], nbt, sidecar, metrics }; metrics: lib/check.mjs computeMetrics, null when not computed).
// --imported applies the import severity (lib/check.mjs header).
// --profile massing: the request was a massing (the sidecar must say massing: true; a massing sidecar is checked with the
// massing profile anyway). --massing <file>: the massing this design was detailed from; adds massing conformance
// (errors: the size cap; warnings `massing: ...`) and, with --json, `conformance: { ok, errors[], issues[] }`. --massing-cap x,y,z
// (since NEXT, 7a K3): the conformance size cap in place of the massing's size + 2 (a wall lot's exact box).
// --restraint <bible.json|name> (phase 5a): warnings `restraint: ...` against the bible's restraint (lib/bible.mjs restraintOf); (6c VOC-b)
// and `rarity: ...` / `coherence: ...` against its `rarity` when it carries one (lib/vocab/budget.mjs styleOf; metrics.rarity always).
// --site <volume> [--lot <site.json>] (7b SC): check the template composited with its site (lib/siteCheck.mjs): the frozen ARVX volume and
// the lot's site spec (default: the sidecar's `site`, what the design was built into). The site rules' findings join the errors and
// warnings; --json adds `site: {fit, ok, findings, metrics}`.
// Exit code 0 = OK, 1 = the check failed, 2 = bad usage / unreadable files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFiles, parseMax } from './lib/check.mjs';
import { readMassingArg } from './lib/massing.mjs';
import { BUILDING_TYPES, TYPE_RE } from './lib/kit.mjs';
import { readBibleArg, restraintOf } from './lib/bible.mjs';
import { styleOf } from './lib/vocab/budget.mjs';
import { Site } from './lib/site.mjs';

const USAGE = 'usage: node kit/check.mjs <file.nbt> <sidecar.json> [--max x,y,z] [--type <t>] [--profile massing] [--massing <massing.blueprint.json> [--massing-cap x,y,z]] [--imported] [--restraint <bible.json>] [--site <volume> [--lot <site.json>]] [--json]';

export function parseCheckArgs(argv) {
  const o = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--max') o.max = parseMax(val());
    else if (a === '--type') {
      o.type = val();
      if (!TYPE_RE.test(o.type)) throw new Error(`--type '${o.type}' must be a preset (${BUILDING_TYPES.join(', ')}) or an open type matching ${TYPE_RE}`);
    } else if (a === '--profile') {
      const v = val();
      if (v !== 'massing') throw new Error(`--profile '${v}': check.mjs takes only --profile massing (an open type's profile is read from the sidecar)`);
      o.profile = 'massing';
    } else if (a === '--massing') o.massing = readMassingArg(val());
    else if (a === '--massing-cap') o.massingCap = parseMax(val());
    else if (a === '--imported') o.imported = true;
    else if (a === '--restraint') { const b = readBibleArg(val()); o.restraint = restraintOf(b); o.style = styleOf(b); }
    else if (a === '--site') o.sitePath = path.resolve(val());
    else if (a === '--lot') o.lotPath = path.resolve(val());
    else if (a === '--json') o.json = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.files.push(path.resolve(a));
  }
  if (o.files.length !== 2) throw new Error('needs <file.nbt> and <sidecar.json>');
  if (o.lotPath && !o.sitePath) throw new Error('--lot needs --site');
  return o;
}

/** Print a check result the way build.mjs does. */
export function report(result, { json, nbt, sidecar }) {
  if (json) console.log(JSON.stringify({ ok: result.ok, errors: result.errors, warnings: result.warnings, nbt, sidecar, metrics: result.metrics ?? null, ...(result.conformance ? { conformance: result.conformance } : {}), ...(result.site ? { site: result.site } : {}) }));
  else {
    for (const w of result.warnings) console.log(`warning: ${w}`);
    for (const e of result.errors) console.log(`error: ${e}`);
    console.log(result.ok ? 'check: OK' : 'check: FAILED');
  }
}

function main() {
  const argv = process.argv.slice(2);
  let o;
  try { o = parseCheckArgs(argv); } catch (e) {
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, errors: [e.message], warnings: [], nbt: null, sidecar: null, metrics: null }));
    console.error(`${e.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const [nbt, sidecar] = o.files;
  for (const f of o.files) {
    if (!fs.existsSync(f)) {
      if (o.json) console.log(JSON.stringify({ ok: false, errors: [`no such file: ${f}`], warnings: [], nbt: null, sidecar: null, metrics: null }));
      else console.error(`error: no such file: ${f}`);
      process.exitCode = 2;
      return;
    }
  }
  // (7b SC) the site: --site (the volume) and --lot (default: the sidecar's site spec)
  let site;
  if (o.sitePath) {
    try {
      const lot = o.lotPath ? JSON.parse(fs.readFileSync(o.lotPath, 'utf8')) : JSON.parse(fs.readFileSync(sidecar, 'utf8')).site;
      if (!lot) throw new Error('--site needs the lot: --lot <site.json>, or a sidecar with a `site` (a design built into a site)');
      site = new Site(fs.readFileSync(o.sitePath), lot);
    } catch (e) {
      if (o.json) console.log(JSON.stringify({ ok: false, errors: [e.message], warnings: [], nbt, sidecar, metrics: null }));
      else console.error(`error: ${e.message}`);
      process.exitCode = 2;
      return;
    }
  }
  const result = checkFiles(nbt, sidecar, { ...(site ? { site } : {}), max: o.max, type: o.type, imported: o.imported, ...(o.profile ? { profile: o.profile } : {}), ...(o.massing ? { massing: o.massing } : {}), ...(o.massing && o.massingCap ? { massingCap: o.massingCap } : {}), ...(o.restraint ? { restraint: o.restraint } : {}), ...(o.style ? { style: o.style } : {}) });
  report(result, { json: o.json, nbt, sidecar });
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
