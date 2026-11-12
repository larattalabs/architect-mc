// (C33) System-prompt references: a job's `systemRefs: ["plan/0#compact"]` names schemas Architect holds, and the sidecar
// expands each into the system prompt from the kit it carries (kit/schemas/*.json, plus the live capability catalogue), so the
// caller stops sending 45 KB of schema in `job.system`, and the schema it gets is always the running kit's.
//
//   expansion = <ref blocks, in REGISTRY order> + "\n\n" + (the caller's `system`, else the job kind's default)
//
// - The order is the registry's, not the caller's, and a ref is expanded once, so the same refs give the same bytes whatever
//   order they were listed in; the refs lead, so the prompt prefix is the same across calls that only differ in `system` (the
//   provider's prompt cache hits on it).
// - A block holds nothing that varies between runs or machines (no paths, no times): the schema text, and the catalogue the
//   kit returns with every plan check (`planCatalogue()`: catalogueVersion, api, kitVersion, schemaVersion, entries).
// - `<family>/<id>` is the full rendering; `#compact` is the same minus bookkeeping (COMPACT below says exactly what). (6c VOC) vocab/1's
//   file holds both forms itself (RefDoc.forms): `#compact` is its grouped member instead of the per-block one.
// - A ref the registry lacks, or two forms of one document, is refused with FIELD_LIMIT naming the ref; so is a kit that does
//   not carry the document.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RefusedError } from '../errors.js';

/** One document a ref can name. */
interface RefDoc {
  /** `<family>/<id>`, without a form */
  id: string;
  /** the file under the kit's schemas/ dir */
  file: string;
  /** what the block is called in the prompt */
  title: string;
  /** plan/0 only: the catalogue the schema carries is rendered once, from the kit's own planCatalogue() */
  catalogue?: boolean;
  /**
   * (6c VOC) vocab/1: the generated file holds both forms, `blocks` (the full form) and `compact` (the grouped one); the full rendering
   * drops `compact` and the compact one drops `blocks` (kit/tools/vocab-derive.mjs vocabDoc says what each holds)
   */
  forms?: { full: string; compact: string };
}

/** The documents, in the order their blocks come in the prompt. Append only: the order is the cache key. */
export const SYSTEM_REF_DOCS: readonly RefDoc[] = [
  { id: 'plan/0', file: 'plan.json', title: "Architect's plan schema (plan/0)", catalogue: true },
  { id: 'siteplan/1', file: 'siteplan-1.json', title: "Architect's site plan schema (siteplan/1)" },
  { id: 'mask/1', file: 'mask.json', title: "Architect's mask schema (mask/1)" },
  { id: 'pattern/1', file: 'pattern.json', title: "Architect's pattern schema (pattern/1)" },
  // (6c VOC, S-VOC-6) the block vocabulary: every 26.3 block's family, colour, tier and survival class (kit/tools/gen-vocab.mjs)
  { id: 'vocab/1', file: 'vocab-1.json', title: "Architect's block vocabulary (vocab/1)", forms: { full: 'blocks', compact: 'compact' } },
];

/** The forms of a ref, after its `#`. */
export const SYSTEM_REF_FORMS = ['compact'] as const;

/** Every ref the sidecar accepts, for messages and the feature's docs. */
export function knownSystemRefs(): string[] {
  return SYSTEM_REF_DOCS.flatMap((d) => [d.id, `${d.id}#compact`]);
}

/**
 * What `#compact` drops, and nothing else:
 *   - catalogue entries: `sinceApi` and `schemaVersion` (per entry), and the catalogue's `api`, `kitVersion` and `schemaVersion`
 *   - (7cF, "catalogue text on demand") each entry's `note` and any member not in `lineKeys`: the long text, served by kind
 *     (`Regions.planCatalogue(Set<String> kinds)`, the kit's planCatalogueKinds)
 *   - (7cF) a kind def's own top-level `description` (a def a catalogue entry names as its `def` or `draft`): long text too, served by
 *     kind with the def; its members' descriptions, and every other def's, stay
 *   - `$defs` that are only a `$ref` to another def: inlined at their uses, and removed
 * A schema's own members are never touched by name: `schemaVersion` inside a def stays.
 *
 * (7cF) The compact catalogue is one line per kind, in catalogue order, after a head line naming the catalogueVersion
 * (compactCatalogueText):
 *   <id> <state>[ until <slice>][ alias of <id>][ replaced by <id>][ retired in <api>][ limits <JSON>]
 */
export const COMPACT = {
  entryKeys: ['sinceApi', 'schemaVersion'],
  catalogueKeys: ['api', 'kitVersion', 'schemaVersion'],
  lineKeys: ['id', 'state', 'until', 'aliasOf', 'replacedBy', 'retiredInApi', 'limits'],
} as const;

export interface ParsedRef {
  ref: string;
  doc: RefDoc;
  compact: boolean;
}

const refuse = (detail: string, message: string) => new RefusedError('FIELD_LIMIT', detail, message);

/** Parse and order the refs; throws RefusedError (FIELD_LIMIT) naming the first bad one. Pure. */
export function parseSystemRefs(refs: readonly string[]): ParsedRef[] {
  const byId = new Map<string, ParsedRef>();
  for (const ref of refs) {
    const hash = ref.indexOf('#');
    const id = hash < 0 ? ref : ref.slice(0, hash);
    const form = hash < 0 ? '' : ref.slice(hash + 1);
    const doc = SYSTEM_REF_DOCS.find((d) => d.id === id);
    if (!doc || (form && !(SYSTEM_REF_FORMS as readonly string[]).includes(form))) {
      throw refuse('system_ref', `systemRefs: unknown ref "${ref}" (known: ${knownSystemRefs().join(', ')})`);
    }
    const prev = byId.get(id);
    if (prev && prev.compact !== (form === 'compact')) throw refuse('system_ref', `systemRefs: "${ref}" and "${prev.ref}" are two forms of one document; list one`);
    if (!prev) byId.set(id, { ref, doc, compact: form === 'compact' });
  }
  return SYSTEM_REF_DOCS.flatMap((d) => (byId.has(d.id) ? [byId.get(d.id)!] : []));
}

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `$defs` that are exactly `{"$ref": "#/$defs/x"}` (a description alongside is dropped with them), inlined at their uses. */
export function inlineTrivialRefs(schema: Record<string, Json>): Record<string, Json> {
  const defs = isObj(schema.$defs) ? schema.$defs : {};
  const alias = new Map<string, string>();
  for (const [name, d] of Object.entries(defs)) {
    if (isObj(d) && typeof d.$ref === 'string' && Object.keys(d).every((k) => k === '$ref' || k === 'description')) alias.set(`#/$defs/${name}`, d.$ref);
  }
  if (!alias.size) return schema;
  const target = (r: string): string => {
    for (let i = 0; i < 16 && alias.has(r); i++) r = alias.get(r)!;
    return r;
  };
  const walk = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    const o: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) o[k] = k === '$ref' && typeof x === 'string' ? target(x) : walk(x);
    return o;
  };
  const out = walk(schema) as Record<string, Json>;
  const rest: Record<string, Json> = {};
  for (const [name, d] of Object.entries(out.$defs as Record<string, Json>)) if (!alias.has(`#/$defs/${name}`)) rest[name] = d;
  out.$defs = rest;
  return out;
}

/** (7cF) The defs a catalogue entry names as its `def` or `draft` (the kind defs), by name. */
export function kindDefNames(schema: Record<string, Json>): Set<string> {
  const x = schema['x-catalogue'];
  const entries = isObj(x) && Array.isArray(x.entries) ? x.entries.filter(isObj) : [];
  const out = new Set<string>();
  for (const e of entries) for (const k of ['def', 'draft']) if (typeof e[k] === 'string' && (e[k] as string).startsWith('#/$defs/')) out.add((e[k] as string).slice('#/$defs/'.length));
  return out;
}

/** (7cF) The schema with each kind def's top-level description left out (COMPACT). */
export function dropKindDescriptions(schema: Record<string, Json>, kinds: Set<string>): Record<string, Json> {
  if (!isObj(schema.$defs)) return schema;
  const defs: Record<string, Json> = {};
  for (const [name, d] of Object.entries(schema.$defs)) {
    if (kinds.has(name) && isObj(d) && 'description' in d) {
      const { description: _d, ...rest } = d;
      void _d;
      defs[name] = rest;
    } else defs[name] = d;
  }
  return { ...schema, $defs: defs };
}

const catalogueModules = new Map<string, Promise<Record<string, unknown>>>();

/** The kit's own planCatalogue() (what every plan check returns), imported from the kit at run time (never bundled). */
async function kitCatalogue(kitDir: string): Promise<Record<string, Json>> {
  const file = path.join(kitDir, 'lib', 'plan', 'catalogue.mjs');
  let mod = catalogueModules.get(file);
  if (!mod) {
    mod = import(pathToFileURL(file).href) as Promise<Record<string, unknown>>;
    catalogueModules.set(file, mod);
  }
  const fn = (await mod).planCatalogue;
  if (typeof fn !== 'function') throw new Error('no planCatalogue()');
  return (fn as () => Record<string, Json>)();
}

/** One compact catalogue line (COMPACT's grammar). */
export function compactCatalogueLine(e: Record<string, Json>): string {
  let l = `${String(e.id)} ${String(e.state)}`;
  if (typeof e.until === 'string') l += ` until ${e.until}`;
  if (typeof e.aliasOf === 'string') l += ` alias of ${e.aliasOf}`;
  if (typeof e.replacedBy === 'string') l += ` replaced by ${e.replacedBy}`;
  if (typeof e.retiredInApi === 'string') l += ` retired in ${e.retiredInApi}`;
  if (e.limits !== undefined) l += ` limits ${JSON.stringify(e.limits)}`;
  return l;
}

/** (7cF) The compact catalogue: a head line, then one line per kind (COMPACT). */
export function compactCatalogueText(cat: Record<string, Json>): string {
  const entries = Array.isArray(cat.entries) ? cat.entries.filter(isObj) : [];
  const head = `catalogueVersion ${String(cat.catalogueVersion)}; one line per kind: id state [until slice] [alias of id] [replaced by id] [retired in api] [limits {...}]. A kind's note and full entry are served on demand (Regions.planCatalogue(kinds)).`;
  return [head, ...entries.map(compactCatalogueLine)].join('\n');
}

/** One ref's block (the schema file is read and rendered each time: about a millisecond; the catalogue module is imported once per sidecar process, the kit being fixed for it). */
async function renderBlock(kitDir: string, p: ParsedRef): Promise<string> {
  const file = path.join(kitDir, 'schemas', p.doc.file);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw refuse('system_ref_unavailable', `systemRefs: "${p.ref}" is not in this helper's kit (no schemas/${p.doc.file})`);
  }
  let schema: Record<string, Json>;
  try {
    schema = JSON.parse(text) as Record<string, Json>;
  } catch {
    throw refuse('system_ref_unavailable', `systemRefs: "${p.ref}" is not readable in this helper's kit (schemas/${p.doc.file} is not JSON)`);
  }
  let catalogue: Record<string, Json> | undefined;
  const kinds = p.doc.catalogue && p.compact ? kindDefNames(schema) : new Set<string>();
  if (p.doc.catalogue) {
    try {
      catalogue = await kitCatalogue(kitDir);
    } catch {
      throw refuse('system_ref_unavailable', `systemRefs: "${p.ref}" needs the kit's capability catalogue (lib/plan/catalogue.mjs), which this helper's kit lacks`);
    }
    delete schema['x-catalogue']; // rendered once, below, from the kit's own catalogue
  }
  if (p.doc.forms) {
    // (6c VOC) a document with both forms in one file: each rendering keeps its own member
    delete schema[p.compact ? p.doc.forms.full : p.doc.forms.compact];
  } else if (p.compact) {
    schema = inlineTrivialRefs(dropKindDescriptions(schema, kinds));
  }
  const head = `## ${p.doc.title}${p.compact ? ', compact' : ''}\n\n`;
  let out = `${head}${JSON.stringify(schema)}`;
  if (catalogue) out += `\n\n## Capability catalogue of ${p.doc.id}${p.compact ? ', compact' : ''}\n\n${p.compact && !p.doc.forms ? compactCatalogueText(catalogue) : JSON.stringify(catalogue)}`;
  return out;
}

/** The ref blocks, joined; '' for no refs. Throws RefusedError (FIELD_LIMIT) for a bad ref. */
export async function expandSystemRefs(kitDir: string, refs: readonly string[] | undefined): Promise<string> {
  if (!refs?.length) return '';
  const parsed = parseSystemRefs(refs);
  const out: string[] = [];
  for (const p of parsed) out.push(await renderBlock(kitDir, p));
  return out.join('\n\n');
}

/** The system prompt of a job: the ref blocks first, then the caller's `system` (or the job kind's default). */
export async function composeSystem(kitDir: string, refs: readonly string[] | undefined, system: string): Promise<string> {
  const head = await expandSystemRefs(kitDir, refs);
  return head ? `${head}\n\n${system}` : system;
}

/** job.run's check: refuses a bad ref now (before the job exists). */
export async function checkSystemRefs(kitDir: string, refs: readonly string[] | undefined): Promise<void> {
  await expandSystemRefs(kitDir, refs);
}
