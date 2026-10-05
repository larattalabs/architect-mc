#!/usr/bin/env node
// node kit/tools/examples.mjs [id...]
// Builds the hand-written designs into kit/examples/<id>/ in the library layout (docs/CONTRACT.md "Library on disk"):
// <id>.nbt, <id>.blueprint.json, <id>.mjs (the source) and the three previews. The mod bundles these and the
// sidecar's sim designer copies them. Fails (exit 1) if any design does not pass the checker with zero warnings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesign, listDesigns, DESIGNS } from '../build.mjs';
import { renderStructure } from '../render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../examples');

const ids = process.argv.slice(2).length ? process.argv.slice(2) : listDesigns();
let failed = false;
for (const id of ids) {
  const dir = path.join(OUT, id);
  const { result } = await buildDesign(id, { out: dir });
  fs.copyFileSync(path.join(DESIGNS, `${id}.mjs`), path.join(dir, `${id}.mjs`));
  renderStructure(path.join(dir, `${id}.nbt`), { out: dir });
  const clean = result.ok && !result.warnings.length;
  console.log(`${id}: ${clean ? 'OK' : `${result.errors.length} error(s), ${result.warnings.length} warning(s)`}`);
  for (const m of [...result.errors, ...result.warnings]) console.log(`  ${m}`);
  if (!clean) failed = true;
}
process.exit(failed ? 1 : 0);
