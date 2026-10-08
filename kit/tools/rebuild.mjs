#!/usr/bin/env node
// node kit/tools/rebuild.mjs <dir>... [--bible <dir>] [--out <dir>] [--json]
//
// Phase 5b: rebuild stored builds from their source with their recorded inputs (lib/rebuild.mjs) and byte-compare the
// .nbt. Each <dir> holds <id>.mjs, <id>.nbt and <id>.blueprint.json (a library entry, a kit example, a design round).
// --bible <dir>: the bible files (bible.json, components.mjs) for builds that record a bible pin. --out <dir>: keep the
// rebuilt files in <out>/<n>/ (n = the position of the dir). Prints one line per dir (or one JSON line with --json:
// { ok, results: [{ dir, id, same, stored, rebuilt, error? }] }). Exit 0 = all identical, 1 = a drift, 2 = bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRebuild } from '../lib/rebuild.mjs';

function main() {
  const argv = process.argv.slice(2);
  const o = { dirs: [] };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const val = () => {
        if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
        return argv[++i];
      };
      if (a === '--bible') o.bible = path.resolve(val());
      else if (a === '--out') o.out = path.resolve(val());
      else if (a === '--json') o.json = true;
      else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
      else o.dirs.push(path.resolve(a));
    }
    if (!o.dirs.length) throw new Error('no dir');
  } catch (e) {
    console.error(`${e.message}\nusage: node kit/tools/rebuild.mjs <dir>... [--bible <dir>] [--out <dir>] [--json]`);
    process.exitCode = 2;
    return;
  }
  const results = o.dirs.map((d, n) => {
    const keep = o.out ? path.join(o.out, String(n)) : undefined;
    if (keep) fs.mkdirSync(keep, { recursive: true });
    return verifyRebuild(d, { bibleFor: () => o.bible, keep });
  });
  const ok = results.every((r) => r.same);
  if (o.json) console.log(JSON.stringify({ ok, results }));
  else for (const r of results) console.log(`${r.same ? 'same   ' : 'DIFFERS'} ${r.id ?? '?'} (${r.dir})${r.error ? `: ${r.error}` : ''}`);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
