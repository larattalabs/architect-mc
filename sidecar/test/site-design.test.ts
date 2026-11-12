// (7b DS) The designer's site inputs, on the sim designer and the real kit ($0): DesignRequest.site (schema, refusals, the kept
// volume), the scratch's site/ (ARVX, site.json, the four empty-site renders), BRIEF.md's Site section diffed against a plain brief,
// the composite check, the installed entry's binding and site files; Designs.siteVariant (site.variant): a site variant installed as a
// SITE derivation, refusals SITE_UNFIT (the rule id), SITE_UNSUPPORTED, no_entry, the opKey replayed and conflicting; the estimate
// kinds `site` and `adapted`; the policy lets the brief's commands run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DesignRequest, FEATURES, GroupRequest, parseClientMessage, siteSize, SiteSpec, type Outbound } from '../src/protocol.js';
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
    expect(DesignRequest.safeParse(req({ site: CLIFF.spec, critique: { mode: 'polish' } })).success).toBe(false);
    const item = (over: Record<string, unknown>) => ({ type: 'cabin', style: 'rustic', features: [], maxSize: { x: 20, y: 24, z: 20 }, ...over });
    expect(GroupRequest.safeParse({ name: 'g', bible: 'rustic', items: [item({ itemKey: 'a', site: CLIFF.spec }), item({ itemKey: 'b', copyOf: 'a' })] }).success).toBe(false);
    expect(GroupRequest.safeParse({ name: 'g', bible: 'rustic', items: [item({ itemKey: 'a', site: CLIFF.spec, count: 2 })] }).success).toBe(false);
    expect(GroupRequest.safeParse({ name: 'g', bible: 'rustic', items: [item({ itemKey: 'a', site: CLIFF.spec }), item({ itemKey: 'b' })] }).success).toBe(true);
    // (change 2) a variant lot's item names its archetype item: validated, passed through
    const arch = (v: unknown) => GroupRequest.safeParse({ name: 'g', bible: 'rustic', items: [item({ itemKey: 'a', site: CLIFF.spec }), item({ itemKey: 'b', site: EAST.spec, ext: { 'architect_mc:site': v } })] });
    expect(arch({ archetype: 'a' }).success).toBe(true);
    expect((arch({ archetype: 'a' }) as { data: GroupRequest }).data.items[1]!.ext).toEqual({ 'architect_mc:site': { archetype: 'a' } });
    expect(arch({ archetype: 'zz' }).success).toBe(false);
    expect(arch({ archetype: 'b' }).success).toBe(false);
    expect(arch('a').success).toBe(false);
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

  it("refuses a blob that is not the spec's volume (the kept volume is content-addressed)", async () => {
    const wrong = put(h, RIFT.bytes);
    const a = await call(h, { type: 'design.request', request: req({ site: { ...CLIFF.spec, volumeBlobId: wrong } }) });
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/is not the site's frozen volume/);
    expect(fs.existsSync(path.join(h.cfg.dataDir, 'sites', `${CLIFF.spec.volumeSha}.arvx`))).toBe(false);
  });

  // (7b SL, Steward's DS answers 2026-11-12) a massingFirst group takes site-aware items: they wait for the group's massing step, then
  // design in one pass (no massing of their own) in the same group; count and copyOf stay refused for them
  it('a massingFirst group with a site item: the site item waits for the massing step, then designs in one pass in the same group', async () => {
    const blob = put(h, CLIFF.bytes);
    const plain = { type: 'cabin', style: 'rustic', features: [], maxSize: { x: 20, y: 24, z: 20 }, itemKey: 'hall' };
    const sited = { type: 'cabin', style: 'rustic', features: [], maxSize: { x: 20, y: 24, z: 20 }, itemKey: 'cliff', site: { ...CLIFF.spec, volumeBlobId: blob } };
    const a = await call(h, { type: 'design.group', group: { name: 'mf', bible: 'rustic', massingFirst: true, items: [plain, sited] } });
    expect(a.error).toBeUndefined();
    const gid = a.result!.groupId as string;
    const g0 = h.sc.groups.get(gid)!;
    const site0 = g0.items.find((x) => x.itemKey === 'cliff')!;
    expect(site0.designId).toBe('');
    expect(site0.step).toMatch(/waiting for the group's massing step/);
    expect(g0.items.find((x) => x.itemKey === 'hall')!.stage).toBe('massing');
    await until(() => h.sc.groups.get(gid)!.status === 'awaiting_approval', 300_000);
    const g1 = h.sc.groups.get(gid)!;
    expect(g1.awaiting).toEqual(['hall']);
    expect(g1.items.find((x) => x.itemKey === 'cliff')!.designId, 'still waiting while a massing awaits approval').toBe('');
    const ap = await call(h, { type: 'group.approve', groupId: gid, approve: ['hall'] });
    expect(ap.error).toBeUndefined();
    await until(() => ['done', 'failed'].includes(h.sc.groups.get(gid)!.status), 300_000);
    const g2 = h.sc.groups.get(gid)!;
    expect(g2.status, JSON.stringify(g2.items.map((x) => [x.itemKey, x.status, x.step]))).toBe('done');
    const site2 = g2.items.find((x) => x.itemKey === 'cliff')!;
    expect(site2.designIds).toHaveLength(1);
    const d = h.sc.designs.get(site2.designId)!;
    expect(d.request.site?.volumeSha).toBe(CLIFF.spec.volumeSha);
    expect(d.request.massing ?? false, 'no massing of its own').toBe(false);
    expect(d.request.fromMassing).toBeUndefined();
    expect(d.request.group).toBe(gid);
    expect(g2.done).toBe(2);
  });

  it('a massingFirst group whose massing fails still designs its site item (a failed massing holds nothing)', async () => {
    const blob = put(h, CLIFF.bytes);
    const tiny = { type: 'house', style: 'rustic', features: [], maxSize: { x: 11, y: 10, z: 11 }, itemKey: 'tiny' };
    const sited = { type: 'cabin', style: 'rustic', features: [], maxSize: { x: 20, y: 24, z: 20 }, itemKey: 'cliff', site: { ...CLIFF.spec, volumeBlobId: blob } };
    const a = await call(h, { type: 'design.group', group: { name: 'mf5', bible: 'rustic', massingFirst: true, items: [tiny, sited] } });
    expect(a.error).toBeUndefined();
    const gid = a.result!.groupId as string;
    await until(() => ['done', 'failed'].includes(h.sc.groups.get(gid)!.status), 300_000);
    const g = h.sc.groups.get(gid)!;
    expect(g.items.find((x) => x.itemKey === 'tiny')!.status, 'the sim massing refuses the 11x10x11 cap').toBe('failed');
    expect(g.items.find((x) => x.itemKey === 'cliff')!.status).toBe('done');
    expect(g.status).toBe('done');
  });

  it('a massingFirst group of site items only starts them at once; count and copyOf stay refused for site items', async () => {
    const blob = put(h, CLIFF.bytes);
    const sited = { type: 'cabin', style: 'rustic', features: [], maxSize: { x: 20, y: 24, z: 20 }, itemKey: 'cliff', site: { ...CLIFF.spec, volumeBlobId: blob } };
    const a = await call(h, { type: 'design.group', group: { name: 'mf2', bible: 'rustic', massingFirst: true, items: [sited] } });
    expect(a.error).toBeUndefined();
    const g = h.sc.groups.get(a.result!.groupId as string)!;
    expect(g.items[0]!.designId).not.toBe('');
    const n = await call(h, { type: 'design.group', group: { name: 'mf3', bible: 'rustic', massingFirst: true, items: [{ ...sited, count: 2 }] } });
    expect(n.ok).toBe(false);
    const c = await call(h, { type: 'design.group', group: { name: 'mf4', bible: 'rustic', massingFirst: true, items: [sited, { type: 'cabin', style: 'rustic', features: [], maxSize: { x: 20, y: 24, z: 20 }, itemKey: 'b', copyOf: 'cliff' }] } });
    expect(c.ok).toBe(false);
    await until(() => ['done', 'failed'].includes(h.sc.groups.get(g.id)!.status), 300_000);
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

  it("a palette variant of a site-bound entry re-runs on the entry's own site (its files and binding kept)", async () => {
    const v = h.sc.requestVariant(entryId, 'cherry');
    await until(() => ['done', 'failed'].includes(h.sc.variants.get(v.id)!.status), 300_000);
    const done = h.sc.variants.get(v.id)!;
    expect(done.status, done.error).toBe('done');
    const id = done.blueprintId!;
    const j = JSON.parse(fs.readFileSync(path.join(h.cfg.libraryDir, id, `${id}.blueprint.json`), 'utf8')) as Record<string, any>;
    expect(j.site.volumeSha).toBe(CLIFF.spec.volumeSha);
    expect(j.ext['architect_mc:site'].volumeSha).toBe(CLIFF.spec.volumeSha);
    expect(fs.existsSync(path.join(h.cfg.libraryDir, id, 'site', 'site.arvx'))).toBe(true);
  });

  it('a SITE entry follows its source: the new version re-run on its own site; a paid adaptation (versionOf + site) rebinds the entry (sim)', async () => {
    // the source's next version: a paid adaptation of the archetype to cliff_east would rebind it, so the source's v2 here is a
    // versionOf on its own site (the sim keeps the program: a site stand-in re-run)
    const a = await call(h, { type: 'design.request', request: req({ notes: 'add a lantern', versionOf: { entryId } }) });
    expect(a.error).toBeUndefined();
    const did = a.result!.designId as string;
    await until(() => ['done', 'failed'].includes(h.sc.designs.get(did)!.status), 300_000);
    expect(h.sc.designs.get(did)!.status, h.sc.designs.get(did)!.step).toBe('done');
    expect(h.sc.designs.get(did)!.request.site?.volumeSha).toBe(CLIFF.spec.volumeSha); // inherited from the entry's own site
    expect(h.sc.versions.head(entryId)).toBe(2);
    const follower = h.sc.follows.followers(entryId).find((f) => f.kind === 'site')!;
    expect(follower).toMatchObject({ kind: 'site', sourceVersion: 1, behind: true });
    const op = h.sc.follows.follow(follower.entryId, 0);
    await until(() => h.sc.follows.get(op.id)?.status === 'done', 300_000);
    const r = h.sc.follows.get(op.id)!.members[0]!.result!;
    expect(r, r.message).toMatchObject({ followed: true, newVersion: 2, sourceVersion: 2 });
    const top = h.sc.versions.top(follower.entryId)! as Record<string, any>;
    expect(top.derivation).toMatchObject({ kind: 'site', sourceVersion: 2 });
    expect(top.ext['architect_mc:site'].volumeSha).toBe(EAST.spec.volumeSha);
    expect(top.size).toEqual({ x: 18, y: 24, z: 12 });
  });

  it('a paid adaptation (versionOf + site) of a plain entry: the scratch gets site/, checked on the composite, the version bound (sim)', async () => {
    const p0 = await call(h, { type: 'design.request', request: req({ name: 'Plain Cabin', maxSize: { x: 40, y: 20, z: 40 } }) });
    const pid = p0.result!.designId as string;
    await until(() => ['done', 'failed'].includes(h.sc.designs.get(pid)!.status), 300_000);
    const plain = h.sc.designs.get(pid)!.blueprintId!;
    const a = await call(h, { type: 'design.request', request: req({ notes: 'adapt it to the cliff', versionOf: { entryId: plain }, site: { ...EAST.spec, volumeBlobId: put(h, EAST.bytes) } }) });
    expect(a.error).toBeUndefined();
    const did = a.result!.designId as string;
    await until(() => ['done', 'failed'].includes(h.sc.designs.get(did)!.status), 300_000);
    expect(h.sc.designs.get(did)!.status, h.sc.designs.get(did)!.step).toBe('done');
    const scratch = scratchDirFor(h.cfg.dataDir, did);
    expect(fs.readFileSync(path.join(scratch, 'BRIEF.md'), 'utf8')).toMatch(/## Site \(binding/);
    const top = h.sc.versions.top(plain)! as Record<string, any>;
    expect(h.sc.versions.head(plain)).toBe(2);
    expect(top.ext['architect_mc:site'].volumeSha).toBe(EAST.spec.volumeSha);
    expect(top.size).toEqual({ x: 18, y: 24, z: 12 });
  });

  it("estimates: a site-aware design is the 'site' kind (1.3-2x the design seed), a paid adaptation 'adapted', a group's site items their own line", () => {
    const ctx = (h.sc as unknown as { estimateCtx(): Parameters<typeof h.sc.estimates.design>[1] }).estimateCtx();
    const plain = h.sc.estimates.design(DesignRequest.parse(req({ model: 'claude-opus-5-5' })), ctx);
    const site = h.sc.estimates.design(DesignRequest.parse(req({ model: 'claude-opus-5-5', site: CLIFF.spec })), ctx);
    expect(site.basis).toMatch(/site-aware design: 1\.3-2x/);
    expect(site.usdLow).toBeCloseTo(2.5 * 1.3, 2);
    expect(site.usdHigh).toBeCloseTo(4.6 * 2, 2);
    expect(plain.basis).not.toMatch(/site-aware/);
    const adapted = h.sc.estimates.design(DesignRequest.parse(req({ site: CLIFF.spec, versionOf: { entryId: 'x' } })), ctx);
    expect(adapted).toMatchObject({ usdLow: 0.3, usdHigh: 0.9 });
    expect(adapted.basis).toMatch(/paid adaptation/);
    const mix = h.sc.estimates.mix({ group: { items: [req({ itemKey: 'a' }), req({ itemKey: 'b', site: CLIFF.spec })] } as never, originals: 0, adapted: 2, copies: 0, newBible: false, massingFirst: false, reportCritique: false, site: 1 }, ctx);
    expect(mix.byKind.site).toMatchObject({ count: 2 });
    expect(mix.byKind.original).toMatchObject({ count: 1 });
    expect(mix.byKind.adapted).toMatchObject({ count: 2, usdLow: 0.6, usdHigh: 1.8 });
    // the group estimate (Java's estimate(GroupRequest)): a site item at the site figure
    const g = h.sc.estimates.group({ items: [req({ itemKey: 'b', model: 'claude-opus-5-5', site: CLIFF.spec })], concurrency: 1 } as never, ctx);
    expect(g.basis).toMatch(/site-aware design: 1\.3-2x/);
    expect(g.usdLow).toBeCloseTo(2.5 * 1.3, 2);
    h.sc.estimates.record('adapted', 'claude-sonnet-5-5', 0.5, 120_000);
    expect(h.sc.estimates.perJob('adapted', 'claude-sonnet-5-5').basis).toMatch(/adaptation claude-sonnet-5-5: 1 measured/);
  });

  it('refuses polish of a site-bound entry (VERSION_REFUSED site_bound): it is changed by versionOf on its site', async () => {
    const a = await call(h, { type: 'design.polish', entryId });
    expect(a).toMatchObject({ ok: false, code: 'VERSION_REFUSED', detail: 'site_bound' });
  });

  it('the kit and the sidecar agree on the site rule ids', async () => {
    const { SITE_RULE_IDS: kitIds } = (await import(path.join(KIT, 'lib', 'siteCheck.mjs'))) as { SITE_RULE_IDS: string[] };
    expect([...SITE_RULE_IDS]).toEqual(kitIds);
  });
});
