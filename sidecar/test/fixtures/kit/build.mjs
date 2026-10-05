// Test fixture: implements the kit CLI from docs/CONTRACT.md "Kit CLI" without Minecraft data.
//   node kit/build.mjs <id> [--out <dir>] [--max x,y,z] [--type <t>] [--palette <preset>|<json>] [--values <json>] [--json]
// exit 0 = OK, 1 = check failed, 2 = the design threw / bad usage (an unknown palette or param value too).
// It also writes env.json (the environment it ran with) next to the outputs, so tests can check
// that the checker child process gets a minimal environment.
// Palettes: the presets below, or { preset?, wood?, stone?, roof?, accent? }; recorded as inputs with defaults filled.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRESETS = { rustic: { wood: 'spruce', stone: 'cobblestone', roof: 'dark_oak', accent: 'dark_oak' }, birch: { wood: 'birch', stone: 'polished_andesite', roof: 'dark_oak', accent: 'dark_oak' }, dark: { wood: 'dark_oak', stone: 'deepslate_bricks', roof: 'deepslate_tiles', accent: 'spruce' } };

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const id = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = args.includes('--json');
const usage = (msg) => {
  if (json) console.log(JSON.stringify({ ok: false, errors: [msg], warnings: [] }));
  else console.error(msg);
  process.exit(2);
};
if (!id || !/^[a-z0-9_]+$/.test(id)) usage('usage: node kit/build.mjs <id> [--out <dir>] [--max x,y,z] [--type <t>] [--palette p] [--values v] [--json]');
const out = path.resolve(opt('out') ?? path.join(here, 'out'));
let palette;
const pal = opt('palette');
if (pal !== undefined) {
  let spec;
  try { spec = pal.startsWith('{') ? JSON.parse(pal) : pal; } catch { usage('palette: bad JSON'); }
  if (typeof spec === 'string') spec = { preset: spec };
  if (spec.preset !== undefined && !PRESETS[spec.preset]) usage(`palette: unknown preset '${spec.preset}'`);
  if (spec.wood === 'plastic') usage("palette: unknown wood 'plastic'");
  palette = { ...(spec.preset ? { preset: spec.preset } : {}), ...PRESETS.rustic, ...(PRESETS[spec.preset] ?? {}), ...spec };
}
let given = {};
if (opt('values') !== undefined) {
  try { given = JSON.parse(opt('values')); } catch { usage('values: bad JSON'); }
}
let bp;
let params;
try {
  const mod = await import(pathToFileURL(path.join(here, 'designs', `${id}.mjs`)).href);
  if (mod.id !== id) throw new Error(`designs/${id}.mjs exports id '${mod.id}'`);
  params = mod.params;
  const values = Object.fromEntries(Object.entries(params ?? {}).map(([k, p]) => [k, p.default]));
  for (const [k, v] of Object.entries(given)) {
    const p = params?.[k];
    if (!p) usage(`values: unknown param '${k}'`);
    if (p.type === 'int' && !(Number.isInteger(v) && v >= p.min && v <= p.max)) usage(`values: ${k} must be an integer ${p.min}..${p.max} (got ${JSON.stringify(v)})`);
    values[k] = v;
  }
  bp = mod.default({ ...(palette ? { palette } : {}), ...values });
  bp.palette ??= palette ?? { preset: 'rustic', ...PRESETS.rustic };
  if (params) {
    bp.params = params;
    bp.values = values;
  }
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
fs.writeFileSync(nbt, `FAKE-NBT ${id} ${JSON.stringify(bp.size)} ${JSON.stringify(bp.palette)}`);
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
