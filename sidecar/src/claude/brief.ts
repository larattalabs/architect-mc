// What the design agent reads (rewritten from AgentCraft's agents/claude/design.ts for general
// buildings): BRIEF.md from the request, the system prompt, the first / fix / restart prompts, and
// one line of progress per tool call.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { BUILDING_TYPES, type BuildingType, type Context, type DesignRequest, type Massing } from '../protocol.js';

/** design agent turns per job (the first + follow-ups after a failed check) */
export const MAX_DESIGN_ROUNDS = 4;

/** One style line per building type: what makes it read as that type. */
export const TYPE_GUIDE: Record<BuildingType, string> = {
  house:
    'House: a family home of one or two storeys. A clear front door with a step or a small porch, a hall or main room, a kitchen corner (furnace, smoker, barrel, cauldron), a bedroom with a bed, windows on every side in a regular rhythm, a pitched roof with an overhang, a chimney if it has a hearth.',
  cabin:
    'Cabin: a small, sturdy single-room (or one room plus a loft) dwelling in the woods. Log walls with posts at the corners (stripped logs for trim), a stone or cobblestone base and chimney, a steep gable roof of stairs with a slab ridge, small paned windows, a covered porch, lanterns and candles, a fireplace, a bed and a table inside. Warm and cosy.',
  cottage:
    'Cottage: a low, charming country home. Whitewashed or plaster walls (white/light terracotta, calcite or birch planks) framed with dark timber, a steep roof that comes down low (thatch-like: hay bales, or dark stairs), small windows with flower boxes (potted flowers, trapdoor shutters), a garden path, a round or arched door. Asymmetric and lived-in.',
  tower:
    'Tower: tall and narrow (the checker wants height >= 2 x the smaller footprint side and at least 3 floor levels reachable by stairs or ladders). Stone or brick walls, slit or arched windows on every floor, a stair or ladder that really connects the floors, a lit landing on each level, and a crown: battlements, a conical / pyramid roof, or a lookout platform with a railing.',
  shop:
    'Shop: a storefront on the ground floor with big display windows and a wide door facing the street, a counter and shelves (barrels, chests, item frames, lecterns) inside, a sign or banner above the door, an awning over the front; optionally the shopkeeper\'s rooms above.',
  tavern:
    'Tavern: a large, welcoming two-storey inn. A big common room with tables and chairs (stairs as seats), a bar counter with barrels and brewing stands, a hearth, warm lighting (lanterns, candles), a hanging sign at the door, guest rooms upstairs with beds. Timber frame over a stone ground floor suits it.',
  barn:
    'Barn: a tall farm building with a wide entrance (at least 3 wide and 3 tall: big doors or an open arch), an open interior with stalls or pens (fences, gates, hay bales), a hay loft reached by a ladder, a gambrel or steep gable roof. Wood planks (often red: crimson/mangrove/red terracotta accents) on a stone base.',
  smithy:
    'Smithy: a forge workshop. A stone or brick building, often with one open side under a roof on posts; a forge (blast furnace, furnace, campfire or lava behind iron bars, with a chimney), anvil, grindstone, smithing table, a quenching cauldron, tool racks; a small storeroom.',
  chapel:
    'Chapel: a small house of worship. A long nave with rows of pews (stairs), an aisle to an altar at the far end, tall arched or lancet windows (stained glass panes), a steep roof, a bell tower or a small steeple with a bell over the entrance, candles. Stone (stone bricks, deepslate, calcite) with a timber or slate roof.',
  gatehouse:
    'Gatehouse: a fortified gate. A passage straight through the building, front to back, at least 3 wide and 3 tall (the checker wants it), towers or thick walls on both sides, a portcullis look (iron bars / fences over the arch, kept open), a guard room with arrow slits, battlements on top reached by stairs or a ladder.',
  custom: 'Custom: no preset; the notes describe the building. Pick the closest familiar form for anything they leave open.',
};

/** One line per well-known feature; unknown ones are passed through as-is. */
export const FEATURE_GUIDE: Record<string, string> = {
  porch: 'a covered porch at the entrance (posts, a roof, a step)',
  chimney: 'a chimney rising above the roof from a fireplace or forge inside',
  balcony: 'a balcony on an upper floor with a railing, reachable from inside',
  garden: 'a small garden on the plot (flower beds, moss, potted plants, a fence), inside the maximum size',
  skylights: 'skylights (glass in the roof) over the main room; declare them so the enclosure check knows',
  courtyard: 'an open-air courtyard inside the footprint',
  big_windows: 'big windows: tall glass on the long walls',
  basement: 'a basement below the ground floor, reached by stairs, lit',
  loft: 'a loft or mezzanine reached by a ladder or stairs',
  bell: 'a bell in a small tower or under the eaves',
  fireplace: 'a fireplace (campfire in a stone surround, with a chimney)',
  well: 'a well near the entrance',
  stable: 'a stable or pen at the side',
  battlements: 'battlements along the top of the walls',
};

export function featureLine(f: string): string {
  const g = FEATURE_GUIDE[f];
  return g ? `${f} (${g})` : f.replace(/_/g, ' ');
}

/** The checker profile line the brief repeats for this type. */
export const PROFILE_LINE: Record<BuildingType, string> = {
  tower: 'height >= 2 x the smaller footprint side; >= 3 floor levels reachable from the entrance',
  barn: 'an entrance opening at least 3 wide and 3 tall (a door or an open arch)',
  gatehouse: 'a passage through the building, front to back, at least 3 wide and 3 tall',
  chapel: 'the common rules plus a minimum interior volume',
  tavern: 'the common rules plus a minimum interior volume',
  shop: 'the common rules plus a minimum interior volume',
  house: 'the common rules plus a minimum interior volume',
  cottage: 'the common rules plus a minimum interior volume',
  cabin: 'the common rules plus a minimum interior volume',
  smithy: 'the common rules plus a minimum interior volume',
  custom: 'the common rules only',
};

const isPreset = (t: string): t is BuildingType => (BUILDING_TYPES as readonly string[]).includes(t);
const DEFAULT_PROFILE = ['door', 'lit', 'no_floating'];

/** What makes a type read as that type (an open type: its name and the request). */
export function typeGuide(type: string): string {
  if (isPreset(type)) return TYPE_GUIDE[type];
  return `${type.replace(/_/g, ' ')}: an open building type (not one of the presets). Work out from the name, the style and the notes what such a building has and how it reads from outside; give it a clear entrance and the rooms its use needs.`;
}

const RULE_TEXT: Record<string, string> = {
  door: 'a closed outside door on the front face, reachable from the entrance',
  roof_closed: 'the interior closed by walls and a roof',
  floors_reachable: 'every floor level reachable from the entrance',
  lit: 'every standable interior cell lit (needs `interior`)',
  no_floating: 'nothing floating',
  interior: 'an `interior` box',
};

/** The checker profile line for a request's type (open types: their profile, default door, lit, no_floating). */
export function profileLine(type: string, profile?: string[]): string {
  if (isPreset(type)) return PROFILE_LINE[type];
  const rules = profile?.length ? profile : DEFAULT_PROFILE;
  return `this open type's profile is [${rules.join(', ')}]: ${rules
    .map((r) => {
      const [n, a] = r.split(':');
      if (n === 'min_interior_volume') return `an interior volume of at least ${a} free cells`;
      if (n === 'passage') return `a passage through the building, front to back, at least ${a!.replace('x', ' wide and ')} tall`;
      if (n === 'tall') return `height >= ${a} x the smaller footprint side`;
      return RULE_TEXT[n!] ?? r;
    })
    .join('; ')} (and the common rules: vanilla blocks, anchors, size). Set \`profile: ${JSON.stringify(rules)}\` on the Blueprint`;
}

/** The example design closest to a type (kit/designs/<example>.mjs), in order of preference. */
export function examplesFor(type: string, available: string[]): string[] {
  const prefer: Record<BuildingType, string[]> = {
    house: ['house', 'cottage', 'cabin'],
    cabin: ['cabin', 'cottage', 'house'],
    cottage: ['cottage', 'cabin', 'house'],
    tower: ['tower', 'gatehouse', 'chapel'],
    shop: ['shop', 'house', 'tavern'],
    tavern: ['tavern', 'house', 'shop'],
    barn: ['barn', 'smithy', 'cabin'],
    smithy: ['smithy', 'barn', 'cabin'],
    chapel: ['chapel', 'tower', 'house'],
    gatehouse: ['gatehouse', 'tower'],
    custom: [],
  };
  const order = [...(isPreset(type) ? prefer[type] : []), 'cabin', 'tower'];
  const out = order.filter((x, i) => available.includes(x) && order.indexOf(x) === i);
  return out.length ? out : available.slice(0, 2);
}

export interface BriefOptions {
  /** the kit has render.mjs */
  renderer: boolean;
  /** example designs in kit/designs (ids) */
  examples: string[];
  /** what the remix source is, if any */
  remix?: string;
  /** (4b) the style bible copied into bible/ */
  bible?: { id: string; version: number; name: string; roles: Record<string, string>; components: string[]; hasProse: boolean; restraint?: { heroMotifs: string[]; accentShareMax: number; detailDensity: string; windowsPerFacadeMin: number } | undefined };
  /** (5a) the kit has PLAYBOOK.md (the design playbook) */
  playbook?: boolean;
  /** (4b) renders of the group's finished earlier-wave items in neighbours/ */
  neighbours?: Array<{ file: string; entryId: string; name?: string; type: string }>;
  /** (4c) the massing copied into massing/: the one a detail pass is bound to, or the version a redirect starts from */
  massing?: { record: Massing; role: 'detail' | 'redirect'; files: string[]; maxSize?: DesignRequest['maxSize'] };
}

/** (4c) the context section (a group's site, purpose, neighbour lots), for every brief. */
export function contextSection(ctx: Context | undefined): string[] {
  if (ctx === undefined) return [];
  const text = typeof ctx === 'string' ? ctx : JSON.stringify(ctx, null, 2);
  return ['## Context', '', 'From whoever asked for this building (the site, its purpose, the neighbouring lots and the street side). Respect it:', '', typeof ctx === 'string' ? text : ['```json', text, '```'].join('\n'), ''];
}

/** (4c) the parts of a massing, one line each. */
function partLines(m: Massing): string[] {
  return Object.entries(m.parts).map(([name, p]) => {
    const q = (p ?? {}) as { box?: number[]; roof?: string; storeys?: number };
    return `  - \`${name}\`: box ${q.box ? `[${q.box.join(', ')}]` : '?'}${q.roof ? `, roof ${q.roof}` : ''}${q.storeys ? `, ${q.storeys} storey${q.storeys === 1 ? '' : 's'}` : ''}`;
  });
}

/** (4c) the binding-massing section of a detail pass's BRIEF.md. */
export function massingBindingSection(m: Massing, maxSize: DesignRequest['maxSize']): string[] {
  return [
    `## The approved massing (binding): \`${m.id}\` v${m.version}`,
    '',
    `The player approved this massing of the building; your design details it. Its source is \`massing/${m.id}.mjs\`, its sidecar (parts with boxes and roof forms, size) \`massing/${m.id}.blueprint.json\`, its renders \`massing/${m.id}.preview-*.png\`: read them first. It is binding:`,
    `- **The same part names**: wrap each mass in \`bp.part('<same name>', () => { ... }, { roof: '<same form>' })\`. The parts (design coordinates, size ${m.size.x}x${m.size.y}x${m.size.z}):`,
    ...partLines(m),
    '- **Each part\'s box within 1 of the massing\'s on every face**, and **the same roof form** per part.',
    `- **The total size within 2 of the massing\'s, and never more than x ${maxSize.x}, y ${maxSize.y}, z ${maxSize.z}** (the massing\'s size + 2, capped by the request): a bigger design is refused.`,
    '- Detail goes inside and on the masses: walls, openings, trim, roofs, furnishings, lighting. Extra parts of your own (`openings`, `furnishings`) are fine.',
    `- The check adds the massing conformance: \`--massing massing/${m.id}.blueprint.json\` in the build command below. Its size errors fail the design; fix its \`massing:\` warnings too.`,
    '',
  ];
}

/** BRIEF.md of a massing job (4c): a coarse volume design, cheap and quick. */
export function massingBrief(req: DesignRequest, bp: string, opts: BriefOptions): string {
  const m = req.maxSize;
  const examples = opts.examples.filter((e) => e.endsWith('_massing'));
  const plot = req.plot ? `- plot: a marked plot of ${req.plot.dx} x ${req.plot.dz} blocks${req.plot.height ? `, up to ${req.plot.height} high` : ''}${req.plot.front ? `, its front facing ${req.plot.front}` : ''}. Design it with \`front: 'south'\` as usual.` : '';
  const prev = opts.massing?.role === 'redirect' ? opts.massing.record : undefined;
  const lines = [
    `# Massing brief: ${req.name ?? `a ${req.style} ${req.type}`}`,
    '',
    `Massing id: \`${bp}\`. Write it as \`kit/designs/${bp}.mjs\` (\`export const id = '${bp}'\` and a default export that returns the Blueprint; the file name must match the id).`,
    '',
    'A **massing** is the cheap first pass of a building: its volumes, roof forms and major openings, no detail. The player approves its shape (or redirects it with notes) before anyone pays for detail; then a detail design keeps its part names and boxes. Keep it quick: a few masses, one build, one look at the renders.',
    '',
    '## Request',
    '',
    `- type: \`${req.type}\` (set \`type: '${req.type}'\` on the Blueprint). ${typeGuide(req.type)} Give the masses the proportions such a building needs; the rooms come later.`,
    `- style: "${req.style}". It shapes the silhouette: roof forms and pitch, storeys, towers, wings, porches.`,
    `- features: ${req.features.length ? req.features.map(featureLine).join('; ') : 'none requested'} (only the ones that are volumes: a porch, a tower, a wing, a chimney column).`,
    `- **maximum size: x <= ${m.x}, y <= ${m.y}, z <= ${m.z}** (the whole template, roofs and overhangs included). This is a hard limit: a bigger massing is refused.`,
    plot,
    req.notes ? `- notes from the player: ${req.notes}` : '',
    req.group ? `- this is the massing of item \`${req.itemKey ?? '?'}\` (${req.role ?? 'ordinary'}${req.role === 'landmark' ? ': the set\'s centrepiece' : ''}) of a design group, wave ${req.wave ?? 1}.` : '',
    '',
    ...(prev && req.redirect
      ? [
          `## Redirect: from version ${prev.version}`,
          '',
          `The player looked at version ${prev.version} (\`massing/${prev.id}.mjs\`, its renders \`massing/${prev.id}.preview-*.png\`) and asked for changes:`,
          '',
          `> ${req.redirect.notes.replace(/\n/g, '\n> ')}`,
          '',
          `Start from its source (copy it into your file; it already has your id) and change it as the notes say. Keep the names of the masses that stay; name new masses by their function.`,
          '',
        ]
      : []),
    ...contextSection(req.context),
    ...(opts.bible
      ? [
          `## The style bible: ${opts.bible.name} (\`${opts.bible.id}\` v${opts.bible.version})`,
          '',
          `The masses use the bible\'s roles in flat form (wall, roof, foundation, glass, frame), so the massing reads in its colours: \`import { palette } from '../lib/kit.mjs'; import { loadBible } from '../lib/bible.mjs'; const BIBLE = loadBible(new URL('../../bible/bible.json', import.meta.url));\` and \`export default function build({ palette: p = palette({ bible: BIBLE }) } = {})\`. Read \`bible/bible.json\` (proportions, roof language, silhouette)${opts.bible.hasProse ? ' and `bible/bible.md`' : ''}: follow its storey height, roof pitch and silhouette.`,
          '',
        ]
      : []),
    ...(opts.neighbours?.length ? ['## Neighbours', '', `Massings of the same set that come before yours: ${opts.neighbours.map((n) => `\`${n.file}\` (${n.name ? `${n.name}, ` : ''}a ${n.type})`).join(', ')}. Make yours belong with them (scale, roof language).`, ''] : []),
    '## How you work',
    '',
    `- Only \`kit/designs/${bp}.mjs\` is yours. The sidecar re-checks it with a fresh copy of the kit.`,
    `- Read \`kit/README.md\`, section "Massing designs": \`massing(bp)\` marks the Blueprint \`massing: true\`; \`m.mass(name, [x0,y0,z0,x1,y1,z1], { roof, ridge, storeys, wall, roofPart })\`, \`m.opening(mass, face, [u, y], [w, h])\` for the door and major openings, \`m.stilts(name, box, spacing)\`. ${examples.length ? `Examples: ${examples.map((e) => `\`kit/massings/${e}.mjs\``).join(', ')}.` : ''}`,
    '- **Name every mass by its function** (`hall`, `lodging`, `wing_east`, `tower`, `porch`, `roof`; lower_snake_case, unique, never `box1`): at least 2 masses, and the names carry over to the detail design.',
    '- An entrance (`bp.spot(\'entrance\', ...)` just outside the door, `spawn` a little further out), reachable from outside; nothing floating. No light, interior or furnishing rules apply.',
    `- Build and check: \`node kit/build.mjs ${bp} --profile massing --max ${m.x},${m.y},${m.z} --type ${req.type}\`. "check: OK" is required; fix the warnings too.`,
    opts.renderer ? `- Look at it once: \`node kit/render.mjs kit/out/${bp}.nbt --out previews\` and Read \`previews/${bp}.preview-iso.png\`.` : '',
    '- Report progress with the `design_status` tool. No network, no installs, no git, no subagents.',
    '- Finish with ONE line: the masses and the silhouette.',
    '',
  ];
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

export function massingSystemPrompt(): string {
  return [
    "# You are Architect's massing designer",
    'You make massings of Minecraft buildings: the volumes, roof forms and main openings, as code with the Architect blueprint kit (kit/lib/massing.mjs). A player approves the shape before a detail designer builds it out, so the masses must read clearly and be named by what they are for.',
    'Your working directory is a scratch folder with BRIEF.md (read it first), CONTRACT.md and kit/. Work only inside it and write only your own design file. Be quick: a massing is meant to cost cents and take a minute or two.',
  ].join('\n');
}

export function massingPrompt(bp: string): string {
  return `Make the massing described in BRIEF.md as kit/designs/${bp}.mjs. Read BRIEF.md and the "Massing designs" section of kit/README.md, write the massing, build and check it, look at the iso render once, then end with a one-line summary.`;
}

export function massingFixPrompt(bp: string, problem: string, round: number): string {
  return `The sidecar re-checked your massing with a fresh copy of the kit and it did not pass (round ${round} of ${MAX_DESIGN_ROUNDS}):\n${problem}\n\nFix kit/designs/${bp}.mjs (only that file counts), run the build command from BRIEF.md until the check is OK, then end with a one-line summary.`;
}

/** The style-bible section of BRIEF.md (4b). */
export function bibleSection(b: NonNullable<BriefOptions['bible']>, bp: string): string[] {
  const roles = Object.entries(b.roles).map(([k, v]) => `\`${k}\` ${v.replace(/^minecraft:/, '')}`).join(', ');
  return [
    `## The style bible: ${b.name} (\`${b.id}\` v${b.version})`,
    '',
    `This building is one of a set that must read as ONE place. The bible is in \`bible/\`: \`bible/bible.json\` (roles, proportions, roof language, silhouette, motifs, tiers, lighting, what to avoid)${b.hasProse ? ', `bible/bible.md` (the prose: read it first)' : ''} and \`bible/components.mjs\` (the shared component library). Follow it over your own taste.`,
    `- **Roles are the materials.** Roles: ${roles}. Default palette = the bible's: \`import { palette } from '../lib/kit.mjs'; import { loadBible } from '../lib/bible.mjs'; const BIBLE = loadBible(new URL('../../bible/bible.json', import.meta.url));\` and \`export default function build({ palette: p = palette({ bible: BIBLE }), ... })\`. Every palette field comes from a role (\`p.wall\`, \`p.plaster\` = wall_alt, \`p.stoneTrim\` = trim, \`p.roofStairs\`, \`p.floor\`, \`p.frame\`, \`p.accentPlanks\`, \`p.light\`, \`p.pane\`, \`p.foundation\`, \`p.path\`, plus the wood and stone sets derived from them); extra roles are \`p.roles.<name>\`. Use the bible's tiers (important vs humble materials) and proportions (storey height, roof pitch, overhang, window rhythm, plinth).`,
    `- **Use the components** for those elements, never your own version of them: \`import * as C from '../../bible/components.mjs';\` then \`C.window(bp, { x, y, z, facing, width, height }, opts)\`, \`C.door_surround(bp, { x, y, z, facing })\` (after placing the door), \`C.lantern_post(bp, { x, y, z, facing })\`, \`C.roof_trim(bp, { x, y, z, facing, length })\`, \`C.chimney(bp, { x, y, z, facing, top })\`${b.components.filter((c) => !['window', 'door_surround', 'lantern_post', 'roof_trim', 'chimney'].includes(c)).map((c) => `, \`C.${c}(...)\``).join('')}. Read \`bible/components.mjs\` for what each one does and what \`at\` means (design coordinates; facing = outwards).`,
    `- Keep the bible's files as they are (the sidecar puts them back before its check); \`kit/designs/${bp}.mjs\` imports them from \`../../bible/\`.`,
    ...(b.restraint
      ? [
          `- **Restraint** (the bible is a restraint as much as a palette): the hero motifs ${b.restraint.heroMotifs.map((m) => `"${m}"`).join(', ') || '(none named)'} go on this building; every other motif at most once, and never as a block that hangs on nothing. Accents (accent blocks and decor that is in no role) stay under ${Math.round(b.restraint.accentShareMax * 100)}% of the facade; detail density "${b.restraint.detailDensity}"; at least ${b.restraint.windowsPerFacadeMin} readable windows per facade, readable from the front render. When in doubt, leave it out. The checker warns (\`restraint: ...\`) when a design breaks it.`,
        ]
      : []),
    '',
  ];
}

/** BRIEF.md for a request: what the design agent reads first. */
export function designBrief(req: DesignRequest, bp: string, opts: BriefOptions): string {
  if (req.massing) return massingBrief(req, bp, opts);
  const bound = opts.massing?.role === 'detail' ? opts.massing : undefined;
  // (4c) a detail pass's hard cap: min(massing size + 2, request.maxSize)
  const m = bound?.maxSize ?? req.maxSize;
  const massingArg = bound ? ` --massing massing/${bound.record.id}.blueprint.json` : '';
  const ex = examplesFor(req.type, opts.examples);
  const plot = req.plot
    ? `- plot: a marked plot of ${req.plot.dx} x ${req.plot.dz} blocks${req.plot.height ? `, up to ${req.plot.height} high` : ''}${req.plot.front ? `, its front facing ${req.plot.front}` : ''}. The mod turns the design so its \`front\` faces the plot's front; design it with \`front: 'south'\` as usual.`
    : '';
  const lines = [
    `# Design brief: ${req.name ?? `a ${req.style} ${req.type}`}`,
    '',
    `Design id: \`${bp}\`. Write it as \`kit/designs/${bp}.mjs\` (\`export const id = '${bp}'\` and a default export that returns the Blueprint; the file name must match the id).`,
    '',
    '## Request',
    '',
    `- type: \`${req.type}\` (set \`type: '${req.type}'\` on the Blueprint). ${typeGuide(req.type)}`,
    `- checker profile for ${req.type}: ${profileLine(req.type, req.profile)}.`,
    `- style: "${req.style}". Interpret it with vanilla blocks; let it shape the materials, the roof form, the windows and the details.`,
    req.materials ? `- materials: "${req.materials}". Make the design's default palette match them (a preset, or \`palette({ wood, stone, roof, accent })\` with the closest vanilla names).` : '- materials: your choice, fitting the type and the style: pick the default palette (a preset or `palette({ wood, stone, roof, accent })`).',
    `- features: ${req.features.length ? req.features.map(featureLine).join('; ') : 'none requested'}`,
    `- maximum size (the whole template, including roof overhangs, porch, chimney and garden): x <= ${m.x}, y <= ${m.y}, z <= ${m.z}. Use the space well, but never exceed it.`,
    plot,
    req.name ? `- name: "${req.name}" (the sidecar's \`name\`)` : '- name: pick a short, fitting display name for the sidecar\'s `name`',
    '- description: one sentence for the sidecar\'s `description`; tags: a few words (style, size) for `tags`.',
    req.notes ? `- notes from the player: ${req.notes}` : '',
    req.remix ? `- remix: start from the library design \`${req.remix}\`. ${opts.remix ?? 'Its source was not found; design from scratch in its spirit.'}` : '',
    req.group ? `- this is item \`${req.itemKey ?? '?'}\` (${req.role ?? 'ordinary'}${req.role === 'landmark' ? ': the set\'s centrepiece, the most elaborate and recognisable' : ': it supports the landmarks, simpler and smaller'}) of a design group, wave ${req.wave ?? 1}.` : '',
    '',
    ...contextSection(req.context),
    ...(bound ? massingBindingSection(bound.record, m) : []),
    ...(opts.bible ? bibleSection(opts.bible, bp) : []),
    ...(opts.neighbours?.length
      ? [
          '## Neighbours',
          '',
          `These finished buildings of the same set stand next to yours: ${opts.neighbours.map((n) => `\`${n.file}\` (${n.name ? `${n.name}, ` : ''}a ${n.type})`).join(', ')}. Read the PNGs and make yours belong with them: the same roof language, materials, trim and details, at a scale that suits your type.`,
          '',
        ]
      : []),
    '## The contract (CONTRACT.md has the full text: read it)',
    '',
    '- Coordinates are relative to the template origin (minimum corner); +x east, +y up, +z south. `front` is the side the entrance faces: keep `south` unless the notes say otherwise. Every door is written closed.',
    '- `groundY` is the feet row; row groundY-1 is the floor. Set `foundationBlock` (a vanilla block the mod fills below the floor down to the ground) and `approach` to match the style.',
    '- Required anchors: `entrance` (just outside the front door, as the examples do with `bp.spot(\'entrance\', ...)`) and `spawn` (a little further out in front), both on a standable cell; add a `cam_overview` camera for a nice first view.',
    `- Declare \`interior\` (the inside box)${req.type === 'custom' ? '' : `: it is required for a ${req.type} (a checker error without it)`}. Every standable interior cell must be lit by vanilla light sources (lanterns, torches, candles, glowstone, sea lanterns, froglights, shroomlights, lit campfires): mind the corners, each floor and the stairwells. Every floor must be reachable from the entrance by walking (stairs, ladders; max step 1). The roof must close the interior (no sky straight down into it except declared skylights / courtyards). Nothing may float.`,
    '- An outside door on the front face, reachable from the entrance. Wooden doors are fine; an iron door needs a button on both sides.',
    '- Only blocks listed in `kit/lib/blocks.mjs` can be used, with every property explicit and valid (the checker refuses anything else). It is a large generated table (every vanilla block): grep it for the blocks you need, never read it whole. When the style wants a block that is not there, use the closest one and say so in your summary.',
    '',
    '## How you work',
    '',
    `- Only \`kit/designs/${bp}.mjs\` is yours: you cannot write anywhere else, and the sidecar re-checks your design with a fresh copy of the kit, so changes to the kit would not count anyway.`,
    '- Read `kit/README.md` first: it has the kit API and a complete small parametric design.',
    opts.playbook ? '- Read `kit/PLAYBOOK.md` too: how to plan, build in layers, look at it (slices with `node kit/tools/slices.mjs`, then the renders) and critique your own design before you finish. It adds to this brief and never overrides it.' : '',
    '- **Make it parametric** (players make variants of it later without you, so this matters): `export const params = {...}` with 2 to 4 meaningful params (e.g. floors, width or depth, porch on/off, roof style; `int` with min/max/default, `bool`, `enum` with options), each with a `label`. The default export takes `{ palette, ...values }` with the defaults in the signature. The defaults must fit the maximum size above; the bounds may go past it. Every combination must build and pass the checker: try the corners (`--values \'{"floors":3,"porch":false}\'`) before you finish.',
    '- **Materials come from the palette**: the default export gets `palette` (default: the preset or `palette({ wood, stone, roof, accent })` that fits the request). Read every wood and stone from it (`p.planks`, `p.log`, `p.strippedLog`, `p.stairs`, `p.slab`, `p.fence`, `p.door`, `p.trapdoor`, `p.accentLog`, `p.accentStairs`, `p.stone`, `p.stoneStairs`, `p.stoneSlab`, `p.stoneWall`, `p.stoneTrim`, `p.roofStairs`, `p.roofSlab`, `p.roofBlock`, `p.plaster`), never a hard-coded wood or stone id, so a palette swap re-skins the whole building; the checker warns otherwise. Decor (chests, barrels, beds, lanterns, glass, carpets, iron) is free. Check a second preset too (`--palette cherry`, `--palette fortress`).',
    "- **Name the parts**: wrap every major mass in `bp.part('<name>', () => { ... })` (e.g. `main`, `roof`, `porch`, `tower`, `wing_east`, `chimney`, `furnishings`): at least 2 parts, and at most 20% of the cells outside any part (the checker warns otherwise). Names are stable ids (later edits diff by them): lower_snake_case, unique. Declare consts outside the part closures if several parts use them.",
    `- Build it semantically with the kit helpers in \`kit/lib/kit.mjs\` (walls with openings, floors, doors, roofs with overhang, stairs and ladders, windows, chimney, porch, lighting, \`anchor()\`), not as a dump of raw coordinates. ${ex.length ? `Start by reading the closest example${ex.length > 1 ? 's' : ''}: ${ex.map((e) => `\`kit/designs/${e}.mjs\``).join(', ')} (each is parametric and palette-driven: see how its \`params\` shape the code).` : 'Look at the examples in `kit/designs/`.'}`,
    `- Build and check: \`node kit/build.mjs ${bp} --max ${m.x},${m.y},${m.z} --type ${req.type}${!isPreset(req.type) ? ` --profile ${(req.profile ?? DEFAULT_PROFILE).join(',')}` : ''}${massingArg}\` (writes kit/out/${bp}.nbt and the sidecar, then runs the checker; add \`--palette <preset>\` / \`--values <json>\` for the variants). "check: OK" is required with the defaults; fix the warnings too.`,
    opts.renderer
      ? `- Look at it: \`node kit/render.mjs kit/out/${bp}.nbt --out previews\` writes ${bp}.preview-iso.png / -top.png / -front.png into previews/; Read the PNGs and fix what looks wrong (holes, floating blocks, a missing roof, the entrance not on the front, dark rooms, a flat or boxy look). Iterate until it looks like a ${req.type} a player would be proud of.`
      : '- There is no renderer in this kit: check the layout by reasoning about the code and the checker output.',
    '- Report progress with the `design_status` tool (one short line, e.g. "roof done, checking").',
    '- No network, no installs, no git, no subagents; nobody can answer questions or permission prompts during the job. Decide yourself and mention assumptions in your summary.',
    '- Finish with ONE line: a summary of the design (type, style, footprint, highlights).',
    '',
  ];
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

export function designSystemPrompt(): string {
  return [
    "# You are Architect's building designer",
    'You design Minecraft buildings (houses, cabins, towers, shops, taverns, barns, chapels, gatehouses, ...) as parametric code with the Architect blueprint kit. The player placing your design will walk through it: it must be well built, lit, reachable and beautiful.',
    "Your working directory is a scratch folder, not a git repository and not anyone's project. Everything you need is in it: BRIEF.md (the request: read it first), CONTRACT.md (the blueprint contract and the checker rules), kit/ (the kit: README.md with its API, lib/kit.mjs helpers, lib/blocks.mjs, the checker lib/check.mjs, build.mjs, render.mjs and example designs in designs/).",
    'Work only inside this folder and write only your own design file. Your turn ends when the design passes the checker, fits the size limit and looks right.',
  ].join('\n');
}

export function designPrompt(bp: string): string {
  return `Design the building described in BRIEF.md as kit/designs/${bp}.mjs. Read BRIEF.md, CONTRACT.md and kit/README.md, look at the closest example design, write the design, then build, check, look at the renders and iterate as BRIEF.md says until the checker passes and it looks right. End with a one-line summary.`;
}

export function designFixPrompt(bp: string, problem: string, round: number): string {
  return `The sidecar re-checked your design with a fresh copy of the kit and it did not pass (round ${round} of ${MAX_DESIGN_ROUNDS}):\n${problem}\n\nFix kit/designs/${bp}.mjs (only that file counts), run the build command from BRIEF.md until the check is OK and the size fits, look at the renders again if there is a renderer, then end with a one-line summary.`;
}

/** (5a) a revision after critique whose check failed (its own allowance, not MAX_DESIGN_ROUNDS) */
export function revisionFixPrompt(bp: string, problem: string): string {
  return `The sidecar re-checked your revision with a fresh copy of the kit and it did not pass:\n${problem}\n\nFix kit/designs/${bp}.mjs (only that file counts), keeping the revision's changes, run the build command from BRIEF.md until the check is OK, then end with a one-line summary.`;
}

export const RESTART_PROMPT =
  'The sidecar restarted while you were working on this design. Re-check where you were (kit/designs/, BRIEF.md) and continue until the checker passes and it looks right, then end with a one-line summary.';

export const LIMIT_RESUME_PROMPT =
  'A usage limit stopped your last turn; it has reset now. Re-check where you were (kit/designs/, BRIEF.md) and continue until the checker passes and it looks right, then end with a one-line summary.';

/** One line of progress from a design turn's tool calls. */
export function designStepFor(msg: SDKMessage, bp: string): string | undefined {
  if (msg.type !== 'assistant' || msg.parent_tool_use_id) return undefined;
  let step: string | undefined;
  for (const b of (msg.message?.content ?? []) as Array<{ type: string; name?: string; input?: Record<string, unknown> }>) {
    if (b.type !== 'tool_use' || !b.name) continue;
    const input = b.input ?? {};
    const cmd = typeof input.command === 'string' ? input.command : '';
    const file = typeof input.file_path === 'string' ? input.file_path : '';
    if (b.name === 'Bash' && /build\.mjs/.test(cmd)) step = 'running the checker';
    else if (b.name === 'Bash' && /render\.mjs/.test(cmd)) step = 'rendering previews';
    else if (b.name === 'Read' && /\.png$/i.test(file)) step = 'looking at the renders';
    else if ((b.name === 'Write' || b.name === 'Edit' || b.name === 'MultiEdit') && file.includes(`${bp}.mjs`)) step = 'writing the design';
    else if (b.name === 'Read' && /BRIEF\.md|CONTRACT\.md/.test(file)) step = 'reading the brief';
    else if (b.name === 'Read' || b.name === 'Grep' || b.name === 'Glob') step ??= 'studying the kit';
  }
  return step;
}
