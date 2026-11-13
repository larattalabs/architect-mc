#!/usr/bin/env node
// (7c CM-a) node kit/tools/composite.mjs <id|file.mjs> [--out <dir>] [--views iso,top,front,...] [--no-render] [--json]
// Builds a composite design (kit/designs/composite/<id>.mjs, or a file whose default export returns a Composite), checks it (the
// findings and every checker rule on the union grid), writes the union entry, the module entries and the manifest into --out
// (default: <cwd>/<id>) and renders the union's views (lib/composite.mjs).
// Exit 0 = clean, 1 = check errors or a failure, 2 = bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Composite } from '../lib/composite.mjs';
import { renderStructure, parseViews } from '../render.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPOSITE_DESIGNS = path.join(KIT, 'designs', 'composite');
const USAGE = 'usage: node kit/tools/composite.mjs <id|file.mjs> [--out <dir>] [--views iso,top,front,...] [--no-render] [--json]';

/** Build a composite design by id (kit/designs/composite) or path; `opts` are passed to its default export. */
export async function loadComposite(idOrFile, opts = {}) {
  const file = idOrFile.endsWith('.mjs') ? path.resolve(idOrFile) : path.join(COMPOSITE_DESIGNS, `${idOrFile}.mjs`);
  if (!fs.existsSync(file)) throw new Error(`no composite design '${idOrFile}' (${file})`);
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.default !== 'function') throw new Error(`${file}: no default export function`);
  const c = await mod.default(opts);
  if (!(c instanceof Composite)) throw new Error(`${file}: the default export must return a Composite`);
  if (mod.id !== undefined && mod.id !== c.id) throw new Error(`${file}: exports id '${mod.id}' but builds '${c.id}'`);
  return c;
}

function parseArgs(argv) {
  const o = { _: [], render: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--out') o.out = path.resolve(val());
    else if (a === '--views') o.views = parseViews(val());
    else if (a === '--no-render') o.render = false;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o._.push(a);
  }
  if (o._.length !== 1) throw new Error('one composite design');
  return o;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
  try {
    const c = await loadComposite(o._[0]);
    const r = c.check();
    const out = o.out ?? path.resolve(c.id);
    const files = c.write(out);
    const renders = o.render ? renderStructure(files[`${c.id}.nbt`], { out, views: o.views }).files : {};
    const s = c.size();
    if (o.json) console.log(JSON.stringify({ id: c.id, size: s, modules: c.modules.length, ok: r.ok, errors: r.errors, warnings: r.warnings, files: Object.keys(files), renders: Object.keys(renders) }));
    else {
      console.log(`${c.id}: ${s.x}x${s.y}x${s.z}, ${c.modules.length} modules, ${c.joins.length} joins: ${r.ok ? 'ok' : `${r.errors.length} error(s)`}, ${r.warnings.length} warning(s)`);
      for (const e of r.errors) console.log(`  error: ${e}`);
      for (const w of r.warnings) console.log(`  warning: ${w}`);
      console.log(`  wrote ${Object.keys(files).length} files and ${Object.keys(renders).length} renders to ${path.relative(process.cwd(), out) || '.'}`);
    }
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`${o._[0]}: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
