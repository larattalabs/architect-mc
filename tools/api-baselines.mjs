#!/usr/bin/env node
// (TJ CG) The binary-compatibility baselines (tools/api-baselines.json; docs/GATES.md "API compatibility baselines").
//
//   node tools/api-baselines.mjs list                 each baseline and consumer, and whether its files are in place (exit 1 when not)
//   [--artifacts <dir>]                               default: $ARCHITECT_ARTIFACTS, else <main checkout>/artifacts (untracked)
//
// Building the files is tools/api-baselines-build.mjs (build <tag>, build --missing, steward): a separate module, so the gate drivers
// that read the baselines (gate6a apijars, api-compat --baselines, release-version) never reach a Gradle call.
//
// The release-version roll (rollBaselines) shifts the list at every release: the release being set comes first, the oldest drops.
// (GI) `anchors` (one older release per API minor family: 1.55, 1.49 and 1.39 so far) are never rolled; apitestBaselines() is both lists.
// The new tag does not exist yet then, so release-version prints the build command to run once the tag is pushed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINES_FILE = 'tools/api-baselines.json';
export const KEEP = 3; // main's latest three releases
const log = (...a) => console.log(...a);
const TAG_TOOLS = 'tools', TAG_APITEST = 'apitest.mjs';

/** The main checkout: this one, or the sibling ../architect-mc of a worktree (in _work/, a bridge symlink to it). */
export function mainCheckout(root = HERE) {
  // the sibling (gate6a's MAIN; a gate run's tree has one too), else the known place (as tools/api-compat.mjs's --gate* modes), else this
  for (const c of [path.resolve(root, '..', 'architect-mc'), path.join(os.homedir(), 'Developer', 'LarattaLabs', 'Minecraft', 'architect-mc')]) {
    try { if (fs.existsSync(path.join(c, '.git'))) return fs.realpathSync(c); } catch { /* not there */ }
  }
  return fs.realpathSync(root);
}

/** Where the baselines' files live: --artifacts, $ARCHITECT_ARTIFACTS, else the main checkout's artifacts/. */
export function artifactsDir(root = HERE, override = null) {
  return path.resolve(override ?? process.env.ARCHITECT_ARTIFACTS ?? path.join(mainCheckout(root), 'artifacts'));
}

export function readBaselines(root = HERE) {
  return JSON.parse(fs.readFileSync(path.join(root, BASELINES_FILE), 'utf8'));
}

/**
 * (GI) Every release whose unchanged apitest jar is judged: main's latest three (`releases`, rolled) then the fixed `anchors` (one older
 * release per API minor family the three no longer reach, never rolled), without a duplicate mod version. apijars runs each; api-compat
 * --baselines checks each jar's references (the mod-jar surface stays the newest release's only).
 */
export function apitestBaselines(b) {
  const seen = new Set(b.releases.map((r) => r.mod));
  return [...b.releases, ...(b.anchors ?? []).filter((r) => !seen.has(r.mod) && seen.add(r.mod))];
}

/** A release baseline's files: {dir, apitest, mod, tools} as absolute paths under `art`. */
export function releaseFiles(art, r) {
  const dir = path.join(art, 'api-baselines', r.dir);
  // (the tag's own tools/apitest.mjs, not this tree's: TAG_TOOLS keeps step-inputs' closure from reading it as this tree's file)
  return { dir, apitest: path.join(dir, `architect_apitest-${r.mod}.jar`), mod: path.join(dir, `architect_mc-${r.mod}.jar`), tools: path.join(dir, TAG_TOOLS, TAG_APITEST) };
}
export function consumerFile(art, c) { return path.join(art, 'api-baselines', c.dir, c.jar); }

/** The dir name of a release: v0.64.0 -> v0640, v0.40.1 -> v0401 (the archive's habit). */
export const dirOf = (mod) => `v${mod.replace(/\./g, '')}`;

/**
 * The roll (pure): the release being set first, then the previous ones, KEEP at most, no duplicate mod version. Returns the new
 * object (the input untouched).
 */
export function rollBaselines(b, { mod, api }) {
  const head = { tag: `v${mod}`, mod, api, dir: dirOf(mod) };
  const rest = b.releases.filter((r) => r.mod !== mod);
  return { ...b, releases: [head, ...rest].slice(0, KEEP) };
}

/** The baselines' file text, as committed (one release per line). */
export function formatBaselines(b) {
  const line = (o) => `  ${JSON.stringify(o).replace(/":/g, '": ').replace(/,"/g, ', "').replace(/^\{/, '{ ').replace(/\}$/, ' }')}`;
  return `{\n "$comment": ${JSON.stringify(b.$comment)},\n "releases": [\n${b.releases.map(line).join(',\n')}\n ],\n${b.anchors ? ` "anchors": [\n${b.anchors.map(line).join(',\n')}\n ],\n` : ''} "consumers": [\n${b.consumers.map(line).join(',\n')}\n ]\n}\n`;
}

/** What is missing: [{what, path, fix}] (empty = every baseline in place). */
export function missingFiles(root = HERE, art = artifactsDir(root)) {
  const b = readBaselines(root);
  const out = [];
  for (const r of apitestBaselines(b)) {
    const f = releaseFiles(art, r);
    for (const k of ['apitest', 'mod', 'tools']) if (!fs.existsSync(f[k])) out.push({ what: `${r.tag} ${k}`, path: f[k], fix: `node tools/api-baselines-build.mjs build ${r.tag}` });
  }
  for (const c of b.consumers) {
    const p = consumerFile(art, c);
    if (!fs.existsSync(p)) out.push({ what: `consumer ${c.name}`, path: p, fix: `node tools/api-baselines-build.mjs ${c.name}` });
  }
  return out;
}

async function main(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--artifacts') o.artifacts = argv[++i];
    else if (a.startsWith('--')) { console.error(`usage: unknown argument ${a}`); return 2; }
    else o._.push(a);
  }
  const art = artifactsDir(HERE, o.artifacts ?? null);
  const cmd = o._[0];
  if (cmd === 'list') {
    const b = readBaselines(HERE);
    const anchor = new Set((b.anchors ?? []).map((r) => r.mod));
    for (const r of apitestBaselines(b)) {
      const f = releaseFiles(art, r);
      log(`${r.tag} (API ${r.api}${anchor.has(r.mod) && !b.releases.some((x) => x.mod === r.mod) ? ', anchor' : ''}): ${['apitest', 'mod', 'tools'].map((k) => `${k} ${fs.existsSync(f[k]) ? 'ok' : 'MISSING'}`).join(', ')}   ${f.dir}`);
    }
    for (const c of b.consumers) {
      const p = consumerFile(art, c);
      const src = fs.existsSync(path.join(path.dirname(p), 'SOURCE.txt')) ? fs.readFileSync(path.join(path.dirname(p), 'SOURCE.txt'), 'utf8').split(':')[0] : '';
      log(`consumer ${c.name}: ${fs.existsSync(p) ? 'ok' : 'MISSING'}   ${p}${src ? `   (${src})` : ''}`);
    }
    const m = missingFiles(HERE, art);
    for (const f of [...new Set(m.map((x) => x.fix))]) log(`  fix: ${f}`);
    return m.length ? 1 : 0;
  }
  console.error('usage: node tools/api-baselines.mjs list [--artifacts dir]   (building: tools/api-baselines-build.mjs)');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`api-baselines: ${e.message}`); process.exit(1); });
}
