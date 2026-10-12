// Sponge Schematic files (docs/CONTRACT.md "Phase 6c slice SCH"): read versions 2 and 3, write version 3. Written from the
// public specification only: SpongePowered/Schematic-Specification at 8e6be2d980d3bd794bc29df5fdca5921129fac5d,
// versions/schematic-2.md and versions/schematic-3.md. No other implementation was consulted.
//
// The spec, in short:
//   v3: root { Schematic: { Version 3, DataVersion, Metadata {Name, Author, Date (ms)}, Width/Height/Length (unsigned shorts),
//         Offset int[3], Blocks { Palette {state: index}, Data varint[] (x + z*Width + y*Width*Length),
//         BlockEntities [{Pos int[3], Id, Data}] }, Biomes, Entities } }
//   v2: the same fields in the root itself, with Palette, PaletteMax, BlockData and BlockEntities whose own fields sit beside
//       Pos and Id (the spec's "Extra").
//   A palette key is a block id with optional [key=value,...] properties; a missing namespace is minecraft.
//
// Architect's conventions (the mod's library/Schematic.java does the same): a template cell Architect does not write is
// minecraft:structure_void in a file it writes, and a structure_void cell read is not written; air is air. Offset puts the
// template's ground row at y 0 ([0, -groundY, 0]). The mod reads the files a player imports (it upgrades them with vanilla's
// data fixers first); this codec is the kit's twin for tests, tools and the cross-checks of the gate.
import { nbt, parse, encode, TAG } from './nbt.mjs';
import zlib from 'node:zlib';

export const STRUCTURE_VOID = 'minecraft:structure_void';
export const STATE_FIELD_NAMES_DV = 5006;
export const CAP = { x: 96, y: 64, z: 96 };

export class SchemError extends Error {
  /** @param {'FORMAT'|'TOO_LARGE'} reason */
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

const fmt = (m) => new SchemError('FORMAT', m);
const num = (t) => (t && (t.t === 'byte' || t.t === 'short' || t.t === 'int') ? t.v : undefined);
const ns = (id) => (String(id).includes(':') ? String(id).trim() : `minecraft:${String(id).trim()}`);

/**
 * Read a schematic's parsed (tagged) root.
 * @returns {{version:number, dataVersion:number, width:number, height:number, length:number, offset:number[], palette:string[],
 *   data:Int32Array, blockEntities:{x:number,y:number,z:number,id:string,data:object}[], name?:string, author?:string,
 *   date?:bigint, entities:number}}
 */
export function readSchem(root, { maxDataVersion = Infinity } = {}) {
  if (root?.t !== 'compound') throw fmt('not an NBT compound');
  const s = root.v.Schematic?.t === 'compound' ? root.v.Schematic.v : root.v;
  const version = num(s.Version);
  if (version === undefined) throw fmt('not a Sponge schematic (no Version)');
  if (version !== 2 && version !== 3) throw fmt(`Sponge schematic version ${version} is not supported (2 and 3 are)`);
  const dataVersion = num(s.DataVersion);
  if (dataVersion === undefined) throw fmt('no DataVersion');
  if (dataVersion > maxDataVersion) throw fmt(`made by a newer game (DataVersion ${dataVersion})`);
  const [w, h, l] = [num(s.Width), num(s.Height), num(s.Length)];
  if (w === undefined || h === undefined || l === undefined) throw fmt('no Width, Height or Length');
  const [width, height, length] = [w & 0xffff, h & 0xffff, l & 0xffff];
  if (!width || !height || !length) throw fmt(`an empty schematic (${width}x${height}x${length})`);
  if (width > CAP.x || height > CAP.y || length > CAP.z) {
    throw new SchemError('TOO_LARGE', `${width}x${height}x${length} is past the template cap of ${CAP.x}x${CAP.y}x${CAP.z}`);
  }
  let offset = [0, 0, 0];
  if (s.Offset !== undefined) {
    if (s.Offset.t !== 'intArray' || s.Offset.v.length !== 3) throw fmt('Offset is not 3 integers');
    offset = [...s.Offset.v];
  }
  let blocks;
  let dataKey;
  if (version === 3) {
    if (s.Blocks?.t !== 'compound') throw fmt('no Blocks (a schematic without blocks has nothing to import)');
    blocks = s.Blocks.v;
    dataKey = 'Data';
  } else {
    blocks = s;
    dataKey = 'BlockData';
  }
  if (blocks.Palette?.t !== 'compound') throw fmt('no Palette');
  const palette = [];
  for (const [k, t] of Object.entries(blocks.Palette.v)) {
    const i = num(t);
    if (i === undefined || i < 0 || i > 1 << 20) throw fmt(`palette entry ${k} has no valid index`);
    if (palette[i] !== undefined) throw fmt(`palette index ${i} is used twice`);
    palette[i] = k;
  }
  if (!palette.length) throw fmt('the palette is empty');
  const raw = blocks[dataKey];
  if (raw?.t !== 'byteArray') throw fmt(`no block data (${dataKey})`);
  const cells = width * height * length;
  const data = new Int32Array(cells);
  let n = 0;
  for (let p = 0; p < raw.v.length;) {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (p >= raw.v.length) throw fmt('the block data ends inside a varint');
      const b = raw.v[p++] & 0xff;
      value |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 28) throw fmt('a varint in the block data is too long');
    }
    if (n >= cells) throw fmt(`the block data has more than the ${cells} cells of ${width}x${height}x${length}`);
    if (value < 0 || value >= palette.length || palette[value] === undefined) throw fmt(`the block data names palette index ${value}, which the palette lacks`);
    data[n++] = value;
  }
  if (n !== cells) throw fmt(`the block data has ${n} cells, not the ${cells} of ${width}x${height}x${length}`);
  const blockEntities = [];
  const list = blocks.BlockEntities?.t === 'list' ? blocks.BlockEntities.v : [];
  list.forEach((be, i) => {
    if (be.t !== 'compound') throw fmt(`block entity ${i} is not a compound`);
    const pos = be.v.Pos;
    if (pos?.t !== 'intArray' || pos.v.length !== 3) throw fmt(`block entity ${i} has no Pos of 3 integers`);
    const [x, y, z] = pos.v;
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= length) throw fmt(`block entity ${i} at ${x},${y},${z} is outside the schematic`);
    const idTag = be.v.Id ?? be.v.id;
    if (idTag?.t !== 'string' || !idTag.v.trim()) throw fmt(`block entity ${i} has no Id`);
    let d = {};
    if (version === 3) {
      if (be.v.Data?.t === 'compound') d = { ...be.v.Data.v };
    } else {
      for (const [k, v] of Object.entries(be.v)) if (!['Pos', 'Id', 'id', 'Extra'].includes(k)) d[k] = v;
      if (be.v.Extra?.t === 'compound') Object.assign(d, be.v.Extra.v);
    }
    delete d.x; delete d.y; delete d.z; delete d.Id;
    d.id = nbt.str(ns(idTag.v));
    blockEntities.push({ x, y, z, id: ns(idTag.v), data: nbt.compound(d) });
  });
  const md = s.Metadata?.t === 'compound' ? s.Metadata.v : {};
  const ents = s.Entities?.t === 'list' ? s.Entities.v.length : 0;
  return {
    version, dataVersion, width, height, length, offset, palette, data, blockEntities,
    ...(md.Name?.t === 'string' ? { name: md.Name.v } : {}),
    ...(md.Author?.t === 'string' ? { author: md.Author.v } : {}),
    ...(md.Date?.t === 'long' ? { date: md.Date.v } : {}),
    entities: ents,
  };
}

/** Read a .schem file's bytes (gzipped or raw). Corrupt bytes are FORMAT. */
export function parseSchem(buf, opts) {
  let root;
  try {
    root = parse(buf);
  } catch (e) {
    throw fmt(`not an NBT file (${e.message})`);
  }
  return readSchem(root, opts);
}

/** "ns:name[k=v,...]" -> { name, props } (namespace added). */
export function parseState(s) {
  const str = String(s).trim();
  const open = str.indexOf('[');
  const name = open < 0 ? str : str.slice(0, open);
  const props = {};
  if (open >= 0) {
    if (!str.endsWith(']')) throw fmt(`palette entry ${s}: properties are not closed by ]`);
    const body = str.slice(open + 1, -1).trim();
    if (body) {
      for (const kv of body.split(',')) {
        const eq = kv.indexOf('=');
        if (eq <= 0 || eq === kv.length - 1) throw fmt(`palette entry ${s}: ${kv} is not key=value`);
        props[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
      }
    }
  }
  if (!/^([a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(name)) throw fmt(`palette entry ${s} is not a block id`);
  return { name: ns(name), props };
}

/**
 * A read schematic as a vanilla structure template (tagged root, at the file's DataVersion): the palette in order of first use
 * (y, z, x), one block per cell except structure_void, block-entity data as `nbt`, no entities. Same as the mod's.
 */
export function schemToStructure(p) {
  const states = p.palette.map((k) => (k === undefined ? undefined : parseState(k)));
  const bes = new Map(p.blockEntities.map((b) => [`${b.x},${b.y},${b.z}`, b.data]));
  const remap = new Map();
  const palette = [];
  // a structure palette entry is {id, properties} from DataVersion 5006 (vanilla's BlockStateFieldNamesFix), {Name, Properties} before
  const legacy = p.dataVersion < STATE_FIELD_NAMES_DV;
  const blocks = [];
  for (let y = 0; y < p.height; y++) {
    for (let z = 0; z < p.length; z++) {
      for (let x = 0; x < p.width; x++) {
        const pi = p.data[x + z * p.width + y * p.width * p.length];
        const st = states[pi];
        if (st.name === STRUCTURE_VOID) continue;
        if (!remap.has(pi)) {
          remap.set(pi, palette.length);
          const e = { [legacy ? 'Name' : 'id']: nbt.str(st.name) };
          if (Object.keys(st.props).length) e[legacy ? 'Properties' : 'properties'] = nbt.compound(Object.fromEntries(Object.entries(st.props).map(([k, v]) => [k, nbt.str(v)])));
          palette.push(nbt.compound(e));
        }
        const b = { pos: nbt.list('int', [nbt.int(x), nbt.int(y), nbt.int(z)]), state: nbt.int(remap.get(pi)) };
        const d = bes.get(`${x},${y},${z}`);
        if (d) b.nbt = d;
        blocks.push(nbt.compound(b));
      }
    }
  }
  return nbt.compound({
    size: nbt.list('int', [nbt.int(p.width), nbt.int(p.height), nbt.int(p.length)]),
    palette: nbt.list('compound', palette),
    blocks: nbt.list('compound', blocks),
    entities: nbt.list('compound', []),
    DataVersion: nbt.int(p.dataVersion),
  });
}

/** A structure palette entry ({id, properties}, or the older {Name, Properties}) as a state string, properties in their stored order. */
export function stateString(entry) {
  const name = entry.v.id?.v ?? entry.v.Name?.v;
  const pt = entry.v.properties ?? entry.v.Properties;
  const props = pt?.t === 'compound' ? Object.entries(pt.v).map(([k, v]) => `${k}=${v.v}`) : [];
  return props.length ? `${name}[${props.join(',')}]` : name;
}

function varints(values) {
  const out = [];
  for (let i of values) {
    while (i & ~0x7f) {
      out.push(((i & 0x7f) | 0x80) << 24 >> 24);
      i >>>= 7;
    }
    out.push(i << 24 >> 24);
  }
  return out;
}

/**
 * A structure template (tagged root) as a version-3 schematic (tagged root). Cells the template does not write are
 * structure_void; the palette is in order of first use in y, z, x order; block entities sorted by y, z, x with their `nbt`
 * minus id/x/y/z as `Data`.
 * @param {{name:string, author?:string, date:bigint|number, groundY:number, dataVersion?:number}} meta
 */
export function structureToSchem(structure, meta) {
  const v = structure.v;
  const [width, height, length] = v.size.v.map((t) => t.v);
  const pal = v.palette.v.map(stateString);
  const grid = new Array(width * height * length).fill(STRUCTURE_VOID);
  const bes = [];
  for (const b of v.blocks.v) {
    const [x, y, z] = b.v.pos.v.map((t) => t.v);
    grid[x + z * width + y * width * length] = pal[b.v.state.v];
    if (b.v.nbt?.t === 'compound') bes.push({ x, y, z, nbt: b.v.nbt });
  }
  const index = new Map();
  const data = [];
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const s = grid[x + z * width + y * width * length];
        if (!index.has(s)) index.set(s, index.size);
        data.push(index.get(s));
      }
    }
  }
  bes.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  const beList = bes.map(({ x, y, z, nbt: d }) => {
    const rest = { ...d.v };
    const id = rest.id?.v;
    delete rest.id; delete rest.x; delete rest.y; delete rest.z;
    return nbt.compound({ Pos: nbt.intArray([x, y, z]), Id: nbt.str(id ?? 'minecraft:unknown'), Data: nbt.compound(rest) });
  });
  return nbt.compound({
    Schematic: nbt.compound({
      Version: nbt.int(3),
      DataVersion: nbt.int(meta.dataVersion ?? v.DataVersion.v),
      Metadata: nbt.compound({ Name: nbt.str(meta.name), Author: nbt.str(meta.author ?? 'Architect'), Date: nbt.long(meta.date) }),
      Width: nbt.short(width << 16 >> 16),
      Height: nbt.short(height << 16 >> 16),
      Length: nbt.short(length << 16 >> 16),
      Offset: nbt.intArray([0, -meta.groundY, 0]),
      Blocks: nbt.compound({
        Palette: nbt.compound(Object.fromEntries([...index].map(([s, i]) => [s, nbt.int(i)]))),
        Data: nbt.byteArray(varints(data)),
        BlockEntities: nbt.list('compound', beList),
      }),
    }),
  });
}

/** Sort every compound's keys (the mod writes them sorted too), so bytes depend only on the content. */
export function sortKeys(tag) {
  if (tag.t === 'compound') return nbt.compound(Object.fromEntries(Object.keys(tag.v).sort().map((k) => [k, sortKeys(tag.v[k])])));
  if (tag.t === 'list') return nbt.list(tag.of, tag.v.map(sortKeys));
  return tag;
}

/** The uncompressed NBT bytes of a schematic root, keys sorted (comparable with the mod's). */
export function encodeSchemRaw(root) {
  return encode(sortKeys(root));
}

/** Gzipped .schem bytes: keys sorted, level 9, the gzip OS byte pinned (as the kit's .nbt files). */
export function encodeSchem(root) {
  const out = zlib.gzipSync(encodeSchemRaw(root), { level: 9 });
  out[9] = 19;
  return out;
}

export { TAG };
