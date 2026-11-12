// (7b foundation, slice 7bF) A site spec's check: kit/schemas/site-spec.json (lib/specschema.mjs, the subset api.SpecSchema reads the
// same way) plus its x-rules, as api.SiteSpec.fromWire runs them. Pure.
import fs from 'node:fs';
import { validateSpec } from './specschema.mjs';

export const SITE_SPEC_SCHEMA = JSON.parse(fs.readFileSync(new URL('../schemas/site-spec.json', import.meta.url), 'utf8'));

/** Every problem of a site spec's wire form ("path: message"; empty: valid). */
export function siteSpecProblems(o) {
  const errs = validateSpec(SITE_SPEC_SCHEMA, o, 'site');
  if (errs.length) return errs;
  const out = [];
  const v = o.volume;
  if (v.minX > v.maxX || v.minY > v.maxY || v.minZ > v.maxZ) out.push('site.volume: a min passes its max');
  const names = new Set();
  for (const p of o.ports) {
    if (names.has(p.name)) out.push(`site.ports: port name "${p.name}" twice`);
    names.add(p.name);
  }
  const inside = ([x, y, z]) => x >= v.minX && x <= v.maxX && y >= v.minY && y <= v.maxY && z >= v.minZ && z <= v.maxZ;
  const out1 = o.keepCritical.find((c) => !inside(c));
  if (out1) out.push(`site.keepCritical: [${out1.join(', ')}] is outside the volume`);
  return out;
}
