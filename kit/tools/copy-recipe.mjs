#!/usr/bin/env node
// node kit/tools/copy-recipe.mjs <id> --in <request.json>   (slice 0b: the sidecar's copy stage)
//
// Chooses a copy's recipe (lib/variation.mjs chooseRecipe) for kit/designs/<id>.mjs and prints it as one JSON line:
// { ok: true, recipe } or { ok: false, error }. request.json:
//   { bible: { id, version, roles }, values?, seed, ordinal, siblings?: [recipe], max?: {x,y,z}, massing?: <path to the
//     archetype's massing blueprint.json>, attempt? }
// The design's `params` come from its module; `values` are the archetype's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDesign, loadDesign, DESIGNS } from '../build.mjs';
import { chooseRecipe } from '../lib/variation.mjs';

async function main() {
  const argv = process.argv.slice(2);
  const id = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--in');
  const inFile = argv[argv.indexOf('--in') + 1];
  const saved = console.log;
  console.log = console.info = console.debug = console.error;
  try {
    if (!id || !/^[a-z0-9_]+$/.test(id) || argv.indexOf('--in') < 0 || !inFile) throw new Error('usage: copy-recipe.mjs <id> --in <request.json>');
    const req = JSON.parse(fs.readFileSync(inFile, 'utf8'));
    const mod = await importDesign(id, DESIGNS);
    const massing = req.massing ? JSON.parse(fs.readFileSync(req.massing, 'utf8')) : undefined;
    const bible = req.bible;
    const load = (roles, values, mirror) => loadDesign(id, { palette: { bible: { id: bible.id, version: bible.version, roles } }, values, mirror });
    const recipe = await chooseRecipe({ load, bible, params: mod.params ?? {}, values: req.values ?? {}, seed: req.seed, ordinal: req.ordinal, siblings: req.siblings ?? [], max: req.max, massing, attempt: req.attempt ?? 0 });
    console.log = saved;
    console.log(JSON.stringify({ ok: true, recipe }));
  } catch (e) {
    console.log = saved;
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
