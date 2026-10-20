// (6c VOC) The jar side of gen-vocab.mjs: reads the 26.3 server jar's built-in data pack (recipes, loot tables, villager trades, item
// tags; `data/minecraft/datapacks/**`, the feature packs, are not read) and derives, per block, only the edges the vocabulary needs
// (docs/CONTRACT.md "Phase 6c slice VOC" §1, §3; N-VOC-7: kit/vocab/edges.json holds these edges, never a recipe or a loot table):
//   - `j`: the family links (stonecutter recipes, shape recipes from one material, a recipe of one material plus modifiers);
//   - `ck`: the cooking inputs (smelting is excluded from families: the evidence for a listed split);
//   - `raw`: the raw items of the cheapest recipe path (fewest raw items, ties by recipe id), stopping at an item tiers.json names;
//   - `sv`, `src`: the generated survival class of the block's item and one source naming it.
// Pure over its inputs (the zip reader and the tables), so the generator's two runs give the same bytes.
import crypto from 'node:crypto';

const RECIPE = 'data/minecraft/recipe/';
const LOOT = 'data/minecraft/loot_table/';
const TRADE = 'data/minecraft/villager_trade/';
const ITEM_TAGS = 'data/minecraft/tags/item/';
const BLOCK_TAGS = 'data/minecraft/tags/block/';
const SILK = 'minecraft:tool/can_silk_touch';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const q = (s) => (s.includes(':') ? s : `minecraft:${s}`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Every JSON entry under a prefix, as [id (path without prefix and .json), parsed] in code-point order of the path. */
function entries(zip, prefix) {
  return zip.names().filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort(cmp).map((n) => [n.slice(prefix.length, -5), JSON.parse(zip.read(n).toString('utf8'))]);
}

/** Resolved tags under a prefix: {`minecraft:x`: [ids...]} (references expanded, sorted). */
function resolveTags(zip, prefix) {
  const raw = {};
  for (const [t, j] of entries(zip, prefix)) raw[`minecraft:${t}`] = j.values.map((v) => (typeof v === 'string' ? v : v.id));
  const out = {};
  const res = (t, seen = new Set()) => {
    if (out[t]) return out[t];
    if (seen.has(t)) throw new Error(`tag cycle at ${t}`);
    seen.add(t);
    const s = new Set();
    for (const v of raw[t] ?? []) {
      if (v.startsWith('#')) for (const x of res(q(v.slice(1)), seen)) s.add(x);
      else s.add(q(v));
    }
    return (out[t] = [...s].sort(cmp));
  };
  for (const t of Object.keys(raw).sort(cmp)) res(t);
  return out;
}

/**
 * The digests the registry step compares (gate item 2): per kind, sha256 over the sorted `path sha256(bytes)` lines of the vanilla
 * pack's files (the bytes the server loads), and the resolved block tags as `tag member member ...` lines.
 */
export function digests(zip) {
  const out = {};
  for (const [k, pre] of [['recipe', RECIPE], ['loot_table', LOOT], ['tags/block', BLOCK_TAGS], ['tags/item', ITEM_TAGS]]) {
    const lines = zip.names().filter((n) => n.startsWith(pre) && n.endsWith('.json')).sort(cmp).map((n) => `${n.slice('data/minecraft/'.length)} ${sha(zip.read(n))}`);
    out[k] = { files: lines.length, sha256: sha(lines.join('\n')) };
  }
  const bt = resolveTags(zip, BLOCK_TAGS);
  const lines = Object.keys(bt).sort(cmp).map((t) => `${t} ${bt[t].filter((b) => b.startsWith('minecraft:')).join(' ')}`);
  out.blockTagsResolved = { tags: lines.length, sha256: sha(lines.join('\n')) };
  // the ids the server loads from those files (dev.vocab.registry's `loaded`)
  const ids = (pre) => zip.names().filter((n) => n.startsWith(pre) && n.endsWith('.json')).map((n) => `minecraft:${n.slice(pre.length, -5)}`).sort(cmp);
  out.loaded = {};
  for (const [k, pre] of [['recipes', RECIPE], ['lootTables', LOOT]]) {
    const l = ids(pre);
    out.loaded[k] = { count: l.length, sha256: sha(l.join('\n')) };
  }
  return out;
}

/** An ingredient's alternatives (item ids), from a string, `#tag` or an array of them. */
function alts(v, itemTags) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return [...new Set(v.flatMap((x) => alts(x, itemTags)))].sort(cmp);
  if (typeof v === 'object') return alts(v.item ?? v.tag ?? v.id, itemTags);
  const s = String(v);
  if (s.startsWith('#')) return [...(itemTags[q(s.slice(1))] ?? [])];
  return [q(s)];
}

const SLOT_KEYS = ['ingredient', 'input', 'material', 'base', 'addition', 'template', 'banner', 'target', 'dye', 'source', 'front', 'back', 'left', 'right'];
const COOKING = new Set(['minecraft:smelting', 'minecraft:blasting', 'minecraft:smoking', 'minecraft:campfire_cooking']);

/** A recipe as {id, type, out, n, slots: [{alts, count}]} (null for one with no fixed result: special recipes, brewing). */
export function parseRecipe(id, j, itemTags) {
  const out = j.result?.id ?? (typeof j.result === 'string' ? j.result : null);
  if (!out || j.type === 'minecraft:brewing') return null;
  const slots = [];
  if (j.key && j.pattern) {
    const n = {};
    for (const row of j.pattern) for (const ch of row) if (ch !== ' ') n[ch] = (n[ch] ?? 0) + 1;
    for (const ch of Object.keys(j.key).sort(cmp)) slots.push({ alts: alts(j.key[ch], itemTags), count: n[ch] ?? 0, raw: j.key[ch] });
  }
  if (Array.isArray(j.ingredients)) {
    const n = new Map();
    for (const ing of j.ingredients) {
      const k = JSON.stringify(ing);
      n.set(k, (n.get(k) ?? { raw: ing, count: 0 }));
      n.get(k).count++;
    }
    for (const [, v] of [...n].sort(([a], [b]) => cmp(a, b))) slots.push({ alts: alts(v.raw, itemTags), count: v.count, raw: v.raw });
  }
  for (const k of SLOT_KEYS) if (j[k] !== undefined) slots.push({ alts: alts(j[k], itemTags), count: 1, raw: j[k] });
  return { id: `minecraft:${id}`, type: j.type, out: q(out), n: j.result?.count ?? 1, slots: slots.filter((s) => s.count > 0), cooking: COOKING.has(j.type) };
}

/** Does a loot condition (a predicate reference, an inline predicate or a list) require silk touch? */
function needsSilk(c, preds) {
  if (!c) return false;
  if (Array.isArray(c)) return c.some((x) => needsSilk(x, preds));
  if (typeof c === 'string') return c === SILK || needsSilk(preds[c], preds);
  switch (c.type) {
    case 'minecraft:all_of': return c.terms.some((t) => needsSilk(t, preds));
    case 'minecraft:any_of': return c.terms.every((t) => needsSilk(t, preds));
    case 'minecraft:inverted': return false;
    case 'minecraft:reference': return needsSilk(c.name, preds);
    case 'minecraft:match_tool': return JSON.stringify(c.predicate ?? {}).includes('minecraft:silk_touch');
    default: return false;
  }
}

/** The items a loot table can yield: Map item -> silk-only (true when every way to it needs silk touch). */
function lootItems(table, tables, itemTags, preds, seen = new Set()) {
  const out = new Map();
  const put = (i, silk) => out.set(i, out.has(i) ? out.get(i) && silk : silk);
  const walk = (e, silk) => {
    const s = silk || needsSilk(e.condition, preds) || needsSilk(e.conditions, preds);
    switch (e.type) {
      case 'minecraft:item': put(q(e.name), s); break;
      case 'minecraft:tag': for (const i of itemTags[q(String(e.items ?? e.name).replace(/^#/, ''))] ?? []) put(i, s); break;
      case 'minecraft:loot_table': {
        const v = e.value ?? e.name;
        if (typeof v === 'string') {
          if (seen.has(v) || !tables[v]) break;
          for (const [i, x] of lootItems(tables[v], tables, itemTags, preds, new Set([...seen, v]))) put(i, s || x);
        } else if (v && typeof v === 'object') for (const [i, x] of lootItems(v, tables, itemTags, preds, seen)) put(i, s || x);
        break;
      }
      default: for (const c of e.children ?? []) walk(c, s);
    }
  };
  for (const p of table.pools ?? []) {
    const silk = needsSilk(p.condition, preds) || needsSilk(p.conditions, preds);
    for (const e of p.entries ?? []) walk(e, silk);
  }
  return out;
}

/** Reads the data pack: { recipes, itemTags, loot: {table: Map}, trades: [[id, item]], digests }. */
export function readDataPack(zip) {
  const itemTags = resolveTags(zip, ITEM_TAGS);
  const recipes = entries(zip, RECIPE).map(([id, j]) => parseRecipe(id, j, itemTags)).filter(Boolean);
  const preds = Object.fromEntries(entries(zip, 'data/minecraft/predicate/').map(([id, j]) => [`minecraft:${id}`, j]));
  const tables = Object.fromEntries(entries(zip, LOOT).map(([id, j]) => [`minecraft:${id}`, j]));
  const loot = {};
  for (const t of Object.keys(tables).sort(cmp)) loot[t] = lootItems(tables[t], tables, itemTags, preds, new Set([t]));
  const trades = [];
  for (const [id, j] of entries(zip, TRADE)) if (j.gives?.id) trades.push([`minecraft:${id}`, q(j.gives.id)]);
  return { recipes, itemTags, loot, trades, digests: digests(zip) };
}

/**
 * Tarjan's strongly connected components over `nodes` (sorted) and `deps(n)`: the lexically smallest node of every component that
 * depends on nothing outside itself (a cycle with no way in, or a node with no dependency left).
 */
function terminalPicks(nodes, deps) {
  const index = new Map();
  const low = new Map();
  const on = new Set();
  const stack = [];
  const comps = [];
  let i = 0;
  const visit = (v) => {
    index.set(v, i); low.set(v, i); i++;
    stack.push(v); on.add(v);
    for (const w of deps(v)) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const c = [];
      let w;
      do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v);
      comps.push(c);
    }
  };
  for (const n of nodes) if (!index.has(n)) visit(n);
  const out = [];
  for (const c of comps) {
    const set = new Set(c);
    if (c.every((v) => deps(v).every((w) => set.has(w)))) out.push([...c].sort(cmp)[0]);
  }
  return out.sort(cmp);
}

/** The stem a multi-alternative ingredient's members must share to join a family (`stripped_oak_wood` -> `oak`). */
export const stemOf = (id) => id.replace(/^minecraft:/, '').replace(/^stripped_/, '').replace(/_(log|wood|stem|hyphae|block)$/, '');

/**
 * The per-block edges (CONTRACT VOC §1, §2.1-2.4).
 * @param {object} o
 * @param {object} o.report blocks.json (the block ids)
 * @param {object} o.blocks the kit's block table rows ({i} the item when it differs; '' = none)
 * @param {object} o.pack readDataPack()'s result
 * @param {object} o.vdump VocabDump's {id: {rt, ff, next?, waxed?}}
 * @param {object} o.dump BlockDump's {id: {be}}
 * @param {object} o.tiers kit/vocab/tiers.json
 * @param {object} o.modifiers kit/vocab/modifiers.json
 * @param {object} o.survival kit/vocab/survival.json (its `obtain` rows: items gameplay yields that no data names)
 */
export function deriveEdges({ report, blocks, pack, vdump, dump, tiers, modifiers, survival }) {
  const ids = Object.keys(report).sort(cmp);
  const itemOf = (b) => (blocks[b].i === undefined ? b : blocks[b].i ? q(blocks[b].i) : '');
  // an item that is a block's own item (string is tripwire's item, not a block of its own)
  const isBlockItem = new Set(ids.map(itemOf).filter((i) => i && report[i]));
  const mods = new Set(modifiers.rows.map((r) => r.item));
  const stops = new Set();
  for (const r of tiers.rows) {
    if (r.key.startsWith('#')) for (const i of pack.itemTags[r.key.slice(1)] ?? []) stops.add(i);
    else if (!r.key.startsWith('fam:')) stops.add(r.key);
  }

  // ---- family links (node = the block's item, else the block): only recipes whose output is a block item
  const links = new Map();
  const link = (a, b) => {
    if (a === b) return;
    if (!links.has(a)) links.set(a, new Set());
    links.get(a).add(b);
  };
  const cooked = new Map();
  const unjoined = new Map();
  const one = (r) => (r.slots.length === 1 && r.slots[0].alts.length === 1 ? r.slots[0].alts[0] : null);
  const storage = new Set();
  for (const r of pack.recipes) {
    const from = one(r);
    if (!from || isBlockItem.has(r.out) || !isBlockItem.has(from) || r.cooking) continue;
    if (pack.recipes.some((b) => b.out === from && one(b) === r.out)) storage.add(r.out);
  }
  for (const r of pack.recipes) {
    if (!isBlockItem.has(r.out)) continue;
    if (r.cooking) {
      for (const s of r.slots) for (const a of s.alts) {
        if (!cooked.has(r.out)) cooked.set(r.out, new Set());
        cooked.get(r.out).add(a);
      }
      continue;
    }
    if (r.type !== 'minecraft:stonecutting' && r.type !== 'minecraft:crafting_shaped' && r.type !== 'minecraft:crafting_shapeless') continue;
    const mats = r.slots.filter((s) => !(s.alts.length === 1 && mods.has(s.alts[0])));
    const a = mats.length === 1 ? mats[0].alts : null;
    if (!a || (a.length > 1 && new Set(a.map(stemOf)).size !== 1)) {
      // the evidence for a listed split: the first recipe (by id) that joins nothing, with its materials (first alternative each)
      const cur = unjoined.get(r.out);
      if (!cur || r.id < cur[0]) unjoined.set(r.out, [r.id, mats.map((s) => s.alts[0] ?? '?').sort(cmp)]);
      continue;
    }
    // a non-block item joins only as a storage material (a block decrafts into it and is made from it: copper_ingot, iron_ingot),
    // so string doesn't join candles to wool and a brick doesn't join flower pots to bricks
    for (const x of a) if (isBlockItem.has(x) || storage.has(x)) link(r.out, x);
  }

  // ---- obtainable items: loot (block tables: drop or silk; other tables: loot), trades, then recipes to a fixpoint
  const src = new Map(); // item -> {sv, src}
  const rank = { craft: 0, drop: 1, silk: 2, loot: 3 };
  const offer = (i, sv, s) => {
    const cur = src.get(i);
    if (!cur || rank[sv] < rank[cur.sv] || (rank[sv] === rank[cur.sv] && s < cur.src)) src.set(i, { sv, src: s });
  };
  for (const [t, items] of Object.entries(pack.loot)) {
    const isBlock = t.startsWith('minecraft:blocks/');
    for (const [i, silk] of items) offer(i, isBlock ? (silk ? 'silk' : 'drop') : 'loot', `loot ${t}`);
  }
  for (const [t, i] of pack.trades) offer(i, 'loot', `trade ${t}`);
  for (const r of survival.obtain) offer(r.item, r.sv, `survival.json obtain ${r.item}`);
  const obtain = new Set(src.keys());
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of pack.recipes) {
      if (r.slots.every((s) => s.alts.some((a) => obtain.has(a)))) {
        if (!obtain.has(r.out)) { obtain.add(r.out); grew = true; }
        offer(r.out, 'craft', `recipe ${r.id}`);
      }
    }
  }

  // ---- the cheapest recipe path (fewest raw items; cooking counts, the fuel doesn't), stopping at a tiers.json item
  const byOut = new Map();
  for (const r of pack.recipes) {
    if (!byOut.has(r.out)) byOut.set(r.out, []);
    byOut.get(r.out).push(r);
  }
  const raw = new Set();
  const cost = new Map();
  const best = new Map();
  const isRaw = (i) => stops.has(i) || !byOut.has(i) || raw.has(i);
  /** A slot's cheapest alternative (ties by id). */
  const pickAlt = (sl) => {
    let pick = null;
    let m = Infinity;
    for (const a of sl.alts) {
      const c = isRaw(a) ? 1 : cost.get(a) ?? Infinity;
      if (c < m - 1e-9 || (Math.abs(c - m) <= 1e-9 && pick !== null && a < pick)) { m = c; pick = a; }
    }
    return pick;
  };
  /** Does recipe r's cheapest path (its ingredients' current best recipes) pass through item o? */
  const loopsBack = (r, o) => {
    const seen = new Set();
    const walk = (i) => {
      if (i === o) return true;
      if (isRaw(i) || seen.has(i) || !best.has(i)) return false;
      seen.add(i);
      return best.get(i).slots.some((sl) => { const p = pickAlt(sl); return p !== null && walk(p); });
    };
    return r.slots.some((sl) => { const p = pickAlt(sl); return p !== null && walk(p); });
  };
  for (let round = 0; round < 64; round++) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [o, rs] of byOut) {
        if (isRaw(o)) continue;
        for (const r of [...rs].sort((a, b) => cmp(a.id, b.id))) {
          let c = 0;
          for (const s of r.slots) {
            let m = Infinity;
            for (const a of s.alts) m = Math.min(m, isRaw(a) ? 1 : cost.get(a) ?? Infinity);
            c += m * s.count;
          }
          c /= r.n;
          const cur = cost.get(o) ?? Infinity;
          // a tie goes to the smaller recipe id, unless that recipe's path comes back through o (coal from a coal block)
          if (c < cur - 1e-9 || (Math.abs(c - cur) <= 1e-9 && r.id < best.get(o).id && !loopsBack(r, o))) {
            if (c < cur - 1e-9) changed = true;
            cost.set(o, c);
            best.set(o, r);
          }
        }
      }
    }
    // an item made only through a cycle with no way in (coal <-> a coal block, stone <-> cobblestone) is raw itself: in every cycle
    // the rest waits on (a terminal strongly connected component of the items still without a cost), its lexically smallest item
    const stuck = [...byOut.keys()].filter((o) => !isRaw(o) && !cost.has(o)).sort(cmp);
    if (!stuck.length) break;
    for (const o of terminalPicks(stuck, (o) => [...new Set(byOut.get(o).flatMap((r) => r.slots.flatMap((sl) => sl.alts)))].filter((a) => !isRaw(a) && !cost.has(a)).sort(cmp))) raw.add(o);
  }
  const rawOf = (i, seen = new Set()) => {
    if (isRaw(i) || seen.has(i)) return new Set([i]);
    const r = best.get(i);
    const s = new Set();
    seen.add(i);
    for (const sl of r.slots) {
      const pick = pickAlt(sl);
      if (pick) for (const x of rawOf(pick, seen)) s.add(x);
    }
    seen.delete(i);
    return s;
  };

  const out = {};
  for (const b of ids) {
    const e = {};
    const node = itemOf(b) || b;
    if (links.has(node)) e.j = [...links.get(node)].sort(cmp).map((x) => x.replace(/^minecraft:/, ''));
    if (cooked.has(node)) e.ck = [...cooked.get(node)].sort(cmp).map((x) => x.replace(/^minecraft:/, ''));
    if (!links.has(node) && unjoined.has(node)) { const [rid, m] = unjoined.get(node); e.nj = [rid.replace(/^minecraft:/, ''), m.map((x) => x.replace(/^minecraft:/, ''))]; }
    const item = itemOf(b);
    if (item && byOut.has(item) && !stops.has(item) && !raw.has(item) && cost.has(item)) {
      e.raw = [...rawOf(item)].sort(cmp).map((x) => x.replace(/^minecraft:/, ''));
      e.rp = best.get(item).id.replace(/^minecraft:/, '');
    }
    if (item) {
      const s = src.get(item);
      if (s) { e.sv = s.sv; e.src = s.src.replace(/minecraft:/g, ''); } else e.sv = 'none';
    } else e.sv = 'none';
    const v = vdump[b];
    if (v?.rt) e.rt = 1;
    if (v?.next || v?.waxed) e.wx = { ...(v.next ? { next: v.next.replace(/^minecraft:/, '') } : {}), ...(v.waxed ? { waxed: v.waxed.replace(/^minecraft:/, '') } : {}) };
    if (dump[b]?.be) e.be = 1;
    if (v?.ff?.length) e.ff = v.ff;
    out[b.replace(/^minecraft:/, '')] = e;
  }
  // the item tags tiers.json keys name (the no-jar run resolves tag rows from these)
  const tagRows = {};
  for (const r of tiers.rows) if (r.key.startsWith('#')) tagRows[r.key] = (pack.itemTags[r.key.slice(1)] ?? []).map((x) => x.replace(/^minecraft:/, ''));
  return { blocks: out, tagRows };
}
