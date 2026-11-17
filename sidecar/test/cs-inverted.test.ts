// (7c CS, US's leftover) DesignRequest.inverted: a rule.suspended lot's design job is told the lot hangs inverted. The request member
// (only `true`, absent otherwise, so every other request's bytes and opKey body are unchanged), the refusals (a suspend site, never a
// massing; a group item too), the brief's "Inverted lot" section (only with a site and the flag), the feature, and the entry reader
// a versionOf keeps it by.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { designBrief, invertedSection } from '../src/claude/brief.js';
import { designKeyBody } from '../src/opkeys.js';
import { DesignRequest, FEATURES, GroupRequest, invertedProblem, isInvertedEntry, siteSize, type SiteSpec } from '../src/protocol.js';

const KIT = path.resolve(__dirname, '..', '..', 'kit');
const spec = (name: string) => (JSON.parse(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'site', name, 'site.json'), 'utf8')) as { spec: SiteSpec }).spec;
const OVERHANG = spec('overhang');
const CLIFF = spec('cliff_face');
const req = (over: Record<string, unknown> = {}) => ({ type: 'cabin', style: 'rustic', features: [], maxSize: { x: 20, y: 24, z: 20 }, name: 'Hanging House', ...over });

describe('DesignRequest.inverted (7c CS)', () => {
  it('the schema takes exactly true; the feature is advertised after design.fillProvided', () => {
    expect(OVERHANG.fit).toBe('suspend');
    expect(DesignRequest.safeParse(req({ site: OVERHANG, inverted: true })).success).toBe(true);
    expect(DesignRequest.safeParse(req({ site: OVERHANG, inverted: false })).success).toBe(false);
    expect(DesignRequest.parse(req({ site: OVERHANG })).inverted).toBeUndefined();
    expect(FEATURES.indexOf('design.inverted')).toBe(FEATURES.indexOf('design.fillProvided') + 1); // (batch 8a) later features follow it
    const item = { ...req(), itemKey: 'a', site: OVERHANG, inverted: true };
    expect(GroupRequest.parse({ name: 'g', bible: 'rustic', items: [item] }).items[0]!.inverted).toBe(true);
  });

  it('invertedProblem: a suspend site, never a massing; a versionOf names its own rule', () => {
    expect(invertedProblem(DesignRequest.parse(req({ site: OVERHANG, inverted: true })))).toBeUndefined();
    expect(invertedProblem(DesignRequest.parse(req({ site: CLIFF })))).toBeUndefined();
    expect(invertedProblem({ inverted: true })).toMatch(/needs a suspend site .*has no site/);
    expect(invertedProblem({ inverted: true, site: CLIFF })).toMatch(/fit is attach_to_cliff/);
    expect(invertedProblem({ inverted: true, site: OVERHANG, massing: true })).toMatch(/not a massing/);
    expect(invertedProblem({ inverted: true, versionOf: { entryId: 'x' } })).toMatch(/versionOf needs a site-bound entry/);
  });

  it('isInvertedEntry: the kit\'s inverted mark or the recorded request\'s', () => {
    expect(isInvertedEntry({ inverted: true })).toBe(true);
    expect(isInvertedEntry({ request: { inverted: true } })).toBe(true);
    expect(isInvertedEntry({ request: {} })).toBe(false);
    expect(isInvertedEntry(undefined)).toBe(false);
  });

  it('the opKey body of a request without the flag is unchanged; with it, it differs', () => {
    const a = designKeyBody(req({ site: OVERHANG }) as Record<string, unknown>);
    expect(designKeyBody(DesignRequest.parse(req({ site: OVERHANG })) as Record<string, unknown>)).toEqual(designKeyBody(req({ site: OVERHANG, features: [] }) as Record<string, unknown>));
    expect(designKeyBody(req({ site: OVERHANG, inverted: true }) as Record<string, unknown>)).not.toEqual(a);
  });

  it('the brief: an "Inverted lot" section only with a site and the flag (build standing, bp.invert(), furniture after, the example)', () => {
    const site = { section: ['## Site (binding: you build INTO this land)', '', '- the words', ''], size: siteSize(OVERHANG) };
    const opts = { renderer: true, examples: ['cabin'], playbook: true, site };
    const inv = designBrief(DesignRequest.parse(req({ site: OVERHANG, inverted: true })), 'gen_x', opts);
    const plain = designBrief(DesignRequest.parse(req({ site: OVERHANG })), 'gen_x', opts);
    const noSite = designBrief(DesignRequest.parse(req({ inverted: true })), 'gen_x', { renderer: true, examples: ['cabin'], playbook: true });
    expect(inv).toMatch(/## Inverted lot/);
    expect(inv).toMatch(/bp\.invert\(\)/);
    expect(inv).toMatch(/kit\/designs\/site\/fit_suspend_inverted\.mjs/);
    expect(plain).not.toMatch(/Inverted lot/);
    expect(noSite).not.toMatch(/Inverted lot/);
    const added = inv.split('\n').filter((l) => !plain.split('\n').includes(l));
    expect(added).toEqual(invertedSection().filter((l) => l !== ''));
    // the example the section names exists in the kit
    expect(fs.existsSync(path.join(KIT, 'designs', 'site', 'fit_suspend_inverted.mjs'))).toBe(true);
  });
});
