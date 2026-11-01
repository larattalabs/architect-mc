package dev.larattalabs.architect.api;

/**
 * A placement refusal's type.
 * <ul>
 * <li>{@code PLAYER_IN_BOX}: a player stands in or next to the box.</li>
 * <li>{@code OCCUPIED}: a pet, villager, named mob or other entity that matters is in the box.</li>
 * <li>{@code OVERLAP}: the box overlaps another site.</li>
 * <li>{@code LAVA}: lava in or next to the box or the approach.</li>
 * <li>{@code BLOCK_ENTITIES}: the box holds block entities (chests, ...); {@code force} overwrites them.</li>
 * <li>{@code BUILD_HEIGHT}: the box leaves the world's build height.</li>
 * <li>{@code DOOR_CUT}: a door is cut in half by the box edge.</li>
 * <li>{@code CREATIVE_ONLY_BLOCK}: a construction site of a design with blocks survival can't build.</li>
 * <li>{@code NOT_ALLOWED}: the mode needs a permission the actor lacks (INSTANT in a survival world), or a move in survival.</li>
 * <li>{@code NOT_LOADED}: part of the site is in an unloaded chunk (or the dimension is not loaded).</li>
 * <li>{@code UNKNOWN_BLUEPRINT}: no loaded design with that id.</li>
 * <li>{@code OTHER}: anything else (an I/O error, the world's sites file could not be read, an internal problem).</li>
 * <li>{@code CANCELLED} (1.4.0): a batch item dropped or rolled back by {@link Sites#cancelBatch} (or a skipped stage, a stopped batch).</li>
 * <li>{@code LOT_TOO_SMALL} (1.4.0): {@link Sites#fitToLot}: the footprint does not fit the lot after rotation and setback.</li>
 * <li>{@code TIMED_OUT} (1.4.0): a batch item waited longer than its {@code WaitPolicy} for a temporary blocker; the message
 * names the blocker.</li>
 * <li>{@code OVERLAP_BUSY} (1.5.0): a LAYER placement over a site that is still placing, a construction site still building, or
 * a site being removed. Temporary: a queued item waits.</li>
 * <li>{@code OVERLAP_OWNED} (1.5.0): a LAYER placement (or a road over a cell site) over a site of another owner; {@code force}
 * overrides it.</li>
 * <li>{@code LAYER_DEPTH} (1.5.0): a cell would carry more than 8 active layers.</li>
 * <li>{@code COVERED} (1.5.0): a removal with {@code CoveredPolicy.REFUSE} of a site another site covers.</li>
 * <li>{@code TOO_STEEP} (1.5.0): a road column would need more than 4 of cut or fill.</li>
 * <li>{@code DEEP_WATER} (1.5.0): a road over water deeper than 1 (bridges are phase 6).</li>
 * <li>{@code TOO_LARGE} (1.5.0): a cell site of more than 1,000,000 cells.</li>
 * <li>{@code JOURNAL_UNAVAILABLE} (1.5.0): the world journal could not be read; nothing changes the world until it is fixed.</li>
 * <li>{@code SITE_BUSY} (1.7.0): a delta on a site that is placing, a construction site (or construction delta) still building,
 * being removed, or updating. Temporary: a queued item waits.</li>
 * <li>{@code FRAME_CHANGED} (1.7.0): the new version changes {@code front} or the entrance's feet row: a re-place, not a delta.</li>
 * <li>{@code VERSION_GONE} (1.7.0): the version the site stands at can't be found any more; it can be removed or placed again.</li>
 * <li>{@code PLAYER_EDITS} (1.7.0): a delta with {@code PlayerEdits.REFUSE} would write cells the player changed.</li>
 * <li>{@code NOT_GENERATED} (1.8.0): under {@link LoadPolicy#GENERATED_ONLY} a chunk the item needs was never fully generated
 * ("needs prepare"). Temporary: the item waits (for a region item, with no time limit).</li>
 * <li>{@code CHUNK_BOUND} (1.8.0): under a policy that holds tickets, the item needs more chunks than the batch's bound, so it
 * could never get them; refused at queue time.</li>
 * <li>{@code DRIFTED} (1.8.0): a region's land changed since its plan beyond the tolerance ("land changed since planning"):
 * replan, or realise with {@code force}.</li>
 * <li>{@code SIDECAR_UNAVAILABLE} (1.8.0): a region tile needs the helper (sidecar) and it is not connected. Temporary, no
 * time limit.</li>
 * <li>{@code PLAN_STALE} (1.8.0): a region plan needs a newer kit: its kit version is newer than the running kit, or (1.9.0) its
 * IR format is over 2 or it names a format-2 kind this kit lacks. Refused at plan accept, realise start and region resume,
 * before any tile is requested ("plan needs kit X / format N / kinds [...]; this is kit Y").</li>
 * <li>{@code REGION_LIMIT} (1.8.0): a region plan or a cell outside its limits (the claim, the size, the cell budget).</li>
 * <li>{@code NO_TEMPLATE} (1.9.0): a region design that required a fit ({@code RegionDesignRequest.requireFit}) and no bundled
 * program fits the brief.</li>
 * <li>{@code PLAYER_BLOCKS} (1.9.0): a lot placed LAYERed on a region's pad (over a region tile entry) whose box holds the
 * player's own blocks: non-natural, no block entity, owned by no journal entry. The lot is not placed and the blocks stay
 * (the region ends PARTIAL); {@code force} overrides it (the blocks are overwritten and come back on remove).</li>
 * <li>{@code WORLD_STOPPED} (1.10.0): the world stopped while the future was pending, or no world runs. Work in the helper goes
 * on: find it again after the next load with the {@code *ByKey} lookups or the listings ({@link ArchitectRefused}). * It is not an outcome: never record the work as failed on it. The sweep runs in {@code SERVER_STOPPING}'s default phase,
 * so end your own session in a phase ordered before it ({@code addPhaseOrdering(yourPhase, Event.DEFAULT_PHASE)}), or
 * ignore WORLD_STOPPED in your handlers.</li>
 * <li>{@code OP_KEY_CONFLICT} (1.10.0): an operation key re-used by the same owner for the same kind with another body.</li>
 * <li>{@code TILE_SLOW} (1.10.0): a region tile's evaluation ran over its time limit in every retry of the helper. Temporary:
 * the item waits, the tile is asked for again after 30 s, 60 s, 120 s and then every 5 min, and {@link WaitAction.Kind#RETRY}
 * asks now. Only {@code RealiseRequest.maxWaitSeconds} caps it (TIMED_OUT).</li>
 * <li>{@code COPY_REFUSED} (1.11.0): a group's copies can't be made as asked. {@link ArchitectRefused#detail()}: {@code landmark}
 * (a copyOf naming a landmark), {@code unknown} (a copyOf naming no item), {@code self} (an item copying itself), {@code cap}
 * (one past the archetype's copyCap); {@link Designs#promoteCopy} refused: {@code not_copy}, {@code building}, {@code final}.</li>
 * <li>{@code VERSION_REFUSED} (1.11.0): a {@code versionOf} (or a polish) can't make the entry's next version. Detail:
 * {@code bundled}, {@code no_source}, {@code massing}, {@code copy} (a group copy follows its source by its recipe), {@code busy}
 * (a polish or versionOf of the entry is unfinished), {@code site_mismatch} (the site is not of that entry), {@code group}
 * (single designs only); (PT2) {@code adopted_polish} (an adopted build's entry is changed by versionOf, never polished).</li>
 * <li>{@code PROTECTED} (1.12.0): the op writes into a protected area of its owner ({@link Sites#protect}); {@code force}
 * doesn't override it: lift the area ({@link Sites#unprotect}).</li>
 * <li>{@code FIELD_LIMIT} (1.12.0): a bounded request field is out of range ({@code Limits}); nothing was sent.</li>
 * <li>{@code FORMAT} (1.18.0): a file to import is not in the expected format: not a Sponge schematic, an unknown version, a
 * {@code DataVersion} newer than the game's, corrupt data, or blocks the game does not know ({@link Library#importSchematic}).</li>
 * <li>{@code PERMISSION} (1.21.0): the caller lacks the permission the request needs: a brush stroke with
 * {@link Destruction#PLAYER_BLOCKS} needs an online player with permission level 2 as its actor ({@link Regions#brush}).</li>
 * <li>{@code ARTIFACT_STALE} (1.23.0): {@link Regions#realiseApproved}: the terrain under the plan's tiles, the protection over the
 * claim, or a provisional lot's entry (past its fit box or the top of its cost range) changed since the check; the message names
 * the columns, areas or lot. Nothing was written: check again and approve the new artifact.</li>
 * <li>{@code ARTIFACT_UNAPPROVED} (1.23.0): no artifact has that sha (unknown, or removed: a tombstone).</li>
 * <li>{@code PLAYER_BUILD} (PT): the op would write over a player's build (docs/CONTRACT.md "Phase 6c slice PT" §7) that its
 * {@link BuildConsent} does not name; {@link Refusal#builds()} / {@link ArchitectRefused#builds()} name each blocking build (id,
 * kind, count, the first 8 cells with their block ids). {@code force} never overrides it (N-PT-6). Not a widened PLAYER_BLOCKS.</li>
 * <li>{@code ADOPT_REFUSED} (PT2): a build can't be adopted as a site, or an adopted entry can't be used that way
 * (docs/CONTRACT.md "Phase 6c slice PT2" §5). {@link ArchitectRefused#detail()}: {@code not_a_build} (unknown or released: claim
 * a box first), {@code provisional} (wait for the promoting {@link SiteEvents#BUILD_CHANGED}), {@code consent} (the consent
 * does not name the build, has no actor, or the actor is neither a placer of 10% of its cells nor an op), {@code already_adopted}
 * (the message names the site; {@link Sites#adoptedSite}), {@code tracking_off} (the world rule {@code architect.playerTracking}),
 * {@code adopted} ({@link Sites#releaseBuild} of an adopted build: remove the site first), {@code placed_elsewhere} (an
 * adopted entry is the player's house, not a template: it is never placed or checked anywhere).</li>
 * <li>{@code PALETTE} (VOC-c, 1.37.0): {@link Regions#realiseApproved} (or a delta, {@link Sites#checkDelta}/{@link Sites#applyDelta}):
 * a required {@code rule.palette} of the approved plan measures outside its share with the lots bound now (the artifact's parts'
 * counts plus each bound lot's entry). The message names the rule, the family, the share, the measured share, the cells and the worst
 * lot with its entry; {@link ArchitectRefused#detail()} is the rule id. Nothing was written: bind another entry to the lot (or drop
 * {@code required}). {@link Regions#checkPalette} answers the same measure before any realise.</li>
 * <li>{@code NO_ROOM} (6d GR, since 1.43.0): {@link Regions#planRevision} of a growth ({@code params.grow}) that places no lot: the message
 * starts {@code NO_ROOM: [<kind>]} with kind {@code frontage}, {@code street}, {@code claim}, {@code held}, {@code body} or {@code layout};
 * nothing was planned. A growth that places some lots answers a plan and lists the rest in its IR's {@code revision.grow.unplaced}.
 * Read it as full (Steward: like {@code REGION_LIMIT}, propose a district).</li>
 * </ul>
 * New values are only ever appended.
 */
public enum Reason {
	PLAYER_IN_BOX, OCCUPIED, OVERLAP, LAVA, BLOCK_ENTITIES, BUILD_HEIGHT, DOOR_CUT, CREATIVE_ONLY_BLOCK, NOT_ALLOWED, NOT_LOADED,
	UNKNOWN_BLUEPRINT, OTHER, CANCELLED, LOT_TOO_SMALL, TIMED_OUT, OVERLAP_BUSY, OVERLAP_OWNED, LAYER_DEPTH, COVERED, TOO_STEEP, DEEP_WATER,
	TOO_LARGE, JOURNAL_UNAVAILABLE, SITE_BUSY, FRAME_CHANGED, VERSION_GONE, PLAYER_EDITS, NOT_GENERATED, CHUNK_BOUND, DRIFTED,
	SIDECAR_UNAVAILABLE, PLAN_STALE, REGION_LIMIT, NO_TEMPLATE, PLAYER_BLOCKS, WORLD_STOPPED, OP_KEY_CONFLICT, TILE_SLOW,
	COPY_REFUSED, VERSION_REFUSED,
	// 1.12.0 (6c slice 0c), after 0a's and 0b's
	PROTECTED, FIELD_LIMIT,
	// 1.18.0 (6c slice SCH)
	FORMAT,
	// 1.21.0 (6c slice B)
	PERMISSION,
	// 1.23.0 (6c slice P0)
	ARTIFACT_STALE, ARTIFACT_UNAPPROVED,
	// PT (6c slice PT, C32)
	PLAYER_BUILD,
	// PT2 (6c slice PT2)
	ADOPT_REFUSED,
	// 1.37.0 (6c slice VOC-c; the CU/IRR/VOC-c batch, v0.40.0)
	PALETTE,
	// NEXT (6d slice GR): a growth with no lot that fits (the message names the kind: frontage, street, claim, held, body, layout)
	NO_ROOM
}
