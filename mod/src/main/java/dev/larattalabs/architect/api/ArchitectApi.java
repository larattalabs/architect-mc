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
	String VERSION = "1.37.0";

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
	 * Since NEXT (6c S3), an S3 helper ({@code region.terracedZones}) adds {@code "terracedZones"}: plan/0's {@code terraces: {rise, retain,
	 * stairs}} on a standard zone or a district lays its lots down the slope as levels {@code rise} apart (each lot with its apron on its own
	 * level, rims over 2 retained by a wall with a rail, or blended by the relief), joined by routes between the lots' junctions instead of
	 * a street; and ({@code region.monastery}) {@code "scenarioS3"} (the bundled {@code terraced_monastery} program, S3's terraced mountainside
	 * monastery). No new record, method, reason or IR kind; old IRs are {@code PLAN_STALE} by the kit version, as every kit bump.
	 */
	Set<String> features();
}
