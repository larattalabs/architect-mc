package dev.larattalabs.architect.api;

import java.util.Set;
import net.minecraft.server.MinecraftServer;

/**
 * Architect's public API (docs/CONTRACT.md "Phase 4a contract: public API"). Everything in {@code dev.larattalabs.architect.api}
 * is the contract and follows {@link #VERSION} (semver: a minor bump adds methods, a major bump breaks); everything else in
 * Architect is internal and may change without notice.
 *
 * <p>Entry: {@link #get()}. All calls are on the server thread unless noted; async results are {@code CompletableFuture}s
 * completed on the server thread. A dependent mod declares {@code "depends": {"architect_mc": ">=0.4.0"}} and checks
 * {@link #VERSION} at runtime when it needs a newer minor version.
 */
public interface ArchitectApi {
	/**
	 * 1.2.0: bibles, design groups, estimates, re-skins, open types, named parts, the survival toggle (docs/CONTRACT.md phase 4b).
	 * 1.3.0: massings, redirects, massingFirst groups and their approval, context, the composite preview (phase 4c).
	 * 1.4.0: batches over ticks, site groups, stages, the group crate, lot fitting (phase 4d).
	 * 1.5.0: journal-backed sites: overlap policies (LAYER), covered policies, roads and cell sites as sites, the stack query
	 * (phase 4e).
	 * 1.6.0: critique (report and loop) on designs, groups and items, report critiques of library entries, DESIGN_CRITIQUED,
	 * the critique figures of estimates, images in jobs, bible delete and archive, bible restraint (phase 5a).
	 * 1.7.0: entry versions, blueprint deltas, delta apply, revert, polish (phase 5b).
	 * 1.8.0: regions (plan, prepare, realise, undo), LoadPolicy GENERATED_ONLY, the queue-time CHUNK_BOUND, cell conditions,
	 * the region events (phase 6a).
	 * 1.9.0: region checks and previews, region designs (template-first), nudge actions, Survey.volume, IR format 2 and
	 * PLAN_STALE gating, the PLAYER_BLOCKS refusal on region pads, the region ghost (phase 6b).
	 * 1.12.0: minLotSize and the recommended lot, partial roads, ground heights, bounded fields refused in the mod, the extend
	 * warning, survival construction roads, protected areas, owner-tagged entities (phase 6c slice 0c).
	 */
	String VERSION = "1.58.0";

	/**
	 * (TJ AV) The API version of the Architect that is loaded, read at runtime. {@link #VERSION} is a compile-time constant, so javac
	 * inlines it into a consumer's bytecode: a consumer that reads {@code VERSION} sees the version it compiled against, not the one
	 * running. This default's body is compiled into Architect's own interface class, so it answers the loaded Architect's version.
	 * An Architect before this method has none ({@link NoSuchMethodError}): check {@code features().contains("apiVersion")} first.
	 * Since 1.58.0.
	 */
	default String apiVersion() {
		return VERSION;
	}

	/** The singleton. Safe to call from any mod's initializer (it does not depend on Architect's init order). */
	static ArchitectApi get() {
		return dev.larattalabs.architect.apiimpl.ApiImpl.instance();
	}

	/** The design library (bundled + user): reads and a few writes. */
	Library library();

	/** The sites of the world {@code s} runs. */
	Sites sites(MinecraftServer s);

	/** Terrain sampling. */
	Survey survey();

	/** Fabric events (R7). The fields are static on {@link SiteEvents}, so registering before a world exists is fine. */
	SiteEvents events();

	/** Claude jobs (R2). Until the sidecar speaks protocol 2 this reports {@code available() == false}. */
	Jobs jobs();

	/** Building design requests (the Design tab's pipeline) and, since 1.2.0, design groups. */
	Designs designs();

	/** Style bibles (phase 4b). Since 1.2.0. */
	Bibles bibles();

	/** Regions: whole sites as programs (phase 6a). Since 1.8.0. */
	default Regions regions() {
		throw new UnsupportedOperationException("regions() needs Architect API 1.8.0");
	}

	/**
	 * What this game can do: the sidecar's {@code features} (when the snapshot names any; {@code "protocol2"} when it chose
	 * protocol 2) plus Java-only ones ({@code "designs"}, {@code "survey"}, {@code "sites"}, {@code "events"}, ...). Any thread.
	 * Since 1.2.0, a 4b helper adds {@code "bibles"}, {@code "designGroups"}, {@code "namedParts"}, {@code "openTypes"},
	 * {@code "estimates"} and {@code "reskin"}; {@code "survivalInfo"} is always there. Since 1.3.0, a 4c helper adds
	 * {@code "massing"}, and {@code "compositePreview"} ({@code ArchitectClientApi.previewComposite}) is always there.
	 * Since 1.4.0, {@code "batchPlacement"}, {@code "siteGroups"}, {@code "stages"} and {@code "groupCrate"} are always there.
	 * Since 1.5.0, {@code "journal"}, {@code "overlapLayer"}, {@code "roads"}, {@code "cellSites"} and {@code "stackQuery"}.
	 * Since 1.6.0, a 5a helper adds {@code "critique"}, {@code "critiqueReport"}, {@code "jobImages"}, {@code "bibleAdmin"} and
	 * {@code "bibleRestraint"}.
	 * Since 1.8.0, {@code "generatedOnly"}, {@code "cellConditions"} and {@code "chunkBound"} are always there, and a 6a helper
	 * ({@code region.plan} and {@code region.tiles}) adds {@code "regions"} and {@code "regionPrepare"}.
	 * Since 1.9.0, {@code "surveyVolume"} and {@code "regionNudge"} are always there, and a 6b helper adds {@code "regionCheck"}
	 * ({@code region.check}), {@code "regionPreview"} ({@code region.preview}), {@code "regionDesign"} ({@code region.design}),
	 * {@code "irFormat2"} ({@code ir.format2}), {@code "regionBlobs"} ({@code region.blobs}) and {@code "regionGhost"} (preview
	 * tiles: with {@code region.preview}).
	 * Since 1.12.0, a 0c helper adds {@code "extendInfo"} (its {@code group.extend} ack carries the spend and soft fraction that
	 * {@link Designs#extend} reports; without it the cached group's are used).
	 * Since 1.13.0, a V helper ({@code region.keepOut}) adds {@code "planKeepOut"} ({@link Regions#plan} sends the owner's
	 * protected areas that meet the claim as {@code keepOut}; a program that honours them is planned around them),
	 * {@code "flatVillage"} (the bundled {@code flat_village} program: {@code params.lots}, unplaced lots in {@code notes},
	 * {@code LotSpec.ext["architect_mc:village"]}), {@code "regionGraph"} (the IR's settlement graph in {@code siteplan.json},
	 * {@code derived: false}) and {@code "villagerMover"} (the checker's villager mover and M22-M24).
	 * Since 1.15.0, {@code "frozenWater"} is always there (the region survey reads ice over water as water, {@link Sample#frozen}),
	 * and a W helper ({@code region.lightCover}) adds {@code "apronLights"} ({@code flat_village} lights its lot aprons and batters
	 * with the bible's lamp fixture; each lot's lamps on {@code LotSpec.ext["architect_mc:village"].lamps}).
	 * Since 1.16.0, a forms-I helper ({@code region.forms1}) adds {@code "formsIce"} (the kit's {@code iceSpike} generator and
	 * {@code keepNatural}), {@code "formsRock"} (the {@code rockSpire} generator) and {@code "voxelsOp"} (the {@code voxels} op: a
	 * plan that uses it requires the {@code voxels} kind, and an older game refuses it PLAN_STALE); its checker has M17 (melt).
	 * Since 1.18.0, a T1 helper ({@code region.passes}) adds {@code "planPasses"} (plan-time passes: a program that declares
	 * them is planned within 120 s and 2 GB, its second plan's survey is resolution 1 up to 1024x1024 columns, and the pass
	 * timings are in {@link RegionPlan#notes} and {@code siteplan.json}) and {@code "reliefOp"} (the {@code relief} op and pass,
	 * {@code pad.edge: 'blend'}: a plan that uses it requires the {@code relief} kind, and an older game refuses it PLAN_STALE).
	 * Since 1.18.0, {@code "schematics"} is always there: Sponge schematic import ({@link Library#importSchematic}, through the
	 * helper) and export ({@link Library#exportSchematic}, {@link Sites#exportSiteSchematic}, in the mod).
	 * Since 1.20.0, an F2 helper ({@code region.scatter}) adds {@code "scatterOp"} (the {@code scatter} op: decoration on a hashed
	 * jittered grid, on ground, walls and ceilings, by density, field or mask, with the bundled items) and {@code "stampOp"} (the
	 * {@code stamp} op: a vanilla feature captured in the player's own game as a stamp, local-only). A plan that uses them requires the
	 * {@code scatter} / {@code stamp} kinds, and an older game refuses it PLAN_STALE.
	 * Since 1.21.0, a B helper ({@code region.brush}) adds {@code "brushes"} ({@link Regions#brush}: its kit bundles the {@code brush}
	 * program, and frozen volumes may record block ids, so a mask's {@code block} term reads the world).
	 * Since 1.22.0, a T2 helper ({@code region.route}) adds {@code "routePass"} (the {@code route} pass: slope-aware routing with
	 * switchbacks, stairs, ladders on player-only edges and keep-out avoidance; routes are ordinary roads, stairs and columns,
	 * so a routed plan needs no new kind, and the IR graph's edges carry {@code movers} and {@code segments}).
	 * Since 1.25.0 (C33), a helper with {@code job.systemRefs} adds {@code "job.systemRefs"}: {@link JobSpec#systemRefs} is
	 * expanded by the helper, and a structured job's {@code system} may be {@link Limits#JOB_SYSTEM_MAX} characters.
	 * Since 1.28.0, an S2 helper ({@code region.outpost}) adds {@code "scenarioS2"} (the bundled {@code ice_outpost} program, S2's
	 * ice-spike outpost: lots on the dry land among kept natural ice spikes, blended pads, routes from a gate, generated spikes,
	 * scatter and melt-safe light; with it, a keep set is a route obstacle at its kept columns and the relief keeps them).
	 * Since 1.31.0 (C38), {@code "planCatalogueView"} is always there: {@link Regions#planCatalogue()} reads the capability catalogue
	 * synchronously from the mod.
	 * Since 1.37.0 (6c CU), {@code "weatheringOurs"} is always there (the journal's "still ours"): a copper block at any weathering
	 * stage of the block Architect wrote, waxed or scraped, is still Architect's, so undo and removal restore it (fewer {@code kept}
	 * cells), deltas replace it, the survival builder never re-queues it, and its refund is a {@code REFUND} of the block standing,
	 * credited to the stockpile; farmland and dirt are interchangeable the same way. A player's own placed block stays the player's.
	 * Since 1.37.0 (6c IRR), an IRR helper ({@code region.irrigation}) adds {@code "farmIrrigation"}: plan/0's {@code irrigate: true} on a
	 * farm lot or its zone puts an open water source in every 9x9 of the lot's field, the region's (inside the lot's box: the lot's
	 * design never writes those cells, the plan-check artifact's {@code lots[].irrigation}), removed with the lot; and
	 * ({@code reserved}) {@code "designReserved"}: {@link DesignRequest#reserved} is kept by the design job and checked by its checker.
	 * Since 1.37.0 (6c VOC-c), a VOC-c helper ({@code plan.rules}) adds {@code "rulePalette"}: plan/0's {@code rule.palette} is
	 * measured over the parts and the bound lots in its scope, {@link Regions#checkPalette} pre-checks an artifact's lot entries, and
	 * {@link Regions#realiseApproved} and a lot's delta refuse {@link Reason#PALETTE} when a required rule is broken.
	 * Since 1.38.0 (6c F3), a forms-II helper ({@code plan.forms2}) adds {@code "formsTrees"} (plan/0's {@code form.giant_tree} and
	 * {@code form.giant_mushroom}: grown landscape on open land, 8 off natural trees, its canopy's columns hard for lots, streets and
	 * walls), {@code "formsCave"} ({@code form.stalactites}, {@code form.roots}: their check reads a frozen volume, the catalogue's
	 * {@code limits.volume}) and {@code "formsWater"} ({@code form.coral}: live coral as a plan body's own cells). And the journal's
	 * "still ours" (Java, always): a huge mushroom block's faces and pointed dripstone's thickness are volatile, and a dead coral is
	 * the live coral Architect wrote (undo and removal restore it).
	 * Since 1.38.0 (6c RS), an RS helper ({@code region.survival}) adds {@code "regionSurvival"}: in a survival world (the toggle on, not
	 * creative) regions plan, check and realise in survival: the land they shape is free and written at once, everything they build is a
	 * construction target fed from the owner's stockpile ({@link RegionView#build}), a plan answers {@code cost.survival} per part and
	 * refuses a creative-only block {@code SURVIVAL}, and removal refunds what stands.
	 * Since 1.38.0 (6c S3), an S3 helper ({@code region.terracedZones}) adds {@code "terracedZones"}: plan/0's {@code terraces: {rise, retain,
	 * stairs}} on a standard zone or a district lays its lots down the slope as levels {@code rise} apart (each lot with its apron on its own
	 * level, rims over 2 retained by a wall with a rail, or blended by the relief), joined by routes between the lots' junctions instead of
	 * a street; and ({@code region.monastery}) {@code "scenarioS3"} (the bundled {@code terraced_monastery} program, S3's terraced mountainside
	 * monastery). No new record, method, reason or IR kind; old IRs are {@code PLAN_STALE} by the kit version, as every kit bump.
	 * Since 1.38.0 (6c FL), an FL helper ({@code plan.layouts}) adds {@code "freeLayouts"}: plan/0's {@code layout.ring},
	 * {@code layout.spiral}, {@code layout.grid}, {@code layout.organic}, {@code locator.around} (zones and forms) and
	 * {@code sketch.outline} are compiled (lots stay axis-aligned rects with a cardinal front, their streets ordinary roads); every
	 * street road a plan region writes carries the road ext {@code architect_mc:street: {zone, district?}} (S-FL-5), on its
	 * batch item.
	 * Since 1.40.0 (7a CW), a CW helper ({@code region.catwalks}) adds {@code "catwalks"}: plan/0's {@code connector.catwalk} (the face
	 * form: a level deck on brackets along a cliff, railed on its open side) is compiled (route row 10), the graph edge typed
	 * {@code catwalk} with its crossing {@code {type, length, brackets}}, the siteplan's {@code catwalks[]}. No new record, method or
	 * reason.
	 * Since 1.41.0 (7a K2), a K2 helper adds {@code "wallAlong"} ({@code region.walls.along}: plan/0's {@code wall.along}, a wall along a
	 * shore, a biome edge or a ridge, open, its gates where routes cross and {@code gates.min} evenly) and {@code "wallWalks"}
	 * ({@code region.walls.walk}: a wall's {@code walk} member, a railed and lit walk on its top with stairs or ladders up from the
	 * inside, player only; the siteplan's {@code walls[].walk}, graph edges {@code type: wall_walk}). No new record or method.
	 * Since 1.43.0 (7a RK), an RK helper ({@code region.rockStairs}) adds {@code "rockStairs"}: plan/0's {@code connector.rock_stair} (a straight
	 * stair flight carved or bored into rising ground, lined and lit; route row 11) is compiled, the graph edge typed {@code rock_stair}
	 * with its crossing {@code {type, rise, steps, cover}}, the siteplan's {@code rockStairs[]}. A plan with one is checked in the
	 * two-plan flow as a tunnel's (its corridor's frozen volume; {@code limits.volume}), and an artifact's stale rock names it
	 * ({@code ARTIFACT_STALE} "rock_stair &lt;part&gt;: ..."). No new record, method or reason.
	 * Since 1.43.0 (7a SA), an SA helper ({@code region.spirals}) adds {@code "spiralStairs"}: plan/0's {@code connector.stairs_around} (a
	 * spiral stair round a rock spire, an ice spike, a giant tree's trunk or a giant mushroom's stem to a railed lookout, a path leg from
	 * {@code from} to its foot) is compiled; the graph gains a {@code lookout} node and an edge typed {@code stairs_around} with its
	 * crossing {@code {type, host, rise, turns}}; the siteplan's {@code spirals[]}. No new record, method or reason.
	 * Since 1.43.0 (7a LF), an LF helper ({@code region.lifts}) adds {@code "liftConnectors"}: plan/0's {@code connector.lift} (a bubble column
	 * against a face rising 4 to 64 in a tower 2 thick, entered through a two-door airlock and left over a railed rim; {@code down}: a second
	 * column; route row 9; player only) is compiled, the graph edge typed {@code lift} with its crossing {@code {type, rise, down}}, the
	 * siteplan's {@code lifts[]}, the {@code architect_mc:fluids} rows of its body. The column is a fluid body (H): written in the
	 * {@code fluids} stage as {@code bubble_column} states (the IR kind {@code bubbleColumns}), census-exact, drained first on removal. The
	 * journal's "still ours" gains a global row: a cell written as a bubble column holds as any bubble column, a water source or air, and a
	 * cell written as a water source holds as a bubble column (deltas, {@code versionOf}, adopt counts and survival matches read it). No new
	 * record, method or reason.
	 * Since 1.43.0 (7a K3), a K3 helper ({@code region.walls.lots}) adds {@code "wallLots"}: the towers, corner lots and gatehouses a wall
	 * names are sited on the wall's line (withheld from their zone's street; a gatehouse straddles a gate run with a passage through it,
	 * routes cross the wall there); the plan-check artifact's {@code lots[].onWall} ({@code wall}, {@code at}, {@code floorY}, the box's
	 * {@code outerFaces} and a gatehouse's {@code passage}) and {@code lots[].ports}; the siteplan's {@code walls[].lots}. When a lot on a
	 * wall binds, {@link Regions#realiseApproved} refuses {@link Reason#ARTIFACT_STALE} ("lot &lt;id&gt; on wall &lt;wall&gt;: ...")
	 * if its design leaves the wall's outer faces open (air, a door, a fence gate or a trapdoor there) or the passage floor is not
	 * standable; the realise drops the entry's blocks on a gatehouse's passage (IRR's rule) and the lot's site never owns those cells.
	 * No new record, method or reason.
	 * (TJ, since 1.58.0) Every feature name that is a dotted sidecar name also comes as a camelCase alias, and both are advertised (names
	 * are stable within 1.x): {@code "design.opKeys"} and {@code "designOpKeys"}, {@code "wallLots.exactMassing"} and
	 * {@code "wallLotsExactMassing"}, {@code "job.systemRefs"} and {@code "jobSystemRefs"}. New consumers should check the camelCase
	 * name. (TJ AV, since 1.58.0) {@code "apiVersion"}: {@link #apiVersion()} exists.
	 * Since 1.43.0 (7a K3), a helper with {@code design.opKeys} adds {@code "design.opKeys"} (the same name): {@link DesignRequest#opKey}
	 * (request identity), {@link Designs#designByKey}, {@link Designs#cancelDesign} ({@link CancelOutcome}) and the DONE ordering
	 * of {@link Designs#get}.
	 * Since 1.43.0 (7a K3), a helper with {@code wallLots.exactMassing} adds {@code "wallLots.exactMassing"} (the same name): a design
	 * request carrying {@code ext["architect:wallLot"]} (a wall lot; its maxSize the lot's exact box) has, in a massing-first group, a
	 * massing whose footprint is exactly the box (x and z; else the round fails and is repaired) and a detail pass capped by the box
	 * (not the massing's size + 2), so the detail can fill the box and close the wall. Other requests are unchanged. No new record,
	 * method or reason.
	 * Since 1.45.0 (7a GM), a GM helper ({@code region.walls.mechanisms}) adds {@code "gateMechanisms"}: a gate lot on a wall's line
	 * ({@code connector.wall.lots[]}) may name {@code mech} ({@code portcullis}, the split sliding grate and the default; {@code slide};
	 * {@code swing}) and {@code rest}. In a box at least 13 along the wall, 7 through it and 10 high its passage gets the mechanism: the
	 * artifact's {@code lots[].onWall.passage.mechanism {kind, rest, width, dayDriven, cells, lotCells, triggers, states, rungs, brief}},
	 * its envelope merged into {@code onWall.passage.lotCells} (the lot's reserved cells), the graph's {@code pg_<lot>} {@code state},
	 * {@code closesAtNight} and {@code mechanism}; a smaller box keeps the plain passage with the deviation {@code mechanism}, refused
	 * {@code NO_ROOM} on a required wall. {@link Regions#realiseApproved} picks the daylight sensor's rung from the bound design (no
	 * sky-exposed rung: levers only, the lot site's {@code architect_mc:gateMechanism} deviation {@code mechanism.sensor}) and writes the
	 * mechanism as the region's cells after the lot (the design's blocks there dropped). No new record, method or reason.
	 * Since 1.50.0 (slice PG), a PG helper ({@code region.plan.passageJoin}) adds {@code "passageJoins"}: a K3 gatehouse's passage is a
	 * gate of the join through a walled town ({@code "gateJoins"}): the district's join crosses it front port to back port, never writing
	 * it, and opens on the town's own lane at the back port (no leg in). The IR's {@code reach.gate} gains {@code kind: passage},
	 * {@code lot} and, with a gate mechanism, {@code mechanism {kind, rest, volatile}}; {@code via} is "region:lot". A gatehouse not built is
	 * skipped "not standing as built"; a mechanism resting closed (swing) is skipped as player-only; a wall's lot boxes now count as its
	 * wall, so a walled town with wall lots answers {@code NO_JOIN [wall]} (listing its gates), no longer {@code NO_JOIN [route]}. No new
	 * record, method or reason.
	 * Since 1.44.0 (7a GJ), a GJ helper ({@code region.plan.gateJoin}) adds {@code "gateJoins"}: where a district's join (a {@code beside}
	 * plan, {@code checkBeside}, plan/0's {@code endpoint.region}) would answer {@code NO_JOIN [wall]}, it crosses one standing gate of the
	 * town's wall or of a wall region round the town (open or a wooden door; a fence gate is skipped for a villager join), never writing
	 * it: two runs and a traverse. The district's {@code join_external} gains {@code via} ("region:gate"), {@code junction {kind: gate,
	 * gate, at, then}} and {@code crossing {type: gate, lands}}; {@code architect_mc:land}'s join part gains {@code via}; the IR's
	 * {@code reach.gate}. The realise re-check refuses {@code ARTIFACT_STALE} naming the gate when it no longer stands as planned; removing
	 * the wall region first sets the district's {@code dangling} (with {@code gateRemoved}). {@link BesideJoin} is unchanged (its kind is the
	 * junction the join ends at). No new record, method or reason.
	 * (7b, since 1.53.0) Names reserved for phase 7b, advertised only by the slice that makes each work (never by the foundation, whose
	 * members are stubs: {@link Sites#fitToSite}, {@link Survey#site}, {@link Designs#siteVariant} and {@link Regions#affordances} throw,
	 * and a request carrying a {@link SiteSpec} is refused, until then): {@code "siteDesign"} (site-aware design and placement:
	 * {@link DesignRequest#site()}, {@link PlaceRequest#site()}, fitToSite, siteVariant), {@code "siteSurvey"} (Survey.site and a
	 * plan's affordances), {@code "siteLots"} ({@link LotSpec#site()}) and {@code "linkPass"} (links to design ports at realise).
	 * (7b AF, since 1.53.0) {@code "siteSurvey"} is advertised when the helper has the site analysis (its {@code site.analyse}):
	 * {@link Survey#site} and {@link Regions#affordances} work. (7b DS, since 1.53.0) {@code "siteDesign"} is advertised when the helper
	 * designs into sites (its {@code site.design}): {@link DesignRequest#site()} on a design, a group item or an estimate,
	 * {@link Designs#siteVariant}, SITE entries following their source, and the estimate kind {@link Estimate.Kind#SITE}.
	 * (M5 GP, since 1.55.0) {@code "givenPrograms"} is advertised when the helper runs callers' kit programs (its {@code design.program}):
	 * {@link Designs#fromProgram}, {@link Designs#variant} and {@link Designs#variantByKey}.
	 * (7c, since 1.55.0) Names reserved for phase 7c (composition), advertised only by the slice that makes each work, never by the
	 * foundation (docs/CONTRACT.md "Phase 7c" §2): {@code "bigForms"} (BF: form.hollow_mountain, form.crater, form.floating_island),
	 * {@code "hiddenRooms"} (HR: form.hidden_room and the artifact's secrets), {@code "suspendedBuilds"} (US: rule.suspended),
	 * {@code "aqueduct"} (AQ: channel.aqueduct), {@code "regionM15"} (RM), {@code "styleFormat3"} (SF), {@code "scenarioTemplates"}
	 * (TC), {@code "compose"} (CO: {@link Regions#compose}), {@code "programAuthoring"} (AU: {@link Regions#authorProgram}),
	 * {@code "shapePromotion"} (PM), {@code "composites"} (CM-b: {@link CompositeInfo}) and {@code "placeConnector"} (CX:
	 * {@link Sites#placeConnector}). {@link Regions#planCatalogue(Set)} has no feature name: it works from API 1.55.0 on.
	 * (7c BF, since 1.56.0) {@code "bigForms"} is advertised when the helper's kit plans the big forms (its {@code plan.bigForms}): plan/0's
	 * {@code form.hollow_mountain}, {@code form.crater} (its lake an H pond body) and {@code form.floating_island} are supported, each
	 * natural cut and fill (free in survival); a hollow mountain's cavern, ledge and halls are recorded in the plan's affordances
	 * ({@link Regions#affordances}: cliff_face, cave, ledge). No new record, method or reason.
	 * (7c HR, since 1.57.0) {@code "hiddenRooms"} is advertised when the helper's kit plans hidden rooms (its {@code plan.hiddenRooms}): plan/0's
	 * {@code form.hidden_room {host, size, entrance}} is supported (a room behind a concealed entrance in a form.hollow_mountain, a
	 * form.waterfall or a lot of the plan). Where each stands (its entrance cell and kind, its host, its room's box) is only in the
	 * artifact's {@code $.secrets[]} ({@link Regions#artifact}): never in a part's answer, the check's preview or its siteplan, unless the
	 * request asks with {@code ext[}{@link PlanRequest#EXT_SECRETS}{@code ]: true} (then {@code preview.secrets} and
	 * {@code preview.siteplan.secrets}). In survival the hollow is free and the entrance a construction target. No new record, method or reason.
	 * (7c AQ, since 1.58.0) {@code "aqueduct"} is advertised when the helper's kit plans aqueducts (its {@code plan.aqueduct}): a plan/0
	 * course ({@code connector.channel} from/to) whose level must stand more than its fill over low ground is carried over it on arches
	 * (the default) or piers ({@code params.span}), its trough's side walls 2 thick, in the Style's roles (where it answered
	 * {@code unsupported channel.aqueduct} before); the part's answer has the block {@code channel.aqueduct} and
	 * {@code aqueduct {span, every, length, rise, piers}}. In survival the piers, arches, walls and lining are construction targets and the
	 * water is free. No new record, method or reason.
	 * (7c RM, since 1.57.0) {@code "regionM15"} is advertised when the helper's kit checks region M15 (its {@code region.m15}): the region
	 * check's warnings {@code M15:cantilever}, {@code M15:joint} (a port link's end, at a site lot's port), {@code M15:span} (over a Style
	 * format 3 connector type's {@code maxSpan}) and {@code M15:neck}. Warnings only: no plan answer, record, method or reason changes.
	 * (7c TC, since 1.57.0) {@code "scenarioTemplates"} is advertised when the helper has the template catalogue (its
	 * {@code region.templates}): {@link Regions#design}'s pick also lists the scenario programs ({@code flat_village}, {@code ice_outpost},
	 * {@code terraced_monastery}, {@code s5_treehouses}, {@code s6_cave_city}; {@code floating_islands} already was), each with the land
	 * features it needs ({@code needs.affordances}: AF kinds, counts and metric floors); the mod freezes the claim's volume (read only) so
	 * the pick sees the claim's affordance summary, and a pick that would land a template on land without its features answers
	 * {@code NO_TEMPLATE} with that program as the closest. No new record, method or reason.
	 * (7c CO, since 1.58.0) {@code "compose"} is advertised when the helper has the standalone composer (its {@code region.compose}):
	 * {@link Regions#compose} works, and {@link Regions#checkPlan} honours {@link PlanRequest#EXT_PLAN_IMAGES}.
	 * (7c US, since 1.58.0) {@code "suspendedBuilds"} is advertised when the helper's kit plans inverted builds (its
	 * {@code plan.suspendedBuilds}): plan/0's {@code rule.suspended {scope}} is supported. The lots of each elevated lots zone in scope stand
	 * on overhangs only (suspend site lots hung from the rock ceilings), and each artifact lot carries {@code inverted: true}: its design is
	 * built upside down (the kit's {@code bp.invert()}), placed and built like any suspend site lot (in survival, in support order from the
	 * ceiling). An overhang made by the plan's own forms can't host one (the land is read before the plan). No new record, method or reason.
	 */
	Set<String> features();
}
