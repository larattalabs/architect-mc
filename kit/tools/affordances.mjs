#!/usr/bin/env node
// (7b AF) The site analysis CLI (kit/lib/region/affordances.mjs): the affordances of a frozen ARVX volume and, with a lot and a fit,
// the frame proposed for it. The helper's `site.analyse` (api.Survey.site) runs this; gates run it on the mod's frozen volume file.
//   node kit/tools/affordances.mjs <volume.bin> [--lot minX,minY,minZ,maxX,maxY,maxZ --fit <fit>] [--kinds a,b] [--sha <hex>]
// The last stdout line is one JSON object: {ok: true, sha, box, affordances, proposed} or {ok: false, error}. Exit 0 ok, 1 failure,
// 2 usage. `--sha`: refuse a volume whose ARVX bytes hash to anything else.
import fs from 'node:fs';
import { decodeArvx } from '../lib/region/volume.mjs';
import { analyseVolume, proposeFrame, AFFORDANCE_KINDS, FIT_AFFORDANCES } from '../lib/region/affordances.mjs';

function main(argv) {
  const pos = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!['lot', 'fit', 'kinds', 'sha'].includes(k)) return usage(`unknown option --${k}`);
      if (i + 1 >= argv.length) return usage(`--${k} needs a value`);
      opts[k] = argv[++i];
    } else pos.push(a);
  }
  if (pos.length !== 1) return usage('one volume file');
  if (!!opts.lot !== !!opts.fit) return usage('--lot and --fit go together');
  let lot = null;
  if (opts.lot) {
    const n = opts.lot.split(',').map(Number);
    if (n.length !== 6 || !n.every(Number.isInteger)) return usage('--lot is minX,minY,minZ,maxX,maxY,maxZ');
    lot = { minX: n[0], minY: n[1], minZ: n[2], maxX: n[3], maxY: n[4], maxZ: n[5] };
    if (lot.minX > lot.maxX || lot.minY > lot.maxY || lot.minZ > lot.maxZ) return usage('--lot needs min <= max');
  }
  if (opts.fit && !FIT_AFFORDANCES[opts.fit]) return usage(`--fit is one of ${Object.keys(FIT_AFFORDANCES).join(', ')}`);
  const kinds = opts.kinds ? opts.kinds.split(',') : undefined;
  if (kinds && !kinds.every((k) => AFFORDANCE_KINDS.includes(k))) return usage(`--kinds from ${AFFORDANCE_KINDS.join(', ')}`);
  try {
    const v = decodeArvx(fs.readFileSync(pos[0]));
    if (opts.sha && opts.sha !== v.sha) throw new Error(`the volume's ARVX bytes hash to ${v.sha}, not ${opts.sha}`);
    const b = v.box;
    if (lot && (lot.minX < b.minX || lot.minY < b.minY || lot.minZ < b.minZ || lot.maxX > b.maxX || lot.maxY > b.maxY || lot.maxZ > b.maxZ)) throw new Error('the lot is not inside the volume');
    const affordances = analyseVolume(v, kinds ? { kinds } : {});
    const proposed = lot ? proposeFrame(affordances, lot, opts.fit) : null;
    console.log(JSON.stringify({ ok: true, sha: v.sha, box: b, affordances, proposed }));
    return 0;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    return 1;
  }
}

function usage(msg) {
  console.error(`affordances: ${msg}\nusage: node kit/tools/affordances.mjs <volume.bin> [--lot minX,minY,minZ,maxX,maxY,maxZ --fit <fit>] [--kinds a,b] [--sha <hex>]`);
  console.log(JSON.stringify({ ok: false, error: msg }));
  return 2;
}

process.exitCode = main(process.argv.slice(2));
