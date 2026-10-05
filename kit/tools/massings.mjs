#!/usr/bin/env node
// node kit/tools/massings.mjs [id...]
// Builds the example massings (kit/massings/<id>.mjs, docs/CONTRACT.md phase 4c) into kit/massings/<id>/: <id>.nbt,
// <id>.blueprint.json and the three previews. Not under kit/examples: that folder is the mod's bundled library. Then checks
// each example (kit/examples/<id without _massing>/) against its massing and fails (exit 1) on any checker error or warning
// of the massing, or any conformance error or issue.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesign, listDesigns } from '../build.mjs';
import { checkFiles } from '../lib/check.mjs';
import { renderStructure } from '../render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MASSINGS = path.resolve(HERE, '../massings');
const EXAMPLES = path.resolve(HERE, '../examples');

const ids = process.argv.slice(2).length ? process.argv.slice(2) : listDesigns(MASSINGS);
let failed = false;
for (const id of ids) {
  const dir = path.join(MASSINGS, id);
  const { result, written } = await buildDesign(id, { out: dir, dir: MASSINGS });
  renderStructure(written.nbtPath, { out: dir });
  const lines = [...result.errors.map((m) => `error: ${m}`), ...result.warnings.map((m) => `warning: ${m}`)];
  const detail = id.replace(/_massing$/, '');
  const ex = path.join(EXAMPLES, detail, `${detail}.blueprint.json`);
  if (fs.existsSync(ex)) {
    const c = checkFiles(path.join(EXAMPLES, detail, `${detail}.nbt`), ex, { massing: JSON.parse(fs.readFileSync(written.jsonPath, 'utf8')) });
    lines.push(...c.conformance.errors.map((m) => `${detail} vs massing (error): ${m}`), ...c.conformance.issues.map((m) => `${detail} vs massing: ${m}`));
  }
  console.log(`${id}: ${lines.length ? `${lines.length} problem(s)` : 'OK'}`);
  for (const m of lines) console.log(`  ${m}`);
  if (lines.length) failed = true;
}
process.exit(failed ? 1 : 0);
