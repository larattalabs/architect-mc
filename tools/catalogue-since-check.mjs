#!/usr/bin/env node
// Fails if a plan-catalogue entry's `sinceApi` is not a real semver, or names a version newer than the catalogue's own API
// (PLAN_API). A new or changed entry on a slice carries the placeholder "NEXT" (docs/GATES.md "Release versions"), which
// tools/release-version.mjs stamps at merge: NEXT is allowed only off a release context (tools/lib/release-context.mjs: not main,
// integrate/*, release/* or a v* tag). Run by kit/test/catalogue-since.test.mjs, so the kit tests catch an unstamped "P0"/slice-name
// placeholder, and NEXT on a release branch. Also checks that the committed golden carries the same values.
// Usage: node tools/catalogue-since-check.mjs   (exit 1 with the offending ids)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseContext } from './lib/release-context.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^(\d{1,4})\.(\d{1,5})\.(\d{1,6})$/;
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/** @returns {string[]} problems (empty when every entry is stamped). `allowNext`: the NEXT placeholder passes (a slice branch). */
export function sinceApiProblems(catalogue, { api = catalogue.api, allowNext = false } = {}) {
  const out = [];
  for (const e of catalogue.entries) {
    if (e.sinceApi === 'NEXT') { if (!allowNext) out.push(`${e.id}: sinceApi "NEXT" is the slice placeholder: stamp it (node tools/release-version.mjs, at merge)`); }
    else if (typeof e.sinceApi !== 'string' || !SEMVER.test(e.sinceApi)) out.push(`${e.id}: sinceApi ${JSON.stringify(e.sinceApi)} is not a semver (stamp the real API version)`);
    else if (SEMVER.test(api) && cmp(e.sinceApi, api) > 0) out.push(`${e.id}: sinceApi ${e.sinceApi} is newer than the catalogue's api ${api}`);
  }
  return out;
}

export async function checkAll({ allowNext = !releaseContext(ROOT).release } = {}) {
  const { planCatalogue } = await import(pathToFileURL(path.join(ROOT, 'kit/lib/plan/catalogue.mjs')).href);
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit/schemas/plan-catalogue.golden.json'), 'utf8'));
  return [...sinceApiProblems(planCatalogue(), { allowNext }), ...sinceApiProblems(golden, { allowNext }).map((p) => `golden ${p}`)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await checkAll();
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('catalogue sinceApi: every entry is a semver at or below the catalogue api (or NEXT off a release branch)');
}
