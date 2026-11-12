// (7b DS) The designer's site inputs, on the sim designer and the real kit ($0): DesignRequest.site (schema, refusals, the kept
// volume), the scratch's site/ (ARVX, site.json, the four empty-site renders), BRIEF.md's Site section diffed against a plain brief,
// the composite check, the installed entry's binding and site files; Designs.siteVariant (site.variant): a site variant installed as a
// SITE derivation, refusals SITE_UNFIT (the rule id), SITE_UNSUPPORTED, no_entry, the opKey replayed and conflicting; the estimate
// kinds `site` and `adapted`; the policy lets the brief's commands run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DesignRequest, FEATURES, parseClientMessage, siteSize, SiteSpec, type Outbound } from '../src/protocol.js';
import { SimDesigner } from '../src/sim.js';
import { designBrief } from '../src/claude/brief.js';
import { scratchDirFor } from '../src/scratch.js';
import { SITE_RULE_IDS } from '../src/sitevariants.js';
import { designKeyBody } from '../src/opkeys.js';
import { classifyToolUse } from '../src/policy.js';
import { makeSidecar, until, type Harness } from './helpers.js';

const KIT = path.resolve(__dirname, '..', '..', 'kit');
const fixture = (dir: string) => {
  const site = JSON.parse(fs.readFileSync(path.join(dir, 'site.json'), 'utf8')) as { spec: SiteSpec };
  return { spec: site.spec, bytes: fs.readFileSync(path.join(dir, 'volume.bin')) };
};
const CLIFF = fixture(path.join(KIT, 'test', 'fixtures', 'site', 'cliff_face'));
const EAST = fixture(path.join(KIT, 'test', 'fixtures', 'ds', 'cliff_east'));
const OWNED = fixture(path.join(KIT, 'test', 'fixtures', 'ds', 'cliff_owned'));
const RIFT = fixture(path.join(KIT, 'test', 'fixtures', 'site', 'rift_site'));

type Ack = { ok: boolean; error?: string; code?: string; detail?: string; result?: Record<string, unknown> };
async function call(h: Harness, msg: Record<string, unknown>): Promise<Ack> {
  const parsed = parseClientMessage(JSON.stringify({ v: 1, id: 'q', ...msg }));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  let ack: Ack | undefined;
  await h.sc.handle(parsed.msg, (m) => {
    if (m.type === 'ack') ack = { ok: m.ok, ...(m.error ? { error: m.error } : {}), ...(m.code ? { code: m.code, detail: m.detail } : {}), ...(m.result ? { result: m.result } : {}) };
  });
  return ack!;
}
const put = (h: Harness, bytes: Buffer) => h.sc.blobs.put({ kind: 'region.volume', chunks: [bytes.toString('base64')] }).blobId;
const req = (over: Record<string, unknown> = {}) => ({ type: 'cabin', style: 'rustic', features: [], maxSize: { x: 20, y: 24, z: 20 }, name: 'Cliff House', ...over });
/** the operation's end, from follow.upsert (the API's operation channel) */
async function opDone(h: Harness, id: string): Promise<Record<string, unknown>> {
  let done: Record<string, unknown> | undefined;
  await until(() => {
    done = (h.events as Array<Outbound & { follow?: Record<string, unknown> }>).filter((e) => e.type === 'follow.upsert' && e.follow?.id === id && e.follow.status === 'done').pop()?.follow;
    return !!done;
  }, 300_000);
  return done!;
}

describe('DesignRequest.site (7b DS): schema', () => {
  it('takes a site spec (7bF bounds), refuses a bad one, a site with a massing, a site item with count', () => {
    expect(FEATURES).toContain('site.design');
    expect(DesignRequest.safeParse(req({ site: CLIFF.spec })).success).toBe(true);
    expect(DesignRequest.safeParse(req({ site: { ...CLIFF.spec, fit: 'hover' } })).success).toBe(false);
    expect(DesignRequest.safeParse(req({ site: { ...CLIFF.spec, frame: { origin: [0, 0, 0], rotation: 'none' } } })).success).toBe(false);
    expect(DesignRequest.safeParse(req({ site: { ...CLIFF.spec, ports: [CLIFF.spec.ports[0], CLIFF.spec.ports[0]] } })).success).toBe(false);
    expect(DesignRequest.safeParse(req({ site: CLIFF.spec, massing: true })).success).toBe(false);
    expect(siteSize(CLIFF.spec)).toEqual({ x: 16, y: 22, z: 12 });
    expect(siteSize({ ...CLIFF.spec, frame: { ...CLIFF.spec.frame, rotation: 'clockwise_90' } })).toEqual({ x: 12, y: 22, z: 16 });
  });

  it("an opKey's body leaves the volume's blob id out (the mod re-uploads it under a new id)", () => {
    const a = designKeyBody(req({ site: CLIFF.spec }) as Record<string, unknown>);
    const b = designKeyBody(req({ site: { ...CLIFF.spec, volumeBlobId: 'b-other' } }) as Record<string, unknown>);
    expect(a).toEqual(b);
  });

  it('the BRIEF with a site differs from a plain one by the Site section, the lot size and the site commands (no tuning against eval briefs)', () => {
    const r = DesignRequest.parse(req({ site: CLIFF.spec }));
    const plain = designBrief({ ...r, site: undefined }, 'gen_x', { renderer: true, examples: ['cabin'], playbook: true });
    const site = designBrief(r, 'gen_x', { renderer: true, examples: ['cabin'], playbook: true, site: { section: ['## Site (binding: you build INTO this land)', '', '- the words', ''], size: siteSize(CLIFF.spec) } });
    expect(plain).not.toMatch(/## Site/);
    expect(site).toMatch(/## Site \(binding/);
    expect(site).toMatch(/size: exactly the lot, x 16, y 22, z 12/);
    expect(site).toMatch(/node kit\/build\.mjs gen_x --max 16,22,12 --type cabin --site site\/site\.arvx --lot site\/site\.json/);
    expect(site).toMatch(/--site site\/site\.arvx --lot site\/site\.json --views iso,top,composite,section/);
    expect(site).toMatch(/No `foundationBlock` fill and no ground `approach`/);
    expect(plain).toMatch(/maximum size .* x <= 20, y <= 24, z <= 20/);
    const added = site.split('\n').filter((l) => !plain.split('\n').includes(l));
    const removed = plain.split('\n').filter((l) => !site.split('\n').includes(l));
    // the diff: the Site section, the size line, groundY, the reading line, the build and render commands; nothing else moved
    expect(removed.length).toBeLessThanOrEqual(4);
    expect(added.length).toBeLessThanOrEqual(10);
  });

  it("the policy lets the brief's site commands run (build, render, slices, reading site/)", () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-policy-')));
    const ctx = { role: 'worker' as const, cwd };
    for (const command of [
      'node kit/build.mjs gen_x --max 16,22,12 --type cabin --site site/site.arvx --lot site/site.json --json',
      'node kit/render.mjs kit/out/gen_x.nbt --out previews --site site/site.arvx --lot site/site.json --views iso,top,composite,section',
      'node kit/tools/slices.mjs kit/out/gen_x.nbt --site site/site.arvx --lot site/site.json --y 8-12',
    ]) {
      expect(classifyToolUse('Bash', { command }, ctx).action, command).toBe('allow');
    }
    expect(classifyToolUse('Read', { file_path: path.join(cwd, 'site', 'site.json') }, ctx).action).toBe('allow');
    expect(classifyToolUse('Read', { file_path: path.join(cwd, 'site', 'site-iso.png') }, ctx).action).toBe('allow');
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('site-aware design and site variants on the sim (7b DS)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim', '--kit', KIT]);
    await h.sc.start(new SimDesigner(h.sc, 10));
  });
  afterAll(async () => {
    await h.close();
  });

  it('refuses a site whose volume blob is missing (nothing designed)', async () => {
    const a = await call(h, { type: 'design.request', request: req({ site: { ...CLIFF.spec, volumeBlobId: 'bnothere' } }) });
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/no blob "bnothere"/);
    expect(h.sc.designs.list().length).toBe(0);
  });

  let entryId = '';
  it('designs into the cliff (the sim stand-in): site/, the Site section, checked on the composite, bound and installed', async () => {
    const blob = put(h, CLIFF.bytes);
    const a = await call(h, { type: 'design.request', request: req({ site: { ...CLIFF.spec, volumeBlobId: blob }, ext: { 'steward:lot': 'l1' } }) });
    expect(a.error).toBeUndefined();
    const id = a.result!.designId as string;
    await until(() => ['done', 'failed'].includes(h.sc.designs.get(id)!.status), 300_000);
    const d = h.sc.designs.get(id)!;
    expect(d.status, d.step).toBe('done');
    entryId = d.blueprintId!;
    // the volume kept by sha, the scratch's site/
    expect(fs.existsSync(path.join(h.cfg.dataDir, 'sites', `${CLIFF.spec.volumeSha}.arvx`))).toBe(true);
    const scratch = scratchDirFor(h.cfg.dataDir, id);
    for (const f of ['site.arvx', 'spec.json', 'site.json', 'site-iso.png', 'site-section.png', 'site-top.png', 'site-composite.png']) expect(fs.existsSync(path.join(scratch, 'site', f)), f).toBe(true);
    const brief = fs.readFileSync(path.join(scratch, 'BRIEF.md'), 'utf8');
    expect(brief).toMatch(/## Site \(binding/);
    expect(brief).toMatch(/a cliff face facing south \(\+z, your front\), 22 tall/);
    expect(brief).toMatch(/`walk_top` \(architect:walk\) at 7, 19, 1, facing north/);
    expect(brief).toMatch(/Fit: `attach_to_cliff`/);
    const siteJson = JSON.parse(fs.readFileSync(path.join(scratch, 'site', 'site.json'), 'utf8')) as { fit: string; affordances: unknown[]; proposed: { frame: unknown } };
    expect(siteJson.fit).toBe('attach_to_cliff');
    expect(siteJson.affordances.length).toBeGreaterThan(0);
    expect(siteJson.proposed.frame).toEqual(CLIFF.spec.frame);
    // the entry: the lot's size, the sidecar's site, the binding in ext beside the caller's, the site's files
    const dir = path.join(h.cfg.libraryDir, entryId);
    const j = JSON.parse(fs.readFileSync(path.join(dir, `${entryId}.blueprint.json`), 'utf8')) as Record<string, any>;
    expect(j.size).toEqual({ x: 16, y: 22, z: 12 });
    expect(j.fit).toBe('attach_to_cliff');
    expect(j.site.volumeSha).toBe(CLIFF.spec.volumeSha);
    expect(j.ext['steward:lot']).toBe('l1');
    expect(j.ext['architect_mc:site']).toEqual({ volumeSha: CLIFF.spec.volumeSha, fit: 'attach_to_cliff', lotId: 'lot_cliff_face', volume: CLIFF.spec.volume });
    expect(fs.existsSync(path.join(dir, 'site', 'site.arvx'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'site', 'site.json'))).toBe(true);
  });

  it('the renders are off with config siteRenders false (the A/B arm): the words stay', async () => {
    (h.cfg as { siteRenders: boolean }).siteRenders = false;
    try {
      const blob = put(h, CLIFF.bytes);
      const a = await call(h, { type: 'design.request', request: req({ site: { ...CLIFF.spec, volumeBlobId: blob }, name: 'Cliff House B' }) });
      const id = a.result!.designId as string;
      await until(() => ['done', 'failed'].includes(h.sc.designs.get(id)!.status), 300_000);
      expect(h.sc.designs.get(id)!.status).toBe('done');
      const scratch = scratchDirFor(h.cfg.dataDir, id);
      expect(fs.existsSync(path.join(scratch, 'site', 'site-iso.png'))).toBe(false);
      const brief = fs.readFileSync(path.join(scratch, 'BRIEF.md'), 'utf8');
      expect(brief).toMatch(/## Site/);
      expect(brief).not.toMatch(/empty site, rendered/);
    } finally {
      (h.cfg as { siteRenders: boolean }).siteRenders = true;
    }
  });

  it('a site variant on another cliff installs at $0 as a SITE derivation bound to it; the key replays the operation', async () => {
    const blob = put(h, EAST.bytes);
    const a = await call(h, { type: 'site.variant', entryId, site: { ...EAST.spec, volumeBlobId: blob }, opKey: 'sv-east', owner: 'steward:test' });
    expect(a.error).toBeUndefined();
    const op = a.result!;
    expect(op.kind).toBe('siteVariant');
    const done = op.status === 'done' ? op : await opDone(h, op.id as string);
    expect(done.refused).toBeUndefined();
    const nid = done.newEntryId as string;
    expect(nid).toMatch(new RegExp(`^${entryId}_site_lot_cliff_east`));
    const j = JSON.parse(fs.readFileSync(path.join(h.cfg.libraryDir, nid, `${nid}.blueprint.json`), 'utf8')) as Record<string, any>;
    expect(j.derivation).toMatchObject({ source: entryId, sourceVersion: 1, kind: 'site', recipe: { lotId: 'lot_cliff_east', volumeSha: EAST.spec.volumeSha, fit: 'attach_to_cliff', frame: EAST.spec.frame } });
    expect(j.size).toEqual({ x: 18, y: 24, z: 12 });
    expect(j.ext['architect_mc:site'].volumeSha).toBe(EAST.spec.volumeSha);
    expect(j.ext['steward:lot']).toBe('l1');
    expect(j.request.site.volumeSha).toBe(EAST.spec.volumeSha);
    expect(fs.existsSync(path.join(h.cfg.libraryDir, nid, 'site', 'site.arvx'))).toBe(true);
    // the same key and body (another blob id): the same operation; another body: op_key_conflict
    const again = await call(h, { type: 'site.variant', entryId, site: { ...EAST.spec, volumeBlobId: 'b-reuploaded' }, opKey: 'sv-east', owner: 'steward:test' });
    expect(again.result).toMatchObject({ id: op.id, status: 'done', newEntryId: nid });
    const other = await call(h, { type: 'site.variant', entryId, site: { ...CLIFF.spec }, opKey: 'sv-east', owner: 'steward:test' });
    expect(other.ok).toBe(false);
    expect(other.error).toMatch(/op_key_conflict/);
  });

  it('refuses SITE_UNFIT with the failing rule id (a player pillar: site_keep; another fit: site_bound)', async () => {
    const a = await call(h, { type: 'site.variant', entryId, site: { ...OWNED.spec, volumeBlobId: put(h, OWNED.bytes) }, opKey: 'sv-owned' });
    const done = a.result!.status === 'done' ? a.result! : await opDone(h, a.result!.id as string);
    expect(done.newEntryId).toBeUndefined();
    expect(done.refused).toMatchObject({ code: 'SITE_UNFIT', detail: 'site_keep' });
    expect(SITE_RULE_IDS).toContain((done.refused as { detail: string }).detail);
    const b = await call(h, { type: 'site.variant', entryId, site: { ...RIFT.spec, volumeBlobId: put(h, RIFT.bytes) }, opKey: 'sv-rift' });
    const doneB = b.result!.status === 'done' ? b.result! : await opDone(h, b.result!.id as string);
    expect(doneB.refused).toMatchObject({ code: 'SITE_UNFIT', detail: 'site_bound' });
  });

  it('refuses SITE_UNSUPPORTED for a program that is not site-aware, and no_entry for an unknown entry (before the ack)', async () => {
    const blob = put(h, EAST.bytes);
    const plain = await call(h, { type: 'site.variant', entryId: 'cabin', site: { ...EAST.spec, volumeBlobId: blob }, opKey: 'sv-cabin' });
    expect(plain).toMatchObject({ ok: false, code: 'SITE_UNSUPPORTED', detail: 'not_site_aware' });
    const none = await call(h, { type: 'site.variant', entryId: 'gen_nothing', site: { ...EAST.spec, volumeBlobId: blob }, opKey: 'sv-none' });
    expect(none).toMatchObject({ ok: false, code: 'VERSION_REFUSED', detail: 'no_entry' });
  });

  it('the kit and the sidecar agree on the site rule ids', async () => {
    const { SITE_RULE_IDS: kitIds } = (await import(path.join(KIT, 'lib', 'siteCheck.mjs'))) as { SITE_RULE_IDS: string[] };
    expect([...SITE_RULE_IDS]).toEqual(kitIds);
  });
});
