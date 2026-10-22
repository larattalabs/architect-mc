package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.api.Reason;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * (6c close-out A, §3 and §14) Plans' retention: their last use, {@code Regions.discardPlan}, the tombstone a discard leaves, the
 * sidecar's plan dirs (sent now, or at its next connect), and the world-start sweep of unrealised plans. Files beside a plan's
 * {@code plans/<id>.json}:
 * <pre>
 * plans/&lt;id&gt;.used.json        {lastUsed}: the plan's last use (written durably on each use; absent: the plan file's time)
 * plans/&lt;id&gt;.discarded.json   {discardedAt, owner?, opKey?, opHash?}: the tombstone
 * plans/discard-pending.json  {plans: [ids]}: discarded plans whose helper dir is still to go
 * </pre>
 * Server thread, except where noted.
 */
public final class PlanRetention {
	/** An unkeyed unrealised plan is swept this long after its last use. */
	public static final long UNKEYED_MS = 7L * 24 * 3600 * 1000;
	/** A plan with a plan key (0a's key retention), and a keyed artifact pin, are swept this long after their last use. */
	public static final long KEYED_MS = 30L * 24 * 3600 * 1000;
	/** The ArchitectRefused detail of a refusal against a discarded plan (PLAN_STALE). */
	public static final String DISCARDED = "discarded";

	/** DevBridge (the gate's forced ages): added to the wall clock for every last use written and every sweep. */
	static volatile long clockOffsetMs;

	/** Discarded keyed plans: {@link RegionKeys#scope} of (owner, "region.plan", key) -> {planId, opHash}. */
	static final Map<String, String[]> DISCARDED_KEYS = new ConcurrentHashMap<>();
	private static volatile int replayedGen = Integer.MIN_VALUE;

	private PlanRetention() {
	}

	/** The retention clock: the wall clock plus the DevBridge offset. */
	public static long now() {
		return System.currentTimeMillis() + clockOffsetMs;
	}

	/** DevBridge: set the clock's offset (ms). */
	public static void clockOffset(long ms) {
		clockOffsetMs = ms;
	}

	static Path plans(Path world) {
		return RegionStore.root(world).resolve("plans");
	}

	private static @Nullable Path world() {
		MinecraftServer s = RegionsImpl.server();
		return s == null ? null : s.getWorldPath(LevelResource.ROOT);
	}

	// ------------------------------------------------------------------ last use

	/** A use of the plan (a lookup by key, a pin of its artifact, a realise attempt): its last use is now. Never throws. */
	public static void touch(@Nullable String planId) {
		Path w = world();
		if (w != null) {
			touchAt(w, planId);
		}
	}

	/** {@link #touch} in a world dir (tests). */
	static void touchAt(Path w, @Nullable String planId) {
		if (planId == null || !planId.matches("[A-Za-z0-9_.-]{1,96}") || planId.contains("..")) {
			return;
		}
		try {
			Path p = plans(w);
			if (!Files.isRegularFile(p.resolve(planId + ".json"))) {
				return;
			}
			JsonObject o = new JsonObject();
			o.addProperty("lastUsed", now());
			RegionStore.writeJson(p.resolve(planId + ".used.json"), o);
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Region plan {}: last use not written: {}", planId, e.toString());
		}
	}

	/** The plan's last use: its {@code used.json}, else its plan file's time (a plan made before close-out A). */
	static long lastUsed(Path plans, String planId) throws IOException {
		JsonObject o = RegionStore.readJson(plans.resolve(planId + ".used.json"));
		if (o != null && o.has("lastUsed")) {
			return o.get("lastUsed").getAsLong();
		}
		Path f = plans.resolve(planId + ".json");
		return Files.isRegularFile(f) ? Files.getLastModifiedTime(f).toMillis() : 0;
	}

	// ------------------------------------------------------------------ tombstones

	public static boolean discarded(String planId) {
		Path w = world();
		return w != null && planId.matches("[A-Za-z0-9_.-]{1,96}") && !planId.contains("..") && Files.isRegularFile(plans(w).resolve(planId + ".discarded.json"));
	}

	/** Whether a discarded tombstone stands for the plan in this world dir. */
	static boolean discardedAt(Path world, String planId) {
		return Files.isRegularFile(plans(world).resolve(planId + ".discarded.json"));
	}

	/** The world start: the discarded keyed plans into {@link #DISCARDED_KEYS}. */
	static void loadTombstones(Path world) {
		DISCARDED_KEYS.clear();
		replayedGen = Integer.MIN_VALUE;
		Path p = plans(world);
		if (!Files.isDirectory(p)) {
			return;
		}
		try (var st = Files.list(p)) {
			for (Path f : st.filter(x -> x.getFileName().toString().endsWith(".discarded.json")).toList()) {
				try {
					JsonObject o = RegionStore.readJson(f);
					if (o != null && o.has("opKey") && o.has("opHash")) {
						String id = f.getFileName().toString().replace(".discarded.json", "");
						DISCARDED_KEYS.put(RegionKeys.scope(o.has("owner") ? o.get("owner").getAsString() : null, "region.plan", o.get("opKey").getAsString()),
							new String[] {id, o.get("opHash").getAsString()});
					}
				} catch (IOException | RuntimeException e) {
					Architect.LOGGER.warn("Region plan tombstone {} unreadable: {}", f.getFileName(), e.toString());
				}
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("Region plan tombstones unreadable: {}", e.toString());
		}
	}

	// ------------------------------------------------------------------ discard

	/** Why a plan can't be discarded now ({@code realised}, {@code busy}, {@code pinned}), with the message; null when it can. */
	static @Nullable String[] held(Path world, String planId) {
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			if (planId.equals(l.rec().planId) && l.rec().state != RegionState.REMOVED) {
				return new String[] {"realised", "plan " + planId + " was realised as region " + l.rec().id + ": remove the region first"};
			}
		}
		if (RegionsImpl.server() != null && Prepare.runningFor(planId)) { // (no server: no prepare runs; tests)
			return new String[] {"busy", "plan " + planId + " is still being prepared"};
		}
		String pinned = PlanChecks.pinnedArtifactOf(world, planId);
		if (pinned != null) {
			return new String[] {"pinned", "artifact " + pinned.substring(0, 12) + " of plan " + planId + " is pinned: unpin it first"};
		}
		return null;
	}

	/** {@code Regions.discardPlan}: see its javadoc. */
	public static CompletableFuture<Boolean> discard(String planId) {
		MinecraftServer s = RegionsImpl.server();
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no world"));
		}
		return RegionsImpl.onServer(s, () -> {
			if (!planId.matches("[A-Za-z0-9_.-]{1,96}") || planId.contains("..")) {
				throw RegionsImpl.refusal(Reason.FIELD_LIMIT, "bad plan id " + planId);
			}
			Path w = s.getWorldPath(LevelResource.ROOT);
			Path p = plans(w);
			if (Files.isRegularFile(p.resolve(planId + ".discarded.json")) || !Files.isRegularFile(p.resolve(planId + ".json"))) {
				return false;
			}
			String[] why = held(w, planId);
			if (why != null) {
				throw new RegionsImpl.RegionException(Reason.OVERLAP_BUSY, why[1], why[0]);
			}
			discard0(s, w, planId, "discarded");
			return true;
		});
	}

	/** Discards a plan that is not held (the files, the caches, the tombstone, the helper's dir, its unpinned artifacts). */
	static void discard0(@Nullable MinecraftServer s, Path w, String planId, String how) {
		Path p = plans(w);
		JsonObject tomb = new JsonObject();
		tomb.addProperty("discardedAt", now());
		try {
			JsonObject key = RegionStore.readJson(p.resolve(planId + ".key.json"));
			if (key != null && key.has("opKey") && key.has("opHash")) {
				if (key.has("owner")) {
					tomb.add("owner", key.get("owner"));
				}
				tomb.add("opKey", key.get("opKey"));
				tomb.add("opHash", key.get("opHash"));
				String scope = RegionKeys.scope(key.has("owner") ? key.get("owner").getAsString() : null, "region.plan", key.get("opKey").getAsString());
				DISCARDED_KEYS.put(scope, new String[] {planId, key.get("opHash").getAsString()});
				RegionsImpl.dropPlanKey(scope);
			}
			RegionStore.writeJson(p.resolve(planId + ".discarded.json"), tomb);
			for (String suffix : List.of(".json", ".survey.bin", ".key.json", ".used.json")) {
				Files.deleteIfExists(p.resolve(planId + suffix));
			}
			Files.deleteIfExists(RegionStore.prepare(w, planId));
		} catch (IOException e) {
			Architect.LOGGER.warn("Region plan {}: discard incomplete: {}", planId, e.toString());
		}
		RegionsImpl.forgetPlan(planId);
		if (s != null) {
			Prepare.forget(planId);
		}
		PlanChecks.planDiscarded(w, planId);
		pendingAdd(w, planId);
		if (s != null) {
			replaySidecar(s, true);
		}
		Architect.LOGGER.info("Region plan {} {}", planId, how);
	}

	// ------------------------------------------------------------------ the helper's plan dirs

	private static void pendingAdd(Path w, String planId) {
		Set<String> ids = pending(w);
		if (ids.add(planId)) {
			pendingWrite(w, ids);
		}
	}

	private static Set<String> pending(Path w) {
		Set<String> out = new LinkedHashSet<>();
		try {
			JsonObject o = RegionStore.readJson(plans(w).resolve("discard-pending.json"));
			if (o != null && o.get("plans") instanceof JsonArray a) {
				a.forEach(e -> out.add(e.getAsString()));
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Region plans: discard-pending unreadable: {}", e.toString());
		}
		return out;
	}

	private static void pendingWrite(Path w, Set<String> ids) {
		try {
			Path f = plans(w).resolve("discard-pending.json");
			if (ids.isEmpty()) {
				Files.deleteIfExists(f);
				return;
			}
			JsonObject o = new JsonObject();
			JsonArray a = new JsonArray();
			ids.forEach(a::add);
			o.add("plans", a);
			RegionStore.writeJson(f, o);
		} catch (IOException e) {
			Architect.LOGGER.warn("Region plans: discard-pending not written: {}", e.toString());
		}
	}

	/**
	 * Sends {@code region.plan.discard} for every pending plan once per helper link (a new link: its generation), dropping each the
	 * helper answered. Called after a discard ({@code now}: whatever the link) and from the regions' tick. Server thread.
	 */
	static void replaySidecar(MinecraftServer s, boolean now) {
		TileStream.Link link = TileStream.link;
		if (link == null || !link.connected()) {
			return;
		}
		int gen = link.generation();
		if (gen == replayedGen && !now) {
			return;
		}
		replayedGen = gen;
		Path w = s.getWorldPath(LevelResource.ROOT);
		for (String id : pending(w)) {
			JsonObject m = new JsonObject();
			m.addProperty("type", "region.plan.discard");
			m.addProperty("planId", id);
			link.send(m).whenComplete((ack, e) -> s.execute(() -> {
				if (e == null && ack != null && !(ack.has("ok") && !ack.get("ok").getAsBoolean())) {
					Set<String> left = pending(w);
					if (left.remove(id)) {
						pendingWrite(w, left);
					}
				} else {
					Architect.LOGGER.info("Region plan {}: the helper did not remove its dir ({}): kept for its next connect", id, e != null ? e.toString()
						: RegionsImpl.str(ack, "error"));
				}
			}));
		}
	}

	// ------------------------------------------------------------------ the world-start sweep

	/**
	 * The sweep (world start, after the regions and the artifacts' pins load): every plan not held ({@link #held}) whose last use (or its
	 * region's removal) is past {@link #UNKEYED_MS}, or {@link #KEYED_MS} with a plan key, is discarded. Returns the ids discarded.
	 */
	public static List<String> sweep(MinecraftServer s) {
		return sweepAt(s, s.getWorldPath(LevelResource.ROOT));
	}

	/** {@link #sweep} in a world dir ({@code s} null in tests: nothing is sent to a helper). */
	static List<String> sweepAt(@Nullable MinecraftServer s, Path w) {
		Path p = plans(w);
		List<String> out = new ArrayList<>();
		if (!Files.isDirectory(p)) {
			return out;
		}
		long now = now();
		List<String> ids;
		try (var st = Files.list(p)) {
			ids = st.map(x -> x.getFileName().toString()).filter(n -> n.endsWith(".json") && !n.endsWith(".key.json") && !n.endsWith(".used.json")
				&& !n.endsWith(".discarded.json") && !n.equals("discard-pending.json")).map(n -> n.substring(0, n.length() - 5)).sorted().toList();
		} catch (IOException e) {
			Architect.LOGGER.warn("Region plans: sweep skipped: {}", e.toString());
			return out;
		}
		for (String id : ids) {
			try {
				if (held(w, id) != null) {
					continue;
				}
				long used = Math.max(lastUsed(p, id), RegionsImpl.removedAtOfPlan(id));
				long limit = Files.isRegularFile(p.resolve(id + ".key.json")) ? KEYED_MS : UNKEYED_MS;
				if (now - used > limit) {
					discard0(s, w, id, "swept (last used " + (now - used) / 3_600_000L + " h ago)");
					out.add(id);
				}
			} catch (IOException | RuntimeException e) {
				Architect.LOGGER.warn("Region plan {}: sweep skipped: {}", id, e.toString());
			}
		}
		if (!out.isEmpty()) {
			Architect.LOGGER.info("Region plans: the sweep discarded {} unrealised plan(s)", out.size());
		}
		return out;
	}

	/** A JSON string member, or null. */
	static @Nullable String str(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() ? e.getAsString() : null;
	}
}
