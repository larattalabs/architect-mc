package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.site.DurableBarrier;
import dev.larattalabs.architect.site.DurableFile;
import dev.larattalabs.architect.site.Stockpiles;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import net.fabricmc.fabric.api.event.Event;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.2, §3.6, §3.9) The game's side of the txn core: {@code <world>/architect/txn.json} through
 * {@link DurableFile}, the global barrier ({@link Stockpiles#barrier}), kill points ({@link WorldJournal#kill}), and the order at start:
 * <ol>
 * <li><b>load</b> at SERVER_STARTING, before any SERVER_STARTED listener (the legacy resolvers): txn.json read, its holds rebuilt, nothing
 * run;</li>
 * <li><b>recovery</b> in the recovery slot: SERVER_STARTED's own phase {@link #PHASE}, ordered before the default phase, so before every
 * legacy SERVER_STARTED reconcile and every first-tick fill (T1 review P1-2). Each open txn's effects are probed and applied or compensated
 * there (a test.move chunk is loaded for it); the barrier that retires them waits for the first tick, so a recovered txn stays held (its
 * resources guarded from every writer) until then;</li>
 * <li><b>events</b> a recovery owes fire on the tick after it (never inside SERVER_STARTED, §3.12.9), and count as emitted only once
 * delivered;</li>
 * <li>each later tick re-drives retiring txns; a held one is retried with backoff (1 s doubling to 20 s), since a retry may run a
 * barrier.</li>
 * </ol>
 * T1 migrates no caller: its only kind is the dev hook's {@link TestMove} ({@code dev.txn.run}). Server thread.
 */
public final class TxnServer {
	private TxnServer() {
	}

	private static volatile @Nullable MinecraftServer server;
	private static @Nullable DurableFile file;
	private static TxnCore core = emptyCore("no world loaded");
	private static boolean recovered;
	private static final Deque<Runnable> NEXT_TICK = new ArrayDeque<>();
	/** (dev) the last events fired (at least once), newest last. */
	static final Deque<String> EVENTS = new ArrayDeque<>();
	/** (TEST, dev.txn.failPersist) the next txn.json writes that are refused before the rename. */
	static final AtomicInteger FAIL_WRITES = new AtomicInteger();

	private static TxnCore emptyCore(@Nullable String why) {
		TxnCore c = new TxnCore(new GameEnv());
		register(c);
		c.load(null, why);
		return c;
	}

	private static void register(TxnCore c) {
		c.register(TestMove.KIND);
	}

	/** The recovery slot: SERVER_STARTED's phase that runs before the default phase (every legacy listener registers there). */
	public static final net.minecraft.resources.Identifier PHASE = Architect.id("txn_recovery");
	/** Whether the first server tick has run (the barrier needs every store loaded; before it, a barrier is deferred). */
	private static boolean ticking;
	private static final java.util.Set<String> DELIVERED = new java.util.HashSet<>();
	private static final java.util.Set<String> QUEUED = new java.util.HashSet<>();

	public static void init() {
		TestMove.init();
		ServerLifecycleEvents.SERVER_STARTING.register(TxnServer::load);
		ServerLifecycleEvents.SERVER_STARTED.addPhaseOrdering(PHASE, Event.DEFAULT_PHASE);
		ServerLifecycleEvents.SERVER_STARTED.register(PHASE, TxnServer::recoverAtStart);
		ServerTickEvents.END_SERVER_TICK.register(TxnServer::tick);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			server = null;
			file = null;
			recovered = false;
			ticking = false;
			NEXT_TICK.clear();
			DELIVERED.clear();
			QUEUED.clear();
			core = emptyCore("no world loaded");
		});
	}

	/** The core of the world loaded now. Server thread. */
	public static TxnCore core() {
		return core;
	}

	public static @Nullable MinecraftServer server() {
		return server;
	}

	/** The world's txn.json. */
	static Path path(MinecraftServer srv) {
		return srv.getWorldPath(LevelResource.ROOT).resolve("architect").resolve(TxnCore.FILE);
	}

	/** Load only (§3.6 "load is split from reconcile"): the file read, holds rebuilt; recovery waits for the first tick. */
	static void load(MinecraftServer srv) {
		server = srv;
		recovered = false;
		ticking = false;
		NEXT_TICK.clear();
		DELIVERED.clear();
		QUEUED.clear();
		heldBackoff = HELD_MIN;
		heldWait = 0;
		Path p = path(srv);
		TxnCore c = new TxnCore(new GameEnv());
		register(c);
		JsonObject doc = null;
		String failure = null;
		if (Files.exists(p)) {
			try {
				doc = JsonParser.parseString(Files.readString(p, StandardCharsets.UTF_8)).getAsJsonObject();
			} catch (Exception e) {
				failure = "txn.json unreadable: " + e;
			}
		}
		file = new DurableFile("txn", p); // a loaded generation counts only after its re-force (T0)
		c.load(doc, failure);
		core = c;
		if (c.loadFailed() != null) {
			Architect.LOGGER.error("Txn: {} - every txn operation is refused this session (the file is kept for ops)", c.loadFailed());
		} else if (c.anyOpen()) {
			Architect.LOGGER.warn("Txn: {} open txn(s), {} quarantined; their resources are held until recovery runs on the first tick", c.open().size(),
				c.quarantined().size());
		}
	}

	/** The recovery slot (SERVER_STARTED, {@link #PHASE}): every open txn by the §3.6 table, before any legacy reconcile or fill. */
	static void recoverAtStart(MinecraftServer srv) {
		if (srv != server || recovered) {
			return;
		}
		recovered = true;
		if (core.anyOpen()) {
			Architect.LOGGER.info("Txn: recovering {} open txn(s) in the recovery slot (before the legacy reconciles)", core.open().size());
			core.recover();
		}
	}

	static void tick(MinecraftServer srv) {
		if (srv != server) {
			return;
		}
		if (!ticking) {
			ticking = true;
			heldWait = 0; // the barriers deferred from the recovery slot run on this first tick
		}
		for (int n = NEXT_TICK.size(); n > 0; n--) {
			Runnable r = NEXT_TICK.poll();
			if (r != null) {
				r.run();
			}
		}
		if (!recovered) {
			recovered = true; // no SERVER_STARTED (a test harness): recover now
			if (core.anyOpen()) {
				core.recover();
			}
		}
		if (core.open().isEmpty() && !core.unsynced()) {
			heldBackoff = HELD_MIN;
			return;
		}
		if (!anyHeld()) {
			heldBackoff = HELD_MIN; // retiring txns check their awaits every tick (cheap)
			core.tick();
			return;
		}
		// a held txn retries with backoff: a retry may run a barrier (owed chunk and player writes resubmitted, every chunk flushed)
		if (--heldWait > 0) {
			return;
		}
		core.tick();
		heldBackoff = anyHeld() ? Math.min(heldBackoff * 2, HELD_MAX) : HELD_MIN;
		heldWait = heldBackoff;
	}

	/** Ticks between retries of a held txn: from 1 s, doubling to 20 s while it stays held. */
	static final int HELD_MIN = 20;
	static final int HELD_MAX = 400;
	private static int heldBackoff = HELD_MIN;
	private static int heldWait;

	private static boolean anyHeld() {
		if (core.unsynced()) {
			return true;
		}
		for (TxnEntry t : core.open()) {
			if (t.held() != null) {
				return true;
			}
		}
		return false;
	}

	// ------------------------------------------------------------------ the holds every writer honours (O(1) with none open)

	/** Whether {@code resource} is held by an open, retiring or quarantined txn. */
	public static boolean held(String resource) {
		TxnCore c = core;
		return !c.holds().isEmpty() && c.holds().holder(resource) != null;
	}

	/**
	 * Whether the cell {@code pos} of {@code level} is a box or crate an open txn holds, for any writer but that txn's own adapter (the hold
	 * mixins, Fills). Server side only: an integrated server's client thread shares this static core, and its own block updates are never a
	 * write (slice T2a). O(1) with none open; while any is open, a per-dimension cell index before any string is built.
	 */
	public static boolean boxHeld(net.minecraft.world.level.@Nullable Level level, net.minecraft.core.BlockPos pos) {
		TxnEntry t = cellHolder(level, pos);
		return t != null && t != WRITER;
	}

	/** The txn holding the cell, or null (no txn open, a client level, no hold there). The holder's own writes are not exempted here. */
	public static @Nullable TxnEntry cellHolder(net.minecraft.world.level.@Nullable Level level, net.minecraft.core.BlockPos pos) {
		TxnCore c = core;
		if (level == null || c.holds().isEmpty() || level.isClientSide()) {
			return null;
		}
		return c.holds().cellHolder(level.dimension().identifier().toString(), pos.getX(), pos.getY(), pos.getZ());
	}

	/**
	 * (slice T2a) The txn whose adapter is writing now: its own held cells accept its writes (a test.move take or put-back, a crate take,
	 * T2b's restore of the crate cell). Every other writer is refused while it holds them. Server thread.
	 */
	private static @Nullable TxnEntry WRITER;

	/** Runs {@code r} as {@code t}'s own write: {@link #boxHeld} answers false for the cells {@code t} holds while it runs. */
	public static void asHolder(TxnEntry t, Runnable r) {
		TxnEntry was = WRITER;
		WRITER = t;
		try {
			r.run();
		} finally {
			WRITER = was;
		}
	}

	/** (slice T2a) {@code held(other) tx-<n>: <cell>} when a held cell of {@code level} lies in the box (inclusive), else null. */
	public static @Nullable String regionHeld(net.minecraft.world.level.@Nullable Level level, int x0, int y0, int z0, int x1, int y1, int z1) {
		TxnCore c = core;
		if (level == null || c.holds().isEmpty() || level.isClientSide()) {
			return null;
		}
		String dim = level.dimension().identifier().toString();
		if (!c.holds().anyCell(dim)) {
			return null;
		}
		String r = c.holds().cellIn(dim, x0, y0, z0, x1, y1, z1);
		TxnEntry t = r == null ? null : c.holds().holder(r);
		return t == null || t == WRITER ? null : Holds.other(t, r);
	}

	/** {@code held(other) tx-<n>: <cell>} for a held cell, else null. */
	public static @Nullable String cellWhy(net.minecraft.world.level.@Nullable Level level, net.minecraft.core.BlockPos pos) {
		return regionHeld(level, pos.getX(), pos.getY(), pos.getZ(), pos.getX(), pos.getY(), pos.getZ());
	}

	/** (slice T2a) A command's refusal over a held cell: "&lt;what&gt; refused: an open transaction holds it (held(other) tx-n: ...)". */
	public static com.mojang.brigadier.exceptions.CommandSyntaxException commandRefused(String what, String why) {
		return new com.mojang.brigadier.exceptions.SimpleCommandExceptionType(
			net.minecraft.network.chat.Component.literal(what + " refused: an open transaction holds it (" + why + ")")).create();
	}

	/** Throws {@code e} unchecked (a mixin into a method that does not declare it; brigadier's caller does). */
	@SuppressWarnings("unchecked")
	public static <E extends Throwable> RuntimeException sneaky(Throwable e) throws E {
		throw (E) e;
	}

	private static boolean backstopLogged;

	/**
	 * (slice T2a) A write refused by a backstop (the container mutators, a block entity's load): the named paths refuse earlier, so one that
	 * reaches here is an unlisted writer (another mod). Logged once per session with its stack, then counted in dev.txn.state.
	 */
	public static void backstop(String what, net.minecraft.core.BlockPos pos) {
		BACKSTOPS.incrementAndGet();
		if (!backstopLogged) {
			backstopLogged = true;
			Architect.LOGGER.warn("Txn: {} at {} refused: an open txn holds the box (an unlisted writer; logged once)", what, pos.toShortString(),
				new Throwable("the writer"));
		}
	}

	static final AtomicInteger BACKSTOPS = new AtomicInteger();

	/** {@code held(other) tx-<n>: <where>} for a held resource, else null (§3.12.10). */
	public static @Nullable String heldWhy(String resource) {
		TxnCore c = core;
		if (c.holds().isEmpty()) {
			return null;
		}
		TxnEntry t = c.holds().holder(resource);
		return t == null ? null : Holds.other(t, resource);
	}

	// ------------------------------------------------------------------ the env

	static final class GameEnv implements TxnEnv {
		@Override
		public TxnStore store() {
			return new TxnStore() {
				@Override
				public DurableFile.Outcome write(JsonObject doc) {
					DurableFile f = file;
					if (f == null) {
						return DurableFile.Outcome.REFUSED;
					}
					if (FAIL_WRITES.get() > 0 && FAIL_WRITES.getAndDecrement() > 0) {
						Architect.LOGGER.warn("Txn: txn.json write refused (TEST, dev.txn.failPersist)");
						return DurableFile.Outcome.REFUSED;
					}
					DurableFile.Result r = f.write(doc, f.request());
					if (!r.ok()) {
						Architect.LOGGER.warn("Txn: txn.json write {}: {}", r.outcome(), r.reason());
					}
					return r.outcome();
				}

				@Override
				public DurableFile.Outcome confirm() {
					DurableFile f = file;
					return f == null ? DurableFile.Outcome.REFUSED : f.confirm().outcome();
				}

				@Override
				public boolean inDoubt() {
					DurableFile f = file;
					return f != null && (f.inDoubt() > 0 || f.installedGen() > f.writtenGen());
				}
			};
		}

		@Override
		public Barrier barrier() {
			MinecraftServer s = server;
			if (s == null) {
				return Barrier.refused("no server");
			}
			if (!ticking) {
				return Barrier.refused("deferred to the first tick (the stores load in SERVER_STARTED)");
			}
			DurableBarrier.Result r = Stockpiles.barrier(s);
			if (!r.ok()) {
				return Barrier.refused(r.outcome() + ": " + r.reason());
			}
			List<Await> aw = new ArrayList<>();
			DurableFile l = Stockpiles.ledgerDurable();
			if (l != null && r.ledgerGen() > 0) {
				aw.add(new Await(l.id(), r.ledgerGen())); // only a generation the completed barrier returned
			}
			return Barrier.ok(aw);
		}

		@Override
		public boolean satisfied(Await a) {
			DurableFile l = Stockpiles.ledgerDurable();
			return l != null && l.satisfies(a.store(), a.gen());
		}

		@Override
		public void kill(String point) {
			WorldJournal.kill(point);
		}

		@Override
		public boolean emit(TxnEntry t, String event, JsonObject payload, boolean replayed) {
			String key = t.id + "/" + event;
			if (DELIVERED.contains(key)) {
				return true;
			}
			String line = t.id + " " + event + (replayed ? " (replayed)" : "") + " " + payload;
			Runnable fire = () -> {
				Architect.LOGGER.info("Txn event: {}", line);
				EVENTS.addLast(line);
				while (EVENTS.size() > 32) {
					EVENTS.pollFirst();
				}
				DELIVERED.add(key);
				QUEUED.remove(key);
			};
			if (!replayed && ticking) {
				fire.run();
				return true;
			}
			if (QUEUED.add(key)) {
				NEXT_TICK.add(fire); // a re-fired event: on the tick after recovery, with every store loaded; emitted once delivered
			}
			return false;
		}

		@Override
		public long tick() {
			MinecraftServer s = server;
			return s == null ? 0 : s.getTickCount();
		}

		@Override
		public long wall() {
			return System.currentTimeMillis();
		}
	}

	/** dev.txn.state: the core's state plus the file, the holds and the last events. */
	public static JsonObject state() {
		JsonObject o = core.state();
		DurableFile f = file;
		if (f != null) {
			JsonObject d = new JsonObject();
			d.addProperty("path", f.file().toString());
			d.addProperty("exists", Files.exists(f.file()));
			d.addProperty("writtenGen", f.writtenGen());
			d.addProperty("installedGen", f.installedGen());
			d.addProperty("inDoubt", f.inDoubt());
			o.add("file", d);
		}
		JsonArray h = new JsonArray();
		core.holds().resources().forEach(h::add);
		o.add("holds", h);
		JsonArray ev = new JsonArray();
		EVENTS.forEach(ev::add);
		o.add("events", ev);
		o.addProperty("recovered", recovered);
		o.addProperty("backstops", BACKSTOPS.get());
		return o;
	}
}
