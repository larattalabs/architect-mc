package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * (slice T0, docs/TXN-DESIGN.md on slice/TXN §3.1) The world barrier, {@code Stockpiles.barrier()}: everything a durable record may
 * depend on made durable, in this order:
 * <ol>
 * <li><b>players</b>: every online player's data saved and each save acknowledged by its real replace result ({@link PlayerSaves}: a
 * failed save, online or at a logout, is owed per player until a later save of it succeeds), then each acknowledged file and the playerdata
 * folder forced;</li>
 * <li><b>chunks</b>: owed chunk writes submitted again ({@link ChunkDebt}), a flushed save of every level, known durable when {@link
 * RegionDurability#undurable} is empty (every write that reached a region file covered by a successful force, new region files' and
 * {@code .mcc} payloads' entries forced) and no chunk write or serialization is owed;</li>
 * <li><b>the ledger</b>: {@code stockpiles.json} written through {@link DurableFile} (its generation in the file).</li>
 * </ol>
 * It refuses (nothing after the failed step runs) when called from inside a running barrier, on the wrong thread, under {@code /save-off} (any level's {@code noSave}), when the ledger
 * failed to load this session, or on any failed step; a ledger rename followed by a failed directory force is {@link
 * DurableFile.Outcome#IN_DOUBT}. Each step's time is in the result. Server thread. It replaces no caller (T0); slice ST's staged terrain
 * barrier is its first.
 */
public final class DurableBarrier {
	private DurableBarrier() {
	}

	/** A barrier's result: its outcome, the failed step's reason, the ledger's generation, and each step's milliseconds. */
	public record Result(DurableFile.Outcome outcome, @Nullable String reason, long ledgerGen, double playersMs, double chunksMs, double ledgerMs) {
		public boolean ok() {
			return outcome == DurableFile.Outcome.OK;
		}

		static Result refused(String why) {
			return new Result(DurableFile.Outcome.REFUSED, why, 0, 0, 0, 0);
		}
	}

	/** The barrier's steps (the server's; the units give their own). Each answers null when it succeeded, else why it failed. */
	interface Steps {
		@Nullable String refusal();

		@Nullable String players();

		@Nullable String chunks();

		DurableFile.Result ledger();
	}

	/** Player saves that failed this session ({@code PlayerSaveFailMixin}). */
	public static final AtomicInteger PLAYER_SAVE_FAILURES = new AtomicInteger();
	/** Barriers run this session, and the last one's result (dev). */
	static final AtomicInteger RUNS = new AtomicInteger();
	static volatile @Nullable Result last;

	/** (PlayerSaveFailMixin) A player's save failed (vanilla logged and swallowed it). */
	public static void playerSaveFailed() {
		PLAYER_SAVE_FAILURES.incrementAndGet();
	}

	/** (T0 review 2 finding 1) Every owed player and chunk save: while any is, no ledger is published (barrier or ordinary save). */
	public static java.util.List<String> owedDebts() {
		String l = Stockpiles.ledgerDebt();
		if (l == null) {
			return owedSaves();
		}
		java.util.List<String> out = new java.util.ArrayList<>(owedSaves());
		out.add("the stockpile ledger (" + l + ")");
		return out;
	}

	/** The owed player and chunk saves only (an ordinary ledger save holds over these; it repairs a ledger debt itself). */
	public static java.util.List<String> owedSaves() {
		if (PlayerSaves.OWED.isEmpty() && ChunkDebt.OWED.isEmpty()) {
			return java.util.List.of();
		}
		java.util.List<String> out = new java.util.ArrayList<>(PlayerSaves.owed());
		out.addAll(ChunkDebt.owed());
		return out;
	}

	/** Whether a barrier is running (review P2-10: a save callback that calls barrier() again is refused, never recursed into). */
	private static volatile boolean active;

	/** The barrier over {@code steps}, in order, stopping at the first that fails; a nested call (from inside a step) is refused. */
	static Result run(Steps steps) {
		if (active) {
			return Result.refused("reentrant: a barrier is already running (a save callback called barrier() again)");
		}
		active = true;
		try {
			return runSteps(steps);
		} finally {
			active = false;
		}
	}

	private static Result runSteps(Steps steps) {
		String why = steps.refusal();
		if (why != null) {
			return Result.refused(why);
		}
		long t0 = System.nanoTime();
		why = steps.players();
		double pms = (System.nanoTime() - t0) / 1e6;
		if (why != null) {
			return new Result(DurableFile.Outcome.REFUSED, "players: " + why, 0, pms, 0, 0);
		}
		long t1 = System.nanoTime();
		why = steps.chunks();
		double cms = (System.nanoTime() - t1) / 1e6;
		if (why != null) {
			return new Result(DurableFile.Outcome.REFUSED, "chunks: " + why, 0, pms, cms, 0);
		}
		long t2 = System.nanoTime();
		DurableFile.Result l = steps.ledger();
		double lms = (System.nanoTime() - t2) / 1e6;
		return new Result(l.outcome(), l.ok() ? null : "ledger: " + l.reason(), l.gen(), pms, cms, lms);
	}

	/** The barrier on the running server. */
	public static Result run(MinecraftServer srv) {
		Result r = run(new ServerSteps(srv));
		RUNS.incrementAndGet();
		last = r;
		if (!r.ok()) {
			Architect.LOGGER.warn("Durable barrier {}: {}", r.outcome(), r.reason());
		} else if (!AFTER_OK.isEmpty()) {
			// (slice T2 fix round) work that waits for the ledger it changed to be durable over its chunks: run once, after this OK
			java.util.List<Runnable> now = new java.util.ArrayList<>(AFTER_OK);
			AFTER_OK.clear();
			now.forEach(Runnable::run);
		}
		return r;
	}

	/**
	 * (slice T2b fix round, GPT P1-1) The barrier's players step alone: every online player saved and acknowledged by its real replace result,
	 * the files and playerdata forced. Null when it held, else why not. A payout to a player confirms its own save with this in the tick it
	 * gives, before anything can move the items. Server thread.
	 */
	public static @Nullable String savePlayersConfirmed(MinecraftServer srv) {
		return new ServerSteps(srv).players();
	}

	/** (slice T2) Run after the next barrier that returns OK (every store it covers durable): the custody write-backs' receipt pruning. */
	static final java.util.List<Runnable> AFTER_OK = new java.util.ArrayList<>();

	/** Queues {@code r} for after the next OK barrier. Server thread. */
	public static void afterNextOk(Runnable r) {
		AFTER_OK.add(r);
	}

	/** Drops the queued work (the world stopped: its chunks are gone; the receipts stay stale on disk, never read under a later key). */
	public static void clearAfterOk() {
		AFTER_OK.clear();
	}

	/** The server's steps. */
	static final class ServerSteps implements Steps {
		private final MinecraftServer srv;

		ServerSteps(MinecraftServer srv) {
			this.srv = srv;
		}

		@Override
		public @Nullable String refusal() {
			if (!srv.isSameThread()) {
				return "not the server thread";
			}
			for (ServerLevel l : srv.getAllLevels()) {
				if (l.noSave) {
					return "saving is off (/save-off) in " + l.dimension().identifier();
				}
			}
			if (Stockpiles.loadFailed()) {
				return "the stockpile ledger could not be read when the world loaded (it is never overwritten this session)";
			}
			return null;
		}

		@Override
		public @Nullable String players() {
			// (review P1-1, P1-2) each player's save acknowledged by its real replace result, a failed one owed per player (offline too) until
			// a later save of it succeeds; an owed offline player's kept snapshot written again first
			Path dir = srv.getWorldPath(LevelResource.PLAYER_DATA_DIR);
			return PlayerSaves.step(() -> srv.getPlayerList().saveAll(), () -> {
				java.util.List<java.util.UUID> ids = new java.util.ArrayList<>();
				for (ServerPlayer p : srv.getPlayerList().getPlayers()) {
					ids.add(p.getUUID());
				}
				return ids;
			}, id -> dir.resolve(id + ".dat"), dir);
		}

		@Override
		public @Nullable String chunks() {
			// (review P2-10, P3-11) both explicit flags scoped and restored, as saveWithWorld scopes them: the world-save callback leaves the
			// ledger to the barrier, and ChunkSaveWaitMixin skips the waits of clean or still-loading chunks
			boolean wasExplicit = Stockpiles.explicitSave(true);
			boolean wasTiming = SaveTiming.explicit;
			boolean timerWasOn = SaveTiming.on();
			SaveTiming.explicit = true;
			try {
				ChunkDebt.retry(); // (review P1-3, TXN item 5) every failed write's snapshot submitted again, before the flush waits for it
				srv.saveAllChunks(true, true, false);
			} catch (RuntimeException e) {
				return "the flushed save threw: " + e;
			} finally {
				Stockpiles.explicitSave(wasExplicit);
				SaveTiming.explicit = wasTiming;
				if (!timerWasOn && SaveTiming.on()) {
					SaveTiming.stop(); // (T0 review 2 finding 8) the world save's timer the flushed save started: the barrier times itself
				}
			}
			RegionDurability.retryOwed();
			java.util.List<String> undurable = new java.util.ArrayList<>(RegionDurability.undurable("chunk", "entities"));
			undurable.addAll(ChunkDebt.owed());
			undurable.addAll(RegionDurability.confirmFolders("chunk", "entities")); // (TXN review 4 item 1) region folders' entries
			return undurable.isEmpty() ? null : undurable.size() + " chunk write(s) or region file(s) not durable: " + (undurable.size() > 4
				? undurable.subList(0, 4) + " ..." : undurable);
		}

		@Override
		public DurableFile.Result ledger() {
			return Stockpiles.writeConfirmed(srv);
		}
	}

	/**
	 * Dev ({@code dev.stockpile.barrier}): arms the TEST failures ({@code failPlayerReplace}, {@code failChunkWrite}: that many next player
	 * replaces or region writes fail), {@code forgive} (operator: every owed save's loss accepted, stale debts too), runs {@code reps} barriers (each step's ms, p50/p90/max), and answers {@link #devJson}.
	 */
	public static JsonObject dev(MinecraftServer srv, JsonObject req) {
		if (req.has("failPlayerReplace")) {
			PlayerSaves.FAIL_REPLACE.set(req.get("failPlayerReplace").getAsInt());
		}
		if (req.has("failChunkWrite")) {
			ChunkDebt.FAIL_WRITES.set(req.get("failChunkWrite").getAsInt());
		}
		JsonObject forgiven = null;
		if (req.has("forgive") && req.get("forgive").getAsBoolean()) { // (operator) accept the loss of every owed save
			forgiven = new JsonObject();
			forgiven.addProperty("players", PlayerSaves.forgiveAll());
			forgiven.addProperty("chunks", ChunkDebt.forgiveAll());
			Architect.LOGGER.warn("Durable barrier: every owed save forgiven (dev.stockpile.barrier forgive): {}", forgiven);
		}
		int reps = req.has("reps") ? Math.max(0, Math.min(200, req.get("reps").getAsInt())) : req.has("run") && req.get("run").getAsBoolean() ? 1 : 0;
		java.util.List<double[]> ms = new java.util.ArrayList<>();
		java.util.Map<String, Integer> outcomes = new java.util.TreeMap<>();
		for (int i = 0; i < reps; i++) {
			long t0 = System.nanoTime();
			Result r = Stockpiles.barrier(srv);
			ms.add(new double[] {(System.nanoTime() - t0) / 1e6, r.playersMs(), r.chunksMs(), r.ledgerMs()});
			outcomes.merge(r.outcome().name(), 1, Integer::sum);
		}
		JsonObject o = devJson();
		if (forgiven != null) {
			o.add("forgiven", forgiven);
		}
		if (reps > 1) {
			JsonObject b = new JsonObject();
			b.addProperty("reps", reps);
			outcomes.forEach(b::addProperty);
			String[] names = {"total", "players", "chunks", "ledger"};
			for (int k = 0; k < names.length; k++) {
				final int kk = k;
				double[] v = ms.stream().mapToDouble(a -> a[kk]).sorted().toArray();
				JsonObject x = new JsonObject();
				x.addProperty("p50", v[(v.length - 1) / 2]);
				x.addProperty("p90", v[(int) Math.ceil(v.length * 0.9) - 1]);
				x.addProperty("max", v[v.length - 1]);
				b.add(names[k], x);
			}
			o.add("bench", b);
		}
		return o;
	}

	/** Dev: the barrier's counts and its last result. */
	public static JsonObject devJson() {
		JsonObject o = new JsonObject();
		o.addProperty("runs", RUNS.get());
		o.addProperty("playerSaveFailures", PLAYER_SAVE_FAILURES.get());
		Result r = last;
		if (r != null) {
			JsonObject x = new JsonObject();
			x.addProperty("outcome", r.outcome().name());
			x.addProperty("reason", r.reason());
			x.addProperty("ledgerGen", r.ledgerGen());
			x.addProperty("playersMs", r.playersMs());
			x.addProperty("chunksMs", r.chunksMs());
			x.addProperty("ledgerMs", r.ledgerMs());
			o.add("last", x);
		}
		o.add("players", PlayerSaves.devJson());
		o.add("chunks", ChunkDebt.devJson());
		DurableFile lf = Stockpiles.ledgerFile();
		if (lf != null) {
			JsonObject l = new JsonObject();
			l.addProperty("id", lf.id());
			l.addProperty("writtenGen", lf.writtenGen());
			l.addProperty("installedGen", lf.installedGen());
			l.addProperty("inDoubt", lf.inDoubt());
			o.add("ledger", l);
		}
		return o;
	}
}
