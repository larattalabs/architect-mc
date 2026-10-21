// (fast checks P2, docs/FAST-CHECKS.md "Structure lint") The lints' virtual worlds from committed plan directories, never a live
// seed (gate7ak1.mjs: the live seed drifts). A plan directory is what a plan or a gate run keeps: `ir.json`, `survey.bin` (ARSV),
// `meta.json` (optional), `blobs/<sha>.bin` (side blobs: fields, baked forms, frozen volumes). The fixtures the lints read are listed
// in kit/test/fixtures/lint/surveys.json (name -> dir, the natural survey's sha, where it came from, the Minecraft version), so a
// survey that moves is a visible diff, not a silent re-pin.
//
// Shared with the P3 lints (water and survival ledger): load a fixture by name, or any plan dir, and build its virtual world once.
//
//   import { loadPlanDir, loadFixture, fixtureNames, virtualOf } from '../lib/lint/vworld-fixtures.mjs';
//   const F = loadFixture('s7');            // {name, dir, ir, meta, survey (bytes), blobs(sha), volumes [decoded], claim, entry}
//   const { vw } = virtualOf(F);            // vworld.buildVirtual with the plan's own volumes, cached per F
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildVirtual } from '../region/vworld.mjs';
import { decodeArvx } from '../region/volume.mjs';

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ROOT = path.resolve(KIT, '..');
export const LINT_FIXTURES = path.join(KIT, 'test', 'fixtures', 'lint');
export const MANIFEST = path.join(LINT_FIXTURES, 'surveys.json');

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** The manifest: {surveys: {name: {dir, surveySha, source, minecraft, claim, note}}}. */
export function manifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

/** Every pinned natural survey's name (S1, S2, S3, S7, tunnel_hill ...). */
export function fixtureNames() {
  return Object.keys(manifest().surveys);
}

/**
 * A plan directory as the lints read it. `dir`: absolute, or relative to the repo root. Volumes: every `ir.volumes` entry whose blob is
 * in `blobs/` (decoded ARVX), so a keep set and a tunnel's cover read the frozen world the plan read.
 */
export function loadPlanDir(dir, { name = null } = {}) {
  const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  const ir = JSON.parse(fs.readFileSync(path.join(abs, 'ir.json'), 'utf8'));
  const metaFile = path.join(abs, 'meta.json');
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;
  const survey = fs.readFileSync(path.join(abs, 'survey.bin'));
  const blobDir = path.join(abs, 'blobs');
  const blobs = (sha) => {
    const f = path.join(blobDir, `${sha}.bin`);
    return fs.existsSync(f) ? fs.readFileSync(f) : null;
  };
  const volumes = [];
  for (const v of Object.values(ir.volumes ?? {})) {
    const sha = ir.blobs?.[v.blob]?.sha ?? v.sha;
    const b = sha ? blobs(sha) : null;
    if (b) volumes.push(decodeArvx(b));
  }
  return { name: name ?? path.basename(abs), dir: abs, ir, meta, survey, surveySha: sha256(survey), blobs, volumes, claim: { ...ir.claim, minY: -64, maxY: 319 } };
}

/** A pinned fixture by name; throws when its survey's sha is not the manifest's (a re-pin is an explicit manifest edit). */
export function loadFixture(name) {
  const e = manifest().surveys[name];
  if (!e) throw new Error(`lint fixture ${name}: not in ${path.relative(ROOT, MANIFEST)}`);
  const F = loadPlanDir(e.dir, { name });
  if (e.surveySha && F.surveySha !== e.surveySha) throw new Error(`lint fixture ${name}: survey sha ${F.surveySha.slice(0, 12)} is not the pinned ${e.surveySha.slice(0, 12)} (${e.dir}/survey.bin moved)`);
  return { ...F, entry: e };
}

const cache = new WeakMap();
/** The plan's virtual world (vworld.buildVirtual over its survey, blobs and volumes), built once per loaded fixture. */
export function virtualOf(F, { ir = F.ir } = {}) {
  if (ir !== F.ir) return buildVirtual({ ir, survey: F.survey, blobs: F.blobs, volumes: F.volumes });
  let v = cache.get(F);
  if (!v) { v = buildVirtual({ ir: F.ir, survey: F.survey, blobs: F.blobs, volumes: F.volumes }); cache.set(F, v); }
  return v;
}

/** A deep copy of a fixture's IR (the lints' broken variants edit a copy, never the fixture). */
export function irCopy(F) {
  return JSON.parse(JSON.stringify(F.ir));
}
