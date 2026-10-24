// (Style unification U1) Materials only: a design request's `palette` (a preset, inputs, or a Style's roles inline) is checked with
// the kit the sidecar carries (`kit/tools/bible.mjs palette`: it builds a palette, and inline roles pass the bible checks, the test
// house included) before any design job exists. It never turns on bible set mode (docs/CONTRACT.md "Style unification").
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { minimalEnv } from './designs.js';
import { ClientError } from './errors.js';
import type { PaletteSpec } from './protocol.js';
import { truncate } from './util/text.js';

/** Refuse (a ClientError naming why) a palette the kit cannot build; returns for a sound one, or a kit without the check. */
export function checkPaletteSpec(kitDir: string, spec: PaletteSpec): void {
  const tool = path.join(kitDir, 'tools', 'bible.mjs');
  if (!fs.existsSync(tool) || !fs.readFileSync(tool, 'utf8').includes("'palette'")) return;
  const r = spawnSync(process.execPath, [tool, 'palette', typeof spec === 'string' ? spec : JSON.stringify(spec)], { cwd: kitDir, env: minimalEnv(), encoding: 'utf8', timeout: 60_000 });
  let v: { ok?: boolean; errors?: string[] } = {};
  try {
    v = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as typeof v;
  } catch {
    /* below */
  }
  if (r.status === 0 && v.ok) return;
  throw new ClientError(`palette: ${(v.errors ?? [truncate(`${r.stdout}${r.stderr}`, 300)]).slice(0, 4).join('; ')}`);
}

/**
 * (U1) The bible an installed entry is designed again with (polish, versionOf, a report critique): its `bible` pin, in set mode,
 * unless the entry was made materials only (its request carries a `palette`). Then the pin only names the Style its roles came
 * from: the request keeps its palette (the roles inline) and no bible turns set mode on.
 */
export function setModePin(json: Record<string, unknown>): { bible: string; bibleVersion: number } | Record<string, never> {
  const req = json.request && typeof json.request === 'object' ? (json.request as { palette?: unknown }) : undefined;
  if (req?.palette !== undefined) return {};
  const pin = json.bible && typeof json.bible === 'object' ? (json.bible as { id?: string; version?: number }) : undefined;
  return pin?.id ? { bible: pin.id, bibleVersion: pin.version ?? 1 } : {};
}
