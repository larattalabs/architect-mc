// Test fixture: `node kit/import.mjs <file.nbt> --id <id> --out <dir> [--name <n>] [--json]` (docs: kit/README.md).
// A file whose text contains "MODDED" fails the check with the list of its non-vanilla blocks; "JUNK" is not a
// structure file (exit 2); anything else imports as a 5x4x5 custom structure.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args[0];
const id = opt('id');
const out = path.resolve(opt('out'));
const text = fs.readFileSync(file, 'latin1');
if (text.includes('JUNK')) {
  console.log(JSON.stringify({ ok: false, errors: [`${path.basename(file)}: cannot read it as a structure file`], warnings: [], nbt: null, sidecar: null }));
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const nbt = path.join(out, `${id}.nbt`);
const sidecar = path.join(out, `${id}.blueprint.json`);
fs.writeFileSync(nbt, `FAKE-NBT ${id} imported`);
const name = opt('name') ?? path.basename(file, '.nbt').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
fs.writeFileSync(sidecar, JSON.stringify({
  id, name, description: `Imported from ${path.basename(file)}.`, type: 'custom', tags: ['imported'], size: { x: 5, y: 4, z: 5 }, groundY: 1, front: 'south',
  anchors: { entrance: { x: 2.5, y: 1, z: 5.5, yaw: 180, pitch: 0 }, spawn: { x: 2.5, y: 1, z: 7.5, yaw: 180, pitch: 0 } }, imported: true,
}, null, 2));
const errors = text.includes('MODDED') ? ['unknown or non-vanilla blocks (2): create:shaft x4, create:cogwheel x1 (Architect places vanilla 26.3 blocks only)'] : [];
console.log(JSON.stringify({ ok: !errors.length, errors, warnings: ['imported: no outside door'], nbt, sidecar }));
process.exit(errors.length ? 1 : 0);
