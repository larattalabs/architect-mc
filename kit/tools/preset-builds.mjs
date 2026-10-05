#!/usr/bin/env node
// node kit/tools/preset-builds.mjs [--write]
// Hashes every kit example built under every palette preset (and its own default) at every corner of its params:
// the template (raw NBT) and the sidecar JSON without `parts`. kit/test/fixtures/preset-builds.json holds the hashes
// recorded before phase 4b (style bibles); test/bible.test.mjs checks that the presets still build byte-identically.
// --write records the current hashes (only when a change to the examples' geometry is intended).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDesign } from '../build.mjs';
import { PALETTE_PRESETS } from '../lib/kit.mjs';
import { cornerValues } from '../lib/params.mjs';
import { encode } from '../lib/nbt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = path.resolve(HERE, '../test/fixtures/preset-builds.json');
export const EXAMPLES = ['cabin', 'tower', 'tavern', 'gatehouse'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

/** `{ "<id>|<preset or ->|<values json>": { nbt, sidecar } }`; `opts.palette(preset)` maps a preset to what is built. */
export async function presetBuilds({ palette = (preset) => preset } = {}) {
  const out = {};
  for (const id of EXAMPLES) {
    const mod = await import(`../designs/${id}.mjs`);
    for (const preset of [undefined, ...Object.keys(PALETTE_PRESETS)]) {
      for (const values of cornerValues(mod.params)) {
        const bp = await loadDesign(id, { palette: preset === undefined ? undefined : palette(preset), values });
        const sc = JSON.parse(JSON.stringify(bp.sidecar()));
        delete sc.parts;
        out[`${id}|${preset ?? '-'}|${JSON.stringify(values)}`] = { nbt: sha(encode(bp.toStructure())), sidecar: sha(JSON.stringify(sc)) };
      }
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const builds = await presetBuilds();
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `${JSON.stringify(builds, null, 1)}\n`);
    console.log(`${Object.keys(builds).length} builds recorded in ${path.relative(process.cwd(), FIXTURE)}`);
  } else {
    const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const diff = Object.keys({ ...want, ...builds }).filter((k) => JSON.stringify(want[k]) !== JSON.stringify(builds[k]));
    console.log(diff.length ? `${diff.length} differ:\n${diff.slice(0, 20).join('\n')}` : `all ${Object.keys(builds).length} builds identical`);
    process.exitCode = diff.length ? 1 : 0;
  }
}
