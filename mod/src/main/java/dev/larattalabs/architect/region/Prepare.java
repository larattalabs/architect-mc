package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.PrepareView;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.site.Sites;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.level.TicketType;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * {@code Regions.prepare} (CONTRACT D6, "Chunks: prepare"): generates every chunk of claim + 2 chunks that was never fully
 * generated, under an MSPT governor, persistently ({@code prepare-<planId>.json}), without writing a block or the journal:
 * <ul>
 * <li>at most {@code inFlight} generation tickets at once (default 2, 1-8);</li>
 * <li>a new ticket only while the last 20 ticks had max MSPT under 35 ms and mean under 20 ms;</li>
 * <li>after a tick over 50 ms, no new ticket for 40 ticks;</li>
 * <li>each finished chunk's ticket released at once;</li>
 * <li>nearest to any player first, then rows.</li>
 * </ul>
 * Server thread.
 */
public final class Prepare {
	static final TicketType TICKET = net.minecraft.core.Registry.register(net.minecraft.core.registries.BuiltInRegistries.TICKET_TYPE,
		Architect.id("region_prepare"), new TicketType(0L, TicketType.FLAG_LOADING));
	public static int defaultInFlight = Integer.getInteger("architect.prepareInFlight", 2);
	private static final int WINDOW = 20;

	private static final class Run {
		final String planId;
		final ServerLevel level;
		final List<Long> todo;
		final Set<Long> done = new LinkedHashSet<>();
		final Set<Long> ticketed = new LinkedHashSet<>();
		final int total;
		int inFlight;
		PrepareView.State state = PrepareView.State.RUNNING;
		final List<CompletableFuture<PrepareView>> futures = new ArrayList<>();
		boolean scanned;
		final Map<Long, CompletableFuture<Boolean>> scans = new HashMap<>();
		long lastSave;
		long lastEvent;
		int generatedThisRun;
		/** Governor stats: ticks, max ms, ticks over 50/100 ms, chunks generated, seconds. */
		long ticks;
		double maxMs;
		long over50;
		long over100;
		long startedAt = System.currentTimeMillis();
		long finishedAt;

		Run(String planId, ServerLevel level, List<Long> todo, int total) {
			this.planId = planId;
			this.level = level;
			this.todo = todo;
			this.total = total;
		}
	}

	private static final Map<String, Run> RUNS = new LinkedHashMap<>();
	/** Done or cancelled runs this session (for views). */
	private static final Map<String, PrepareView> ENDED = new HashMap<>();
	private static final double[] LAST = new double[WINDOW];
	private static int lastN;
	private static long tickStart;
	private static int coolDown;
	private static boolean hooked;

	private Prepare() {
	}

	static void hook() {
		if (hooked) {
			return;
		}
		hooked = true;
		ServerTickEvents.START_SERVER_TICK.register(s -> tickStart = System.nanoTime());
	}

	/** The chunks of claim + 2 chunks (the box + 7 margin of edge items, rounded up). */
	public static List<Long> chunksOf(int[] claim) {
		List<Long> out = new ArrayList<>();
		for (int cx = (claim[0] >> 4) - 2; cx <= (claim[3] >> 4) + 2; cx++) {
			for (int cz = (claim[2] >> 4) - 2; cz <= (claim[5] >> 4) + 2; cz++) {
				out.add(ChunkPos.pack(cx, cz));
			}
		}
		return out;
	}

	static CompletableFuture<PrepareView> start(MinecraftServer s, RegionsImpl.PlanRec p, @Nullable Integer inFlight) {
		hook();
		Run r = RUNS.get(p.planId());
		if (r == null) {
			ServerLevel level = Sites.levelOf(s, p.dimension());
			if (level == null) {
				return CompletableFuture.failedFuture(new IllegalStateException(p.dimension() + " is not loaded"));
			}
			List<Long> all = chunksOf(p.claim());
			List<ServerPlayer> players = level.players();
			int px = players.isEmpty() ? (p.claim()[0] + p.claim()[3]) >> 5 : players.get(0).getBlockX() >> 4;
			int pz = players.isEmpty() ? (p.claim()[2] + p.claim()[5]) >> 5 : players.get(0).getBlockZ() >> 4;
			all.sort(Comparator.comparingLong((Long k) -> {
				long dx = ChunkPos.getX(k) - px;
				long dz = ChunkPos.getZ(k) - pz;
				long d = Long.MAX_VALUE;
				for (ServerPlayer pl : players) {
					long ex = ChunkPos.getX(k) - (pl.getBlockX() >> 4);
					long ez = ChunkPos.getZ(k) - (pl.getBlockZ() >> 4);
					d = Math.min(d, ex * ex + ez * ez);
				}
				return players.isEmpty() ? dx * dx + dz * dz : d;
			}).thenComparingInt(k -> ChunkPos.getZ(k)).thenComparingInt(k -> ChunkPos.getX(k)));
			r = new Run(p.planId(), level, all, all.size());
			r.inFlight = Math.max(1, Math.min(8, inFlight == null ? defaultInFlight : inFlight));
			load(s, r);
			RUNS.put(p.planId(), r);
			ENDED.remove(p.planId());
			Architect.LOGGER.info("Prepare {}: {} chunks of claim + 2 ({} known generated)", p.planId(), all.size(), r.done.size());
		} else if (inFlight != null) {
			r.inFlight = Math.max(1, Math.min(8, inFlight));
		}
		CompletableFuture<PrepareView> f = new CompletableFuture<>();
		r.futures.add(f);
		return f;
	}

	static void tick(MinecraftServer server) {
		double ms = tickStart == 0 ? 0 : (System.nanoTime() - tickStart) / 1e6;
		LAST[lastN++ % WINDOW] = ms;
		if (ms > 50) {
			coolDown = 40;
		} else if (coolDown > 0) {
			coolDown--;
		}
		if (RUNS.isEmpty()) {
			return;
		}
		Run r = RUNS.values().iterator().next();
		if (r.scanned) {
			r.ticks++;
			r.maxMs = Math.max(r.maxMs, ms);
			r.over50 += ms > 50 ? 1 : 0;
			r.over100 += ms > 100 ? 1 : 0;
		}
		try {
			step(server, r);
		} catch (RuntimeException e) {
			Architect.LOGGER.warn("Prepare {} failed", r.planId, e);
			end(server, r, PrepareView.State.FAILED);
		}
	}

	private static void step(MinecraftServer server, Run r) {
		// 1. what is generated already (off the server thread, once)
		if (!r.scanned) {
			int started = 0;
			for (long k : r.todo) {
				if (r.done.contains(k) || r.scans.containsKey(k)) {
					continue;
				}
				ChunkGen.State st = ChunkGen.state(r.level, k);
				if (st == ChunkGen.State.GENERATED) {
					r.done.add(k);
				} else if (st == ChunkGen.State.NOT_GENERATED) {
					r.scans.put(k, CompletableFuture.completedFuture(false));
				} else {
					r.scans.put(k, ChunkGen.query(r.level, k));
				}
				if (++started > 256) {
					return;
				}
			}
			for (var e : r.scans.entrySet()) {
				if (!e.getValue().isDone()) {
					return;
				}
			}
			r.scans.forEach((k, f) -> {
				if (Boolean.TRUE.equals(f.getNow(false))) {
					r.done.add(k);
				}
			});
			r.scans.clear();
			r.scanned = true;
			r.startedAt = System.currentTimeMillis();
		}
		// 2. finished chunks: release at once
		for (var it = r.ticketed.iterator(); it.hasNext();) {
			long k = it.next();
			if (r.level.getChunkSource().getChunkNow(ChunkPos.getX(k), ChunkPos.getZ(k)) != null) {
				r.level.getChunkSource().removeTicketWithRadius(TICKET, ChunkPos.unpack(k), 0);
				it.remove();
				r.done.add(k);
				r.generatedThisRun++;
				ChunkGen.generated(Sites.dimensionId(r.level), k);
				if (r.generatedThisRun == 16) {
					WorldJournal.kill("RG1"); // during prepare: no blocks, no journal touched
				}
			}
		}
		// 3. the governor
		if (r.ticketed.size() < r.inFlight && coolDown == 0 && governorOk()) {
			for (long k : r.todo) {
				if (r.done.contains(k) || r.ticketed.contains(k)) {
					continue;
				}
				r.level.getChunkSource().addTicketWithRadius(TICKET, ChunkPos.unpack(k), 0);
				r.ticketed.add(k);
				break; // one new ticket per tick at most
			}
		}
		long now = System.currentTimeMillis();
		if (r.done.size() >= r.total && r.ticketed.isEmpty()) {
			end(server, r, PrepareView.State.DONE);
			return;
		}
		if (now - r.lastSave > 5000) {
			r.lastSave = now;
			save(server, r);
		}
		if (now - r.lastEvent >= 1000) {
			r.lastEvent = now;
			SiteEvents.PREPARE_PROGRESS.invoker().onProgress(view(r));
		}
	}

	private static boolean governorOk() {
		int n = Math.min(lastN, WINDOW);
		if (n < WINDOW) {
			return false;
		}
		double max = 0;
		double sum = 0;
		for (int i = 0; i < WINDOW; i++) {
			max = Math.max(max, LAST[i]);
			sum += LAST[i];
		}
		return max < 35 && sum / WINDOW < 20;
	}

	private static void end(MinecraftServer server, Run r, PrepareView.State st) {
		for (long k : r.ticketed) {
			r.level.getChunkSource().removeTicketWithRadius(TICKET, ChunkPos.unpack(k), 0);
		}
		r.ticketed.clear();
		r.state = st;
		r.finishedAt = System.currentTimeMillis();
		save(server, r);
		RUNS.remove(r.planId);
		PrepareView v = view(r);
		ENDED.put(r.planId, v);
		LAST_STATS.put(r.planId, stats(r));
		SiteEvents.PREPARE_PROGRESS.invoker().onProgress(v);
		r.futures.forEach(f -> f.complete(v));
		Architect.LOGGER.info("Prepare {} {}: {} of {} chunks generated or present ({} generated now), MSPT max {} ms, {} ticks over 50 ms", r.planId, st,
			r.done.size(), r.total, r.generatedThisRun, String.format(java.util.Locale.ROOT, "%.1f", r.maxMs), r.over50);
	}

	private static final Map<String, JsonObject> LAST_STATS = new HashMap<>();

	static JsonObject stats(Run r) {
		JsonObject o = new JsonObject();
		o.addProperty("planId", r.planId);
		o.addProperty("state", r.state.name());
		o.addProperty("chunksTotal", r.total);
		o.addProperty("chunksDone", r.done.size());
		o.addProperty("generatedThisRun", r.generatedThisRun);
		o.addProperty("ticks", r.ticks);
		o.addProperty("msptMax", r.maxMs);
		o.addProperty("ticksOver50ms", r.over50);
		o.addProperty("ticksOver100ms", r.over100);
		long end = r.finishedAt > 0 ? r.finishedAt : System.currentTimeMillis();
		double secs = (end - r.startedAt) / 1000.0;
		o.addProperty("seconds", secs);
		o.addProperty("chunksPerSecond", secs > 0 ? r.generatedThisRun / secs : 0);
		o.addProperty("inFlight", r.inFlight);
		return o;
	}

	/** The running or last prepare's governor numbers (DevBridge). */
	public static @Nullable JsonObject stats(String planId) {
		Run r = RUNS.get(planId);
		return r != null ? stats(r) : LAST_STATS.get(planId);
	}

	static @Nullable PrepareView view(String planId) {
		Run r = RUNS.get(planId);
		if (r != null) {
			return view(r);
		}
		return ENDED.get(planId);
	}

	private static PrepareView view(Run r) {
		return new PrepareView(r.planId, r.total, r.done.size(), r.total - r.done.size(), r.state);
	}

	static void cancel(String planId) {
		Run r = RUNS.get(planId);
		MinecraftServer s = r == null ? null : r.level.getServer();
		if (r != null) {
			end(s, r, PrepareView.State.CANCELLED);
		}
	}

	static void stopAll() {
		RUNS.clear();
		ENDED.clear();
	}

	/** After a world start: running prepares carry on (their file says RUNNING). */
	static void resumeAll(MinecraftServer s) {
		Path root = RegionStore.root(s.getWorldPath(LevelResource.ROOT));
		if (!Files.isDirectory(root)) {
			return;
		}
		try (var st = Files.list(root)) {
			for (Path f : st.toList()) {
				String n = f.getFileName().toString();
				if (!n.startsWith("prepare-") || !n.endsWith(".json")) {
					continue;
				}
				JsonObject o = RegionStore.readJson(f);
				if (o == null || !"RUNNING".equals(o.get("state").getAsString())) {
					continue;
				}
				String planId = o.get("planId").getAsString();
				RegionsImpl.PlanRec p = RegionsImpl.planRec(planId);
				if (p != null) {
					start(s, p, o.has("inFlight") ? o.get("inFlight").getAsInt() : null);
					Architect.LOGGER.info("Prepare {} resumed after the world start", planId);
				}
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("Prepares unreadable: {}", e.toString());
		}
	}

	private static void load(MinecraftServer s, Run r) {
		try {
			JsonObject o = RegionStore.readJson(RegionStore.prepare(s.getWorldPath(LevelResource.ROOT), r.planId));
			if (o != null && o.has("done")) {
				for (var e : o.getAsJsonArray("done")) {
					r.done.add(e.getAsLong());
				}
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Prepare {}: its progress file is unreadable ({}); starting over", r.planId, e.toString());
		}
	}

	private static void save(@Nullable MinecraftServer s, Run r) {
		if (s == null) {
			return;
		}
		JsonObject o = new JsonObject();
		o.addProperty("planId", r.planId);
		o.addProperty("state", r.state.name());
		o.addProperty("inFlight", r.inFlight);
		o.addProperty("total", r.total);
		JsonArray d = new JsonArray();
		r.done.forEach(d::add);
		o.add("done", d);
		o.add("stats", stats(r));
		try {
			RegionStore.writeJson(RegionStore.prepare(s.getWorldPath(LevelResource.ROOT), r.planId), o);
		} catch (IOException e) {
			Architect.LOGGER.warn("Prepare {}: progress not saved ({})", r.planId, e.toString());
		}
	}
}
