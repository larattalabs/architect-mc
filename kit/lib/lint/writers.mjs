// (fast checks P2, docs/FAST-CHECKS.md "Precondition for every REPLACE row") The writer kind of every cell a plan writes: the unit the
// realised == virtual SMOKE row counts by, so a lint over the virtual world is trusted per writer kind only while one in-game cell diff
// of that kind holds at the slice tier. The kinds: ground, relief, street, route, forms, lots, props, scatter, walls, bridges (beam,
// arch, slab), rope, tunnels, fluids, (7a CW) catwalks. Shared by tools/lib/realised-virtual.mjs (the in-game row) and the lints' coverage map.
//
// A cell's kind comes from the plan meta's connector records first (a bridge, tunnel, rope or wall record names its part and box: its
// cells inside that box are the connector's), then from the part's ops (fluid, scatter, relief, voxels), then its stage and id.

export const WRITER_KINDS = Object.freeze(['ground', 'relief', 'street', 'route', 'forms', 'lots', 'props', 'scatter', 'walls', 'bridges', 'rope', 'tunnels', 'fluids', 'catwalks', 'spirals']);

const inBox = (b, x, y, z) => b && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ;

/** The kind of a part from its ops, stage and id (no connector record). */
export function partKind(ir, p) {
  if (!p) return 'ground';
  const ops = new Set((p.ops ?? []).map((o) => o.op));
  const id = p.id;
  if (ops.has('fluid')) return 'fluids';
  if (ops.has('scatter')) return 'scatter';
  if (ops.has('relief')) return 'relief';
  if (/^w_|(^|_)wall(s|_|$)/.test(id)) return 'walls';
  if (/(^|_)bridges?(_|$)/.test(id)) return 'bridges';
  if (/(^|_)tunnels?(_|$)/.test(id)) return 'tunnels';
  if (/(^|_)ropes?(_|$)/.test(id)) return 'rope';
  if (ops.has('voxels') || p.stage === 'forms' || (ir.forms ?? []).some((f) => (f.part ?? f.id) === id)) return 'forms';
  if (/(^|_)pads$|^lot_pads$|^pads$/.test(id)) return 'lots';
  if (p.stage === 'props' || /(^|_)props(_|$)|(^|_)lamps$|(^|_)lanterns$|(^|_)rails$/.test(id)) return 'props';
  if (/^(routes?|links|ways|services)$|(^|_)routes?$|(^|_)links$/.test(id) || p.stage === 'routes' || p.stage === 'links' || p.stage === 'ways') return 'route';
  if (/(^|_)(street|square|verges|lanes|path|green|landing)$/.test(id) || p.stage === 'street') return 'street';
  return 'ground';
}

/**
 * A classifier `(x, y, z, partIndex) -> {kind, sub}` for a plan (`meta`: the plan's meta.json, optional). `sub`: a bridge's form
 * (beam, arch, slab) or null.
 */
export function writerKinds(ir, meta = null) {
  const recs = [];
  for (const b of meta?.bridges ?? []) recs.push({ kind: 'bridges', sub: b.form ?? null, part: b.part, box: b.box });
  for (const t of meta?.tunnels ?? []) recs.push({ kind: 'tunnels', sub: null, part: t.part, box: t.box }, ...(t.liningPart ? [{ kind: 'tunnels', sub: 'lining', part: t.liningPart, box: t.box }] : []));
  for (const r of meta?.ropes ?? []) recs.push({ kind: 'rope', sub: 'slab', part: r.part, box: r.box ?? null });
  for (const w of meta?.walls ?? []) recs.push({ kind: 'walls', sub: null, part: w.part ?? null, box: w.box ?? null });
  for (const c of meta?.catwalks ?? []) recs.push({ kind: 'catwalks', sub: null, part: c.part, box: c.box }); // (7a CW)
  for (const c of meta?.spirals ?? []) recs.push({ kind: 'spirals', sub: null, part: c.part, box: null }); // (7a SA)
  const kinds = ir.parts.map((p) => partKind(ir, p));
  return (x, y, z, pi) => {
    const p = ir.parts[pi];
    for (const r of recs) if ((!r.part || r.part === p?.id) && (!r.box ? r.part === p?.id : inBox(r.box, x, y, z))) return { kind: r.kind, sub: r.sub };
    return { kind: pi >= 0 ? kinds[pi] : 'ground', sub: null };
  };
}
