// (7b SV) One of the six 7bF site fixtures (kit/test/fixtures/site/<id>/{volume.bin, site.json}) as a Site (lib/site.mjs): the example
// sites of the fit examples (kit/tools/examples.mjs) and the tests. Kept out of lib/site.mjs so the build's module closure does not
// reach the fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Site } from './site.mjs';

/** The fixtures' directory. */
export const SITE_FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'site');

/** The fixture `id` (cliff_face, tunnel_hill, rift_site, grove, overhang, trunk) as a Site. */
export function siteFixture(id) {
  if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`siteFixture: bad id ${JSON.stringify(id)}`);
  const dir = path.join(SITE_FIXTURES, id);
  if (!fs.existsSync(path.join(dir, 'site.json'))) throw new Error(`siteFixture: no site fixture '${id}' (${dir})`);
  return Site.fromFiles(path.join(dir, 'volume.bin'), path.join(dir, 'site.json'));
}
