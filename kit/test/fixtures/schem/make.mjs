#!/usr/bin/env node
// The SCH spec fixtures (docs/CONTRACT.md "Phase 6c slice SCH" §5): hand-built from the public Sponge Schematic
// specification (SpongePowered/Schematic-Specification@8e6be2d, versions/schematic-2.md and schematic-3.md), not exported by
// any tool. `node kit/test/fixtures/schem/make.mjs` rewrites them (byte-stable: sorted keys, the gzip OS byte pinned);
// kit/test/schem.test.mjs checks that the committed files equal what this script makes, and the mod's SchematicTest reads
// the same files.
//
//   v3_hut.schem         version 3, DataVersion 5023 (26.3): a 5x4x5 hut with a chest (items), a sign, stairs, air, a
//                        structure_void corner, one entity (skipped) and a biome container (ignored); Offset [0,-1,0]
//   v2_hut.schem         version 2 (fields in the root, PaletteMax, BlockData, block-entity fields flattened beside Pos/Id), the
//                        same hut; Offset [-2,-1,-2]
//   old_dataversion.schem version 2 at DataVersion 2586 (1.16.5): grass_path, grass and a sign with Text1..Text4 (renamed or
//                        reshaped since; vanilla's data fixers upgrade them)
//   unknown_block.schem  version 3 with two blocks of a mod this game lacks
//   oversize.schem       version 3, 97 x 4 x 5 (past the 96 x 64 x 96 cap)
//   corrupt.schem        version 3 whose block data stops 3 cells short
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nbt } from '../../../lib/nbt.mjs';
import { encodeSchem } from '../../../lib/schem.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const CURRENT_DV = 5023;

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

/** The hut: [state per cell (x + z*W + y*W*L)], palette (state -> index), block entities ({pos, id, data}). */
export function hut() {
  const W = 5;
  const H = 4;
  const L = 5;
  const states = [];
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        const edge = x === 0 || z === 0 || x === W - 1 || z === L - 1;
        let s;
        if (x === 4 && z === 4) s = 'minecraft:structure_void';
        else if (y === 0) s = 'minecraft:stone';
        else if (y === 3) s = edge ? 'minecraft:oak_slab[type=bottom,waterlogged=false]' : 'minecraft:oak_planks';
        else if (edge) s = x === 2 && z === 4 && y <= 2 ? 'minecraft:air' : 'minecraft:oak_planks';
        else if (x === 1 && z === 1 && y === 1) s = 'minecraft:chest[facing=south,type=single,waterlogged=false]';
        else if (x === 3 && z === 1 && y === 1) s = 'minecraft:oak_sign[rotation=0,waterlogged=false]';
        else if (x === 2 && z === 1 && y === 1) s = 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]';
        else s = 'minecraft:air';
        states.push(s);
      }
    }
  }
  const bes = [
    { pos: [1, 1, 1], id: 'minecraft:chest', data: { Items: nbt.list('compound', [nbt.compound({ Slot: nbt.byte(0), id: nbt.str('minecraft:bread'), count: nbt.int(3) })]) } },
    {
      pos: [3, 1, 1],
      id: 'minecraft:sign',
      data: {
        front_text: nbt.compound({ messages: nbt.list('string', ['Spec', 'hut', '', ''].map(nbt.str)), color: nbt.str('black'), has_glowing_text: nbt.byte(0) }),
        back_text: nbt.compound({ messages: nbt.list('string', ['', '', '', ''].map(nbt.str)), color: nbt.str('black'), has_glowing_text: nbt.byte(0) }),
        is_waxed: nbt.byte(0),
      },
    },
  ];
  return { W, H, L, states, bes };
}

function paletteOf(states) {
  const index = new Map();
  for (const s of states) if (!index.has(s)) index.set(s, index.size);
  return index;
}

function v3({ W, H, L, states, bes }, { dv = CURRENT_DV, name, offset = [0, 0, 0], extra = {}, width = W, dataCut = 0 } = {}) {
  const pal = paletteOf(states);
  const data = varints(states.map((s) => pal.get(s)));
  return nbt.compound({
    Schematic: nbt.compound({
      Version: nbt.int(3),
      DataVersion: nbt.int(dv),
      Metadata: nbt.compound({ Name: nbt.str(name), Author: nbt.str('spec fixture'), Date: nbt.long(1760227200000n) }),
      Width: nbt.short(width),
      Height: nbt.short(H),
      Length: nbt.short(L),
      Offset: nbt.intArray(offset),
      Blocks: nbt.compound({
        Palette: nbt.compound(Object.fromEntries([...pal].map(([s, i]) => [s, nbt.int(i)]))),
        Data: nbt.byteArray(dataCut ? data.slice(0, data.length - dataCut) : data),
        BlockEntities: nbt.list('compound', bes.map((b) => nbt.compound({ Pos: nbt.intArray(b.pos), Id: nbt.str(b.id), Data: nbt.compound(b.data) }))),
      }),
      ...extra,
    }),
  });
}

function v2({ W, H, L, states, bes }, { dv = CURRENT_DV, name, offset = [0, 0, 0] } = {}) {
  const pal = paletteOf(states);
  return nbt.compound({
    Version: nbt.int(2),
    DataVersion: nbt.int(dv),
    Metadata: nbt.compound({ Name: nbt.str(name), Author: nbt.str('spec fixture') }),
    Width: nbt.short(W),
    Height: nbt.short(H),
    Length: nbt.short(L),
    Offset: nbt.intArray(offset),
    PaletteMax: nbt.int(pal.size),
    Palette: nbt.compound(Object.fromEntries([...pal].map(([s, i]) => [s, nbt.int(i)]))),
    BlockData: nbt.byteArray(varints(states.map((s) => pal.get(s)))),
    // v2: the block entity's own fields sit beside Pos and Id
    BlockEntities: nbt.list('compound', bes.map((b) => nbt.compound({ Pos: nbt.intArray(b.pos), Id: nbt.str(b.id), ...b.data }))),
  });
}

/** 1.16.5 blocks and a sign in its old text form. */
function oldHut() {
  const W = 3;
  const H = 2;
  const L = 3;
  const states = [];
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        let s;
        if (y === 0) s = x === 1 ? 'minecraft:grass_path' : 'minecraft:grass_block[snowy=false]';
        else if (x === 0 && z === 0) s = 'minecraft:grass';
        else if (x === 2 && z === 2) s = 'minecraft:oak_sign[rotation=8,waterlogged=false]';
        else s = 'minecraft:air';
        states.push(s);
      }
    }
  }
  const t = (s) => nbt.str(JSON.stringify({ text: s }));
  const bes = [{ pos: [2, 1, 2], id: 'minecraft:sign', data: { Text1: t('Old'), Text2: t('sign'), Text3: t(''), Text4: t(''), Color: nbt.str('black'), GlowingText: nbt.byte(0) } }];
  return { W, H, L, states, bes };
}

export function fixtures() {
  const h = hut();
  const entity = nbt.compound({ Pos: nbt.list('double', [2.5, 1, 2.5].map(nbt.double)), Id: nbt.str('minecraft:armor_stand'), Data: nbt.compound({}) });
  const biomes = nbt.compound({ Palette: nbt.compound({ 'minecraft:plains': nbt.int(0) }), Data: nbt.byteArray(new Array(h.W * h.H * h.L).fill(0)) });
  const unknown = { ...h, states: h.states.map((s) => (s === 'minecraft:oak_planks' ? 'othermod:widget' : s === 'minecraft:stone' ? 'othermod:gizmo[on=true]' : s)) };
  return {
    'v3_hut.schem': v3(h, { name: 'Spec Hut v3', offset: [0, -1, 0], extra: { Entities: nbt.list('compound', [entity]), Biomes: biomes } }),
    'v2_hut.schem': v2(h, { name: 'Spec Hut v2', offset: [-2, -1, -2] }),
    'old_dataversion.schem': v2(oldHut(), { name: 'Old Hut 1.16.5', dv: 2586, offset: [0, -1, 0] }),
    'unknown_block.schem': v3(unknown, { name: 'Modded Hut' }),
    'oversize.schem': v3(h, { name: 'Too Wide', width: 97 }),
    'corrupt.schem': v3(h, { name: 'Corrupt Hut', dataCut: 3 }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [f, root] of Object.entries(fixtures())) {
    fs.writeFileSync(path.join(DIR, f), encodeSchem(root));
    console.log(f);
  }
}
