// (7b DS) The designer's site inputs (docs/SETTLEMENTS.md §7.3): the "Site" section of BRIEF.md in words generated from the
// site analysis (lib/region/affordances.mjs, the same analysis as Survey.site and a region plan's affordances[]), the fit
// table's row in plain words, the ports and the keep cells, and the four renders of the EMPTY site (iso from the open side,
// the section through the lot, the top, and the composite camera the gallery and the composite view use).
//
// Everything is in the design's own frame (front south, +x east, +z south, the lot box's minimum corner at 0,0,0), so the
// words match what the agent writes. Deterministic: no clock, no randomness; the same site gives the same bytes.
import fs from 'node:fs';
import path from 'node:path';
import { analyseSite } from './region/affordances.mjs';
import { compositeStructure } from './site.mjs';
import { buildScene, renderIso, renderTop, renderFront } from './render.mjs';
import { encodePng } from './png.mjs';
import { fitOf } from './siteFits.mjs';

/** The four empty-site renders, by key (site/<file>). */
export const SITE_RENDERS = Object.freeze({ iso: 'site-iso.png', section: 'site-section.png', top: 'site-top.png', composite: 'site-composite.png' });

/** At most this many affordances are put into words (the best first; site.json keeps them all). */
export const SITE_WORDS_MAX = 8;
/** At most this many flat pads among them on a non-pad site. */
export const SITE_PADS_MAX = 2;

const CLASS_WORDS = { ROCK: 'rock', SOIL: 'soil', LOOSE: 'sand or gravel', ICE: 'ice', SNOW: 'snow', WATER: 'water', LAVA: 'lava', LOG: 'logs', LEAVES: 'leaves', PLANT: 'plants', OWNED: 'another owner\'s blocks', PLAYER: 'player-placed blocks', BLOCK_ENTITY: 'containers or other block entities' };

const FIT_WORDS = {
  on_pad: 'on a pad: the lot is cleared and filled like any plot; the building stands on the ground row and a ground strip leads to the door',
  carve_into: 'carved into the rock: the rock is your walls and ceiling; carve only the rooms you need (at most the interior plus one layer of wall), bear on the rock, never open into water, lava or a dark cave',
  attach_to_cliff: 'attached to a cliff: the building hangs off the face on beams and brackets that end inside the rock; every bearing group touches at least 2 rock cells; long overhangs off the face are measured',
  span: 'spanning a gap: the floor runs from one rim to the other; each end bears on the rim with at least a 2x2 of bearing cells; one walk port on each side',
  wrap_trunk: 'wrapped round a trunk: a ring deck round the trunk bears on it; never write a log of the trunk (they are kept, keep-critical); the trunk passes through your rooms',
  suspend: 'hanging from an overhang: chains from the hang points carry the building; only the solid above a cell bears it; never write a hang point',
};

const TERRAIN_WORDS = { clear: 'the mod clears the lot and fills below the floor (today\'s placement)', keep: 'the mod keeps every cell you do not write: the rock, soil, water and logs stay as they are (no clearing, no fill)' };

const SUPPORT_WORDS = {
  ground: 'on the ground row',
  site_solid: 'on the site\'s solid cells (rock, soil, ice, snow, logs) next to your blocks',
  trunk_or_site_solid: 'on the trunk or the site\'s solid cells',
  up: 'from the solid above (chains, hangers)',
};

const SIDE_OF = { north: 'north (-z)', south: 'south (+z, your front)', east: 'east (+x)', west: 'west (-x)', up: 'up', down: 'down' };

/** A world box as a design box (the min and max of its corners in the design frame). */
export function designBox(site, box) {
  const cs = [];
  for (const x of [box.minX, box.maxX]) for (const z of [box.minZ, box.maxZ]) cs.push(site.toDesign(x, box.minY, z));
  const ys = [box.minY - site.frame.origin[1], box.maxY - site.frame.origin[1]];
  return { minX: Math.min(...cs.map((c) => c[0])), maxX: Math.max(...cs.map((c) => c[0])), minY: ys[0], maxY: ys[1], minZ: Math.min(...cs.map((c) => c[2])), maxZ: Math.max(...cs.map((c) => c[2])) };
}

const span = (a, b) => (a === b ? `${a}` : `${a}..${b}`);
const boxWords = (b) => `x ${span(b.minX, b.maxX)}, y ${span(b.minY, b.maxY)}, z ${span(b.minZ, b.maxZ)}`;
const inLotWords = (site, b) => {
  const out = b.maxX < 0 || b.minX >= site.size.x || b.maxY < 0 || b.minY >= site.size.y || b.maxZ < 0 || b.minZ >= site.size.z;
  return out ? ' (outside your lot, in the margin)' : '';
};

/** One affordance in words, in the design frame. */
export function affordanceWords(site, a) {
  const m = a.metrics ?? {};
  const b = designBox(site, a.box);
  const where = `${boxWords(b)}${inLotWords(site, b)}`;
  const facing = a.normal ? site.worldFacing(a.normal, true) : null;
  const faces = facing ? `facing ${SIDE_OF[facing] ?? facing}` : '';
  switch (a.kind) {
    case 'cliff_face': return `a cliff face ${faces}, ${m.height} tall and ${m.length} long (drift ${m.drift}), at ${where}`;
    case 'ledge': return `a ledge ${m.depth} deep and ${m.length} long with a drop of ${m.drop} ${faces}, at ${where}`;
    case 'overhang': return `an overhang of ${m.area} cells${m.clearance !== undefined ? ` with ${m.clearance} clear below it` : ''}${m.thickness !== undefined ? `, ${m.thickness} thick` : ''}${facing ? `, open to the ${facing}` : ''}, at ${where}`;
    case 'cave': return `a cave of ${m.cells} air cells (floor ${m.floorArea}, ceiling ${m.ceiling})${facing ? `, its mouth ${faces}` : ''}, at ${where}`;
    case 'trunk': {
      const r = m.radius ?? {};
      return `a tree trunk ${m.height} tall, radius about ${r.base ?? '?'} at the base and ${r.top ?? '?'} at the top, at ${where}`;
    }
    case 'canopy': return `a canopy of leaves (${m.area} cells across, ${m.layers} layers, over ${m.trunks} trunk column${m.trunks === 1 ? '' : 's'}), at ${where}`;
    case 'spike': return `a spike of ${String(m.material ?? 'rock').toLowerCase()} ${m.height} tall and ${m.width} wide, at ${where}`;
    case 'water': return `water: ${m.area} columns at surface y ${m.surfaceY - site.frame.origin[1]}, up to ${m.maxDepth} deep, at ${where}`;
    case 'gap': return `a gap ${m.span} wide between two faces (overlap ${m.length} long and ${m.height} tall), at ${where}`;
    case 'pad': return `a flat pad ${m.size}x${m.size} (ground range ${m.range}), at ${where}`;
    default: return `${a.kind} at ${where}`;
  }
}

/** The lot's cells by class (inside the lot box only), most first, as words with shares. */
export function lotMakeup(site) {
  const n = new Map();
  let total = 0;
  for (let x = 0; x < site.size.x; x++) for (let y = 0; y < site.size.y; y++) for (let z = 0; z < site.size.z; z++) {
    const c = site.at(x, y, z);
    n.set(c, (n.get(c) ?? 0) + 1);
    total++;
  }
  return [...n.entries()].filter(([c]) => c !== 'MISSING').sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([c, k]) => ({ cls: c, cells: k, share: Math.round((k / total) * 100) }));
}

/**
 * The site's analysis for the designer: the affordances that meet the lot (grown by the margin), best first, and the frame proposed
 * for the fit. `{affordances, proposed, near}` (`near`: the ones in words, at most SITE_WORDS_MAX).
 */
export function siteAnalysis(site) {
  const { affordances, proposed } = analyseSite(site.volume, site.lot, site.fit);
  const g = site.margin;
  const L = site.lot;
  const meets = (b) => b.maxX >= L.minX - g && b.minX <= L.maxX + g && b.maxY >= L.minY - g && b.minY <= L.maxY + g && b.maxZ >= L.minZ - g && b.minZ <= L.maxZ + g;
  // pads say little about a non-pad site: they go last, at most SITE_PADS_MAX of them (an on_pad site keeps SITE_WORDS_MAX)
  const close = affordances.filter((a) => meets(a.box));
  const pads = close.filter((a) => a.kind === 'pad').slice(0, site.fit === 'on_pad' ? SITE_WORDS_MAX : SITE_PADS_MAX);
  const near = [...close.filter((a) => a.kind !== 'pad'), ...pads].slice(0, SITE_WORDS_MAX);
  return { affordances, proposed, near };
}

/** site.json for the scratch dir: the lot, the spec (what kit/lib/site.mjs reads), the fit's row, ports, keep hints and the analysis. */
export function siteJson(site, analysis = siteAnalysis(site)) {
  return {
    comment: 'GENERATED by the sidecar (7b DS) for the designer: build with --site site/site.arvx --lot site/site.json',
    lot: { ...site.lot },
    size: { ...site.size },
    fit: site.fit,
    fitRow: fitOf(site.fit),
    spec: site.spec,
    ports: site.ports.map((p) => ({ ...p })),
    keepCritical: site.keepCritical.map((c) => [...c]),
    affordances: analysis.affordances,
    proposed: analysis.proposed,
  };
}

/** The "Site" section of BRIEF.md (lines). `renders`: the render files written (site/<file>), if any. */
export function siteSection(site, { analysis = siteAnalysis(site), renders = [], arvx = 'site/site.arvx', lot = 'site/site.json' } = {}) {
  const row = fitOf(site.fit);
  const s = site.size;
  const lines = [
    '## Site (binding: you build INTO this land)',
    '',
    `This building is designed for one site: \`${arvx}\` (the frozen land, ARVX) and \`${lot}\` (the lot, its fit, its ports and the analysis). The kit's \`Site\` (\`kit/lib/site.mjs\`) reads them: your default export gets it as \`site\` (\`build({ palette, site, ...values })\`).`,
    '',
    `- **The lot:** your template is exactly the lot box, ${s.x} x ${s.y} x ${s.z} (x, y, z), in the design frame: the lot's minimum corner is 0,0,0, +x east, +y up, +z south, the front south. The site's frame turns it into the world (${site.frame.rotation === 'none' ? 'no turn' : site.frame.rotation.replace(/_/g, ' ')}); never move or turn it. The land reaches ${site.margin} cells past the lot on every side (the margin: you can see it, you can't build there).`,
    `- **What the lot holds now:** ${lotMakeup(site).map((c) => `${CLASS_WORDS[c.cls] ?? c.cls.toLowerCase()} ${c.share}%`).join(', ')}.`,
  ];
  if (analysis.near.length) {
    lines.push('- **The land (from the site analysis, best first):**');
    for (const a of analysis.near) lines.push(`  - ${affordanceWords(site, a)}`);
  } else {
    lines.push('- **The land:** the site analysis found no cliff face, ledge, overhang, cave, trunk, canopy, spike, water, gap or pad near the lot.');
  }
  lines.push(
    `- **Fit: \`${site.fit}\`**, ${FIT_WORDS[site.fit]}. Set \`fit: '${site.fit}'\` and \`site\` on the Blueprint (\`new Blueprint({ ..., fit, site, size: site.size })\`).`,
    `  - Terrain: ${TERRAIN_WORDS[row.terrain]}.`,
    `  - Support: every block bears, through your blocks, ${SUPPORT_WORDS[row.bears] ?? row.bears} (the checker's \`${row.support}\`).`,
  );
  if (site.keepCritical.length) lines.push(`  - Keep: ${site.keepCritical.length} keep-critical cell${site.keepCritical.length === 1 ? '' : 's'} (\`site.keepCritical\`${site.fit === 'suspend' ? ', the hang points' : site.fit === 'wrap_trunk' ? ', the trunk\'s logs' : ''}): never write one, not even air (\`bp.keep(...)\`; the checker's \`site_keep\` is an error).`);
  const ports = site.ports;
  if (ports.length) {
    lines.push(`- **Ports (where the paths arrive; the approach is a port, not a ground strip):** ${row.ports > 0 ? `at least ${row.ports} walk or door port${row.ports === 1 ? '' : 's'}; ` : ''}put a design port of the same name, kind and facing within 2 of each hint, facing out, standable (\`bp.port(name, kind, ...site.portHint(name), facing)\`):`);
    for (const p of ports) lines.push(`  - \`${p.name}\` (${p.kind}) at ${p.at.join(', ')}, facing ${SIDE_OF[p.facing] ?? p.facing}, ${p.width} wide and ${p.height} tall${p.edge ? `, to the path \`${p.edge}\`` : ''}`);
    lines.push('  - Every floor level must be reachable from a port (the checker\'s `floors_reachable`).');
  } else if (row.approach === 'port') {
    lines.push('- **Ports:** the site names none: the way in is the player\'s to build. Still give the building an outside door the player can reach.');
  }
  if (renders.length) lines.push(`- **The empty site, rendered:** ${renders.map((f) => `\`${f}\``).join(', ')} (iso from the open side, the section through the lot, the top, and the composite camera your design will be judged in). Read them before you plan.`);
  lines.push('- **Build into the site:** `--site ' + arvx + ' --lot ' + lot + '` on the build (it checks on the composite: the site rules `site_keep`, `fit:' + site.fit + '`, `ports_met`, `floors_reachable`, `site_breach`, `cut_volume`, `cantilever`, `neck`), and `--views iso,composite,section` with `--site` on the renderer to see the design IN its land.', '');
  return lines;
}

/** Write the four empty-site renders into `dir`; returns their file names (SITE_RENDERS order). */
export function renderEmptySite(site, dir, { width } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const empty = { DataVersion: 0, size: [site.size.x, site.size.y, site.size.z], palette: [], blocks: [], entities: [] };
  const whole = compositeStructure(empty, site).structure;
  const cut = compositeStructure(empty, site, { cut: Math.floor((site.size.z - 1) / 2) }).structure;
  // the open side: the face or mouth the proposed frame turned the front to is south in the design frame; an iso from the
  // front-left shows it. The composite camera is the iso of the whole window from the front-left too, so the "iso" looks from
  // the opposite (back-right) side when the lot is open to the north (a span, a trunk), else from the front.
  const unknown = new Set();
  const open = openSide(site);
  const images = {
    iso: renderIso(buildScene(whole, { front: open, unknown }), { width }),
    section: renderFront(buildScene(cut, { unknown }), {}),
    top: renderTop(buildScene(whole, { unknown }), {}),
    composite: renderIso(buildScene(whole, { unknown }), { width }),
  };
  const out = [];
  for (const k of Object.keys(SITE_RENDERS)) {
    const img = images[k];
    fs.writeFileSync(path.join(dir, SITE_RENDERS[k]), encodePng(img.width, img.height, img.data));
    out.push(SITE_RENDERS[k]);
  }
  return out;
}

/** The side of the lot most open to the air (by the share of air cells in the lot's outer layer per side), in the design frame. */
export function openSide(site) {
  const sides = { south: 0, north: 0, east: 0, west: 0 };
  const { x: X, y: Y, z: Z } = site.size;
  const air = (x, y, z) => (site.at(x, y, z) === 'AIR' ? 1 : 0);
  for (let y = 0; y < Y; y++) {
    for (let x = 0; x < X; x++) { sides.north += air(x, y, -1); sides.south += air(x, y, Z); }
    for (let z = 0; z < Z; z++) { sides.west += air(-1, y, z); sides.east += air(X, y, z); }
  }
  const share = { south: sides.south / (X * Y), north: sides.north / (X * Y), east: sides.east / (Z * Y), west: sides.west / (Z * Y) };
  return ['south', 'west', 'east', 'north'].reduce((best, s) => (share[s] > share[best] + 1e-9 ? s : best), 'south');
}
