// Test fixture: implements the kit CLI from docs/CONTRACT.md "Kit CLI" without Minecraft data.
//   node kit/build.mjs <id> [--out <dir>] [--max x,y,z] [--type <t>] [--json]
// exit 0 = OK, 1 = check failed, 2 = the design threw / bad usage.
// It also writes env.json (the environment it ran with) next to the outputs, so tests can check
// that the checker child process gets a minimal environment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const id = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = args.includes('--json');
if (!id || !/^[a-z0-9_]+$/.test(id)) {
  console.error('usage: node kit/build.mjs <id> [--out <dir>] [--max x,y,z] [--type <t>] [--json]');
  process.exit(2);
}
const out = path.resolve(opt('out') ?? path.join(here, 'out'));
let bp;
try {
  const mod = await import(pathToFileURL(path.join(here, 'designs', `${id}.mjs`)).href);
  if (mod.id !== id) throw new Error(`designs/${id}.mjs exports id '${mod.id}'`);
  bp = mod.default();
} catch (e) {
  if (json) console.log(JSON.stringify({ ok: false, errors: [`the design threw: ${e.message}`], warnings: [] }));
  else console.error(`the design threw: ${e.message}`);
  process.exit(2);
}
const errors = [];
const warnings = [...(bp.warnings ?? [])];
const max = opt('max')?.split(',').map(Number);
if (max && (bp.size.x > max[0] || bp.size.y > max[1] || bp.size.z > max[2])) errors.push(`size ${bp.size.x}x${bp.size.y}x${bp.size.z} exceeds --max ${max.join('x')}`);
const type = opt('type');
if (type && bp.type !== type) errors.push(`type is ${bp.type}, expected ${type}`);
if (!bp.anchors?.entrance || !bp.anchors?.spawn) errors.push('entrance and spawn anchors are required');
if (bp.fail) errors.push(bp.fail);
fs.mkdirSync(out, { recursive: true });
const nbt = path.join(out, `${id}.nbt`);
const sidecarFile = path.join(out, `${id}.blueprint.json`);
fs.writeFileSync(nbt, `FAKE-NBT ${id} ${JSON.stringify(bp.size)}`);
const { warnings: _w, fail: _f, ...sidecar } = bp;
sidecar.id = id;
fs.writeFileSync(sidecarFile, JSON.stringify(sidecar, null, 2));
fs.writeFileSync(path.join(out, 'env.json'), JSON.stringify(process.env));
const ok = errors.length === 0;
if (json) console.log(JSON.stringify({ ok, errors, warnings, nbt, sidecar: sidecarFile }));
else {
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const e of errors) console.log(`error: ${e}`);
  console.log(ok ? 'check: OK' : 'check: FAILED');
}
process.exit(ok ? 0 : 1);
