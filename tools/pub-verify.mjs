#!/usr/bin/env node
// (TJ PUB-verify) After a release's Publish: is dev.larattalabs:architect_mc:<version> complete on GitHub Packages? The 0.53.0 package
// shipped without its .module and sources jar and nobody noticed until Steward did (audits/boundary.md finding 8).
//
//   GITHUB_TOKEN=$(gh auth token) node tools/pub-verify.mjs <version> [--json] [--retries N] [--repo owner/name]
//
// The token comes from the environment only (GITHUB_TOKEN, else GH_TOKEN): this script never runs gh and never prints the token. It
// needs read:packages (Actions' GITHUB_TOKEN with packages: read or write has it). It checks:
//   1. the jar, the sources jar, the pom and the Gradle module answer 200;
//   2. the pom names dev.larattalabs:architect_mc at <version>;
//   3. the module's variants list the jar and the sources jar with the size, sha256 and sha1 of the bytes downloaded;
//   4. the jar is a zip with fabric.mod.json whose version is <version>, and carries the plan/0 schema (Regions.PLAN_SCHEMA_RESOURCE).
// Exit 0 complete, 1 incomplete or wrong (each problem printed), 2 usage or no token. --retries N (default 0): retry a 404 up to N
// times 15 s apart (a package just published may take a moment to appear).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GROUP = 'dev.larattalabs', ARTIFACT = 'architect_mc';
export const REPO = 'larattalabs/architect-mc';
const SEMVER = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/;

/** The four files of a release: [{kind, name, url}]. */
export function packageFiles(version, repo = REPO) {
  const base = `https://maven.pkg.github.com/${repo}/${GROUP.replace(/\./g, '/')}/${ARTIFACT}/${version}/${ARTIFACT}-${version}`;
  return [
    { kind: 'jar', name: `${ARTIFACT}-${version}.jar`, url: `${base}.jar` },
    { kind: 'sources', name: `${ARTIFACT}-${version}-sources.jar`, url: `${base}-sources.jar` },
    { kind: 'pom', name: `${ARTIFACT}-${version}.pom`, url: `${base}.pom` },
    { kind: 'module', name: `${ARTIFACT}-${version}.module`, url: `${base}.module` },
  ];
}

const hash = (alg, b) => createHash(alg).update(b).digest('hex');

/**
 * The verifier (pure over the fetched bytes): `got` maps kind -> {status, bytes}. `jarEntries(bytes)` reads a zip's
 * {fabricVersion, hasPlanSchema} (injected for tests). Returns the problem list (empty = complete).
 */
export function verifyPackage(version, got, { jarEntries = readJar } = {}) {
  const problems = [];
  for (const f of packageFiles(version)) {
    const g = got[f.kind];
    if (!g || g.status !== 200) problems.push(`${f.name}: HTTP ${g?.status ?? 'not fetched'}`);
  }
  const ok = (k) => got[k]?.status === 200;
  if (ok('pom')) {
    const pom = got.pom.bytes.toString('utf8');
    for (const [tag, want] of [['groupId', GROUP], ['artifactId', ARTIFACT], ['version', version]]) {
      if (!new RegExp(`<${tag}>${want.replace(/\./g, '\\.')}</${tag}>`).test(pom)) problems.push(`pom: no <${tag}>${want}</${tag}>`);
    }
  }
  if (ok('module')) {
    let m = null;
    try { m = JSON.parse(got.module.bytes.toString('utf8')); } catch (e) { problems.push(`module: not JSON (${e.message})`); }
    if (m) {
      if (m.component?.group !== GROUP || m.component?.module !== ARTIFACT || m.component?.version !== version) {
        problems.push(`module: component is ${m.component?.group}:${m.component?.module}:${m.component?.version}, want ${GROUP}:${ARTIFACT}:${version}`);
      }
      const files = (m.variants ?? []).flatMap((v) => v.files ?? []);
      for (const k of ['jar', 'sources']) {
        const name = packageFiles(version).find((f) => f.kind === k).name;
        const listed = files.filter((f) => f.name === name || f.url === name);
        if (!listed.length) { problems.push(`module: no variant lists ${name}`); continue; }
        if (!ok(k)) continue;
        const b = got[k].bytes;
        for (const f of listed) {
          if (f.size !== b.length) problems.push(`module: ${name} size ${f.size}, downloaded ${b.length}`);
          if (f.sha256 && f.sha256 !== hash('sha256', b)) problems.push(`module: ${name} sha256 ${f.sha256.slice(0, 12)}…, downloaded ${hash('sha256', b).slice(0, 12)}…`);
          if (f.sha1 && f.sha1 !== hash('sha1', b)) problems.push(`module: ${name} sha1 differs from the download`);
          if (!f.sha256 && !f.sha1) problems.push(`module: ${name} has no checksum`);
        }
      }
    }
  }
  if (ok('jar')) {
    let j = null;
    try { j = jarEntries(got.jar.bytes); } catch (e) { problems.push(`jar: not a readable zip (${e.message})`); }
    if (j) {
      if (j.fabricVersion !== version) problems.push(`jar: fabric.mod.json version is ${j.fabricVersion}, want ${version}`);
      if (!j.hasPlanSchema) problems.push('jar: no architect_mc/schemas/plan.json');
    }
  }
  return problems;
}

/** A jar's fabric.mod.json version and whether it has the plan/0 schema (unzip, as tools/api-compat.mjs does). */
function readJar(bytes) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-verify-'));
  try {
    const f = path.join(d, 'a.jar');
    fs.writeFileSync(f, bytes);
    const list = execFileSync('unzip', ['-Z1', f], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n');
    const fmj = JSON.parse(execFileSync('unzip', ['-p', f, 'fabric.mod.json'], { encoding: 'utf8' }));
    return { fabricVersion: fmj.version, hasPlanSchema: list.includes('architect_mc/schemas/plan.json') };
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

async function fetchOne(url, token, retries) {
  for (let i = 0; ; i++) {
    // redirects to the blob store carry their own signature: the auth header goes to GitHub only (fetch drops it cross-origin)
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow' });
    const bytes = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
    if (r.status !== 404 || i >= retries) return { status: r.status, bytes };
    await new Promise((res) => setTimeout(res, 15_000));
  }
}

async function main(argv) {
  const o = { retries: 0, repo: REPO, json: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--retries') o.retries = Number(argv[++i]);
    else if (a === '--repo') o.repo = argv[++i];
    else if (a.startsWith('--')) { console.error(`usage: unknown argument ${a}`); return 2; }
    else pos.push(a);
  }
  const version = (pos[0] ?? '').replace(/^v/, '');
  if (pos.length !== 1 || !SEMVER.test(version) || !Number.isInteger(o.retries) || o.retries < 0 || !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) {
    console.error('usage: GITHUB_TOKEN=$(gh auth token) node tools/pub-verify.mjs <version> [--json] [--retries N] [--repo owner/name]');
    return 2;
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) { console.error('pub-verify: no token: set GITHUB_TOKEN (e.g. GITHUB_TOKEN=$(gh auth token)); it needs read:packages'); return 2; }
  const files = packageFiles(version, o.repo);
  const got = {};
  for (const f of files) got[f.kind] = await fetchOne(f.url, token, o.retries);
  const problems = verifyPackage(version, got);
  const auth = Object.values(got).some((g) => g.status === 401 || g.status === 403);
  if (o.json) console.log(JSON.stringify({ ok: problems.length === 0, version, status: Object.fromEntries(files.map((f) => [f.name, got[f.kind].status])), problems }));
  else {
    for (const f of files) console.log(`${got[f.kind].status === 200 ? 'ok  ' : 'FAIL'} ${f.name}: HTTP ${got[f.kind].status}${got[f.kind].status === 200 ? `, ${got[f.kind].bytes.length} bytes` : ''}`);
    if (auth) console.log('note: 401/403 means the token lacks read:packages (it is not printed)');
    console.log(problems.length ? `INCOMPLETE ${GROUP}:${ARTIFACT}:${version} (${problems.length}):\n  ${problems.join('\n  ')}` : `complete: ${GROUP}:${ARTIFACT}:${version} (jar, sources, pom, module; checksums match)`);
  }
  return problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`pub-verify: ${e.message}`); process.exit(1); });
}
