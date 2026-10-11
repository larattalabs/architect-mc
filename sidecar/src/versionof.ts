// Slice 0b, C13 (docs/CONTRACT.md "Phase 6c slice 0b" §5): `versionOf`, a design as the entry's next version.
//
//   - the base is the head version (the site is context only); refusals VERSION_REFUSED with detail bundled, no_source,
//     massing, copy, busy (a polish or versionOf of the entry is unfinished) or group; site_mismatch is the mod's
//   - context, as scratch files: context/base/ (the head's .mjs, blueprint JSON and renders); with a site
//     context/site-now.nbt (the restore box as it stands) and context/site-edits.json (the KEEP set), from the mod's blobs
//   - the frame guard: exactly TemplateDelta's frame check (front and the entrance feet row, kit/lib/diff.mjs); a result
//     that fails it is a repair round, before install. Growth is allowed up to the request's maxSize
//   - install: head + 1, by 'design', parent = the base, the designId, the change request as the summary. If the head moved
//     meanwhile the design fails `base_moved` (its cost is kept)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Design, DesignRequest } from './protocol.js';
import type { CheckResult } from './designs.js';
import { VersionRefused } from './versions.js';
import { ClientError } from './errors.js';

/** What versionOf needs from the sidecar. */
export interface VersionOfHost {
  readonly config: { libraryDir: string; kitDir: string };
  readonly versions: import('./versions.js').EntryVersions;
  readonly blobs: import('./blobs.js').BlobStore;
  readonly designs: { active(): Design[] };
}

/** Validate a versionOf request and pin its base (the head). Throws VersionRefused / ClientError. */
export function prepareVersionOf(sc: VersionOfHost, req: DesignRequest): DesignRequest {
  const v = req.versionOf!;
  if (req.group || req.itemKey) throw new VersionRefused('group', 'versionOf is for single designs only in 0b, not group items');
  if (req.massing || req.fromMassing || req.remix) throw new ClientError('versionOf excludes massing, fromMassing and remix');
  if (!req.notes?.trim()) throw new ClientError('versionOf needs the change request in notes');
  const json = sc.versions.checkChangeable(v.entryId);
  const busy = sc.designs.active().find((d) => (d.kind === 'polish' && d.polish?.entryId === v.entryId) || d.request.versionOf?.entryId === v.entryId);
  if (busy) throw new VersionRefused('busy', `${v.entryId} has an unfinished ${busy.kind === 'polish' ? 'polish' : 'versionOf'} (design ${busy.id})`);
  for (const b of [v.siteNow, v.siteEdits]) if (b && !sc.blobs.get(b)) throw new ClientError(`no blob "${b}" (the site files)`);
  const head = sc.versions.head(v.entryId);
  const type = typeof json.type === 'string' ? json.type : req.type;
  // the head's bible (a group item's entry): the new version builds with the same roles
  const bible = json.bible && typeof json.bible === 'object' ? (json.bible as { id?: string; version?: number }) : undefined;
  return { ...req, type: type as DesignRequest['type'], ...(!req.bible && bible?.id ? { bible: bible.id, bibleVersion: bible.version ?? 1 } : {}), versionOf: { ...v, baseVersion: head } };
}

/** The scratch context: context/base/ (the head's files) and the site's files. Returns the brief's lines. */
export function writeVersionContext(sc: VersionOfHost, d: Design, scratch: string): string[] {
  const v = d.request.versionOf!;
  const dir = path.join(scratch, 'context');
  fs.rmSync(dir, { recursive: true, force: true });
  const base = path.join(dir, 'base');
  fs.mkdirSync(base, { recursive: true });
  const top = sc.versions.dir(v.entryId);
  for (const f of fs.readdirSync(top)) {
    if (f.endsWith('.mjs') || f.endsWith('.blueprint.json') || f.endsWith('.png')) fs.copyFileSync(path.join(top, f), path.join(base, f));
  }
  if (v.siteNow) fs.writeFileSync(path.join(dir, 'site-now.nbt'), fs.readFileSync(sc.blobs.file(v.siteNow)));
  if (v.siteEdits) fs.writeFileSync(path.join(dir, 'site-edits.json'), fs.readFileSync(sc.blobs.file(v.siteEdits)));
  return versionOfSection(v.entryId, v.baseVersion ?? 1, !!v.siteNow, !!v.siteEdits);
}

/** The brief's section: apply the change, keep `front` and the parts, leave the player's edited cells alone. */
export function versionOfSection(entryId: string, base: number, siteNow: boolean, siteEdits: boolean): string[] {
  return [
    `## A new version of \`${entryId}\` (v${base} + 1)`,
    '',
    `- Your design file starts as a copy of v${base}'s source (\`context/base/${entryId}.mjs\`, with its blueprint JSON and renders next to it). Apply the change the notes ask for, and only that.`,
    "- Keep `front`, the entrance feet row (`groundY` minus the origin's y) and the part names: the sidecar refuses a result whose frame changed, and players' placed copies are updated by part. Growing is fine, up to the maximum size.",
    siteNow ? '- `context/site-now.nbt` is the placed site as it stands now (its restore box), with what the player changed.' : '',
    siteEdits ? "- `context/site-edits.json` lists the cells the player edited (by part and block, plus counts). Leave those cells alone unless the request is about them: the mod keeps them when it applies your version." : '',
    '',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
}

/** The frame guard: the problem that makes the round a repair round, or undefined (TemplateDelta's frame check). */
export function frameProblem(sc: VersionOfHost, d: Design, res: CheckResult): string | undefined {
  const v = d.request.versionOf;
  if (!v || !res.ok || !res.nbt) return undefined;
  const dir = sc.versions.versionDir(v.entryId, v.baseVersion ?? 1) ?? sc.versions.dir(v.entryId);
  const baseNbt = path.join(dir, `${v.entryId}.nbt`);
  const r = spawnSync(process.execPath, [path.join(sc.config.kitDir, 'tools', 'diff.mjs'), baseNbt, res.nbt, '--json'], { encoding: 'utf8', timeout: 120_000 });
  const line = (r.stdout ?? '').trim().split('\n').pop();
  let j: { frameKept?: boolean; notes?: string[] } | undefined;
  try {
    j = line ? JSON.parse(line) : undefined;
  } catch {
    j = undefined;
  }
  if (!j) return `the frame check could not run: ${(r.stderr ?? '').slice(0, 300)}`;
  if (j.frameKept === false) return `the frame changed (${(j.notes ?? []).filter((x) => /^front changed|^entrance feet row/.test(x)).join('; ')}): keep \`front\` and the entrance feet row of v${v.baseVersion ?? 1}`;
  return undefined;
}
