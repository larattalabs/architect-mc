#!/usr/bin/env node
// node kit/tools/components.mjs <components.mjs> [--bible <bible.json|name>] [--out <dir>] [--json]
//
// The component test frame (docs/CONTRACT.md phase 4b, R3): builds each component the module exports into its own
// test frame (lib/components.mjs buildFrame: a small lit house in the bible's roles), checks every frame with the
// checker, and renders the sample sheet <out>/sheet.png (a swatch of the roles, then one tile per component, in the
// order the JSON lists them). Without --bible the built-in bible `rustic` is used.
// Prints `warning:` / `error:` lines and `components: OK` / `components: FAILED`, or with --json one line
// { ok, errors[], warnings[], components: [{ name, slot, ok, errors, warnings }], sheet }.
// Exit code 0 = every component passes, 1 = a component failed (or a required one is missing), 2 = bad usage / the bible
// is invalid.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBibleArg, validateBible } from '../lib/bible.mjs';
import { buildSwatch, checkComponents, renderSheet } from '../lib/components.mjs';
import { palette } from '../lib/kit.mjs';

const USAGE = 'usage: node kit/tools/components.mjs <components.mjs> [--bible <bible.json|name>] [--out <dir>] [--json]';

/** Check a components module against a bible and render its sheet. */
export async function runComponents(file, { bible = 'rustic', out } = {}) {
  const b = typeof bible === 'string' ? readBibleArg(bible) : bible;
  const v = validateBible(b);
  if (!v.ok) throw Object.assign(new Error(`the bible is invalid: ${v.errors.join('; ')}`), { usage: true });
  const p = palette({ bible: { id: v.bible.id ?? 'bible', version: v.bible.version, roles: v.bible.roles } });
  const r = await checkComponents(path.resolve(file), p);
  let sheet = null;
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    sheet = path.join(out, 'sheet.png');
    fs.writeFileSync(sheet, renderSheet([buildSwatch(p), ...r.frames.map((f) => f.bp)]));
  }
  return { ok: r.ok, errors: r.errors, warnings: r.warnings, components: r.components, sheet };
}

async function main() {
  const argv = process.argv.slice(2);
  const o = { files: [] };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
      if (a === '--bible') o.bible = val();
      else if (a === '--out') o.out = path.resolve(val());
      else if (a === '--json') o.json = true;
      else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
      else o.files.push(a);
    }
    if (o.files.length !== 1) throw new Error('one components.mjs');
  } catch (e) {
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, errors: [e.message], warnings: [], components: [], sheet: null }));
    console.error(`${e.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  // --json: stdout carries exactly one line
  const saved = { log: console.log, info: console.info, debug: console.debug };
  if (o.json) console.log = console.info = console.debug = console.error;
  let r;
  try {
    r = await runComponents(o.files[0], { bible: o.bible, out: o.out });
  } catch (e) {
    Object.assign(console, saved);
    if (o.json) console.log(JSON.stringify({ ok: false, errors: [e.message], warnings: [], components: [], sheet: null }));
    else console.error(`error: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  Object.assign(console, saved);
  if (o.json) console.log(JSON.stringify(r));
  else {
    for (const c of r.components) console.log(`${c.name} (${c.slot}): ${c.ok ? 'OK' : 'FAILED'}`);
    for (const w of r.warnings) console.log(`warning: ${w}`);
    for (const e of r.errors) console.log(`error: ${e}`);
    if (r.sheet) console.log(`  ${path.relative(process.cwd(), r.sheet)}`);
    console.log(r.ok ? 'components: OK' : 'components: FAILED');
  }
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
