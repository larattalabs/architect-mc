#!/usr/bin/env node
// node kit/tools/examples.mjs [id...]
// Builds the hand-written designs into kit/examples/<id>/ in the library layout (docs/CONTRACT.md "Library on disk"):
// <id>.nbt, <id>.blueprint.json, <id>.mjs (the source) and the three previews. The mod bundles these and the
// sidecar's sim designer copies them. Fails (exit 1) if any design does not pass the checker with zero warnings.
// (7b SV) The site examples (kit/designs/site/fit_*.mjs, one per fit) are built into their 7bF fixture (`exampleSite`): zero errors,
// and exactly the warnings their `templateOnlyWarnings` name (the template-only check's, which only SC's composite can see past).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesign, importDesign, listDesigns, DESIGNS, SITE_DESIGNS } from '../build.mjs';
import { renderStructure } from '../render.mjs';
import { Site } from '../lib/site.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../examples');

/** The site examples' ids (kit/designs/site). */
export const listSiteDesigns = () => listDesigns(SITE_DESIGNS);

/** The rule names of a check's warnings ("enclosure: ..." -> "enclosure"), sorted. */
export const ruleNames = (warnings) => warnings.map((w) => w.split(':')[0]).sort();

/** Build one example into `out` (default kit/examples/<id>). Returns {id, ok, problems: [...]}. */
export async function buildExample(id, { out = path.join(OUT, id) } = {}) {
  const isSite = listSiteDesigns().includes(id);
  const dir = isSite ? SITE_DESIGNS : DESIGNS;
  const mod = await importDesign(id, dir);
  const site = isSite ? Site.fixture(mod.exampleSite) : undefined;
  const { result } = await buildDesign(id, { out, dir, site });
  fs.copyFileSync(path.join(dir, `${id}.mjs`), path.join(out, `${id}.mjs`));
  renderStructure(path.join(out, `${id}.nbt`), { out });
  const problems = [...result.errors];
  if (isSite) {
    const want = [...(mod.templateOnlyWarnings ?? [])].sort();
    if (JSON.stringify(ruleNames(result.warnings)) !== JSON.stringify(want)) problems.push(...result.warnings, `(expected exactly the template-only warnings ${JSON.stringify(want)})`);
  } else problems.push(...result.warnings);
  return { id, ok: result.ok && !problems.length, problems, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : [...listDesigns(), ...listSiteDesigns()];
  let failed = false;
  for (const id of ids) {
    const r = await buildExample(id);
    console.log(`${id}: ${r.ok ? 'OK' : `${r.result.errors.length} error(s), ${r.result.warnings.length} warning(s)`}`);
    for (const m of r.problems) console.log(`  ${m}`);
    if (!r.ok) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
