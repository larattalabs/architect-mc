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
 * reads the file, so a debt that could not first write its snapshot there turns stale and only an operator clears it.</li>
 * <li>An offline player's snapshot is rewritten at the head of every barrier ({@link #step}: {@code PlayerList.saveAll} only visits online
 * players) and before that player's data is loaded again ({@link #loading}), so a rejoin never loads the older file while a snapshot waits.
 * If that rewrite fails at a load, the snapshot is stale (the new session moves on from the older file): it is never written over the new
 * session and the debt stays (every barrier refuses) until an operator clears it.</li>
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
		final String why;
		/** The player's data was loaded from the older file while this was owed: no later save pays it (only {@link #forgive}). */
		volatile boolean stale;

		Debt(@Nullable Object snapshot, String why) {
			this.snapshot = snapshot;
			this.why = why;
		}
	}

	static final Map<UUID, Debt> OWED = new ConcurrentHashMap<>();
	/** The round of each player's last acknowledged save (its replace returned true). */
	static final Map<UUID, Long> ACKED = new ConcurrentHashMap<>();
	/** Acknowledged saves whose file is not forced yet. */
	static final Set<UUID> UNFORCED = ConcurrentHashMap.newKeySet();
	static final AtomicLong ROUND = new AtomicLong(), REWRITTEN = new AtomicLong();
	/** (TEST, dev.stockpile.barrier failPlayerReplace) the next replaces that fail as Util.safeReplaceOrMoveFile's false does. */
	public static final AtomicInteger FAIL_REPLACE = new AtomicInteger();
	static volatile @Nullable Writer writer;

	private record Current(UUID id, Object player, @Nullable Object snapshot) {
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
		if (!OWED.isEmpty()) {
			Architect.LOGGER.error("Player durability: the world closed with {} player save(s) owed: {}", OWED.size(), owed());
		}
		reset();
	}

	static void reset() {
		OWED.clear();
		ACKED.clear();
		UNFORCED.clear();
		CURRENT.remove();
		FAIL_REPLACE.set(0);
		writer = null;
	}

	/** PlayerDataStorage.save starts for {@code player}. */
	public static void saving(UUID id, Object player) {
		CURRENT.set(new Current(id, player, null));
	}

	/** The snapshot being written to the temp file. */
	public static void captured(Object snapshot) {
		Current c = CURRENT.get();
		if (c != null) {
			CURRENT.set(new Current(c.id, c.player, snapshot));
		}
	}

	/** (TEST seam) Whether this replace is to fail. */
	public static boolean failNext() {
		return FAIL_REPLACE.get() > 0 && FAIL_REPLACE.getAndDecrement() > 0;
	}

	/** The replace's real result. */
	public static void replaced(boolean ok) {
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
		Debt d = OWED.get(c.id);
		if (d != null && !d.stale) { // the session that failed carried on (the same object, or a respawn's restoreFrom copy): its state holds the loss
			OWED.remove(c.id, d);
			Architect.LOGGER.info("Player durability: {}'s save succeeded again; its debt is paid", c.id);
		}
	}

	/** The save threw (vanilla's catch logged it). */
	public static void failed(String why) {
		Current c = CURRENT.get();
		if (c != null) {
			owe(c, why);
		}
	}

	/** PlayerDataStorage.save ended. */
	public static void done() {
		CURRENT.remove();
	}

	private static void owe(Current c, String why) {
		ACKED.remove(c.id);
		Debt old = OWED.get(c.id);
		if (old == null || !old.stale) { // a stale debt stays stale (the session since was loaded from the older file)
			OWED.put(c.id, new Debt(c.snapshot != null ? c.snapshot : old == null ? null : old.snapshot, why));
		}
		DurableBarrier.playerSaveFailed();
		Architect.LOGGER.error("Player durability: the save of {} failed ({}); owed (no ledger is published) until a later save of it succeeds", c.id, why);
	}

	/** Before the player's data is loaded (a login): a kept snapshot is written first, so the login reads it, never the older file. */
	public static void loading(UUID id) {
		Debt d = OWED.get(id);
		if (d == null || d.stale) {
			return;
		}
		if (d.snapshot == null || !rewrite(id, d)) {
			d.stale = true;
			Architect.LOGGER.error("Player durability: {} logs in while its last save is owed and could not be written; the older file is loaded. The debt"
				+ " stays (no ledger is published) until an operator clears it", id);
		}
	}

	private static boolean rewrite(UUID id, Debt d) {
		Writer w = writer;
		if (w == null || d.snapshot == null) {
			return false;
		}
		try {
			if (!failNext() && w.write(id, d.snapshot)) {
				OWED.remove(id, d);
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
		for (Map.Entry<UUID, Debt> e : List.copyOf(OWED.entrySet())) {
			if (!before.contains(e.getKey()) && !e.getValue().stale) {
				rewrite(e.getKey(), e.getValue());
			}
		}
		saveAll.run();
		List<String> why = new ArrayList<>();
		for (UUID id : online.get()) {
			Long r = ACKED.get(id);
			if (r == null || r != round) {
				why.add(id + " not acknowledged");
			}
		}
		OWED.forEach((id, d) -> why.add(id + " owed (" + d.why + (d.stale ? ", stale" : d.snapshot == null ? ", no snapshot" : "") + ")"));
		if (!why.isEmpty()) {
			return why.size() + " player save(s) not durable: " + (why.size() > 4 ? why.subList(0, 4) + " ..." : why);
		}
		try {
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
		List<String> out = new ArrayList<>();
		OWED.forEach((id, d) -> out.add(id + " (" + d.why + ")"));
		return out;
	}

	/** (dev, operator) forget one player's debt: its loss is accepted. */
	public static boolean forgive(UUID id) {
		return OWED.remove(id) != null;
	}

	/** (dev, operator: dev.stockpile.barrier forgive) forget every debt; answers how many. */
	public static int forgiveAll() {
		int n = OWED.size();
		OWED.clear();
		return n;
	}

	static com.google.gson.JsonObject devJson() {
		com.google.gson.JsonObject o = new com.google.gson.JsonObject();
		o.addProperty("owed", OWED.size());
		o.addProperty("unforced", UNFORCED.size());
		o.addProperty("rewritten", REWRITTEN.get());
		o.addProperty("round", ROUND.get());
		return o;
	}
}
