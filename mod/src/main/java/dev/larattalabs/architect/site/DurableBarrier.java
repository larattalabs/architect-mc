package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
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
 * <li><b>players</b>: every online player's data saved (a failed save is detected: vanilla's {@code PlayerDataStorage.save} logs and
 * swallows it, {@code PlayerSaveFailMixin} counts it), then each player file and the playerdata folder forced;</li>
 * <li><b>chunks</b>: a flushed save of every level, known durable when {@link RegionDurability#undurable} is empty (every write that
 * reached a region file covered by a successful force);</li>
 * <li><b>the ledger</b>: {@code stockpiles.json} written through {@link DurableFile} (its generation in the file).</li>
 * </ol>
 * It refuses (nothing after the failed step runs) on the wrong thread, under {@code /save-off} (any level's {@code noSave}), when the ledger
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

	/** The barrier over {@code steps}, in order, stopping at the first that fails. */
	static Result run(Steps steps) {
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
		}
		return r;
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
			int f0 = PLAYER_SAVE_FAILURES.get();
			srv.getPlayerList().saveAll();
			if (PLAYER_SAVE_FAILURES.get() != f0) {
				return (PLAYER_SAVE_FAILURES.get() - f0) + " player save(s) failed";
			}
			Path dir = srv.getWorldPath(LevelResource.PLAYER_DATA_DIR);
			try {
				for (ServerPlayer p : srv.getPlayerList().getPlayers()) {
					Path f = dir.resolve(p.getStringUUID() + ".dat");
					if (Files.exists(f)) {
						try (FileChannel ch = FileChannel.open(f, StandardOpenOption.WRITE)) {
							DurableFile.FORCER.file(ch);
						}
					}
				}
				if (Files.isDirectory(dir)) {
					DurableFile.FORCER.dir(dir);
				}
			} catch (IOException | RuntimeException e) {
				return "a player file's force failed: " + e;
			}
			return null;
		}

		@Override
		public @Nullable String chunks() {
			try {
				Stockpiles.explicitSave(true); // the world-save callback does not write the ledger: the barrier's own step does
				try {
					srv.saveAllChunks(true, true, false);
				} finally {
					Stockpiles.explicitSave(false);
				}
			} catch (RuntimeException e) {
				return "the flushed save threw: " + e;
			}
			RegionDurability.retryOwed();
			java.util.List<String> undurable = RegionDurability.undurable("chunk", "entities");
			return undurable.isEmpty() ? null : undurable.size() + " region file(s) not durable: " + (undurable.size() > 4 ? undurable.subList(0, 4)
				+ " ..." : undurable);
		}

		@Override
		public DurableFile.Result ledger() {
			return Stockpiles.writeConfirmed(srv);
		}
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
		return o;
	}
}
