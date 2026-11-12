// (7b DS) The designer's site inputs and the site's files (docs/CONTRACT.md "Phase 7b", slice DS; SETTLEMENTS §7.3).
//
//   - the volume: at request time the frozen volume (the helper's blob, ARVX) is copied into <data>/sites/<sha>.arvx, so a design,
//     a site variant or a follow never depends on the blob store's lifetime (blobs are GC'd; the content is addressed by its sha)
//   - the scratch dir's site/: site.arvx, spec.json (the request's site spec), site.json (the lot, the fit's row, the ports, the
//     keep hints and the analysis) and the four empty-site renders, written by the kit's tools/site-brief.mjs in a child process
//     (the same analysis Survey.site and a region plan use); its JSON line carries the BRIEF's "Site" section
//   - the build and check of a site-bound design: `--site site/site.arvx --lot site/site.json` (relative to the scratch dir, the
//     build's cwd), so every designer (Claude, the sim) and every $0 rebuild (site variants, follows) checks on the composite
//   - an installed site-bound entry keeps site/site.arvx and site/site.json beside its source (a later palette or param variant or a
//     follow re-runs the program on them)
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { KIT, minimalEnv } from './designs.js';
import { ClientError } from './errors.js';
import { siteSize, type SiteSpec } from './protocol.js';

/** The files of a site in a scratch dir (relative to it: the build's cwd) and in an installed entry's dir. */
export const SITE_DIR = 'site';
export const SITE_ARVX = `${SITE_DIR}/site.arvx`;
export const SITE_JSON = `${SITE_DIR}/site.json`;
export const SITE_SPEC = `${SITE_DIR}/spec.json`;
/** The cached output of tools/site-brief.mjs (keyed by the spec's hash and whether renders were asked for). */
const SITE_BRIEF = `${SITE_DIR}/.brief.json`;
/** The kit's renders of the empty site (kit/lib/siteBrief.mjs SITE_RENDERS). */
export const SITE_RENDER_FILES = ['site-iso.png', 'site-section.png', 'site-top.png', 'site-composite.png'] as const;

/** The build/check args of a site-bound design (relative to the scratch dir). */
export const SITE_CHECK_ARGS: readonly string[] = ['--site', SITE_ARVX, '--lot', SITE_JSON];

/** <data>/sites/<sha>.arvx: a frozen volume the sidecar keeps for its designs (content-addressed). */
export function siteVolumeFile(dataDir: string, sha: string): string {
  return path.join(dataDir, 'sites', `${sha}.arvx`);
}

/**
 * Keep the request's frozen volume: copied from the helper's blob into <data>/sites/<sha>.arvx (once per sha). The blob must exist
 * unless the volume is kept already (a re-sent request, a variant of a site the sidecar has seen). Throws ClientError.
 */
export function keepSiteVolume(dataDir: string, blobs: { get(id: string): unknown; file(id: string): string }, spec: SiteSpec): string {
  const dst = siteVolumeFile(dataDir, spec.volumeSha);
  if (fs.existsSync(dst)) return dst;
  if (!blobs.get(spec.volumeBlobId)) throw new ClientError(`no blob "${spec.volumeBlobId}" (the site's frozen volume ${spec.volumeSha.slice(0, 12)}): upload it first`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.${process.pid}.tmp`;
  fs.copyFileSync(blobs.file(spec.volumeBlobId), tmp);
  fs.renameSync(tmp, dst);
  return dst;
}

/** A spec's stable hash (the blob id left out: the mod uploads the same volume under new ids). */
export function siteKey(spec: SiteSpec): string {
  const { volumeBlobId: _b, ...rest } = spec;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}

export interface SiteInputs {
  /** BRIEF.md's "Site" section */
  section: string[];
  /** the renders written (site/<file>), [] when off */
  renders: string[];
  /** the template size in the design frame (the lot box) */
  size: { x: number; y: number; z: number };
}

/**
 * Write the scratch dir's site/ (site.arvx, spec.json, site.json and, unless `renders` is false, the four empty-site renders) with the
 * scratch kit's tools/site-brief.mjs. Cached: a scratch that already holds this spec's output is reused (a restart, the next round).
 * Synchronous (a child process with a 120 s limit). Throws Error when the kit cannot read or analyse the site.
 */
export function writeSiteScratch(scratch: string, volumeFile: string, spec: SiteSpec, { renders = true, timeoutMs = 120_000 }: { renders?: boolean; timeoutMs?: number } = {}): SiteInputs {
  const dir = path.join(scratch, SITE_DIR);
  const key = `${siteKey(spec)}:${renders ? 'r' : 'n'}`;
  const cached = readJson(path.join(scratch, SITE_BRIEF));
  fs.mkdirSync(dir, { recursive: true });
  // the volume and the spec are re-written every time (the agent never owns them); the analysis and renders are cached
  fs.copyFileSync(volumeFile, path.join(scratch, SITE_ARVX));
  fs.writeFileSync(path.join(scratch, SITE_SPEC), `${JSON.stringify(spec, null, 1)}\n`);
  if (cached && cached.key === key && Array.isArray(cached.section) && fs.existsSync(path.join(scratch, SITE_JSON))) {
    return { section: cached.section as string[], renders: (cached.renders as string[]) ?? [], size: siteSize(spec) };
  }
  for (const f of SITE_RENDER_FILES) fs.rmSync(path.join(dir, f), { force: true });
  const tool = path.join(scratch, KIT, 'tools', 'site-brief.mjs');
  if (!fs.existsSync(tool)) throw new Error('the kit has no tools/site-brief.mjs (an older kit): it cannot design into a site');
  const r = spawnSync(process.execPath, [tool, SITE_ARVX, SITE_SPEC, '--out', SITE_DIR, ...(renders ? [] : ['--no-renders'])], { cwd: scratch, env: minimalEnv(), timeout: timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const line = (r.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  let out: { ok?: boolean; error?: string; section?: string[]; renders?: string[] } | undefined;
  try {
    out = line ? (JSON.parse(line) as typeof out) : undefined;
  } catch {
    out = undefined;
  }
  if (!out?.ok || !Array.isArray(out.section)) throw new Error(`the site could not be read: ${out?.error ?? (r.error ? r.error.message : (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 400))}`);
  fs.writeFileSync(path.join(scratch, SITE_BRIEF), JSON.stringify({ key, section: out.section, renders: out.renders ?? [] }));
  return { section: out.section, renders: out.renders ?? [], size: siteSize(spec) };
}

/** An installed entry's site files (site/site.arvx and site/site.json), for installDesign's `files`. */
export function siteEntryFiles(scratch: string): Array<{ from: string; to: string }> {
  return [SITE_ARVX, SITE_JSON].filter((f) => fs.existsSync(path.join(scratch, f))).map((f) => ({ from: path.join(scratch, f), to: f }));
}

/** An entry's own site (an installed site-bound entry's site/ files), or undefined. */
export function entrySite(entryDir: string): { arvx: string; json: string; spec: SiteSpec } | undefined {
  const arvx = path.join(entryDir, SITE_ARVX);
  const json = path.join(entryDir, SITE_JSON);
  const j = readJson(json);
  if (!fs.existsSync(arvx) || !j || !j.spec || typeof j.spec !== 'object') return undefined;
  return { arvx, json, spec: j.spec as SiteSpec };
}

/** The binding an installed site-bound entry carries in ext["architect_mc:site"] (api.SiteBinding's wire). */
export function siteBinding(spec: SiteSpec, regionPlanId?: string): Record<string, unknown> {
  return { volumeSha: spec.volumeSha, fit: spec.fit, ...(spec.lotId ? { lotId: spec.lotId } : {}), volume: spec.volume, ...(regionPlanId ? { regionPlanId } : {}) };
}

export const SITE_BINDING_KEY = 'architect_mc:site';

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
