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
	String VERSION = "1.12.0";

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
	 */
	Set<String> features();
}
