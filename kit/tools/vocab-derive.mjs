// (6c VOC) The pure half of gen-vocab.mjs: from the committed edges (kit/vocab/edges.json, or the jar run's fresh ones), the committed
// rule tables (kit/vocab/*.json) and the block table's own facts, derive every per-block vocabulary field (docs/CONTRACT.md "Phase 6c
// slice VOC" §1) and every generated copy (§3): blocks.mjs's vocabulary section, kit/lib/vocab/survival.mjs, the mod's
// survival_items.json and the vocab/1 document (kit/schemas/vocab-1.json). Both runs of the generator (with the jar and without it)
// call this one function, so they give the same bytes from the same edges. No I/O.

export const DYES = Object.freeze(['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']);
export const TIERS = Object.freeze(['common', 'uncommon', 'rare', 'precious']);
export const SURVIVAL_CLASSES = Object.freeze(['craft', 'drop', 'silk', 'loot', 'cost', 'none']);
/** The vocabulary fields, in the order blocks.mjs writes them (CONTRACT VOC §1). */
export const FIELDS = Object.freeze(['fam', 'col', 't', 'sv', 'rt', 'wx', 'be', 'ft', 'ff']);
/** A dyed set: a stem with at least this many dye-prefixed blocks (red_sandstone, red_sand, blue_ice and the tulips have fewer). */
export const DYED_MIN = 8;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const bare = (s) => s.replace(/^minecraft:/, '');
const DYES_LONGEST = [...DYES].sort((a, b) => b.length - a.length || cmp(a, b));

/** `light_gray_concrete` -> ['light_gray', 'concrete'], else null. */
export function splitDye(id) {
  for (const d of DYES_LONGEST) if (id.startsWith(`${d}_`)) return [d, id.slice(d.length + 1)];
  return null;
}

/**
 * Java families (blocks.mjs `family`) that are fittings: functional, not material (CONTRACT VOC §1 `ft`; accentShare's set widened).
 * Besides these: glass and panes (a `glass` block that lets light through), a block with a block entity, a light source that is not a
 * full cube, and the redstone parts below.
 */
const FITTING_FAMILIES = new Set(['door', 'trapdoor', 'fence_gate', 'torch', 'wall_torch', 'lantern', 'button', 'lever', 'pressure_plate', 'rail',
  'redstone_wire', 'diode', 'candle', 'cake', 'flower_pot', 'skull', 'wall_skull', 'banner', 'wall_banner', 'sign', 'wall_sign', 'hanging_sign',
  'wall_hanging_sign', 'bed', 'plant', 'double_plant', 'growing_plant', 'ceiling_plant', 'wall_fan', 'cocoa', 'rod', 'wall_hook', 'chain', 'ladder',
  'multiface', 'pane', 'grindstone', 'scaffolding', 'fire']);
const REDSTONE_PARTS = new Set(['piston', 'sticky_piston', 'piston_head', 'moving_piston', 'observer', 'note_block', 'target', 'tnt', 'redstone_lamp']);

/** The stem a family is named by (`chiseled_copper` -> `copper`, `black_concrete` -> `concrete`, `iron_block` -> `iron`): the dye, the
 * shaping and weathering prefixes and a `_block` suffix stripped. A name already taken falls back to the member's own id. */
export function familyStem(id, dyed) {
  let s = bare(id);
  if (dyed) s = splitDye(s)?.[1] ?? s;
  for (let k = 0; k < 4; k++) {
    const t = s.replace(/^(waxed|exposed|weathered|oxidized|chiseled|cut|polished|smooth|cracked|mossy|stripped)_/, '');
    if (t === s) break;
    s = t;
  }
  return s.replace(/_block$/, '') || s;
}

/** Union-find over string nodes. */
function uf() {
  const p = new Map();
  const find = (x) => {
    if (!p.has(x)) p.set(x, x);
    let r = x;
    while (p.get(r) !== r) r = p.get(r);
    while (p.get(x) !== r) { const n = p.get(x); p.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) { if (ra < rb) p.set(rb, ra); else p.set(ra, rb); }
  };
  return { find, union };
}

/**
 * The derivation.
 * @param {object} o
 * @param {object} o.blocks the base block table (blocks.mjs BLOCKS without vocabulary fields): {id: {family, collision, i, L, ...}}
 * @param {(tag:string)=>string[]|null} o.tagBlocks the block tags (blocks.mjs tagBlocks)
 * @param {object} o.edges kit/vocab/edges.json
 * @param {object} o.tables {tiers, roles, survival, hazards, modifiers}
 * @param {object} o.hand {STONE_FAMILIES, WOODS, woodFamilyOf}
 * @param {(state:{name,props})=>number} o.emissionOf
 * @returns {{fields: Object<string, object>, families: object, report: object}}
 */
export function deriveVocab({ blocks, tagBlocks, edges, tables, hand, emissionOf }) {
  const ids = Object.keys(blocks).filter((k) => k.startsWith('minecraft:')).sort(cmp);
  const E = edges.blocks;
  for (const id of ids) if (!E[bare(id)]) throw new Error(`edges.json has no row for ${id}: regenerate with the jar (node kit/tools/gen-vocab.mjs)`);
  for (const k of Object.keys(E)) if (!blocks[`minecraft:${k}`]) throw new Error(`edges.json names ${k}, which blocks.mjs lacks`);
  const itemOf = (id) => (blocks[id].i === undefined ? bare(id) : blocks[id].i);
  const nodeOf = (id) => itemOf(id) || bare(id);

  // ---- colours: a dye prefix whose stem has a full dyed set
  const byStem = new Map();
  for (const id of ids) {
    const s = splitDye(bare(id));
    if (s) byStem.set(s[1], [...(byStem.get(s[1]) ?? []), id]);
  }
  const col = new Map();
  for (const [stem, list] of byStem) if (new Set(list.map((id) => splitDye(bare(id))[0])).size >= DYED_MIN) for (const id of list) col.set(id, splitDye(bare(id))[0]);

  // ---- families
  const U = uf();
  for (const id of ids) {
    const n = nodeOf(id);
    U.find(n);
    for (const j of E[bare(id)].j ?? []) U.union(n, j);
    // weathering and waxing: every block with a weathering stage or a waxed form is WeatheringCopper's, so they are one family
    const wx = E[bare(id)].wx;
    for (const t of [wx?.next, wx?.waxed]) if (t) { U.union(n, nodeOf(`minecraft:${t}`)); U.union(n, 'weathering:copper'); }
    if (col.has(id)) {
      const stem = splitDye(bare(id))[1];
      if (blocks[`minecraft:${stem}`]) U.union(n, nodeOf(`minecraft:${stem}`));
      U.union(n, `dyed:${stem}`);
    }
  }
  const comp = new Map();
  for (const id of ids) {
    const r = U.find(nodeOf(id));
    comp.set(r, [...(comp.get(r) ?? []), id]);
  }
  // the hand families (STONE_FAMILIES' listed blocks; every block woodFamilyOf names a wood) claim the component holding most of them
  const handLists = [
    ...Object.entries(hand.STONE_FAMILIES).map(([f, list]) => ({ name: f, kind: 'stone', members: list.map((b) => `minecraft:${b}`), first: `minecraft:${list[0]}` })),
    ...hand.WOODS.map((w) => ({ name: w, kind: 'wood', members: ids.filter((id) => hand.woodFamilyOf(id) === w), first: `minecraft:${w}_planks` })),
  ];
  const claims = new Map(); // root -> [{name, n}]
  const hands = [];
  for (const h of handLists) {
    const per = new Map();
    for (const m of h.members) {
      if (!blocks[m]) continue;
      const r = U.find(nodeOf(m));
      per.set(r, (per.get(r) ?? 0) + 1);
    }
    const firstRoot = blocks[h.first] ? U.find(nodeOf(h.first)) : null;
    const best = [...per].sort((a, b) => b[1] - a[1] || (a[0] === firstRoot ? -1 : b[0] === firstRoot ? 1 : cmp(a[0], b[0])))[0];
    if (!best) continue;
    claims.set(best[0], [...(claims.get(best[0]) ?? []), { name: h.name, n: best[1], order: hands.length }]);
    hands.push({ ...h, root: best[0], per });
  }
  const names = new Map();
  const used = new Set();
  const merged = [];
  for (const [r, cl] of [...claims].sort(([a], [b]) => cmp(a, b))) {
    const s = [...cl].sort((a, b) => b.n - a.n || a.order - b.order);
    names.set(r, s[0].name);
    used.add(s[0].name);
    if (s.length > 1) merged.push({ family: s[0].name, alsoHolds: s.slice(1).map((x) => x.name) });
  }
  // the rest: named by the shortest stem among the full-cube members (else all members), ties lexically (`ice` over `blue_ice`)
  const rest = [...comp.keys()].filter((r) => !names.has(r)).map((r) => {
    const m = comp.get(r);
    const cubes = m.filter((id) => blocks[id].collision === 'full');
    const cands = (cubes.length ? cubes : m).map((id) => ({ id, stem: familyStem(id, col.has(id)) }));
    cands.sort((a, b) => a.stem.length - b.stem.length || cmp(a.stem, b.stem) || cmp(a.id, b.id));
    return { r, pick: cands[0].id, stem: cands[0].stem };
  }).sort((a, b) => cmp(a.pick, b.pick));
  for (const { r, pick, stem } of rest) {
    let n = stem;
    if (used.has(n)) n = bare(pick);
    for (let k = 2; used.has(n); k++) n = `${bare(pick)}_${k}`;
    names.set(r, n);
    used.add(n);
  }
  const famOf = new Map(ids.map((id) => [id, names.get(U.find(nodeOf(id)))]));

  // the hand families' report: each inside one generated family, or its splits listed with their evidence
  const handReport = hands.map((h) => {
    const fam = names.get(h.root);
    const splits = h.members.filter((m) => blocks[m] && U.find(nodeOf(m)) !== h.root).map((m) => {
      const e = E[bare(m)];
      const why = e.ck?.length ? `smelted from ${e.ck.join(', ')} (smelting joins no family)`
        : e.nj ? `made by recipe ${e.nj[0]} of more than one material (${e.nj[1].join(', ')}), which joins no family`
          : e.j?.length ? `joined to ${e.j.join(', ')} only` : 'no recipe makes it';
      return { block: bare(m), family: famOf.get(m), why };
    });
    return { hand: h.name, kind: h.kind, family: fam, members: h.members.length, splits };
  });

  // ---- tiers
  const T = tables.tiers;
  const rowOf = new Map(T.rows.map((r) => [r.key, r.tier]));
  const rank = (t) => TIERS.indexOf(t);
  const max = (a, b) => (rank(a) >= rank(b) ? a : b);
  const tagRowsOf = (item) => {
    let t = null;
    for (const [k, members] of Object.entries(edges.tagRows ?? {})) if (members.includes(item) && rowOf.has(k)) t = t ? max(t, rowOf.get(k)) : rowOf.get(k);
    return t;
  };
  for (const r of T.rows) if (r.key.startsWith('#') && !(edges.tagRows ?? {})[r.key]) throw new Error(`tiers.json row ${r.key}: edges.json has no members for it: regenerate with the jar (node kit/tools/gen-vocab.mjs)`);
  const blockTagRows = (id) => {
    let t = null;
    for (const r of T.rows) if (r.key.startsWith('#') && (tagBlocks(r.key) ?? []).includes(id)) t = t ? max(t, r.tier) : r.tier;
    return t;
  };
  /** An item's own tier: its row, else its item tags' rows, else (a block item) its family's row, else its block tags' rows. */
  const ownTier = (item) => {
    const q = `minecraft:${item}`;
    if (rowOf.has(q)) return rowOf.get(q);
    const tr = tagRowsOf(item);
    if (tr) return tr;
    if (blocks[q]) {
      const fr = rowOf.get(`fam:${famOf.get(q)}`);
      if (fr) return fr;
      const br = blockTagRows(q);
      if (br) return br;
    }
    return 'common';
  };
  const tierOf = new Map();
  for (const id of ids) {
    const e = E[bare(id)];
    const item = itemOf(id);
    let t;
    if (e.raw?.length) t = e.raw.map(ownTier).reduce(max, 'common');
    else if (item) t = ownTier(item);
    else {
      const fr = rowOf.get(`fam:${famOf.get(id)}`);
      t = fr ?? blockTagRows(id) ?? 'common';
    }
    tierOf.set(id, t);
  }

  // ---- survival: the generated class, the costs rows (`cost`), then the class overrides
  const S = tables.survival;
  const costOf = new Map(S.costs.map((r) => [r.block, r.item]));
  const svOf = new Map();
  const svWhy = new Map();
  for (const id of ids) {
    const e = E[bare(id)];
    if (costOf.has(id)) { svOf.set(id, 'cost'); svWhy.set(id, 'survival.json costs'); continue; }
    svOf.set(id, e.sv);
    svWhy.set(id, e.src ?? (itemOf(id) ? 'no recipe makes its item and no loot table or trade yields it' : 'it has no item'));
  }
  const overridden = [];
  for (const r of S.classes) {
    const targets = r.block.startsWith('#') ? (tagBlocks(r.block) ?? (() => { throw new Error(`survival.json: unknown tag ${r.block}`); })())
      : r.block.endsWith('*') ? ids.filter((id) => id.startsWith(r.block.slice(0, -1))) : [r.block];
    if (!targets.length) throw new Error(`survival.json: ${r.block} matches no block`);
    for (const id of targets) {
      if (!blocks[id]) throw new Error(`survival.json: unknown block ${id}`);
      if (svOf.get(id) !== r.sv) overridden.push({ block: bare(id), from: svOf.get(id), to: r.sv, why: r.why });
      svOf.set(id, r.sv);
      svWhy.set(id, `survival.json: ${r.why}`);
    }
  }

  // ---- fittings
  const L = (id) => {
    const b = blocks[id];
    return emissionOf({ name: id, props: b.defaults ?? {} });
  };
  const ftOf = (id) => {
    const b = blocks[id];
    if (FITTING_FAMILIES.has(b.family)) return true;
    if (REDSTONE_PARTS.has(bare(id))) return true;
    if (E[bare(id)].be) return true;
    if (/glass/.test(bare(id)) && b.o === 'C') return true;
    if (L(id) > 0 && b.collision !== 'full') return true;
    return false;
  };

  // ---- the fields
  const fields = {};
  for (const id of ids) {
    const e = E[bare(id)];
    const f = { fam: famOf.get(id) };
    if (col.has(id)) f.col = col.get(id);
    if (tierOf.get(id) !== 'common') f.t = tierOf.get(id);
    f.sv = svOf.get(id);
    if (e.rt) f.rt = 1;
    if (e.wx) f.wx = e.wx;
    if (e.be) f.be = 1;
    if (ftOf(id)) f.ft = 1;
    if (e.ff?.length) f.ff = e.ff;
    fields[id] = f;
  }
  const creativeOnly = ids.filter((id) => svOf.get(id) === 'none');
  return {
    fields,
    creativeOnly,
    costs: Object.fromEntries([...costOf].sort(([a], [b]) => cmp(a, b))),
    report: { blocks: ids.length, families: used.size, hand: handReport, merged, overridden, svWhy: Object.fromEntries(creativeOnly.map((id) => [bare(id), svWhy.get(id)])) },
  };
}

/** blocks.mjs's vocabulary section: one `v(name, {fields})` line per block. */
export function vocabSection(fields) {
  const lit = (v) => (typeof v === 'string' ? `'${v}'` : typeof v === 'number' ? String(v) : Array.isArray(v) ? `[${v.map(lit).join(', ')}]` : `{ ${Object.entries(v).map(([k, x]) => `${k}: ${lit(x)}`).join(', ')} }`);
  const lines = Object.keys(fields).sort(cmp).map((id) => `v('${bare(id)}', ${lit(fields[id])});`);
  return `// ${lines.length} blocks' vocabulary (generated by kit/tools/gen-vocab.mjs from kit/vocab/edges.json and the tables in kit/vocab/; do not edit)\n${lines.join('\n')}`;
}

/** kit/lib/vocab/survival.mjs. */
export function survivalModule(creativeOnly, costs) {
  const j = (v) => JSON.stringify(v).replaceAll('"', "'");
  return `// GENERATED by kit/tools/gen-vocab.mjs from kit/vocab/edges.json and kit/vocab/survival.json (docs/CONTRACT.md "Phase 6c slice VOC" §3).
// Do not edit: the one source of the survival data. kit/lib/check.mjs (the survival warning), kit/lib/connectors/bom.mjs (cost.bom) and
// the mod's survival_items.json (creativeOnly, costs: the placement refusal and the charge) are all written from it.

/** Blocks survival can't build (their survival class is \`none\`): a survival world refuses to place a design that uses one. */
export const CREATIVE_ONLY = new Set([
${creativeOnly.map((id) => `  '${id}',`).join('\n')}
]);

/** The block-to-item special cases (block -> item, or [] for no item), survival.json's \`costs\` rows. */
export const COSTS = Object.freeze({
${Object.entries(costs).map(([b, i]) => `  '${b}': ${j(i)},`).join('\n')}
});
`;
}

/** The mod's survival_items.json (the shape SurvivalItems.java reads). */
export function survivalItemsJson(creativeOnly, costs, modRows) {
  const o = {
    _comment: "GENERATED by kit/tools/gen-vocab.mjs from kit/vocab/edges.json and kit/vocab/survival.json (docs/CONTRACT.md 'Phase 6c slice VOC' §3; phase 3 'Materials'): blocks whose item survival can't get, or that have none, and what they cost instead; creativeOnly blocks are refused at placement. Do not edit: kit/lib/vocab/survival.mjs is written from the same data.",
    costs,
    creativeOnly: [...creativeOnly, ...modRows.map((r) => r.block)],
  };
  return `${JSON.stringify(o, null, 2)}\n`;
}

/**
 * The vocab/1 document (kit/schemas/vocab-1.json; the systemRef `vocab/1`, S-VOC-6): families, tiers, colours and survival class per
 * block (`blocks`, the full form) and the same grouped (`compact`, the `#compact` form: a family's members only when it has more than
 * one; a tier by whole families where every member shares it, else by block; the dyed families (a member's colour is its name's dye
 * prefix); the blocks survival can't simply mine or craft). (6c VOC-c) `groups` (a rule.palette family may name one) in both forms and
 * `compact.palette`'s note. Nothing in it varies between runs.
 */
export function vocabDoc(fields, { groups = {} } = {}) {
  const ids = Object.keys(fields).sort(cmp);
  const blocksOut = {};
  const fam = {};
  for (const id of ids) {
    const f = fields[id];
    const b = bare(id);
    const o = { fam: f.fam };
    if (f.col) o.col = f.col;
    if (f.t) o.t = f.t;
    o.sv = f.sv;
    if (f.ft) o.ft = 1;
    blocksOut[b] = o;
    (fam[f.fam] ??= []).push(b);
  }
  const famNames = Object.keys(fam).sort(cmp);
  const tiers = {};
  for (const t of TIERS.slice(1)) tiers[t] = { families: [], blocks: [] };
  for (const n of famNames) {
    const ts = new Set(fam[n].map((b) => blocksOut[b].t ?? 'common'));
    if (ts.size === 1 && !ts.has('common') && fam[n].length > 1) tiers[[...ts][0]].families.push(n);
    else for (const b of fam[n]) if (blocksOut[b].t) tiers[blocksOut[b].t].blocks.push(b);
  }
  const dyed = famNames.filter((n) => fam[n].some((b) => blocksOut[b].col));
  const groupsOut = Object.fromEntries(Object.keys(groups).sort(cmp).map((g) => [g, [...groups[g]].sort(cmp)]));
  for (const [g, fs] of Object.entries(groupsOut)) for (const f of fs) if (!fam[f]) throw new Error(`group ${g}: ${f} is not a family`);
  const survival = { silk: [], loot: [], cost: [], none: [] };
  for (const b of Object.keys(blocksOut)) if (survival[blocksOut[b].sv]) survival[blocksOut[b].sv].push(b);
  return {
    vocab: 1,
    mc: '26.3',
    generator: 'kit/tools/gen-vocab.mjs (docs/CONTRACT.md "Phase 6c slice VOC")',
    fields: {
      fam: 'family: the material a block is cut, shaped, dyed, waxed or weathered from (a family name)',
      col: 'dye colour, one of the 16 (absent: none)',
      t: `tier: ${TIERS.slice(1).join(', ')} (absent: common); the highest tier among the raw items of its cheapest recipe`,
      sv: `survival class: ${SURVIVAL_CLASSES.join(', ')} (craft: a recipe makes it; drop: mining drops it; silk: only with silk touch; loot: chests, mobs or trades; cost: placed with another item; none: creative only)`,
      ft: 'fitting (1): functional, not material (doors, glass, lights that are not cubes, beds, signs, plants, redstone parts...)',
    },
    tiers: TIERS,
    survivalClasses: SURVIVAL_CLASSES,
    colours: DYES,
    blocks: blocksOut,
    // (6c VOC-c) family groups (kit/lib/vocab/groups.mjs): a rule.palette's family may name one; both forms carry them
    groups: groupsOut,
    compact: {
      note: 'families: members of every family with more than one (any other block is a family of its own, named by its id); tiers: whole families, else blocks (the rest is common); dyed: the families whose members are dyed (a member\'s colour is its id\'s dye prefix); survival: the blocks not simply crafted or mined (silk: silk touch only; loot: chests, mobs, trades; cost: placed with another item; none: creative only)',
      families: Object.fromEntries(famNames.filter((n) => fam[n].length > 1).map((n) => [n, fam[n]])),
      tiers,
      dyed,
      survival,
      groups: groupsOut,
      palette: PALETTE_NOTE,
    },
  };
}

/** (6c VOC-c) compact.palette: how a plan writer names a family in rule.palette. */
export const PALETTE_NOTE = "rule.palette {family, share} measures a family's share of written blocks; family is a family or group named here; 'only X' is share [1, 1], 'no X' is share [0, 0]";
