// 6c SCH: the kit's Sponge schematic codec (lib/schem.mjs). Round trips of every kit example, determinism (two encodes, and
// committed sha256 goldens that CI's Linux run must reproduce), the spec fixtures (v2 and v3 read alike, the refusals) and the
// fixtures being exactly what make.mjs builds.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../lib/nbt.mjs';
import { encodeSchem, parseSchem, readSchem, schemToStructure, stateString, structureToSchem, SchemError } from '../lib/schem.mjs';
import { prepareImport } from '../lib/importer.mjs';
import { fixtures } from './fixtures/schem/make.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(KIT, 'test', 'fixtures', 'schem');
const GOLDENS = path.join(FIX, 'goldens.json');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const examples = () => fs.readdirSync(path.join(KIT, 'examples')).filter((e) => fs.existsSync(path.join(KIT, 'examples', e, `${e}.nbt`)));
const readStructure = (e) => parse(fs.readFileSync(path.join(KIT, 'examples', e, `${e}.nbt`)));
const groundYOf = (e) => JSON.parse(fs.readFileSync(path.join(KIT, 'examples', e, `${e}.blueprint.json`), 'utf8')).groundY ?? 1;

/** A plain, order-free form of a tag (for comparing block-entity data). */
function canon(tag) {
  if (tag.t === 'compound') return Object.fromEntries(Object.keys(tag.v).sort().map((k) => [k, canon(tag.v[k])]));
  if (tag.t === 'list') return tag.v.map(canon);
  if (tag.t === 'long') return `${tag.v}L`;
  if (tag.t === 'longArray') return tag.v.map((n) => `${n}L`);
  return [tag.t, tag.v];
}

/** Every written cell of a structure: "x,y,z" -> state string (properties sorted) + block-entity data. */
export function cells(structure) {
  const pal = structure.v.palette.v.map((e) => {
    const s = stateString(e);
    const open = s.indexOf('[');
    return open < 0 ? s : `${s.slice(0, open)}[${s.slice(open + 1, -1).split(',').sort().join(',')}]`;
  });
  const out = {};
  for (const b of structure.v.blocks.v) {
    const st = pal[b.v.state.v];
    if (st === 'minecraft:structure_void') continue;
    out[b.v.pos.v.map((t) => t.v).join(',')] = b.v.nbt ? `${st} ${JSON.stringify(canon(b.v.nbt))}` : st;
  }
  return out;
}

const exportOf = (e) => encodeSchem(structureToSchem(readStructure(e), { name: e, date: 0n, groundY: groundYOf(e) }));

test('every kit example: .nbt -> .schem -> structure gives the same cells (item 1, kit half)', () => {
  const list = examples();
  assert.ok(list.length >= 4, list.join(','));
  for (const e of list) {
    const before = readStructure(e);
    const p = parseSchem(exportOf(e));
    assert.equal(p.version, 3);
    assert.equal(p.dataVersion, before.v.DataVersion.v);
    assert.deepEqual(p.offset, [0, -groundYOf(e), 0], e);
    assert.ok(p.palette.some((k) => k.includes('[')), `${e}: the palette keeps block properties`);
    const after = schemToStructure(p);
    assert.deepEqual(after.v.size.v.map((t) => t.v), before.v.size.v.map((t) => t.v), e);
    assert.deepEqual(cells(after), cells(before), e);
  }
});

test('the hut fixture with block entities and a void round-trips through v3 write (item 1, block entities)', () => {
  const before = schemToStructure(parseSchem(fs.readFileSync(path.join(FIX, 'v3_hut.schem'))));
  assert.equal(before.v.blocks.v.filter((b) => b.v.nbt).length, 2);
  const again = schemToStructure(parseSchem(encodeSchem(structureToSchem(before, { name: 'hut', date: 1n, groundY: 1 }))));
  assert.deepEqual(cells(again), cells(before));
  assert.equal(Object.keys(cells(before)).length, 96, 'the structure_void corner column (4 of 100 cells) is not written');
});

test('determinism: two exports are byte-identical and match the committed goldens (item 2; CI runs this on Linux)', () => {
  const goldens = JSON.parse(fs.readFileSync(GOLDENS, 'utf8'));
  for (const e of examples()) {
    const a = exportOf(e);
    const b = exportOf(e);
    assert.ok(a.equals(b), e);
    assert.equal(a[9], 19, 'the gzip OS byte is pinned');
    assert.equal(sha(a), goldens.kit[e], `${e}: the export's bytes moved`);
  }
});

test('the spec fixtures are what make.mjs builds', () => {
  for (const [f, root] of Object.entries(fixtures())) {
    assert.ok(fs.readFileSync(path.join(FIX, f)).equals(encodeSchem(root)), f);
  }
});

test('v2 and v3 of the hut read to the same structure (item 3)', () => {
  const v3 = parseSchem(fs.readFileSync(path.join(FIX, 'v3_hut.schem')));
  const v2 = parseSchem(fs.readFileSync(path.join(FIX, 'v2_hut.schem')));
  assert.equal(v3.version, 3);
  assert.equal(v2.version, 2);
  assert.equal(v3.entities, 1);
  assert.deepEqual(cells(schemToStructure(v2)), cells(schemToStructure(v3)));
  assert.equal(v3.name, 'Spec Hut v3');
  assert.equal(v3.author, 'spec fixture');
  const chest = v2.blockEntities.find((b) => b.id === 'minecraft:chest');
  assert.deepEqual(chest.data.v.Items.v[0].v.id.v, 'minecraft:bread');
  assert.equal(chest.data.v.id.v, 'minecraft:chest');
});

test('refusals: unknown version, newer DataVersion, oversize, corrupt (item 4, kit half)', () => {
  const r = (f, opts) => {
    try {
      parseSchem(fs.readFileSync(path.join(FIX, f)), opts);
      return null;
    } catch (e) {
      assert.ok(e instanceof SchemError, e.message);
      return e;
    }
  };
  assert.equal(r('oversize.schem').reason, 'TOO_LARGE');
  assert.match(r('corrupt.schem').message, /97 cells, not the 100/);
  assert.equal(r('corrupt.schem').reason, 'FORMAT');
  assert.equal(r('v3_hut.schem', { maxDataVersion: 4000 }).reason, 'FORMAT');
  const bad = parse(fs.readFileSync(path.join(FIX, 'v3_hut.schem')));
  bad.v.Schematic.v.Version.v = 4;
  assert.throws(() => readSchem(bad), /version 4 is not supported/);
  assert.throws(() => parseSchem(Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3])), /not an NBT file/);
  const structure = parse(fs.readFileSync(path.join(KIT, 'examples', 'cabin', 'cabin.nbt')));
  assert.throws(() => readSchem(structure), /not a Sponge schematic/);
});

test('an imported schematic takes groundY from Offset, and the tags', () => {
  const p = parseSchem(fs.readFileSync(path.join(FIX, 'v3_hut.schem')));
  const prep = prepareImport(schemToStructure(p), { id: 'imp_hut', file: 'v3_hut.schem', groundY: -p.offset[1], tags: ['schem'] });
  assert.deepEqual(prep.errors, []);
  assert.equal(prep.sidecar.groundY, 1);
  assert.equal(prep.sidecar.anchors.entrance.y, 1);
  assert.deepEqual(prep.sidecar.tags, ['imported', 'schem']);
  assert.equal(prep.sidecar.name, 'V3 Hut');
});
