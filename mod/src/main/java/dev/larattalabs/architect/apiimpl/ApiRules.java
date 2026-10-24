package dev.larattalabs.architect.apiimpl;

import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.placement.Occupancy;
import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/** The pure rules behind the public API (docs/CONTRACT.md phase 4a), tested without a game. Internal. */
public final class ApiRules {
	/** The largest area (per side, in columns) a survey samples at resolution 1. */
	public static final int SURVEY_FULL_MAX = 256;
	/** The coarse survey resolution. */
	public static final int SURVEY_COARSE = 4;
	/** A namespaced ext key: {@code <modid>:<key>}. */
	public static final Pattern EXT_KEY = Pattern.compile("[a-z0-9_.-]+:[^\\s]+");

	/**
	 * The Java-side feature names, always present (docs/CONTRACT.md phase 4a: STABLE within major version 1, never renamed or
	 * removed).
	 */
	public static final java.util.Set<String> JAVA_FEATURES = java.util.Set.of("sites", "events", "designs", "library", "survey", "survivalInfo",
		"compositePreview", "batchPlacement", "siteGroups", "stages", "groupCrate", "journal", "overlapLayer", "roads", "cellSites",
		"stackQuery", "entryVersions", "blueprintDelta", "deltaApply", "siteRevert", "deltaPreview", "regionPrepare", "generatedOnly", "cellConditions",
		"chunkBound", "surveyVolume", "regionNudge", "regionOpKeys", "lotExt", "frozenWater", "siteWaiting", "fullBom", "stockpile",
		"schematics", "targetPause", "removalLeavesFeed", "builds", "adopt", "planCatalogueView", "weatheringOurs",
		// 6c close-out A: keyed artifact pins, the world-start plan sweep, region item waits with their region and parts
		"keyedPins", "planSweep", "regionWaitParts",
		// (6c D3, D-S3) every districts region's land in its ext (architect_mc:land)
		"districtLand");

	private ApiRules() {
	}

	/**
	 * {@code ArchitectApi.features()}: the Java-side names, plus, only when the sidecar chose protocol 2, {@code "protocol2"}
	 * and the sidecar's features under their stable names ({@code job.run} / {@code jobs} -> "jobs", {@code job.tools} /
	 * {@code jobTools} -> "jobTools", {@code blob.put} / {@code blobs} -> "blobs"; other names as the sidecar sends them).
	 */
	public static java.util.Set<String> features(int protocol, java.util.Collection<String> sidecarFeatures) {
		java.util.Set<String> out = new java.util.TreeSet<>(JAVA_FEATURES);
		if (dev.larattalabs.architect.placed.TrackingRule.on) {
			out.add("playerPlaced"); // 6c PT: player-placed tracking is on (the world rule architect.playerTracking)
		}
		if (protocol >= 2) {
			out.add("protocol2");
			for (String f : sidecarFeatures) {
				out.add(switch (f) {
					case "job.run", "jobs" -> "jobs";
					case "job.tools", "jobTools" -> "jobTools";
					case "blob.put", "blobs" -> "blobs";
					case "design.polish" -> "polish"; // phase 5b: the helper can polish (the mod's own 5b features are Java names)
					case "region.plan" -> "regions"; // phase 6a
					case "region.tiles" -> "regions";
					case "region.check" -> "regionCheck"; // phase 6b
					case "region.preview" -> "regionPreview";
					case "region.design" -> "regionDesign";
					case "region.blobs" -> "regionBlobs";
					case "ir.format2" -> "irFormat2";
					case "region.keepOut" -> "planKeepOut"; // 6c V
					case "region.lightCover" -> "apronLights"; // 6c W
					case "region.forms1" -> "formsIce"; // 6c F1 (with formsRock and voxelsOp, below)
					case "region.passes" -> "planPasses"; // 6c T1 (with reliefOp, below)
					case "region.scatter" -> "scatterOp"; // 6c F2 (with stampOp, below)
					case "region.brush" -> "brushes"; // 6c B: the helper's kit has the bundled brush program
					case "region.route" -> "routePass"; // 6c T2
					case "region.planCheck" -> "planCheck"; // 6c P0 (with planCatalogue, below)
					case "region.districts" -> "districtsPass"; // 6c D1: the helper's kit has the districts pass and program
					case "region.beside" -> "besideRegion"; // 6c D1: the helper passes a standing region to the plan (region.plan beside)
					case "region.outpost" -> "scenarioS2"; // 6c S2: the helper's kit bundles the ice_outpost program
					case "region.boundary" -> "boundaryDistricts"; // 6c D2: districts following a biome edge, shore or ridge (with outposts, below)
					case "region.walls" -> "wallConnectors"; // 7a K1: plan/0's connector.wall and connector.gate (walls, gates, the gate move)
					case "region.rope" -> "ropeBridges"; // 7a K1: plan/0's connector.rope_bridge (with autoConnector, below)
					case "region.bridges" -> "bridgeConnectors"; // 6c T3: plan/0's connector.bridge (beam and arch; auto's bridge move; the street fallback)
					case "region.tunnels" -> "tunnelConnectors"; // 6c T3: plan/0's connector.tunnel (with planCheckVolumes, below)
					case "region.fluids" -> "regionFluids"; // 6c H: fluid bodies (ponds, fountains, waterfalls, moats), the fluids stage (with fluidVolumes, below)
					case "region.wet" -> "wetWrites"; // 6c H: wet piers, harbour walls and quays (the wet fallback)
					case "vocab" -> "vocabulary"; // 6c VOC: the block vocabulary (the systemRef vocab/1, generated families, tiers, survival classes)
					case "bible.rarity" -> "rarityBudgets"; // 6c VOC-b: BibleRequest.rarity, a bible's rarity member, metrics.rarity, M26/M27, VOCAB
					case "region.hydrology" -> "hydrologyPass"; // 6c HY: the hydrology pass (flow and wet fields, data.courses)
					case "region.courses" -> "regionCourses"; // 6c HY: courses, mill races and ditches (channel.course, .race, .ditch)
					case "region.waterGates" -> "waterGates"; // 6c HY: a course under a wall behind a grate (wall.water_gate)
					case "region.irrigation" -> "farmIrrigation"; // 6c IRR: a farm lot's irrigate (its sources, lots[].irrigation, the lot mask)
					case "region.survival" -> "regionSurvival"; // 6c RS: regions in survival (free land, targets fed from the stockpile)
					case "reserved" -> "designReserved"; // 6c IRR: DesignRequest.reserved, kept by the design job and its checker
					case "plan.rules" -> "rulePalette"; // 6c VOC-c: rule.palette measured (lotBlocks, the artifact's palette rows, PALETTE)
					case "plan.forms2" -> "formsTrees"; // 6c F3: form.giant_tree, form.giant_mushroom (with formsCave and formsWater, below)
					case "region.terracedZones" -> "terracedZones"; // 6c S3: plan/0's terraces member (a zone or district laid down the slope as levels)
					case "region.monastery" -> "scenarioS3"; // 6c S3: the helper's kit bundles the terraced_monastery program (S3's scenario)
					case "region.planDiscard" -> "planDiscard"; // 6c close-out A: the helper removes a discarded plan's dir (Regions.discardPlan)
					case "plan.layouts" -> "freeLayouts"; // 6c FL: plan/0's layout.ring, .spiral, .grid, .organic, locator.around and sketch.outline
					case "region.catwalks" -> "catwalks"; // 7a CW: plan/0's connector.catwalk (the face form; route row 10)
					case "region.plan.besideReach" -> "besideReach"; // 6c D3: the join reaches into a standing town's claim (ends and side T junctions)
					case "region.plan.dry" -> "besideCheck"; // 6c D3: Regions.checkBeside, a dry beside plan that keeps nothing
					case "region.climbs" -> "climbConnectors"; // 7a CL: plan/0's connector.stair, connector.switchback and connector.ladder (since NEXT)
					default -> Wire4b.FEATURE_NAMES.getOrDefault(f, Wire5a.FEATURE_NAMES.getOrDefault(f, f));
				});
			}
			if (sidecarFeatures.contains("region.preview")) {
				out.add("regionGhost"); // the ghost's preview tiles come with the 6b helper's previews
			}
			if (sidecarFeatures.contains("region.forms1")) {
				// 6c F1: a forms-I helper's kit has the iceSpike and rockSpire generators and the voxels op
				out.add("formsRock");
				out.add("voxelsOp");
			}
			if (sidecarFeatures.contains("plan.forms2")) {
				// 6c F3: a forms-II helper's kit has the cave forms (form.stalactites, form.roots, their volumes) and coral in a plan body
				out.add("formsCave");
				out.add("formsWater");
			}
			if (sidecarFeatures.contains("region.passes")) {
				out.add("reliefOp"); // 6c T1: a T1 helper's kit has the relief op and pass
			}
			if (sidecarFeatures.contains("region.boundary")) {
				out.add("outposts"); // 6c D2: an outpost district and its corridor
			}
			if (sidecarFeatures.contains("region.rope")) {
				out.add("autoConnector"); // 7a K1: plan/0's connector.auto (walk, stair, ladder and rope moves)
			}
			if (sidecarFeatures.contains("region.tunnels")) {
				out.add("planCheckVolumes"); // 6c T3: checkPlan of a plan with a tunnel part plans twice, reading frozen volumes
			}
			if (sidecarFeatures.contains("region.fluids")) {
				out.add("fluidVolumes"); // 6c H: frozen volumes with a fluid layer (ARVX version 3), read by H's plan check and its guards
			}
			if (sidecarFeatures.contains("region.planCheck")) {
				out.add("planCatalogue"); // 6c P0: a P0 helper's kit returns the capability catalogue with every check
			}
			if (sidecarFeatures.contains("region.scatter")) {
				out.add("stampOp"); // 6c F2: an F2 helper's kit has the scatter and stamp ops (and reads the local stamp library)
			}
			if (sidecarFeatures.contains("region.keepOut")) {
				// 6c V: a V helper's kit has the flat_village program, the IR graph and the villager mover with M22-M24
				out.add("flatVillage");
				out.add("regionGraph");
				out.add("villagerMover");
			}
		}
		return java.util.Set.copyOf(out);
	}

	/** The reason of an occupancy refusal: a player in the box wins over every other entity. */
	public static Reason occupancyReason(List<Occupancy.Kind> kinds) {
		return kinds.contains(Occupancy.Kind.PLAYER) ? Reason.PLAYER_IN_BOX : Reason.OCCUPIED;
	}

	/** Whether a placement in {@code mode} becomes a construction site, given the world's survival toggle. */
	public static boolean construction(Mode mode, boolean survivalOn) {
		return switch (mode) {
			case AUTO -> survivalOn;
			case INSTANT -> false;
			case CONSTRUCTION -> true;
		};
	}

	/**
	 * The actor rule: INSTANT in a survival-toggle world needs an actor with permission level 2 (no free builds by an entity
	 * or a mod on its own). Null = allowed; else the NOT_ALLOWED message.
	 */
	public static @Nullable String modeRefusal(Mode mode, boolean survivalOn, boolean hasActor, boolean actorHasPermission2) {
		if (mode != Mode.INSTANT || !survivalOn) {
			return null;
		}
		if (!hasActor) {
			return "Instant placement in a survival world needs a player with permission level 2 (cheats or op) as the actor; no actor was given";
		}
		if (!actorHasPermission2) {
			return "Instant placement in a survival world needs permission level 2 (cheats or op); the actor does not have it";
		}
		return null;
	}

	/**
	 * The owner rule of an API remove: a site whose owner differs from the requester (null = the player) needs force.
	 * Null = allowed; else the refusal.
	 */
	public static @Nullable String removeRefusal(String siteId, @Nullable String owner, @Nullable String requester, boolean force) {
		if (force || Objects.equals(owner, requester)) {
			return null;
		}
		return siteId + " is owned by " + (owner == null ? "the player" : owner) + ", not " + (requester == null ? "the player" : requester)
			+ "; pass force to remove it anyway";
	}

	/** Whether a site with {@code owner} belongs to the {@code filter} of {@code Sites.list(owner)} (null: the player's own). */
	public static boolean ownerMatches(@Nullable String owner, @Nullable String filter) {
		return Objects.equals(owner, filter);
	}

	public static boolean extKeyValid(@Nullable String key) {
		return key != null && EXT_KEY.matcher(key).matches();
	}

	/** The resolution a survey uses: 1 when asked for and the area is at most 256x256 columns, else 4. */
	public static int surveyResolution(int requested, int widthBlocks, int depthBlocks) {
		return requested == 1 && widthBlocks <= SURVEY_FULL_MAX && depthBlocks <= SURVEY_FULL_MAX ? 1 : SURVEY_COARSE;
	}

	/** Sample columns along a side of {@code blocks} at {@code resolution}. */
	public static int surveyColumns(int blocks, int resolution) {
		return (blocks + resolution - 1) / resolution;
	}

	/** Whether a player has permission level 2 (cheats or op): INSTANT in a survival world (phase 5b deltas use it too). */
	public static boolean permission2(net.minecraft.server.level.@Nullable ServerPlayer p) {
		return p != null && p.createCommandSourceStack().permissions().hasPermission(net.minecraft.server.permissions.Permissions.COMMANDS_GAMEMASTER);
	}
}
