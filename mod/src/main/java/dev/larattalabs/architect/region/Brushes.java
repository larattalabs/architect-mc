package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BrushKind;
import dev.larattalabs.architect.api.BrushRequest;
import dev.larattalabs.architect.api.Destruction;
import dev.larattalabs.architect.api.Limits;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RealiseRequest;
import dev.larattalabs.architect.api.RegionPlanRequest;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.api.RegionView;
import dev.larattalabs.architect.site.Sites;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * Terrain brushes (docs/CONTRACT.md "Phase 6c slice B"): one stroke is one region (S-B-1). The brush box plus 8 is surveyed at
 * resolution 1 (and the brush box plus {@link #VOLUME_PAD} frozen as a volume with block ids for MELT, CAVE_CARVE and a mask with a
 * block or class term), the bundled {@code brush} program plans it in the sidecar with the request as params (no Claude call, no
 * checker), and the plan is realised at once through the ordinary region path: tile entries in the journal, so the stroke is exactly
 * undoable ({@code Regions.remove}, in any order with other strokes and sites), owned, under the MSPT budget and crash safe.
 *
 * <p>Destruction (§4) is a flag on the stroke's {@link RegionRec#brush} record, read by {@link dev.larattalabs.architect.site.TileCheck}:
 * a stroke writes natural cells and layers over its owner's earlier strokes; {@code PLAYER_BLOCKS} (the permission checked here) also
 * clears unowned non-natural cells, block entities included. Every other owned cell is skipped (K5). Server thread unless noted.
 */
public final class Brushes {
	/** The frozen volume reaches this far past the brush box ({@code VOLUME_PAD} in kit/lib/region/brush.mjs). */
	public static final int VOLUME_PAD = 2;
	/** The survey margin (the claim is the brush box plus this, CONTRACT B §2). */
	public static final int CLAIM_PAD = 8;
	/** The owner a command's strokes take ({@code architect:player}). */
	public static final String PLAYER_OWNER = "architect:player";
	/** The actor recorded for a console stroke (the console reaches PLAYER_BLOCKS only through the command). */
	public static final String CONSOLE = "console";
	private static final java.util.regex.Pattern OWNER = java.util.regex.Pattern.compile("^[a-z0-9_.-]+:[A-Za-z0-9_./-]+$");

	/** Plans that are strokes: plan id -> the stroke record (taken by the realise into {@link RegionRec#brush}). */
	private static final Map<String, JsonObject> STROKES = new ConcurrentHashMap<>();
	/** Strokes realising: region id -> the caller's future (completed when the region is PLACED, PARTIAL or FAILED). */
	private static final Map<String, CompletableFuture<RegionView>> PENDING = new HashMap<>();
	/** Latency marks (DevBridge {@code dev.brush.stats}): region id -> {requested, planned, realised} epoch ms. */
	static final Map<String, long[]> TIMES = new ConcurrentHashMap<>();

	private Brushes() {
	}

	/** The stroke's kind name, or null for a region that is not a stroke. */
	public static @Nullable String kindOf(RegionRec r) {
		return r.brush == null || !r.brush.has("kind") ? null : r.brush.get("kind").getAsString().toUpperCase(Locale.ROOT);
	}

	/** The stroke record a plan was made for (null: not a stroke). */
	static @Nullable JsonObject strokeOf(String planId) {
		return STROKES.get(planId);
	}

	/** A stroke record's brush box {minX, minY, minZ, maxX, maxY, maxZ}. */
	static int[] box(JsonObject stroke) {
		JsonArray a = stroke.getAsJsonArray("box");
		int[] b = new int[6];
		for (int i = 0; i < 6; i++) {
			b[i] = a.get(i).getAsInt();
		}
		return b;
	}

	/** The brush box (kit brushBox): x/z within the radius, y within the radius, clamped to the world's build height. */
	public static int[] brushBox(BlockPos c, int radius, int minY, int maxY) {
		return new int[] {c.getX() - radius, Math.max(minY, c.getY() - radius), c.getZ() - radius, c.getX() + radius, Math.min(maxY, c.getY() + radius),
			c.getZ() + radius};
	}

	/** The frozen volume's box (kit volumeBox): the brush box plus {@link #VOLUME_PAD}, y clamped. */
	public static int[] volumeBox(BlockPos c, int radius, int minY, int maxY) {
		return new int[] {c.getX() - radius - VOLUME_PAD, Math.max(minY, c.getY() - radius - VOLUME_PAD), c.getZ() - radius - VOLUME_PAD, c.getX() + radius
			+ VOLUME_PAD, Math.min(maxY, c.getY() + radius + VOLUME_PAD), c.getZ() + radius + VOLUME_PAD};
	}

	/** Whether a stroke reads a frozen volume (kit needsVolume): MELT, CAVE_CARVE, a mask with a block or class term. Pure. */
	public static boolean needsVolume(BrushKind kind, @Nullable JsonObject mask) {
		if (kind == BrushKind.MELT || kind == BrushKind.CAVE_CARVE) {
			return true;
		}
		return mask != null && java.util.regex.Pattern.compile("\"(block|class)\":").matcher(mask.toString()).find();
	}

	/**
	 * The field and permission rules, before anything is sampled (null: fine). {@code console}: the command from the server console.
	 * Pure but for the actor's lookup.
	 */
	static @Nullable ArchitectRefused refusal(BrushRequest r, @Nullable ServerPlayer actor, boolean console) {
		if (r.owner() == null || r.owner().isBlank()) {
			return new ArchitectRefused(Reason.FIELD_LIMIT, "owner: required (<modid>:<thing>, or " + PLAYER_OWNER + ")");
		}
		if (r.owner().length() > Limits.OWNER_MAX || !OWNER.matcher(r.owner()).matches()) {
			return new ArchitectRefused(Reason.FIELD_LIMIT, "owner: \"" + r.owner() + "\" is not <modid>:<thing> (at most " + Limits.OWNER_MAX + " characters)");
		}
		if (r.kind() == null || r.center() == null || r.dimension() == null) {
			return new ArchitectRefused(Reason.FIELD_LIMIT, (r.kind() == null ? "kind" : r.center() == null ? "center" : "dimension") + ": required");
		}
		if (r.radius() < Limits.BRUSH_RADIUS_MIN || r.radius() > Limits.BRUSH_RADIUS_MAX) {
			return new ArchitectRefused(Reason.FIELD_LIMIT, "radius: " + r.radius() + ", must be " + Limits.BRUSH_RADIUS_MIN + "-" + Limits.BRUSH_RADIUS_MAX);
		}
		if (r.strength() < Limits.BRUSH_STRENGTH_MIN || r.strength() > Limits.BRUSH_STRENGTH_MAX) {
			return new ArchitectRefused(Reason.FIELD_LIMIT, "strength: " + r.strength() + ", must be " + Limits.BRUSH_STRENGTH_MIN + "-"
				+ Limits.BRUSH_STRENGTH_MAX);
		}
		if (r.dimension() != Level.OVERWORLD) {
			return new ArchitectRefused(Reason.NOT_ALLOWED, "brush strokes are Overworld only in this version");
		}
		if (dev.larattalabs.architect.survival.SurvivalWorld.on()) {
			return new ArchitectRefused(Reason.NOT_ALLOWED, "brush strokes are refused in a survival-toggle world (until regions in survival)");
		}
		// (6c PT, N-PT-5) a build's own placer may consent to PLAYER_BLOCKS on that build (it then clears only the builds the consent
		// names; every other player block stays); B's op-only rule (N-B-1) stays for everyone else's blocks
		if (r.destruction() == Destruction.PLAYER_BLOCKS && !console && !dev.larattalabs.architect.apiimpl.ApiRules.permission2(actor) && (actor == null
			|| dev.larattalabs.architect.placed.BuildViews.consent(actor.level().getServer(), r.consent(), false).allowed().isEmpty())) {
			return new ArchitectRefused(Reason.PERMISSION, r.actor() == null ? "PLAYER_BLOCKS needs an actor: an online player with permission level 2"
				: actor == null ? "PLAYER_BLOCKS needs an online player with permission level 2 as the actor (" + r.actor() + " is not online)"
					: "PLAYER_BLOCKS needs permission level 2 (op); " + actor.getGameProfile().name() + " does not have it");
		}
		return null;
	}

	/** (6c PT) The builds a stroke may clear: its PLAYER_BLOCKS consent, checked at the stroke (a NATURAL_ONLY stroke skips every build). */
	public static java.util.Set<String> consented(JsonObject stroke) {
		java.util.Set<String> out = new java.util.LinkedHashSet<>();
		if (stroke.get("consented") instanceof JsonArray a) {
			a.forEach(e -> out.add(e.getAsString()));
		}
		return out;
	}

	/** The request as the program's params. Pure. */
	static JsonObject params(BrushRequest r) {
		JsonObject p = new JsonObject();
		p.addProperty("kind", r.kind().name().toLowerCase(Locale.ROOT));
		p.addProperty("shape", r.shape().name().toLowerCase(Locale.ROOT));
		p.addProperty("cx", r.center().getX());
		p.addProperty("cy", r.center().getY());
		p.addProperty("cz", r.center().getZ());
		p.addProperty("radius", r.radius());
		p.addProperty("strength", r.strength());
		if (r.mask() != null) {
			p.add("mask", r.mask().spec());
		}
		if (r.pattern() != null) {
			p.add("pattern", r.pattern().spec());
		}
		p.addProperty("destruction", r.destruction().name().toLowerCase(Locale.ROOT));
		return p;
	}

	/**
	 * One stroke. {@code console}: {@code /architect brush} from the server console (the one way to PLAYER_BLOCKS without a player).
	 * Any thread; the work starts on the server thread.
	 */
	public static CompletableFuture<RegionView> stroke(BrushRequest r, boolean console) {
		MinecraftServer s = RegionsImpl.server();
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no world"));
		}
		long t0 = System.currentTimeMillis();
		return RegionsImpl.onServer(s, () -> {
			ServerPlayer actor = r.actor() == null ? null : s.getPlayerList().getPlayer(r.actor());
			ArchitectRefused no = refusal(r, actor, console);
			if (no != null) {
				throw no;
			}
			ServerLevel level = s.getLevel(r.dimension());
			if (level == null) {
				throw new ArchitectRefused(Reason.NOT_ALLOWED, r.dimension() + " is not loaded");
			}
			int[] box = brushBox(r.center(), r.radius(), level.getMinY(), level.getMaxY());
			if (box[1] > box[4]) {
				throw new ArchitectRefused(Reason.FIELD_LIMIT, "center: y " + r.center().getY() + " is outside the world's build height");
			}
			String dim = Sites.dimensionId(level);
			String prot = RegionsImpl.protectedClaim(dim, r.owner(), box);
			if (prot != null) {
				throw new ArchitectRefused(Reason.PROTECTED, prot);
			}
			// a stroke never prepares: every chunk it writes (and its volume reads) must be loaded now
			int[] vb = volumeBox(r.center(), r.radius(), level.getMinY(), level.getMaxY());
			for (int cx = vb[0] >> 4; cx <= vb[3] >> 4; cx++) {
				for (int cz = vb[2] >> 4; cz <= vb[5] >> 4; cz++) {
					if (level.getChunkSource().getChunkNow(cx, cz) == null) {
						throw new ArchitectRefused(Reason.NOT_LOADED, "chunk " + cx + ", " + cz + " of the brush is not loaded (a stroke never generates or loads)");
					}
				}
			}
			TileStream.Link link = TileStream.link;
			if (link == null || !link.connected()) {
				throw new ArchitectRefused(Reason.SIDECAR_UNAVAILABLE, "the helper (sidecar) is not connected");
			}
			JsonObject rec = new JsonObject();
			rec.addProperty("kind", r.kind().name().toLowerCase(Locale.ROOT));
			rec.addProperty("shape", r.shape().name().toLowerCase(Locale.ROOT));
			rec.addProperty("destruction", r.destruction().name().toLowerCase(Locale.ROOT));
			boolean op = console || dev.larattalabs.architect.apiimpl.ApiRules.permission2(actor);
			// checked above; (6c PT) B's rule (every unowned non-natural cell) only for an op or the console: a placer's consented stroke
			// clears just the builds its consent names
			rec.addProperty("playerBlocks", r.destruction() == Destruction.PLAYER_BLOCKS && op);
			if (r.destruction() == Destruction.PLAYER_BLOCKS) {
				JsonArray cs = new JsonArray();
				dev.larattalabs.architect.placed.BuildViews.consent(s, r.consent(), console).allowed().stream().sorted().forEach(cs::add);
				if (!cs.isEmpty()) {
					rec.add("consented", cs);
				}
			}
			rec.addProperty("actor", console ? CONSOLE : r.actor() == null ? "" : r.actor().toString());
			JsonArray ba = new JsonArray();
			for (int v : box) {
				ba.add(v);
			}
			rec.add("box", ba);
			BoundingBox claim = new BoundingBox(box[0] - CLAIM_PAD, level.getMinY(), box[2] - CLAIM_PAD, box[3] + CLAIM_PAD, level.getMaxY(), box[5]
				+ CLAIM_PAD);
			JsonObject ext = new JsonObject();
			ext.addProperty(RegionsImpl.EXT_CHECK, false);
			ext.addProperty(RegionsImpl.EXT_NO_VOLUMES, true);
			RegionPlanRequest pr = new RegionPlanRequest("brush", params(r), level, claim, r.seed(), null, null, LoadPolicy.LOADED_ONLY, r.owner(), ext, null);
			CompletableFuture<@Nullable JsonArray> vol = needsVolume(r.kind(), r.mask() == null ? null : r.mask().spec())
				? volume(level, new BoundingBox(vb[0], vb[1], vb[2], vb[3], vb[4], vb[5]))
				: CompletableFuture.completedFuture(null);
			return vol.thenCompose(v -> RegionsImpl.INSTANCE.planStroke(pr, v)).thenCompose(plan -> RegionsImpl.onServer(s, () -> {
				STROKES.put(plan.planId(), rec);
				long t1 = System.currentTimeMillis();
				RealiseRequest rr = new RealiseRequest(plan.planId(), Mode.INSTANT, actor, Map.of(), null, true, null, true, new JsonObject());
				return RegionsImpl.INSTANCE.realise(rr).whenComplete((id, e) -> STROKES.remove(plan.planId())).thenCompose(id -> RegionsImpl.onServer(s, () -> {
					TIMES.put(id, new long[] {t0, t1, 0});
					CompletableFuture<RegionView> f = new CompletableFuture<>();
					PENDING.put(id, f);
					Architect.LOGGER.info("Brush stroke {} ({} r{} s{} {} at {}) by {}: plan {}", id, r.kind(), r.radius(), r.strength(), r.destruction(), r.center()
						.toShortString(), r.owner(), plan.planId());
					return f;
				}).thenCompose(f -> f));
			}).thenCompose(f -> f));
		}).thenCompose(f -> f);
	}

	/** The stroke's frozen volume with block ids (LOADED_ONLY: the chunks are loaded), uploaded: {@code [{sha, blobId, box}]}. */
	private static CompletableFuture<@Nullable JsonArray> volume(ServerLevel level, BoundingBox bb) {
		return dev.larattalabs.architect.region.volume.VolumeSurvey.start(level, bb, LoadPolicy.LOADED_ONLY, null, true).thenCompose(
			dev.larattalabs.architect.apiimpl.SurveyImpl::upload).thenApply(v -> {
				JsonObject o = new JsonObject();
				o.addProperty("sha", v.sha());
				o.addProperty("blobId", v.blobId());
				JsonObject b = new JsonObject();
				b.addProperty("minX", bb.minX());
				b.addProperty("minY", bb.minY());
				b.addProperty("minZ", bb.minZ());
				b.addProperty("maxX", bb.maxX());
				b.addProperty("maxY", bb.maxY());
				b.addProperty("maxZ", bb.maxZ());
				o.add("box", b);
				JsonArray a = new JsonArray();
				a.add(o);
				return a;
			});
	}

	/** Server tick: completes the futures of strokes that reached PLACED, PARTIAL or FAILED (or were removed meanwhile). */
	static void tick(MinecraftServer s) {
		if (PENDING.isEmpty()) {
			return;
		}
		for (var it = PENDING.entrySet().iterator(); it.hasNext();) {
			var e = it.next();
			RegionsImpl.Live l = RegionsImpl.live(e.getKey());
			RegionState st = l == null ? RegionState.REMOVED : l.rec().state;
			if (st == RegionState.PLACED || st == RegionState.PARTIAL || st == RegionState.FAILED || st == RegionState.REMOVING || st == RegionState.REMOVED) {
				it.remove();
				long[] t = TIMES.get(e.getKey());
				if (t != null) {
					t[2] = System.currentTimeMillis();
				}
				if (l == null) {
					e.getValue().completeExceptionally(new ArchitectRefused(Reason.OTHER, "the stroke " + e.getKey() + " was removed before it finished"));
				} else {
					e.getValue().complete(RegionsImpl.view(l));
				}
			}
		}
	}

	/** The groups whose tile entries a stroke of {@code owner} layers over: the same owner's live strokes (any state but removed). */
	public static Set<String> layerGroups(@Nullable String owner) {
		Set<String> out = new java.util.HashSet<>();
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			RegionRec r = l.rec();
			if (r.brush != null && Objects.equals(r.owner, owner) && !r.groupId.isEmpty()) {
				out.add(r.groupId);
			}
		}
		return out;
	}

	/** The last stroke an actor made (a player's UUID, or {@link #CONSOLE}) that is still standing, or null. */
	public static RegionsImpl.@Nullable Live lastOf(String actor) {
		RegionsImpl.Live best = null;
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			RegionRec r = l.rec();
			if (r.brush == null || !actor.equals(r.brush.has("actor") ? r.brush.get("actor").getAsString() : "") || r.state == RegionState.REMOVING
				|| r.state == RegionState.REMOVED) {
				continue;
			}
			if (best == null || r.createdAt > best.rec().createdAt || r.createdAt == best.rec().createdAt && RegionsImpl.order(r.id) > RegionsImpl.order(best
				.rec().id)) {
				best = l;
			}
		}
		return best;
	}

	/** The latency marks of the strokes (DevBridge): region id -> {requestedMs, plannedMs, realisedMs}. */
	public static List<JsonObject> times() {
		List<JsonObject> out = new ArrayList<>();
		TIMES.forEach((id, t) -> {
			JsonObject o = new JsonObject();
			o.addProperty("region", id);
			o.addProperty("requested", t[0]);
			o.addProperty("planned", t[1]);
			o.addProperty("realised", t[2]);
			out.add(o);
		});
		return out;
	}

	/** A player's UUID as the actor string. */
	public static String actorOf(@Nullable UUID u) {
		return u == null ? "" : u.toString();
	}
}
