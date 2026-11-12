#!/usr/bin/env node
// (7b DS) The designer's site inputs for one site (docs/SETTLEMENTS.md §7.3), written by the sidecar into a design's scratch dir:
//   node kit/tools/site-brief.mjs <volume.arvx> <spec.json> --out <dir> [--no-renders] [--width N]
// <spec.json> is a site spec's wire (kit/schemas/site-spec.json) or a fixture's site.json ({lot, spec}). Writes <dir>/site.json
// (the lot, the spec, the fit's row, the ports, the keep hints and the analysis) and, unless --no-renders, the four empty-site
// renders (lib/siteBrief.mjs SITE_RENDERS); prints one JSON line {ok, sha, fit, size, section: [lines], renders: [files]}.
// Exit 0 = written, 1 = the site could not be read or analysed, 2 = bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { Site } from '../lib/site.mjs';
import { siteAnalysis, siteJson, siteSection, renderEmptySite } from '../lib/siteBrief.mjs';

const USAGE = 'usage: node kit/tools/site-brief.mjs <volume.arvx> <spec.json> --out <dir> [--no-renders] [--width N] [--prefix site/]';

function parse(argv) {
  const o = { _: [], renders: true, prefix: 'site/' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--out') o.out = path.resolve(val());
    else if (a === '--no-renders') o.renders = false;
    else if (a === '--width') o.width = Number(val());
    else if (a === '--prefix') o.prefix = val();
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o._.push(a);
  }
  if (o._.length !== 2 || !o.out) throw new Error(USAGE);
  return o;
}

let o;
try {
  o = parse(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
try {
  const spec = JSON.parse(fs.readFileSync(o._[1], 'utf8'));
  const site = new Site(fs.readFileSync(o._[0]), spec);
  const analysis = siteAnalysis(site);
  fs.mkdirSync(o.out, { recursive: true });
  fs.writeFileSync(path.join(o.out, 'site.json'), `${JSON.stringify(siteJson(site, analysis), null, 1)}\n`);
  const renders = o.renders ? renderEmptySite(site, o.out, { width: o.width }).map((f) => `${o.prefix}${f}`) : [];
  const section = siteSection(site, { analysis, renders, arvx: `${o.prefix}site.arvx`, lot: `${o.prefix}site.json` });
  console.log(JSON.stringify({ ok: true, sha: site.sha, fit: site.fit, size: site.size, section, renders }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
}
