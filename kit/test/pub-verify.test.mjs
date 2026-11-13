// tools/pub-verify.mjs (slice TJ PUB-verify): a release's package is complete only with the jar, sources jar, pom and module, the
// module's checksums those of the bytes downloaded, the jar's fabric.mod.json at the version and the plan/0 schema in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { packageFiles, verifyPackage } from '../../tools/pub-verify.mjs';

const V = '9.8.7';
const h = (alg, b) => createHash(alg).update(b).digest('hex');
function complete() {
  const jar = Buffer.from('jar bytes'), sources = Buffer.from('sources bytes');
  const file = (name, b) => ({ name, url: name, size: b.length, sha256: h('sha256', b), sha1: h('sha1', b) });
  const module = { component: { group: 'dev.larattalabs', module: 'architect_mc', version: V },
    variants: [{ name: 'runtimeElements', files: [file(`architect_mc-${V}.jar`, jar)] }, { name: 'sourcesElements', files: [file(`architect_mc-${V}-sources.jar`, sources)] }] };
  const pom = `<project><groupId>dev.larattalabs</groupId><artifactId>architect_mc</artifactId><version>${V}</version></project>`;
  return { jar: { status: 200, bytes: jar }, sources: { status: 200, bytes: sources }, pom: { status: 200, bytes: Buffer.from(pom) }, module: { status: 200, bytes: Buffer.from(JSON.stringify(module)) } };
}
const jarOk = () => ({ fabricVersion: V, hasPlanSchema: true });

test('the four files of a release, under GitHub Packages', () => {
  assert.deepEqual(packageFiles(V).map((f) => f.name), [`architect_mc-${V}.jar`, `architect_mc-${V}-sources.jar`, `architect_mc-${V}.pom`, `architect_mc-${V}.module`]);
  assert.ok(packageFiles(V).every((f) => f.url.startsWith(`https://maven.pkg.github.com/larattalabs/architect-mc/dev/larattalabs/architect_mc/${V}/`)));
});

test('a complete package passes', () => {
  assert.deepEqual(verifyPackage(V, complete(), { jarEntries: jarOk }), []);
});

test('the 0.53.0 shape (no module, no sources jar) fails, naming both', () => {
  const g = complete();
  g.module = { status: 404, bytes: Buffer.alloc(0) };
  g.sources = { status: 404, bytes: Buffer.alloc(0) };
  const p = verifyPackage(V, g, { jarEntries: jarOk });
  assert.ok(p.some((x) => x.includes('.module: HTTP 404')) && p.some((x) => x.includes('-sources.jar: HTTP 404')), p.join('\n'));
});

test('a module whose checksum or size is not the download fails; a wrong pom, a jar at another version or without the schema fails', () => {
  const g = complete();
  g.jar = { status: 200, bytes: Buffer.from('other jar bytes') };
  const p = verifyPackage(V, g, { jarEntries: jarOk });
  assert.ok(p.some((x) => /size \d+, downloaded/.test(x)) && p.some((x) => /sha256/.test(x)), p.join('\n'));
  const g2 = complete();
  g2.pom = { status: 200, bytes: Buffer.from('<project><artifactId>architect_mc</artifactId><version>0.0.1</version></project>') };
  assert.ok(verifyPackage(V, g2, { jarEntries: jarOk }).some((x) => x.startsWith('pom: no <groupId>')));
  assert.ok(verifyPackage(V, complete(), { jarEntries: () => ({ fabricVersion: '1.0.0', hasPlanSchema: false }) }).length === 2);
  assert.ok(verifyPackage(V, complete(), { jarEntries: () => { throw new Error('bad zip'); } }).some((x) => x.startsWith('jar: not a readable zip')));
});
