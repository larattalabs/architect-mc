package dev.larattalabs.architect.site;

import dev.larattalabs.architect.Architect;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;

/**
 * (slice T0 review P1-1, P1-2; TXN review 3 item 5) Each player's save acknowledged, and a failed one owed per player until a later save of
 * it succeeds. Vanilla's {@code PlayerDataStorage.save} swallows its failures twice: its own catch logs, and {@code Util.safeReplaceFile}
 * drops {@code safeReplaceOrMoveFile}'s false (the old {@code .dat} kept). {@code PlayerSaveFailMixin} reports here instead:
 * <ul>
 * <li>{@link #saving}, then {@link #captured} (the snapshot written to the temp file), then {@link #replaced} with the real replace result, or
 * {@link #failed} (the exception vanilla logged).</li>
 * <li>A failure is owed with its snapshot. A later successful save pays it unless the player's data was loaded from the older file since
 * (the debt is then <b>stale</b>): a respawn's new object (vanilla's {@code restoreFrom}) carries the same session on, so it pays; a login
 * reads the file, so it is first written the snapshot, or served it when that write fails ({@link #loadInstead}); only a debt with no
 * snapshot turns stale there, and only an operator clears a stale debt.</li>
 * <li>An offline player's snapshot is rewritten at the head of every barrier ({@link #step}: {@code PlayerList.saveAll} only visits online
 * players) and before that player's data is loaded again ({@link #loadInstead}), so a rejoin never loads the older file while a snapshot
 * waits: if that rewrite fails, the login loads the snapshot itself.</li>
 * <li>{@link #step} (the barrier's players step) requires every online player acknowledged in this round, nothing owed, and each acknowledged
 * file present and forced, then {@code playerdata/} forced.</li>
 * </ul>
 * Server thread (vanilla saves players there); the maps are concurrent anyway.
 */
public final class PlayerSaves {
	/** Writes a kept snapshot as the player's file ({@code .dat} replaced); true when the replace succeeded. */
	public interface Writer {
		boolean write(UUID id, Object snapshot) throws IOException;
	}

	/** One owed player. */
	static final class Debt {
		final @Nullable Object snapshot;
		/** The save attempt the snapshot came from, and the newest attempt that failed (T0 review 2 finding 2: generation order). */
		final long snapSeq, failSeq;
		final String why;
		/** The player's data was loaded from the older file while this was owed: no later save pays it (only {@link #forgive}). */
		volatile boolean stale;

		Debt(@Nullable Object snapshot, long snapSeq, long failSeq, String why) {
			this.snapshot = snapshot;
			this.snapSeq = snapSeq;
			this.failSeq = failSeq;
			this.why = why;
		}

		/** A snapshot at least as new as the newest failed attempt: only that one may be written in its place or served to a login. */
		boolean usable() {
			return snapshot != null && snapSeq >= failSeq;
		}
	}

	/** Save attempts, in order. */
	static final AtomicLong ATTEMPTS = new AtomicLong();

	static final Map<UUID, Debt> OWED = new ConcurrentHashMap<>();
	/** The round of each player's last acknowledged save (its replace returned true). */
	static final Map<UUID, Long> ACKED = new ConcurrentHashMap<>();
	/** (T0 review 3 finding 7) each player's last acknowledged snapshot this world session: a .dat_old fallback is served it ({@link #loadOld}). */
	static final Map<UUID, Object> LAST = new ConcurrentHashMap<>();
	/** Acknowledged saves whose file is not forced yet. */
	static final Set<UUID> UNFORCED = ConcurrentHashMap.newKeySet();
	static final AtomicLong ROUND = new AtomicLong(), REWRITTEN = new AtomicLong();
	/** (TEST, dev.stockpile.barrier failPlayerReplace) the next replaces that fail as Util.safeReplaceOrMoveFile's false does. */
	public static final AtomicInteger FAIL_REPLACE = new AtomicInteger();
	static volatile @Nullable Writer writer;

	private record Current(UUID id, Object player, @Nullable Object snapshot, long seq) {
	}

	private static final ThreadLocal<@Nullable Current> CURRENT = new ThreadLocal<>();

	private PlayerSaves() {
	}

	/** The world's writer for kept snapshots (null when none: an offline snapshot then waits). */
	public static void worldOpened(@Nullable Writer w) {
		reset();
		writer = w;
	}

	/** The world closed: a debt still owed is logged (its snapshot is lost with the process). */
	public static void worldClosed() {
		synchronized (ChunkDebt.class) { // one lock with ChunkDebt (T0 review 3)
			if (!OWED.isEmpty()) {
				Architect.LOGGER.error("Player durability: the world closed with {} player save(s) owed: {}", OWED.size(), owed());
			}
			reset();
		}
	}

	static void reset() {
		synchronized (ChunkDebt.class) { // one lock with ChunkDebt (T0 review 3)
			OWED.clear();
			LAST.clear();
			ACKED.clear();
			UNFORCED.clear();
			CURRENT.remove();
			FAIL_REPLACE.set(0);
			writer = null;
		}
	}

	/** PlayerDataStorage.save starts for {@code player}. */
	public static void saving(UUID id, Object player) {
		CURRENT.set(new Current(id, player, null, ATTEMPTS.incrementAndGet()));
	}

	/** The snapshot being written to the temp file. */
	public static void captured(Object snapshot) {
		Current c = CURRENT.get();
		if (c != null) {
			CURRENT.set(new Current(c.id, c.player, snapshot, c.seq));
		}
	}

	/** (TEST seam) Whether this replace is to fail. */
	public static boolean failNext() {
		return FAIL_REPLACE.get() > 0 && FAIL_REPLACE.getAndDecrement() > 0;
	}

	/** The replace's real result. */
	public static void replaced(boolean ok) {
		synchronized (ChunkDebt.class) { // one lock with ChunkDebt (T0 review 3)
			Current c = CURRENT.get();
			if (c == null) {
				return;
			}
			if (!ok) {
				owe(c, "the .dat replace failed (Util.safeReplaceOrMoveFile false)");
				return;
			}
			ACKED.put(c.id, ROUND.get());
			UNFORCED.add(c.id);
			if (c.snapshot != null) {
				LAST.put(c.id, c.snapshot);
			}
			Debt d = OWED.get(c.id);
			if (d != null && !d.stale) { // the session that failed carried on (the same object, or a respawn's restoreFrom copy): its state holds the loss
				OWED.remove(c.id, d);
				Architect.LOGGER.info("Player durability: {}'s save succeeded again; its debt is paid", c.id);
			}
		}
	}

	/** The save threw (vanilla's catch logged it). */
	public static void failed(String why) {
		failed(why, null);
	}

	/**
	 * The save threw; {@code self} (T0 review 3 finding 8) serializes the player again when the attempt failed before its capture (a temp file
	 * that could not be made): the debt then keeps a current snapshot and never turns stale for want of one.
	 */
	public static void failed(String why, java.util.function.@Nullable Supplier<Object> self) {
		Current c = CURRENT.get();
		if (c == null) {
			return;
		}
		if (c.snapshot == null && self != null) {
			try {
				Object snap = self.get();
				if (snap != null) {
					c = new Current(c.id, c.player, snap, c.seq);
				}
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Player durability: {} could not be serialized after its failed save", c.id, e);
			}
		}
		owe(c, why);
	}

	/**
	 * (T0 review 3 finding 7) Vanilla falls back to {@code .dat_old} when the {@code .dat} read fails: a current owed snapshot, else the last
	 * acknowledged one, is served instead (never the older file); an owed player with neither turns stale. Null: read {@code .dat_old}.
	 */
	public static @Nullable Object loadOld(UUID id) {
		synchronized (ChunkDebt.class) {
			Debt d = OWED.get(id);
			if (d != null && d.usable()) {
				return d.snapshot;
			}
			Object last = LAST.get(id);
			if (last != null) {
				return last;
			}
			if (d != null && !d.stale) {
				d.stale = true;
				Architect.LOGGER.error("Player durability: {}'s .dat could not be read while its save is owed without a snapshot; .dat_old is loaded", id);
			}
			return null;
		}
	}

	/** PlayerDataStorage.save ended. */
	public static void done() {
		CURRENT.remove();
	}

	private static void owe(Current c, String why) {
		synchronized (ChunkDebt.class) { // one lock with ChunkDebt (T0 review 3)
			ACKED.remove(c.id);
			Debt old = OWED.get(c.id);
			if (old == null || !old.stale) { // a stale debt stays stale (the session since was loaded from the older file)
				// a newer failure without a snapshot keeps the older snapshot but marks it outdated: it never pays this debt (finding 2)
				OWED.put(c.id, c.snapshot != null ? new Debt(c.snapshot, c.seq, c.seq, why)
					: new Debt(old == null ? null : old.snapshot, old == null ? 0 : old.snapSeq, c.seq, why));
			}
			DurableBarrier.playerSaveFailed();
			Architect.LOGGER.error("Player durability: the save of {} failed ({}); owed (no ledger is published) until a later save of it succeeds", c.id, why);
		}
	}

	/** Before the player's data is loaded (a login): {@link #loadInstead}, its answer dropped (the mixin serves it). */
	public static void loading(UUID id) {
		loadInstead(id);
	}

	/**
	 * (TXN review 4 item 2) A login is about to read the player's {@code .dat}: an owed snapshot is written there first; if that fails, the
	 * snapshot itself is answered and the login loads it instead of the older file ({@code PlayerSaveFailMixin} serves it to vanilla's
	 * {@code load(.., ".dat")}, before its data fixer). Either way the joining session starts from the snapshot, so the debt stays payable
	 * by its later save. Only a debt with no snapshot (the save threw before it) leaves the older file to load: that debt turns stale, never
	 * paid by a save (every barrier refuses) until an operator clears it. Null: read the file.
	 */
	public static @Nullable Object loadInstead(UUID id) {
		synchronized (ChunkDebt.class) { // one lock with ChunkDebt (T0 review 3)
			Debt d = OWED.get(id);
			if (d == null || d.stale) {
				return null;
			}
			if (!d.usable()) {
				d.stale = true;
				Architect.LOGGER.error("Player durability: {} logs in while its failed save is owed without a current snapshot; the older file is loaded. The debt"
					+ " stays (no ledger is published) until an operator clears it", id);
				return null;
			}
			if (rewrite(id, d)) {
				return d.snapshot; // (T0 review 3 finding 7) the file holds it now; served all the same, so no failed read falls back to .dat_old
			}
			SERVED.incrementAndGet();
			Architect.LOGGER.warn("Player durability: {} logs in while its last save is owed and could not be written; the kept snapshot is loaded"
				+ " instead of the older file (still owed until a save of this session succeeds)", id);
			return d.snapshot;
		}
	}

	/** (dev) logins served a kept snapshot instead of the older file. */
	static final AtomicLong SERVED = new AtomicLong();

	private static boolean rewrite(UUID id, Debt d) {
		Writer w = writer;
		if (w == null || !d.usable()) { // an outdated snapshot (a newer attempt failed before its capture) is never written
			return false;
		}
		try {
			if (!failNext() && w.write(id, d.snapshot)) {
				OWED.remove(id, d);
				LAST.put(id, d.snapshot);
				ACKED.put(id, ROUND.get());
				UNFORCED.add(id);
				REWRITTEN.incrementAndGet();
				Architect.LOGGER.info("Player durability: {}'s kept snapshot was written; its debt is paid", id);
				return true;
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.error("Player durability: {}'s kept snapshot could not be written", id, e);
		}
		return false;
	}

	/**
	 * The barrier's players step: kept snapshots of offline players rewritten; {@code saveAll} run; every online player acknowledged in this
	 * round; nothing owed; each acknowledged file forced (it must exist), then {@code dir}. Null when it held, else why not.
	 */
	public static @Nullable String step(Runnable saveAll, java.util.function.Supplier<Collection<UUID>> online, Function<UUID, Path> dat, Path dir) {
		long round = ROUND.incrementAndGet();
		Collection<UUID> before = online.get();
		synchronized (ChunkDebt.class) {
			for (Map.Entry<UUID, Debt> e : List.copyOf(OWED.entrySet())) {
				if (!before.contains(e.getKey()) && !e.getValue().stale) {
					rewrite(e.getKey(), e.getValue());
				}
			}
		}
		saveAll.run();
		List<String> why = new ArrayList<>();
		synchronized (ChunkDebt.class) {
			for (UUID id : online.get()) {
				Long r = ACKED.get(id);
				if (r == null || r != round) {
					why.add(id + " not acknowledged");
				}
			}
			OWED.forEach((id, d) -> why.add(id + " owed (" + d.why + (d.stale ? ", stale" : d.snapshot == null ? ", no snapshot" : !d.usable() ? ", snapshot outdated" : "") + ")"));
		}
		if (!why.isEmpty()) {
			return why.size() + " player save(s) not durable: " + (why.size() > 4 ? why.subList(0, 4) + " ..." : why);
		}
		try {
			DurableFile.confirmTo(dir); // (TXN review 4 item 1; T0 review 3 finding 5) every entry from playerdata up to the world root
			for (UUID id : List.copyOf(UNFORCED)) {
				Path f = dat.apply(id);
				if (!Files.isRegularFile(f)) {
					return "the player file " + f.getFileName() + " is missing after an acknowledged save";
				}
				try (FileChannel ch = FileChannel.open(f, StandardOpenOption.READ)) {
					DurableFile.FORCER.file(ch);
				}
			}
			if (Files.isDirectory(dir)) {
				DurableFile.FORCER.dir(dir);
			}
		} catch (IOException | RuntimeException e) {
			return "a player file's force failed: " + e;
		}
		UNFORCED.clear();
		return null;
	}

	/** The owed players, each with why. */
	public static List<String> owed() {
		synchronized (ChunkDebt.class) { // one lock with ChunkDebt (T0 review 3)
			List<String> out = new ArrayList<>();
			OWED.forEach((id, d) -> out.add(id + " (" + d.why + ")"));
			return out;
		}
	}

	/** (dev, operator) forget one player's debt: its loss is accepted. */
	public static boolean forgive(UUID id) {
		synchronized (ChunkDebt.class) { // one lock with ChunkDebt (T0 review 3)
			return OWED.remove(id) != null;
		}
	}

	/** (dev, operator: dev.stockpile.barrier forgive) forget every debt; answers how many. */
	public static int forgiveAll() {
		synchronized (ChunkDebt.class) { // one lock with ChunkDebt (T0 review 3)
			int n = OWED.size();
			OWED.clear();
			return n;
		}
	}

	static com.google.gson.JsonObject devJson() {
		synchronized (ChunkDebt.class) { // one lock with ChunkDebt (T0 review 3)
			com.google.gson.JsonObject o = new com.google.gson.JsonObject();
			o.addProperty("owed", OWED.size());
			o.addProperty("unforced", UNFORCED.size());
			o.addProperty("rewritten", REWRITTEN.get());
			o.addProperty("served", SERVED.get());
			o.addProperty("round", ROUND.get());
			return o;
		}
	}
}
