#!/usr/bin/env node
// (TJ CG) Builds the files of the binary-compatibility baselines (tools/api-baselines.json; docs/GATES.md "API compatibility baselines").
// Kept apart from tools/api-baselines.mjs (the readers) so the gate drivers that read the baselines never reach a Gradle call.
//
//   node tools/api-baselines-build.mjs build <tag>     one release's baseline from its tag: a detached worktree in _work/ with its own
//                                                      .gradle-home clone, `./gradlew --offline --no-daemon -PallowNoSidecar jar :apitest:jar`,
//                                                      then architect_mc-<v>.jar, architect_apitest-<v>.jar, the tag's tools/ (git archive:
//                                                      apijars runs the tag's own tools/apitest.mjs), SOURCE.txt and SHA256SUMS into
//                                                      <artifacts>/api-baselines/<dir>/; the worktree is removed after
//   node tools/api-baselines-build.mjs build --missing every release baseline of api-baselines.json whose files are missing
//   node tools/api-baselines-build.mjs steward [--ref R] [--steward <dir>]
//                                                      Steward's real jar: a detached worktree of steward-mc at R (default its
//                                                      origin/main; fetch first yourself for the newest) with a clone of Steward's own
//                                                      .gradle-home, `./gradlew --offline --no-daemon jar`, the jar into
//                                                      <artifacts>/api-baselines/steward/steward_mc.jar with SOURCE.txt (the commit and
//                                                      its architect_version pin)
//   [--artifacts <dir>]                                default: $ARCHITECT_ARTIFACTS, else <main checkout>/artifacts (untracked)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { artifactsDir, consumerFile, dirOf, mainCheckout, missingFiles, readBaselines, releaseFiles } from './api-baselines.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts });
const log = (...a) => console.log(...a);

/** An APFS clone of a Gradle home with its daemon registry dropped (AGENTS.md: never share one, never reach another's daemons). */
function cloneGradleHome(from, to) {
  if (!fs.existsSync(from)) throw new Error(`no Gradle home to copy at ${from}`);
  sh('cp', ['-c', '-R', from, to]);
  const d = path.join(to, 'daemon');
  if (fs.existsSync(d)) for (const v of fs.readdirSync(d, { withFileTypes: true })) if (v.isDirectory()) for (const f of fs.readdirSync(path.join(d, v.name))) if (f.startsWith('registry.bin')) fs.rmSync(path.join(d, v.name, f), { force: true });
}

function gradle(cwd, gradleHome, args, base = process.env) {
  const env = { ...base, GRADLE_USER_HOME: gradleHome, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25' };
  log(`  ./gradlew ${args.join(' ')}   (in ${cwd})`);
  sh('./gradlew', args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
}

function removeWorktree(repo, wt) {
  try { sh('git', ['-C', repo, 'worktree', 'remove', wt], { stdio: ['ignore', 'pipe', 'pipe'] }); log(`  worktree ${wt} removed`); } catch (e) {
    log(`  NOTE: git worktree remove ${wt} refused (${String(e.stderr ?? e.message).trim().split('\n')[0]}): remove it by hand (no --force)`);
  }
}

/** Build one release baseline from its tag. */
export function buildRelease(root, tag, { art = artifactsDir(root) } = {}) {
  const main = mainCheckout(root);
  const b = readBaselines(root);
  const mod = tag.replace(/^v/, '');
  const r = b.releases.find((x) => x.tag === tag) ?? { tag, mod, api: null, dir: dirOf(mod) };
  const tagMod = /^mod_version=(.+)$/m.exec(sh('git', ['-C', main, 'show', `${tag}:mod/gradle.properties`]))?.[1];
  if (tagMod !== mod) throw new Error(`${tag}: its mod_version is ${tagMod}, not ${mod}`);
  const api = /^\tString VERSION = "(\d+\.\d+\.\d+)";$/m.exec(sh('git', ['-C', main, 'show', `${tag}:mod/src/main/java/dev/larattalabs/architect/api/ArchitectApi.java`]))?.[1];
  if (r.api && r.api !== api) throw new Error(`${tag}: its API is ${api}, api-baselines.json says ${r.api}`);
  const work = path.resolve(main, '..', '_work');
  const wt = path.join(work, `architect-mc-apibase-${r.dir}`);
  if (fs.existsSync(wt)) throw new Error(`${wt} exists (a build in flight, or a leftover: remove it with git worktree remove)`);
  const commit = sh('git', ['-C', main, 'rev-list', '-n1', tag]).trim();
  log(`${tag} (${commit.slice(0, 8)}, API ${api}): worktree ${wt}`);
  sh('git', ['-C', main, 'worktree', 'add', '--detach', wt, tag], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const cache = path.resolve(main, '..', 'architect-mc-buildcache', '.gradle-home');
    cloneGradleHome(fs.existsSync(cache) ? cache : path.join(main, '.gradle-home'), path.join(wt, '.gradle-home'));
    const env = { ...process.env };
    delete env.LAB_UI_DIR; // the tag's own lab-ui (its sibling checkout at the tag, else the Gradle cache)
    gradle(path.join(wt, 'mod'), path.join(wt, '.gradle-home'), ['--offline', '--no-daemon', '-PallowNoSidecar', 'jar', ':apitest:jar'], env);
    const f = releaseFiles(art, r);
    fs.mkdirSync(f.dir, { recursive: true });
    // (-PallowNoSidecar may label the jar architect_mc-<v>+nosidecar.jar: the baseline keeps the plain name, SOURCE.txt says how it was built)
    const pick = (dir, base) => {
      const re = new RegExp(`^${base}-${mod.replace(/\./g, '\\.')}(\\+[\\w.]+)?\\.jar$`);
      const hit = fs.readdirSync(dir).filter((x) => re.test(x));
      if (hit.length !== 1) throw new Error(`${dir}: want one ${base}-${mod}[+label].jar, found ${hit.join(', ') || 'none'}`);
      return path.join(dir, hit[0]);
    };
    const builtMod = pick(path.join(wt, 'mod', 'build', 'libs'), 'architect_mc'), builtApitest = pick(path.join(wt, 'apitest', 'build', 'libs'), 'architect_apitest');
    fs.copyFileSync(builtMod, f.mod);
    fs.copyFileSync(builtApitest, f.apitest);
    log(`  built ${path.basename(builtMod)}, ${path.basename(builtApitest)}`);
    fs.rmSync(path.join(f.dir, 'tools'), { recursive: true, force: true });
    const tar = sh('git', ['-C', main, 'archive', '--format=tar', tag, 'tools'], { encoding: 'buffer' });
    sh('tar', ['-x', '-C', f.dir], { input: tar });
    fs.writeFileSync(path.join(f.dir, 'SOURCE.txt'), `${tag} (${commit}), API ${api}: architect_mc-${mod}.jar and architect_apitest-${mod}.jar built from the tag by tools/api-baselines-build.mjs build `
      + `(./gradlew --offline --no-daemon -PallowNoSidecar jar :apitest:jar: no sidecar bundle in the mod jar, the classes are the tag's), and the tag's tools/ (git archive ${tag} tools), `
      + `for apijars and api-compat --baselines. ${new Date().toISOString()}\n`);
    fs.writeFileSync(path.join(f.dir, 'SHA256SUMS'), [f.mod, f.apitest].map((p) => `${sha256(p)}  ${path.basename(p)}`).join('\n') + '\n');
    log(`  -> ${f.dir}`);
    return { tag, api, dir: f.dir };
  } finally {
    removeWorktree(main, wt);
  }
}

/** Build Steward's jar from a ref of its repo. */
export function buildSteward(root, { ref = 'origin/main', steward = null, art = artifactsDir(root) } = {}) {
  const main = mainCheckout(root);
  const b = readBaselines(root);
  const c = b.consumers.find((x) => x.name === 'steward');
  const repo = fs.realpathSync(steward ?? path.resolve(main, '..', c.repo));
  const commit = sh('git', ['-C', repo, 'rev-parse', ref]).trim();
  const pin = /^architect_version=(.+)$/m.exec(sh('git', ['-C', repo, 'show', `${commit}:mod/gradle.properties`]))?.[1] ?? '?';
  const wt = path.join(path.resolve(main, '..', '_work'), `steward-mc-apibase-${commit.slice(0, 8)}`);
  if (fs.existsSync(wt)) throw new Error(`${wt} exists (remove it with git worktree remove)`);
  log(`steward ${ref} (${commit.slice(0, 8)}, pinned to Architect ${pin}): worktree ${wt}`);
  sh('git', ['-C', repo, 'worktree', 'add', '--detach', wt, commit], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    cloneGradleHome(path.join(repo, '.gradle-home'), path.join(wt, '.gradle-home'));
    const env = { ...process.env };
    delete env.ARCHITECT_JAR; // Steward's pinned, released Architect (its Gradle cache), never an RC jar
    gradle(path.join(wt, 'mod'), path.join(wt, '.gradle-home'), ['--offline', '--no-daemon', 'jar'], env);
    const libs = path.join(wt, 'mod', 'build', 'libs');
    const jar = fs.readdirSync(libs).find((f) => /^steward_mc-[^-]+\.jar$/.test(f));
    if (!jar) throw new Error(`no steward_mc-<v>.jar in ${libs}`);
    const out = consumerFile(art, c);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(path.join(libs, jar), out);
    fs.writeFileSync(path.join(path.dirname(out), 'SOURCE.txt'), `steward-mc ${ref} = ${commit} (architect_version=${pin}): ${jar} built by tools/api-baselines-build.mjs steward `
      + `(./gradlew --offline --no-daemon jar, Steward's own Gradle cache), sha256 ${sha256(out)}, for api-compat --consumer. ${new Date().toISOString()}\n`);
    log(`  -> ${out}`);
    return { commit, pin, jar: out };
  } finally {
    removeWorktree(repo, wt);
  }
}

async function main(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--artifacts' || a === '--ref' || a === '--steward') o[a.slice(2)] = argv[++i];
    else if (a === '--missing') o.missing = true;
    else if (a.startsWith('--')) { console.error(`usage: unknown argument ${a}`); return 2; }
    else o._.push(a);
  }
  const art = artifactsDir(HERE, o.artifacts ?? null);
  const cmd = o._[0];
  if (cmd === 'build') {
    const tags = o.missing ? [...new Set(missingFiles(HERE, art).filter((x) => !x.what.startsWith('consumer')).map((x) => x.what.split(' ')[0]))] : o._.slice(1);
    if (!tags.length && !o.missing) { console.error('usage: build <tag> | build --missing'); return 2; }
    for (const t of tags) buildRelease(HERE, t, { art });
    if (!tags.length) log('every release baseline is in place');
    return 0;
  }
  if (cmd === 'steward') { buildSteward(HERE, { ref: o.ref ?? 'origin/main', steward: o.steward ?? null, art }); return 0; }
  console.error('usage: node tools/api-baselines-build.mjs build <tag> | build --missing | steward [--ref R] [--steward dir] [--artifacts dir]');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`api-baselines-build: ${e.message}`); process.exit(1); });
}
