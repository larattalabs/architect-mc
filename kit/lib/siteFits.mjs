// (7b foundation, docs/CONTRACT.md "Phase 7b" §2 and slice 7bF; SETTLEMENTS §7.1) The fit table: how a site-aware design meets its
// site, one row per fit. A leaf (no imports), read by the slices that act on it: SV (the kit's Site and Blueprint `fit`), SC (the
// checker's `fit:<mode>` support rules), PL (TerrainFit and the approach, mirrored in Java), SO (support order), DS (the designer's
// words). The ids are api.FitMode's wire names, in its order (a test holds them equal). Data only: nothing here plans or checks.
//
// Columns:
//   terrain        what placement does to the cells the template does not write: 'clear' (today: clear natural above the ground row,
//                  clear leaves, fill the foundation down to 12) or 'keep' (touch none of them; the design writes air where it carves)
//   foundationFill fill under the footprint down to 12 (TerrainFit's fill)
//   clearLeaves    clear leaves in the box (never the host's under 'keep')
//   approach       'ground' (today's strip out of the front face) or 'port' (no strip: the door or walk port meets a graph edge)
//   ports          the fewest ports a design of the fit declares (span: one at each end)
//   support        the checker rule (SC) that judges the composite: 'no_floating' (today's) or `fit:<id>`
//   bears          what every cell must connect to: 'ground' (on_pad), 'site_solid', 'trunk_or_site_solid', 'up' (through chains or posts)
//   keepCritical   the site cells that must stand (placement refuses KEEP_LOST when one is gone): null, 'host' (the trunk's logs) or
//                  'hang' (the hang points)
//   limits         the rule's numbers: `bearCells` (rock cells per bracket), `endBearing` (cells under each end, [x, z]); 'bible' means
//                  the bible's limit (cantilever, unsupported span, chain run), resolved by SC
export const FIT_IDS = Object.freeze(['on_pad', 'carve_into', 'attach_to_cliff', 'span', 'wrap_trunk', 'suspend']);

export const FITS = Object.freeze({
  on_pad: Object.freeze({ terrain: 'clear', foundationFill: true, clearLeaves: true, approach: 'ground', ports: 0, support: 'no_floating', bears: 'ground', keepCritical: null, limits: Object.freeze({}) }),
  carve_into: Object.freeze({ terrain: 'keep', foundationFill: false, clearLeaves: false, approach: 'port', ports: 1, support: 'fit:carve_into', bears: 'site_solid', keepCritical: null, limits: Object.freeze({ rockEncloses: true }) }),
  attach_to_cliff: Object.freeze({ terrain: 'keep', foundationFill: false, clearLeaves: false, approach: 'port', ports: 1, support: 'fit:attach_to_cliff', bears: 'site_solid', keepCritical: null, limits: Object.freeze({ cantilever: 'bible', bearCells: 2 }) }),
  span: Object.freeze({ terrain: 'keep', foundationFill: false, clearLeaves: false, approach: 'port', ports: 2, support: 'fit:span', bears: 'site_solid', keepCritical: null, limits: Object.freeze({ span: 'bible', endBearing: Object.freeze([2, 2]) }) }),
  wrap_trunk: Object.freeze({ terrain: 'keep', foundationFill: false, clearLeaves: false, approach: 'port', ports: 1, support: 'fit:wrap_trunk', bears: 'trunk_or_site_solid', keepCritical: 'host', limits: Object.freeze({}) }),
  suspend: Object.freeze({ terrain: 'keep', foundationFill: false, clearLeaves: false, approach: 'port', ports: 1, support: 'fit:suspend', bears: 'up', keepCritical: 'hang', limits: Object.freeze({ chain: 'bible' }) }),
});

/** The standard site port kinds (api.SitePort.WALK and DOOR). */
export const SITE_PORT_KINDS = Object.freeze(['architect:walk', 'door']);
/** A site port's facings: the horizontal four plus up and down (a vertical walk port). */
export const SITE_PORT_FACINGS = Object.freeze(['north', 'south', 'east', 'west', 'up', 'down']);
/** A site frame's rotations (the lowercase Minecraft names, as api.SiteFrame writes them). */
export const SITE_ROTATIONS = Object.freeze(['none', 'clockwise_90', 'clockwise_180', 'counterclockwise_90']);
/** The caps of a site spec (api.SiteSpec.MAX_KEEP_CRITICAL, MAX_PORTS, MAX_PORT_SIZE; kit/schemas/site-spec.json). */
export const SITE_LIMITS = Object.freeze({ keepCritical: 65536, ports: 16, portSize: 16 });
/** The wire key of a site (api.SiteSpec.WIRE_KEY) and of an entry's binding in its ext (api.SiteBinding.EXT_KEY). */
export const SITE_KEY = 'site';
export const SITE_BINDING_KEY = 'architect_mc:site';
/** The margin round a lot box that a site's volume (and Survey.site's sample) covers. */
export const SITE_MARGIN = 8;

/** The row of a fit id; throws on an unknown one. */
export function fitOf(id) {
  if (!Object.prototype.hasOwnProperty.call(FITS, id)) throw new Error(`unknown fit ${JSON.stringify(id)} (one of ${FIT_IDS.join(', ')})`);
  return FITS[id];
}
