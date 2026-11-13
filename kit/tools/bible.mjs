#!/usr/bin/env node
// node kit/tools/bible.mjs validate <bible.json> [--scope building|settlement] [--write <out.json>]
//   Validates a style bible (lib/bible.mjs validateBible): roles are vanilla blocks and build a palette, a settlement bible
//   names the macro roles, the rest of the schema is typed. Prints one JSON line { ok, errors[], bible } (bible: the
//   normalised copy: `minecraft:` prefixes, default proportions, the minimum component list); --write also writes it.
// node kit/tools/bible.mjs builtin [<name>]
//   Prints the built-in bibles (the palette presets as roles, no prose) as one JSON line: { bibles: [...] }, or one bible.
// node kit/tools/bible.mjs palette <json>
//   (Style unification U1) Checks a palette spec as a design request sends it (a preset, inputs, or a Style's roles inline
//   { bible: { id, version, roles } }): it builds a palette, and inline roles also pass the bible checks (the test house).
//   Prints { ok, errors[] }.
// node kit/tools/bible.mjs roles
//   Prints { core, macro, fields }: the role names and which palette fields each role sets.
// node kit/tools/bible.mjs related <zone.json> <settlement.json>
//   (7c SF) A zone Style checked against the settlement Style it relates to (lib/style3.mjs relatedErrors: the target is a settlement
//   Style, a format 1 or 2 Style reading as one; the zone shares its core roles). Prints { ok, errors[], shared } (shared: the target's
//   core roles, which a bible job copies into the zone Style). `--fill`: check the zone with the shared roles put in first.
// Exit code 0 = valid / printed, 1 = invalid, 2 = bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_BIBLES, builtinBible, builtinComponentsFile, validateBible } from '../lib/bible.mjs';
import { CORE_ROLES, MACRO_ROLES, ROLE_FIELDS, resolvePalette } from '../lib/kit.mjs';
import { relatedErrors, sharedCoreRoles } from '../lib/style3.mjs';

const USAGE = 'usage: node kit/tools/bible.mjs validate <bible.json> [--scope building|settlement] [--write <out.json>] | builtin [<name>] | palette <json> | roles | related <zone.json> <settlement.json> [--fill]';

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
    } else if (cmd === 'palette') {
      let spec;
      try {
        spec = JSON.parse(rest[0] ?? '');
      } catch {
        spec = rest[0];
      }
      const errors = [];
      try {
        resolvePalette(spec);
      } catch (e) {
        errors.push(e.message);
      }
      if (!errors.length && spec && typeof spec === 'object' && spec.bible && typeof spec.bible === 'object') {
        const v = validateBible({ id: spec.bible.id, name: 'Style', version: spec.bible.version, roles: spec.bible.roles });
        errors.push(...v.errors);
      }
      out({ ok: errors.length === 0, errors });
      process.exitCode = errors.length ? 1 : 0;
    } else if (cmd === 'related') {
      const files = rest.filter((a) => a !== '--fill');
      if (files.length !== 2) throw new Error('related needs <zone.json> <settlement.json>');
      const [zone, target] = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
      const shared = sharedCoreRoles(target);
      const z = rest.includes('--fill') ? { ...zone, roles: { ...(zone.roles ?? {}), ...shared } } : zone;
      const errors = relatedErrors(z, target);
      out({ ok: errors.length === 0, errors, shared });
      process.exitCode = errors.length ? 1 : 0;
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
