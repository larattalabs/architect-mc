#!/usr/bin/env node
// node kit/tools/describe.mjs <id>        what a design can vary: one JSON line
//   { id, params, values, palette, palettes, choices }
//     params    the design's `params` export ({} when it has none)
//     values    the defaults of those params
//     palette   the inputs of the design's default palette ({ preset?, wood, stone, roof, accent })
//     palettes  the presets: [{ name, preset, wood, stone, roof, accent }]
//     choices   { woods, stones, roofs }: what a custom palette accepts, for pickers
// node kit/tools/describe.mjs --palettes  only { palettes, choices }
// Exit code 0 = printed, 2 = no such design / it threw / bad usage (with { error } on stdout).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDesign, loadDesign } from '../build.mjs';
import { paletteChoices, paletteList } from '../lib/kit.mjs';
import { defaultValues } from '../lib/params.mjs';

const USAGE = 'usage: node kit/tools/describe.mjs <id> | --palettes';

/** The description of a design (see the header). */
export async function describe(id) {
  const mod = await importDesign(id);
  const params = mod.params ?? {};
  // the default build tells the default palette
  const saved = { log: console.log, info: console.info, debug: console.debug };
  console.log = console.info = console.debug = console.error;
  let bp;
  try { bp = await loadDesign(id); } finally { Object.assign(console, saved); }
  return { id, params, values: defaultValues(params), palette: { ...bp.p.inputs }, palettes: paletteList(), choices: paletteChoices() };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '-h' || args[0] === '--help') {
    console.error(USAGE);
    process.exitCode = args[0] === '-h' || args[0] === '--help' ? 0 : 2;
    return;
  }
  try {
    if (args[0] === '--palettes') console.log(JSON.stringify({ palettes: paletteList(), choices: paletteChoices() }));
    else if (!/^[a-z0-9_]+$/.test(args[0])) throw new Error(`design id '${args[0]}' must match [a-z0-9_]+`);
    else console.log(JSON.stringify(await describe(args[0])));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
