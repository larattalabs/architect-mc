#!/usr/bin/env node
// (7c CO) The planning images CLI (kit/lib/region/planImages.mjs): a top hillshade with the affordances' numbers, two sections and an iso
// of an ARSV columns survey. The helper runs it for the composer (Regions.compose) and for a plan check asked for them
// (PlanRequest ext architect_mc:planImages).
//   node kit/tools/planimages.mjs <survey.bin> --out <dir> [--affordances <file.json>]
// `--affordances`: a JSON array of AF affordances, or an object with an `affordances` array (tools/affordances.mjs's output). The PNGs are
// written as <dir>/<name>.png (top, section-1, section-2, iso). The last stdout line is one JSON object: {ok: true, images: [{name, file,
// pixelSha, width, height, bytes}], labels: [{n, id, kind, box}]} or {ok: false, error}. Exit 0 ok, 1 failure, 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { renderPlanImages } from '../lib/region/planImages.mjs';

function usage(msg) {
  console.error(`${msg}\nusage: node kit/tools/planimages.mjs <survey.bin> --out <dir> [--affordances <file.json>]`);
  return 2;
}

function main(argv) {
  const pos = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!['out', 'affordances'].includes(k)) return usage(`unknown option --${k}`);
      if (i + 1 >= argv.length) return usage(`--${k} needs a value`);
      opts[k] = argv[++i];
    } else pos.push(a);
  }
  if (pos.length !== 1) return usage('one survey file');
  if (!opts.out) return usage('--out is required');
  try {
    const survey = fs.readFileSync(pos[0]);
    let affordances = [];
    if (opts.affordances) {
      const j = JSON.parse(fs.readFileSync(opts.affordances, 'utf8'));
      affordances = Array.isArray(j) ? j : Array.isArray(j?.affordances) ? j.affordances : [];
    }
    const r = renderPlanImages({ survey, affordances });
    fs.mkdirSync(opts.out, { recursive: true });
    const images = r.images.map((im) => {
      const file = path.join(opts.out, `${im.name}.png`);
      fs.writeFileSync(file, im.png);
      return { name: im.name, file, pixelSha: im.pixelSha, width: im.width, height: im.height, bytes: im.png.length };
    });
    console.log(JSON.stringify({ ok: true, images, labels: r.labels }));
    return 0;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
