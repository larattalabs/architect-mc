#!/usr/bin/env node
// node kit/import.mjs <file.nbt> --id <id> --out <dir> [--name <name>] [--max x,y,z] [--json]
//
// Turns a vanilla structure file (a structure-block save) into a library entry (lib/importer.mjs): writes
// <out>/<id>.nbt (gzipped, the first palette, no entities) and <out>/<id>.blueprint.json (type custom, groundY 1,
// front south, entrance at the front centre, spawn 2 out, `imported: true`), then checks the pair with the custom
// profile in import mode (lib/check.mjs). Output and exit codes as build.mjs: warning/error lines and
// `check: OK` / `check: FAILED`, or with --json one line { ok, errors[], warnings[], nbt, sidecar }; 0 = OK,
// 1 = the check failed (e.g. non-vanilla blocks, listed), 2 = bad usage or not a structure file.
// --max defaults to 96,64,96 (the largest design a request can ask for).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFiles, parseMax } from './lib/check.mjs';
import { prepareImport } from './lib/importer.mjs';
import { encodeGzip, parse } from './lib/nbt.mjs';
import { report } from './check.mjs';

const USAGE = 'usage: node kit/import.mjs <file.nbt> --id <id> --out <dir> [--name <name>] [--max x,y,z] [--json]';
export const IMPORT_MAX = { x: 96, y: 64, z: 96 };
/** a structure file bigger than this is refused before parsing */
const MAX_BYTES = 32 * 1024 * 1024;

function parseArgs(argv) {
  const o = { files: [], max: IMPORT_MAX };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--id') o.id = val();
    else if (a === '--out') o.out = path.resolve(val());
    else if (a === '--name') o.name = val();
    else if (a === '--max') o.max = parseMax(val());
    else if (a === '--json') o.json = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.files.push(path.resolve(a));
  }
  if (o.files.length !== 1) throw new Error('needs one <file.nbt>');
  if (!/^[a-z0-9_]+$/.test(o.id ?? '')) throw new Error('--id must match [a-z0-9_]+');
  if (!o.out) throw new Error('--out <dir> is required');
  if (o.name !== undefined && (o.name.trim() === '' || o.name.length > 40)) throw new Error('--name must be 1..40 characters');
  return o;
}

function main() {
  const argv = process.argv.slice(2);
  let o;
  const fail2 = (msg, json) => {
    if (json) console.log(JSON.stringify({ ok: false, errors: [msg], warnings: [], nbt: null, sidecar: null }));
    else console.error(`error: ${msg}`);
    process.exitCode = 2;
  };
  try { o = parseArgs(argv); } catch (e) {
    fail2(`${e.message}\n${USAGE}`, argv.includes('--json'));
    return;
  }
  const file = o.files[0];
  let root;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_BYTES) throw new Error(`${st.size} bytes is more than the ${MAX_BYTES} a structure file may have`);
    root = parse(fs.readFileSync(file));
  } catch (e) {
    return fail2(`${path.basename(file)}: cannot read it as a structure file (${e.message})`, o.json);
  }
  const prep = prepareImport(root, { id: o.id, name: o.name, file });
  if (prep.errors.length) return fail2(`${path.basename(file)}: ${prep.errors.join('; ')}`, o.json);
  fs.mkdirSync(o.out, { recursive: true });
  const nbt = path.join(o.out, `${o.id}.nbt`);
  const sidecar = path.join(o.out, `${o.id}.blueprint.json`);
  fs.writeFileSync(nbt, encodeGzip(prep.structure));
  fs.writeFileSync(sidecar, `${JSON.stringify(prep.sidecar, null, 2)}\n`);
  const result = checkFiles(nbt, sidecar, { max: o.max, type: 'custom', imported: true });
  result.warnings.unshift(...prep.warnings.map((w) => `imported: ${w}`));
  if (!o.json) console.log(`${o.id}: imported ${path.basename(file)}, ${prep.sidecar.size.x}x${prep.sidecar.size.y}x${prep.sidecar.size.z}`);
  report(result, { json: o.json, nbt, sidecar });
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
