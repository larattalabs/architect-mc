// (7c CM-a) Composites: one building past the 96x64x96 template cap, made of modules (each a Blueprint within the cap) joined at
// `architect:joint` ports. docs/CONTRACT.md "Phase 7c" §3 row 5 and "Slice CM-a as built".
//
//   import { Composite, joint } from '../../lib/composite.mjs';
//   const c = new Composite({ id: 'castle', type: 'castle', front: 'south', palette: p });
//   c.module('west', westBp, { at: [0, 0, 0] });          // westBp: a Blueprint within MODULE_CAP; `at` = its min corner in the union
//   c.module('centre', centreBp, { at: [40, 0, 0] });     // boxes may share one seam layer (the cells both write must agree)
//   c.join('west.arch_e', 'centre.arch_w');               // two joint ports: the same union cell, opposite facings, same width and height
//   const r = c.check();                                  // the findings + every checker rule on the union grid (across the seams)
//
// A joint port is a port of kind `architect:joint` (`joint(bp, name, x, y, z, facing, { width, height })`): an opening rectangle on
// the module's boundary face in `facing`, whose cell (x, y, z) is its min corner (lowest x or z along the face, lowest row) and which
// spans `width` cells along the face and `height` rows up. Two joined ports name the same rectangle from both sides: the same union
// cell, facings opposite (each faces out of its own module), the same width and height. A joint port no join names is an error.
//
// One composite is one library entry (the union, `entryId()` = its id) and one design-group item; the modules are hidden entries
// (`moduleEntryId(m)` = `<id>__<m>`) that only the composite's ext names (`info()`: 7cF's CompositeInfo wire). The modules' templates
// are cut from the union after the union's finalize (fences, walls and panes connected across the seams), so placing the modules
// writes exactly the union's blocks.
import fs from 'node:fs';
import path from 'node:path';
import { Blueprint } from './kit.mjs';
import { checkPorts, checkStructure } from './check.mjs';
import { encodeGzip, plain } from './nbt.mjs';
import { encodePartMap } from './write.mjs';

/** The port kind of a composite joint. */
export const JOINT_KIND = 'architect:joint';
/** Every module is a Blueprint within the template cap. */
export const MODULE_CAP = Object.freeze({ x: 96, y: 64, z: 96 });
/** 7cF's `CompositeInfo.EXT_KEY`: the composite's library entry carries its wire there. */
export const COMPOSITE_EXT = 'architect_mc:composite';
/** The findings' codes (each an error). */
export const FINDING_CODES = Object.freeze([
  'NO_MODULES', 'MODULE_CAP', 'MODULE_PORTS', 'MODULE_OVERLAP', 'SEAM_CONFLICT',
  'JOINT_UNKNOWN', 'JOINT_KIND', 'JOINT_REUSED', 'JOINT_UNMATCHED', 'JOINT_BOUNDARY', 'JOINT_CELL', 'JOINT_FACING', 'JOINT_WIDTH', 'JOINT_HEIGHT',
]);

const MODULE_ID = /^[a-z][a-z0-9_]{0,15}$/;
const HORIZONTAL = ['north', 'south', 'east', 'west'];
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
const key = (x, y, z) => `${x},${y},${z}`;
const stateKey = (c) => JSON.stringify([c.state.name, Object.entries(c.state.props ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), c.nbt ?? null]);

/**
 * A joint port on `bp` (design coordinates, as `bp.port`): kind `architect:joint`, the min corner of a `width` x `height` opening on
 * the boundary face the port faces (horizontal facings only).
 */
export function joint(bp, name, x, y, z, facing, { width = 1, height = 1 } = {}) {
  bp.port(name, JOINT_KIND, x, y, z, facing);
  const p = bp.ports.find((q) => q.name === name);
  p.width = width;
  p.height = height;
  return bp;
}

/** The cells of a joint port's rectangle, in its module's template coordinates. */
export function jointCells(p) {
  const out = [];
  const alongX = p.facing === 'north' || p.facing === 'south';
  for (let dy = 0; dy < p.height; dy++) for (let a = 0; a < p.width; a++) out.push(alongX ? [p.x + a, p.y + dy, p.z] : [p.x, p.y + dy, p.z + a]);
  return out;
}

/** Is a joint port's rectangle on its module's boundary face in its facing, inside the template? */
function onBoundary(p, size) {
  if (!HORIZONTAL.includes(p.facing)) return false;
  const face = { east: p.x === size.x - 1, west: p.x === 0, south: p.z === size.z - 1, north: p.z === 0 }[p.facing];
  return face && jointCells(p).every(([x, y, z]) => x >= 0 && y >= 0 && z >= 0 && x < size.x && y < size.y && z < size.z);
}

export class Composite {
  /**
   * @param {{id:string, name?:string, description?:string, type?:string, tags?:string[], front?:string, groundY?:number,
   *   palette?:object, profile?:string[], interior?:number[]|object, approach?:false|object, ext?:object}} o
   * `interior`: the union's interior box (union coordinates); default the box round every module's interior. `groundY`: the union's
   * ground row (default the first module's, offset by its `at`).
   */
  constructor(o) {
    if (!/^[a-z0-9_]+$/.test(o?.id ?? '')) throw new Error(`composite id must match [a-z0-9_]+ (got '${o?.id}')`);
    this.o = { ...o };
    this.id = o.id;
    /** [{id, bp, at:[x,y,z]}] in declaration order */
    this.modules = [];
    /** [{a:{module, port}, b:{module, port}}] in declaration order */
    this.joins = [];
    /** union-coordinate anchors the composite sets itself (they win over the modules') */
    this.anchors = {};
    this._union = null;
  }

  /** Add a module: `bp` a Blueprint (within MODULE_CAP; checked by findings()), `at` its template's min corner in the union. */
  module(id, bp, { at = [0, 0, 0] } = {}) {
    if (!MODULE_ID.test(id ?? '')) throw new Error(`${this.id}: module id '${id}' must match ${MODULE_ID}`);
    if (this.modules.some((m) => m.id === id)) throw new Error(`${this.id}: module '${id}' added twice`);
    if (!(bp instanceof Blueprint)) throw new Error(`${this.id}: module '${id}' must be a Blueprint`);
    if (bp.site) throw new Error(`${this.id}: module '${id}' is site-bound (a site-aware composite is not in CM-a)`);
    if (!Array.isArray(at) || at.length !== 3 || !at.every((v) => Number.isInteger(v) && v >= 0)) throw new Error(`${this.id}: module '${id}': at must be [x, y, z] whole numbers >= 0`);
    this.modules.push({ id, bp, at: [...at] });
    this._union = null;
    return this;
  }

  /** Join two joint ports, each `'<module>.<port>'` or `{module, port}`. */
  join(a, b) {
    const end = (e) => {
      if (typeof e === 'string') {
        const i = e.indexOf('.');
        if (i <= 0) throw new Error(`${this.id}: join end '${e}' must be '<module>.<port>'`);
        return { module: e.slice(0, i), port: e.slice(i + 1) };
      }
      if (!e || typeof e.module !== 'string' || typeof e.port !== 'string') throw new Error(`${this.id}: join end must be '<module>.<port>' or {module, port}`);
      return { module: e.module, port: e.port };
    };
    this.joins.push({ a: end(a), b: end(b) });
    return this;
  }

  /** A composite-level anchor in union coordinates (as Blueprint.anchor; entrance and spawn set here win over the modules'). */
  anchor(name, x, y, z, yaw = 0, pitch = 0) {
    this.anchors[name] = { x, y, z, yaw, pitch };
    this._union = null;
    return this;
  }

  /** The one library entry a composite is (and the one design-group item: Steward's `itemKey == lotId` binding holds on it). */
  entryId() { return this.id; }

  /** A module's hidden library entry id. */
  moduleEntryId(m) { return `${this.id}__${m}`; }

  /** The union box's size ({x, y, z}): every module's box from the origin. */
  size() {
    const s = { x: 0, y: 0, z: 0 };
    for (const m of this.modules) {
      s.x = Math.max(s.x, m.at[0] + m.bp.size.x);
      s.y = Math.max(s.y, m.at[1] + m.bp.size.y);
      s.z = Math.max(s.z, m.at[2] + m.bp.size.z);
    }
    return s;
  }

  /** 7cF's CompositeInfo wire: `{modules: [entryId...], joints: [{from: {module, port}, to: {module, port}}...], union: {minX..maxZ}}`. */
  info() {
    const s = this.size();
    return {
      modules: this.modules.map((m) => this.moduleEntryId(m.id)),
      joints: this.joins.map(({ a, b }) => ({ from: { module: this.moduleEntryId(a.module), port: a.port }, to: { module: this.moduleEntryId(b.module), port: b.port } })),
      union: { minX: 0, minY: 0, minZ: 0, maxX: s.x - 1, maxY: s.y - 1, maxZ: s.z - 1 },
    };
  }

  /** The kit's manifest (`<id>.composite.json`): the entry, each module's hidden entry, box and place in the union, the joins. */
  manifest() {
    return {
      id: this.id,
      entryId: this.entryId(),
      size: this.size(),
      modules: this.modules.map((m) => ({ id: m.id, entryId: this.moduleEntryId(m.id), at: [...m.at], size: { ...m.bp.size } })),
      joints: this.joins.map(({ a, b }) => ({ from: { ...a }, to: { ...b } })),
    };
  }

  /**
   * The composite's own findings (each an error): `[{code, message, module?, joint?}]`, sorted as found (modules, overlaps, seams,
   * joins, then unmatched ports). The union checker's rules are `check()`'s.
   */
  findings() {
    const out = [];
    const add = (code, message, extra = {}) => out.push({ code, message, ...extra });
    if (!this.modules.length) { add('NO_MODULES', `${this.id}: a composite needs at least one module`); return out; }
    const byId = new Map(this.modules.map((m) => [m.id, m]));
    for (const m of this.modules) {
      const s = m.bp.size;
      if (s.x > MODULE_CAP.x || s.y > MODULE_CAP.y || s.z > MODULE_CAP.z) add('MODULE_CAP', `module '${m.id}': ${s.x}x${s.y}x${s.z} is over the cap ${MODULE_CAP.x}x${MODULE_CAP.y}x${MODULE_CAP.z}`, { module: m.id });
      for (const e of checkPorts(m.bp.ports, [s.x, s.y, s.z])) add('MODULE_PORTS', `module '${m.id}': ${e}`, { module: m.id });
    }
    // boxes: apart, or sharing one seam layer (an intersection one cell thick on some axis)
    for (let i = 0; i < this.modules.length; i++) for (let j = i + 1; j < this.modules.length; j++) {
      const A = this.modules[i]; const B = this.modules[j];
      const t = ['x', 'y', 'z'].map((ax, k) => Math.min(A.at[k] + A.bp.size[ax], B.at[k] + B.bp.size[ax]) - Math.max(A.at[k], B.at[k]));
      if (t.every((v) => v > 0) && !t.some((v) => v === 1)) add('MODULE_OVERLAP', `modules '${A.id}' and '${B.id}' overlap ${t.join('x')} (boxes may share one seam layer, no more)`, { module: B.id });
    }
    // seams: a cell two modules write must be the same block (state and data)
    const owner = new Map();
    const conflicts = new Map();
    for (const m of this.modules) {
      for (const [k, c] of m.bp.cells) {
        const [x, y, z] = k.split(',').map(Number);
        const u = key(x + m.at[0], y + m.at[1], z + m.at[2]);
        const prev = owner.get(u);
        if (!prev) { owner.set(u, { m: m.id, c }); continue; }
        if (stateKey(prev.c) !== stateKey(c)) {
          const pair = `${prev.m}|${m.id}`;
          if (!conflicts.has(pair)) conflicts.set(pair, []);
          conflicts.get(pair).push(`${u} (${prev.c.state.name} / ${c.state.name})`);
        }
      }
    }
    for (const [pair, cells] of conflicts) {
      const [a, b] = pair.split('|');
      add('SEAM_CONFLICT', `modules '${a}' and '${b}' write ${cells.length} shared cell(s) differently, e.g. ${cells.slice(0, 5).join('; ')}`, { module: b });
    }
    // joins
    const used = new Map();
    const portOf = (e, label) => {
      const m = byId.get(e.module);
      if (!m) { add('JOINT_UNKNOWN', `${label}: no module '${e.module}'`, { joint: label }); return null; }
      const p = m.bp.ports.find((q) => q.name === e.port);
      if (!p) { add('JOINT_UNKNOWN', `${label}: module '${e.module}' has no port '${e.port}'`, { joint: label }); return null; }
      if (p.kind !== JOINT_KIND) { add('JOINT_KIND', `${label}: port '${e.module}.${e.port}' is a '${p.kind}' port, not ${JOINT_KIND}`, { joint: label }); return null; }
      const k = `${e.module}.${e.port}`;
      if (used.has(k)) { add('JOINT_REUSED', `${label}: port '${k}' is already joined (${used.get(k)})`, { joint: label }); return null; }
      used.set(k, label);
      return { m, p };
    };
    for (const [i, { a, b }] of this.joins.entries()) {
      const label = `join #${i} ${a.module}.${a.port} <-> ${b.module}.${b.port}`;
      const A = portOf(a, label);
      const B = portOf(b, label);
      if (!A || !B) continue;
      for (const { m, p } of [A, B]) {
        if (!onBoundary(p, m.bp.size)) add('JOINT_BOUNDARY', `${label}: port '${m.id}.${p.name}' (${p.x},${p.y},${p.z} facing ${p.facing}, ${p.width}x${p.height}) is not on the module's ${p.facing} face`, { joint: label });
      }
      const ua = [A.p.x + A.m.at[0], A.p.y + A.m.at[1], A.p.z + A.m.at[2]];
      const ub = [B.p.x + B.m.at[0], B.p.y + B.m.at[1], B.p.z + B.m.at[2]];
      if (ua.some((v, k) => v !== ub[k])) add('JOINT_CELL', `${label}: the ports are at union cells ${ua.join(',')} and ${ub.join(',')} (a joint is one boundary cell)`, { joint: label });
      if (OPPOSITE[A.p.facing] !== B.p.facing) add('JOINT_FACING', `${label}: facings ${A.p.facing} and ${B.p.facing} are not opposite`, { joint: label });
      if (A.p.width !== B.p.width) add('JOINT_WIDTH', `${label}: widths ${A.p.width} and ${B.p.width} differ`, { joint: label });
      if (A.p.height !== B.p.height) add('JOINT_HEIGHT', `${label}: heights ${A.p.height} and ${B.p.height} differ`, { joint: label });
    }
    for (const m of this.modules) {
      for (const p of m.bp.ports) {
        if (p.kind === JOINT_KIND && !used.has(`${m.id}.${p.name}`)) add('JOINT_UNMATCHED', `port '${m.id}.${p.name}' is a joint no join names`, { module: m.id });
      }
    }
    return out;
  }

  /**
   * The union as one Blueprint (union coordinates, no cap): every module's cells at its offset, parts as `<module>_<part>`, the
   * modules' non-joint ports as `<module>.<port>`, anchors (the composite's; else entrance and spawn from the first module that has
   * them, every other module anchor as `<module>_<name>`, cameras `cam_<module>_<name>`), and the composite's ext with its
   * CompositeInfo wire. A later module's cell wins a seam cell (findings() reports any that differ).
   */
  union() {
    if (this._union) return this._union;
    if (!this.modules.length) throw new Error(`${this.id}: a composite needs at least one module`);
    const s = this.size();
    const first = this.modules[0];
    const o = this.o;
    const u = new Blueprint({
      id: this.id,
      name: o.name,
      description: o.description,
      type: o.type,
      tags: o.tags,
      profile: o.profile,
      size: [s.x, s.y, s.z],
      groundY: o.groundY ?? first.bp.groundY + first.at[1],
      front: o.front ?? first.bp.front,
      palette: o.palette ?? first.bp.p,
      approach: o.approach ?? (first.bp.approach.length === 0 ? false : { ...first.bp.approach }),
      ext: { ...(o.ext ?? {}), [COMPOSITE_EXT]: this.info() },
    });
    for (const m of this.modules) {
      const [ax, ay, az] = m.at;
      for (const n of m.bp.partNames) {
        const pn = `${m.id}_${n}`;
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(pn)) throw new Error(`${this.id}: part '${pn}' (module '${m.id}', part '${n}') is too long`);
        if (!u.partNames.includes(pn)) u.partNames.push(pn);
        if (m.bp.partInfo.has(n)) u.partInfo.set(pn, { ...m.bp.partInfo.get(n) });
      }
      for (const [k, c] of m.bp.cells) {
        const [x, y, z] = k.split(',').map(Number);
        const uk = key(x + ax, y + ay, z + az);
        u.cells.set(uk, { state: { name: c.state.name, props: { ...c.state.props } }, nbt: c.nbt ?? null, ...(c.raw ? { raw: true } : {}) });
        const part = m.bp.cellPart.get(k);
        if (part) u.cellPart.set(uk, `${m.id}_${part}`);
        else u.cellPart.delete(uk);
      }
      for (const p of m.bp.ports) {
        if (p.kind === JOINT_KIND) continue;
        u.ports.push({ ...p, name: `${m.id}.${p.name}`, x: p.x + ax, y: p.y + ay, z: p.z + az });
      }
    }
    // anchors (template coordinates already: a module's anchors carry its origin)
    const shift = (a, m) => ({ ...a, x: a.x + m.at[0], y: a.y + m.at[1], z: a.z + m.at[2] });
    for (const n of ['entrance', 'spawn']) {
      if (this.anchors[n]) continue;
      const m = this.modules.find((q) => q.bp.anchors[n]);
      if (m) u.anchors[n] = shift(m.bp.anchors[n], m);
    }
    for (const m of this.modules) {
      for (const [n, a] of Object.entries(m.bp.anchors)) {
        if ((n === 'entrance' || n === 'spawn') && u.anchors[n] && m === this.modules.find((q) => q.bp.anchors[n]) && !this.anchors[n]) continue;
        const name = n.startsWith('cam_') ? `cam_${m.id}_${n.slice(4)}` : `${m.id}_${n}`;
        u.anchors[name] = shift(a, m);
      }
    }
    for (const [n, a] of Object.entries(this.anchors)) u.anchors[n] = { ...a };
    // the interior: given, else the box round the modules' interiors
    if (o.interior) u.interior(o.interior);
    else {
      const boxes = this.modules.filter((m) => m.bp.interiorBox).map((m) => {
        const b = m.bp.interiorBox;
        return [b.minX + m.at[0], b.minY + m.at[1], b.minZ + m.at[2], b.maxX + m.at[0], b.maxY + m.at[1], b.maxZ + m.at[2]];
      });
      if (boxes.length) u.interior([0, 1, 2].map((k) => Math.min(...boxes.map((b) => b[k]))).concat([3, 4, 5].map((k) => Math.max(...boxes.map((b) => b[k])))));
    }
    u.finalize();
    this._union = u;
    return u;
  }

  /**
   * A module's template cut from the finalized union (its box, its local coordinates): `{structure, sidecar, partMap}`. The sidecar is
   * the module Blueprint's own with the hidden entry id; its cells are the union's (connections across the seams included).
   */
  moduleOutput(id) {
    const m = this.modules.find((q) => q.id === id);
    if (!m) throw new Error(`${this.id}: no module '${id}'`);
    const u = this.union();
    const cut = new Blueprint({ id: this.moduleEntryId(id), size: [m.bp.size.x, m.bp.size.y, m.bp.size.z], palette: m.bp.p, type: m.bp.type });
    const [ax, ay, az] = m.at;
    for (const [k, c] of u.cells) {
      const [x, y, z] = k.split(',').map(Number);
      const lx = x - ax; const ly = y - ay; const lz = z - az;
      if (lx < 0 || ly < 0 || lz < 0 || lx >= m.bp.size.x || ly >= m.bp.size.y || lz >= m.bp.size.z) continue;
      const lk = key(lx, ly, lz);
      // raw: the union's finalize already connected it (a module-only finalize would cut the seam's connections)
      cut.cells.set(lk, { state: { name: c.state.name, props: { ...c.state.props } }, nbt: c.nbt, raw: true });
      const part = u.cellPart.get(k);
      if (part?.startsWith(`${id}_`)) {
        const pn = part.slice(id.length + 1);
        if (!cut.partNames.includes(pn)) cut.partNames.push(pn);
        cut.cellPart.set(lk, pn);
      }
    }
    const sidecar = { ...m.bp.sidecar(), id: this.moduleEntryId(id) };
    sidecar.materials = cut.materials();
    return { structure: cut.toStructure(), sidecar, partMap: cut.partMap() };
  }

  /**
   * The composite check: the findings (errors `composite: <CODE> <message>`), then every checker rule on the union grid, so walls,
   * light, floating blocks, doors, reachability and the vocabulary rules see across the seams. `opts` are checkStructure's.
   * @returns {{ok:boolean, errors:string[], warnings:string[], findings:object[], metrics:object|null}}
   */
  check(opts = {}) {
    const findings = this.findings();
    const errors = findings.map((f) => `composite: ${f.code} ${f.message}`);
    if (findings.some((f) => f.code === 'NO_MODULES')) return { ok: false, errors, warnings: [], findings, metrics: null };
    const u = this.union();
    const r = checkStructure(JSON.parse(JSON.stringify(u.sidecar())), plain(u.toStructure()), opts);
    errors.push(...r.errors);
    return { ...r, ok: errors.length === 0, errors, findings };
  }

  /**
   * Write the composite: the union entry (`<id>.nbt`, `<id>.blueprint.json` with the CompositeInfo wire in ext, `<id>.parts.nbt`),
   * each module's hidden entry (`<id>__<m>.*`, cut from the union) and the manifest (`<id>.composite.json`). Byte-stable.
   */
  write(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const u = this.union();
    const files = {};
    const put = (name, data) => { const p = path.join(dir, name); fs.writeFileSync(p, data); files[name] = p; };
    put(`${this.id}.nbt`, encodeGzip(u.toStructure()));
    put(`${this.id}.parts.nbt`, encodePartMap(u.partMap()));
    put(`${this.id}.blueprint.json`, `${JSON.stringify(u.sidecar(), null, 2)}\n`);
    for (const m of this.modules) {
      const out = this.moduleOutput(m.id);
      const eid = this.moduleEntryId(m.id);
      put(`${eid}.nbt`, encodeGzip(out.structure));
      put(`${eid}.parts.nbt`, encodePartMap(out.partMap));
      put(`${eid}.blueprint.json`, `${JSON.stringify(out.sidecar, null, 2)}\n`);
    }
    put(`${this.id}.composite.json`, `${JSON.stringify(this.manifest(), null, 2)}\n`);
    return files;
  }
}
