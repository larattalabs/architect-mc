package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.site.CrateSettle;
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
	/** (TEST, dev.txn.failBarrier, T2b txn-crash-crate) barriers let through before the refused ones, then the refused ones. */
	static final AtomicInteger BARRIER_SKIP = new AtomicInteger();
	static final AtomicInteger BARRIER_FAIL = new AtomicInteger();
	/** (TEST, slice T4R-M hooks) dev.txn.failBarrier's {@code kind}: only that kind's drives count and refuse (null: every barrier). */
	static final java.util.concurrent.atomic.AtomicReference<String> BARRIER_KIND = new java.util.concurrent.atomic.AtomicReference<>();

	private static TxnCore emptyCore(@Nullable String why) {
		TxnCore c = new TxnCore(new GameEnv());
		register(c);
		c.load(null, why);
		return c;
	}

	private static void register(TxnCore c) {
		TxnCore.BEGIN_GUARD = dev.larattalabs.architect.site.RemovalAreas::beginGuard; // (slice T4R-D, §4.2)
		c.register(TestMove.KIND);
		c.register(OwedTxn.COLLECT_KIND); // (slice T2b)
		c.register(OwedTxn.CREDIT_KIND);
		c.register(CrateTxn.SETTLE_KIND); // (slice T2b part 2b)
		c.register(RemovalTxn.SITE_KIND); // (slice T4b)
		c.register(RemovalTxn.ROAD_KIND);
		c.register(RemovalTxn.GROUP_KIND); // (slice T4R)
		c.register(RemovalTxn.PBLOCKS_KIND); // (slice T4R-D, D1c)
		c.register(CargoTxn.KIND_DEF); // (slice T4R, R5)
		c.register(dev.larattalabs.architect.site.PileAdopt.KIND); // (slice T3b)
		dev.larattalabs.architect.region.FluidTxns.register(c); // (8cTb) region.charge, fluid.drain
	}

	/** (slice T3b, TEST dev.txn.pauseAt) The kill point a live drive stops at (its txn held open), or null. */
	private static volatile @Nullable String pauseAt;

	/** (slice T3b, TEST) Arms ({@code point}) or clears (null) the pause; clearing retries a paused txn on the next tick. */
	public static void pauseAt(@Nullable String point) {
		pauseAt = point;
		Architect.LOGGER.warn("Txn: pause point {} (dev.txn.pauseAt)", point);
		if (point == null) {
			heldBackoff = HELD_MIN;
			heldWait = 0;
		}
	}

	public static @Nullable String pausedAt() {
		return pauseAt;
	}

	/**
	 * (slice T3b) Whether every store a txn's effects read has loaded: the first server tick has run (the stockpiles, sites and the world
	 * journal load in SERVER_STARTED's default phase, after the recovery slot). A probe of such a store answers UNKNOWN before (the txn holds
	 * until the first tick), never ABSENT.
	 */
	public static boolean storesLoaded() {
		return ticking && server != null;
	}

	/** The recovery slot: SERVER_STARTED's phase that runs before the default phase (every legacy listener registers there). */
	public static final net.minecraft.resources.Identifier PHASE = Architect.id("txn_recovery");
	/** Whether the first server tick has run (the barrier needs every store loaded; before it, a barrier is deferred). */
	private static boolean ticking;
	private static final java.util.Set<String> DELIVERED = new java.util.HashSet<>();
	private static final java.util.Set<String> QUEUED = new java.util.HashSet<>();

	public static void init() {
		TestMove.init();
		dev.larattalabs.architect.region.FluidProv.init(); // (slice T5F) architect_mc:fluid_prov
		OwedTxn.init();
		OwedCommands.init();
		// (T2b fix round, GPT P1-3) an owed effect marker stays while its txn is open: only retired txns' markers are evicted
		dev.larattalabs.architect.site.OwedLedger.PINNED = k -> {
			int sl = k.indexOf('/');
			return sl > 0 && core.get(k.substring(0, sl)) != null;
		};
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
			dev.larattalabs.architect.site.Sites.txnLoaded(false);
			DurableBarrier.clearAfterOk();
			dev.larattalabs.architect.site.PileAdopt.worldClosed(); // (T3b final check P2-3)
		});
	}

	/** (slice T2b) Runs {@code r} at the start of the next server tick (an event owed by an effect: never inside SERVER_STARTED). */
	public static void later(Runnable r) {
		NEXT_TICK.add(r);
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
		dev.larattalabs.architect.site.Sites.txnLoaded(c.loadFailed() != null); // (slice T4R) loadHealthy counts the txn file
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
		if (core.anyOpen() && !dev.larattalabs.architect.site.SaveHold.admits(srv)) {
			// (T4 final round) saving is off at the start: recovery parks (its resources held) until the hold's release, on a tick
			Architect.LOGGER.warn("Txn: {} open txn(s): recovery parked while saving is off (their resources stay held)", core.open().size());
			return;
		}
		recovered = true;
		if (core.anyOpen()) {
			Architect.LOGGER.info("Txn: recovering {} open txn(s) in the recovery slot (before the legacy reconciles)", core.open().size());
			core.recover();
		}
		owedAtLoad();
	}

	/**
	 * (T2b final check P2-5) OWED_CHANGED at least once across a crash after retirement: on every load, once per recipient with owed entries,
	 * on the first tick (listeners re-read {@code owed()}; a spurious one is harmless, a missed one is not).
	 */
	static void owedAtLoad() {
		later(() -> {
			java.util.LinkedHashSet<String> rs = new java.util.LinkedHashSet<>();
			dev.larattalabs.architect.site.OwedLedger.all().forEach(e -> rs.add(e.recipient())); // read on the tick: every store loaded
			for (String r : rs) {
				dev.larattalabs.architect.api.SiteEvents.OWED_CHANGED.invoker().onChanged(r);
			}
		});
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
		if (core.anyOpen() && !dev.larattalabs.architect.site.SaveHold.admits(srv)) {
			// (T4 final round) every open txn parks while saving is off (recovery and retries alike): a barrier would only be refused mid-way;
			// their resources stay held. The menus over held boxes still close
			closeHeldMenus(srv);
			return;
		}
		if (!recovered) {
			recovered = true; // no SERVER_STARTED, or recovery parked at the start: recover now
			if (core.anyOpen()) {
				core.recover();
			}
			owedAtLoad();
		}
		closeHeldMenus(srv); // (T2a fix round) menus open over a box when its hold began, or reopened since: closed every tick
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
		if (t != null && t != WRITER) {
			return true;
		}
		// (T4b fix round, N3) a removal's box, from its tally on (a durable stash) and while its txn is open: every writer but the removal's own
		// (its restore, a txn adapter) is refused (players, pistons, explosions, fluids, other mods), as a held cell is
		if (level == null || level.isClientSide() || !CrateSettle.anyHeldBox() && core.holds().isEmpty()) {
			return false;
		}
		String dim = level.dimension().identifier().toString();
		// (T4 final round, P1 3) a txn adapter writing is exempt only from the hold of the removal its own txn settles; any other txn's adapter
		// (another removal's, an adoption's, a crate move's) is refused there like any writer
		java.util.Set<String> own = WRITER == null ? null : WRITER_SITES;
		return CrateSettle.stashBoxHeldBy(dim, pos.getX(), pos.getY(), pos.getZ(), own) || RemovalTxn.boxHeld(dim, pos.getX(), pos
			.getY(), pos.getZ(), WRITER);
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

	/** (slice T4R-L) {@link RemovalTxn#sitesOf} of {@link #WRITER}, read once per {@link #asHolder} (every guarded write asks it). */
	private static java.util.Set<String> WRITER_SITES = java.util.Set.of();

	/** Runs {@code r} as {@code t}'s own write: {@link #boxHeld} answers false for the cells {@code t} holds while it runs. */
	public static void asHolder(TxnEntry t, Runnable r) {
		TxnEntry was = WRITER;
		java.util.Set<String> wasSites = WRITER_SITES;
		WRITER = t;
		WRITER_SITES = RemovalTxn.sitesOf(t);
		try {
			r.run();
		} finally {
			WRITER = was;
			WRITER_SITES = wasSites;
		}
	}

	/**
	 * (slice T4R-L) The positions whose block writes a hold refused while {@link #refusals} captures (the level and chunk guards report
	 * here), or null when none captures. Server thread.
	 */
	private static it.unimi.dsi.fastutil.longs.@Nullable LongOpenHashSet REFUSED;

	/** (slice T4R-L) A guard refused a block write at {@code pos} of {@code level} (server side). */
	public static void refused(net.minecraft.world.level.@Nullable Level level, net.minecraft.core.BlockPos pos) {
		if (REFUSED != null && level != null && !level.isClientSide()) {
			REFUSED.add(pos.asLong());
		}
	}

	/**
	 * (slice T4R-L, the final check's P1-1) Runs {@code r} (a removal's restore write) and answers the positions a hold refused meanwhile: the
	 * guards refuse silently ({@code setBlock} answers false), so a restore that must never be receipted or refunded over a refused write
	 * reads it here. Nested captures each see their own refusals and pass them up.
	 */
	public static it.unimi.dsi.fastutil.longs.LongSet refusals(Runnable r) {
		it.unimi.dsi.fastutil.longs.LongOpenHashSet was = REFUSED;
		it.unimi.dsi.fastutil.longs.LongOpenHashSet mine = new it.unimi.dsi.fastutil.longs.LongOpenHashSet();
		REFUSED = mine;
		try {
			r.run();
		} finally {
			REFUSED = was;
			if (was != null) {
				was.addAll(mine);
			}
		}
		return mine;
	}

	/**
	 * (slice T2a fix round) Whether a container is, or reaches, a held box: a block entity's own cell, either half of a double chest's
	 * {@code CompoundContainer} (one built before the hold, or cached in a Fabric storage). Everything that already exists when a hold begins
	 * (an open menu, a golem's retained target, a cached storage handle) is checked through here at the moment it writes.
	 */
	public static boolean containerHeld(@Nullable Object c) {
		if (c == null || core.holds().isEmpty()) {
			return false;
		}
		if (c instanceof net.minecraft.world.level.block.entity.BlockEntity be) {
			return boxHeld(be.getLevel(), be.getBlockPos());
		}
		if (c instanceof net.minecraft.world.CompoundContainer cc) {
			var a = (dev.larattalabs.architect.mixin.CompoundContainerAccessor) cc;
			return containerHeld(a.architect$first()) || containerHeld(a.architect$second());
		}
		return false;
	}

	/** Whether any slot of {@code menu} is backed by a held box (the menu is closed and its clicks refused). */
	public static boolean menuHeld(net.minecraft.world.inventory.@Nullable AbstractContainerMenu menu) {
		if (menu == null || core.holds().isEmpty()) {
			return false;
		}
		java.util.Set<net.minecraft.world.Container> seen = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
		for (net.minecraft.world.inventory.Slot sl : menu.slots) {
			if (seen.add(sl.container) && containerHeld(sl.container)) {
				return true;
			}
		}
		return false;
	}

	/** Closes every open menu over a held box now (a hold that begins with a menu already open over its box). */
	public static void closeHeldMenus(@Nullable MinecraftServer srv) {
		if (srv == null || core.holds().isEmpty()) {
			return;
		}
		for (net.minecraft.server.level.ServerPlayer p : srv.getPlayerList().getPlayers()) {
			if (p.containerMenu != p.inventoryMenu && menuHeld(p.containerMenu)) {
				p.closeContainer();
			}
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

	/**
	 * (slice T4R, R7, Steward 5(b)) Why a stockpile crate's removal is refused by an open txn, or null. {@code pile}: the pile's resource;
	 * {@code crate}: the crate's own resource; {@code last}: it is the pile's last crate. A removal txn refuses it only when it holds that crate
	 * or (the last crate) it holds the pile it credits; any other kind holding the pile refuses it as before. Server thread.
	 */
	public static @Nullable String crateRemovalRefusal(String pile, String crate, boolean last) {
		TxnCore c = core;
		if (c.holds().isEmpty()) {
			return null;
		}
		TxnEntry holder = c.holds().holder(pile);
		if (holder != null && (!holder.kind.startsWith("removal.") || last)) {
			return Holds.other(holder, pile);
		}
		TxnEntry own = c.holds().holder(crate);
		return own == null ? null : Holds.other(own, crate);
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
			String only = BARRIER_KIND.get();
			if ((only == null || only.equals(core.drivingKind())) && BARRIER_FAIL.get() > 0 && BARRIER_SKIP.getAndUpdate(n -> Math.max(0, n - 1)) == 0 && BARRIER_FAIL.getAndDecrement() > 0) {
				return Barrier.refused("TEST dev.txn.failBarrier"); // (TEST) a save not confirmed (IN_DOUBT as the txn sees it: not OK)
			}
			DurableBarrier.Result r;
			try {
				r = Stockpiles.barrier(s);
			} catch (RuntimeException x) {
				// (T2b final check P1-3, found by txn-owed's thrown-save row) a step that throws is a refused barrier: before, the exception left
				// drive mid-step with the txn open, not held and not retried (wedged)
				Architect.LOGGER.warn("Txn barrier threw: refused", x);
				return Barrier.refused("threw: " + x.getMessage());
			}
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
		public boolean pauseAt(String point) {
			String p = pauseAt;
			return p != null && p.equals(point);
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
				if (event.startsWith("removal_finished:") && payload.has("owner") && payload.has("member")) {
					// (slice T4R-D, D5) a single removal's member finished: its REMOVAL_FINISHED from its immutable snapshot (at least once)
					dev.larattalabs.architect.site.OwnerRemovals.finished(payload.get("owner").getAsString(), payload.get("member").getAsString());
				}
				if ("removal_finished".equals(event)) {
					// (slice T4R, P1-4) a group's or stage's removal finished: its one REMOVAL_FINISHED, built from the payload captured at planning and
					// the result its effects left (the credits, the owed keys); delivered at least once (re-fired after recovery until delivered)
					dev.larattalabs.architect.apiimpl.ApiEvents.finishedNow(RemovalTxn.finished(t, payload));
				}
				if ("stockpile_changed".equals(event) && payload.has("owner")) {
					// (slice T3b fix round, GPT P2-4; final check P2-2) the txn's persisted payload marks the pile changed: Stockpiles' own limiter
					// fires STOCKPILE_CHANGED (at least once, at most once per 20 ticks, never doubled with the ledger's own change)
					dev.larattalabs.architect.site.Stockpiles.txnChanged(payload.get("owner").getAsString());
				}
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
