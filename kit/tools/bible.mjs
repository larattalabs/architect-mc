#!/usr/bin/env node
// node kit/tools/bible.mjs validate <bible.json> [--scope building|settlement] [--write <out.json>]
//   Validates a style bible (lib/bible.mjs validateBible): roles are vanilla blocks and build a palette, a settlement bible
//   names the macro roles, the rest of the schema is typed. Prints one JSON line { ok, errors[], bible } (bible: the
//   normalised copy: `minecraft:` prefixes, default proportions, the minimum component list); --write also writes it.
// node kit/tools/bible.mjs builtin [<name>]
//   Prints the built-in bibles (the palette presets as roles, no prose) as one JSON line: { bibles: [...] }, or one bible.
// node kit/tools/bible.mjs roles
//   Prints { core, macro, fields }: the role names and which palette fields each role sets.
// Exit code 0 = valid / printed, 1 = invalid, 2 = bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_BIBLES, builtinBible, builtinComponentsFile, validateBible } from '../lib/bible.mjs';
import { CORE_ROLES, MACRO_ROLES, ROLE_FIELDS } from '../lib/kit.mjs';

const USAGE = 'usage: node kit/tools/bible.mjs validate <bible.json> [--scope building|settlement] [--write <out.json>] | builtin [<name>] | roles';

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const out = (o) => console.log(JSON.stringify(o));
  try {
    if (cmd === 'validate') {
      let file;
      let scope;
      let write;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--scope') scope = rest[++i];
        else if (rest[i] === '--write') write = rest[++i];
        else if (!file) file = rest[i];
        else throw new Error(`unexpected ${rest[i]}`);
      }
      if (!file) throw new Error('validate needs a bible.json');
      let j;
      try {
        j = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        out({ ok: false, errors: [`cannot read ${file}: ${e.message}`], bible: null });
        process.exitCode = 1;
        return;
      }
      const r = validateBible(j, scope ? { scope } : {});
      if (r.ok && write) fs.writeFileSync(write, `${JSON.stringify(r.bible, null, 2)}\n`);
      out(r);
      process.exitCode = r.ok ? 0 : 1;
    } else if (cmd === 'builtin') {
      if (rest[0]) out({ ...builtinBible(rest[0]), componentsFile: builtinComponentsFile(rest[0]) });
      else out({ bibles: BUILTIN_BIBLES.map((n) => ({ ...builtinBible(n), componentsFile: builtinComponentsFile(n) })) });
    } else if (cmd === 'roles') {
      out({ core: CORE_ROLES, macro: MACRO_ROLES, fields: ROLE_FIELDS });
    } else throw new Error(cmd ? `unknown command ${cmd}` : 'no command');
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    out({ ok: false, errors: [e.message] });
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
