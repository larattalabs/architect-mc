package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ItemCount;
import dev.larattalabs.architect.api.SiteView;
import dev.larattalabs.architect.api.SiteWait;
import dev.larattalabs.architect.apiimpl.ApiEvents;
import dev.larattalabs.architect.apiimpl.Views;
import dev.larattalabs.architect.survival.CrateBlockEntity;
import dev.larattalabs.architect.survival.SurvivalItems;
import dev.larattalabs.architect.survival.WaitCalc;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * C25 (docs/CONTRACT.md phase 6c slice Y, "Waiting status"): whether a construction target waits for materials, and for what.
 * The builders ({@link Builder}, {@link RoadBuilder}) report one {@link WaitCalc.Outcome} per target per tick; the pure rules live
 * in {@link WaitCalc}. The state is a latch that starts after 100 starved ticks in a row and holds until a cell is placed or the
 * target is paused, built or removed, so a chunk unloading or a restart never ends it. {@code waitingSince} is the world's game
 * time and is saved in {@code <world>/architect/waits.json} (temp file, then rename) when a wait starts or ends and when the world
 * stops. All logic is here so a feed loop that draws from a shared stockpile (Y1) only supplies {@link Supply}. Server thread only.
 */
public final class SiteWaits {
	public static final String FILE = "waits.json";

	/** What is available to one target: the units of an item it may spend now (stock minus what higher targets reserve). The seam for Y1. */
	public interface Supply {
		int available(String item);

		/** Changes whenever {@link #available} could (a cheap fingerprint of the stock), so the {@code nextNeeded} walk can be cached. */
		long version();
	}

	/** Where a target's supply comes from. The default reads the target's own crate or its group's shared crate (reserved is 0). */
	@FunctionalInterface
	public interface Source {
		@Nullable Supply supply(MinecraftServer srv, ServerLevel level, Site target);
	}

	private static volatile Source source = (srv, level, target) -> {
		CrateBlockEntity crate = Builder.crate(level, target, false);
		if (crate == null) {
			return null;
		}
		var ledger = crate.ledger();
		return new Supply() {
			@Override
			public int available(String item) {
				return ledger.stock(item);
			}

			@Override
			public long version() {
				return ledger.stock().hashCode();
			}
		};
	};

	/** Replaces where supplies come from (a stockpile's feed loop). */
	public static void source(Source s) {
		source = s;
	}

	private static final class State {
		final WaitCalc.Latch latch;
		@Nullable SiteView lastView;
		long cacheBuilt = -1;
		long cacheVersion;
		WaitCalc.Needs cached = WaitCalc.Needs.NONE;

		State(WaitCalc.Latch latch) {
			this.latch = latch;
		}
	}

	private static final Map<String, State> STATES = new ConcurrentHashMap<>();
	/** Waits read from disk that no builder tick has claimed yet: id -> waitingSince. */
	private static final Map<String, Long> RESTORED = new ConcurrentHashMap<>();
	/** (8b review P2-4) The canonical wait start per target, whatever the kind: what waitingSince reports and the file keeps. */
	static final WaitClock CLOCK = new WaitClock();
	private static boolean dirty;

	private SiteWaits() {
	}

	public static void init() {
		ServerLifecycleEvents.SERVER_STARTED.register(SiteWaits::load);
		ServerLifecycleEvents.SERVER_STOPPING.register(srv -> flush(srv, true));
		ServerLifecycleEvents.SERVER_STOPPED.register(srv -> {
			STATES.clear();
			RESTORED.clear();
			BILL_CAPPED.clear(); // (BC) re-derived by the next step
			CAP_SCOPE.clear();
			CAP_SINCE.clear();
			CLOCK.clear();
			dirty = false;
		});
	}

	// ------------------------------------------------------------------ the builders' hooks

	/** One builder tick of target {@code id}: what it did. Fires the start and stop edges that are due. */
	static void observe(MinecraftServer srv, ServerLevel level, String id, WaitCalc.Outcome o) {
		long now = level.getGameTime();
		State st = STATES.get(id);
		if (st == null) {
			if (o != WaitCalc.Outcome.STARVED && !RESTORED.containsKey(id)) {
				return; // nothing to track: a target that never starved costs one map lookup per tick
			}
			Long since = RESTORED.remove(id);
			st = new State(since == null ? new WaitCalc.Latch() : WaitCalc.Latch.restored(since));
			STATES.put(id, st);
		}
		if (st.latch.tick(now, o)) {
			dirty = true;
			if (!st.latch.waiting()) {
				freeIfIdle(id); // (8b review P2-4) the latch ended: the start goes only when no typed wait holds it either
			}
		}
		WaitCalc.Edge e = st.latch.poll(now);
		if (e != WaitCalc.Edge.NONE) {
			fire(srv, id, st, e);
		}
		if (!st.latch.waiting() && e == WaitCalc.Edge.NONE && o != WaitCalc.Outcome.STARVED && st.lastView == null) {
			STATES.remove(id, st); // a latch that never started and has nothing deferred
		}
	}

	/** The target left (built, removed, deconstructed): a running wait stops now. */
	static void ended(MinecraftServer srv, String id) {
		BILL_CAPPED.remove(id); // (BC) a gone target is no longer held by its cap
		CAP_SCOPE.remove(id);
		CAP_SINCE.remove(id);
		CLOCK.free(id); // (8b review P2-4) a gone target waits for nothing
		State st = STATES.remove(id);
		Long was = RESTORED.remove(id);
		if (was != null) {
			dirty = true;
		}
		if (st == null) {
			return;
		}
		boolean waiting = st.latch.waiting();
		WaitCalc.Edge e = st.latch.finish(srv.overworld().getGameTime());
		if (waiting) {
			dirty = true;
		}
		if (e == WaitCalc.Edge.STOP) {
			SiteView v = liveView(srv, id);
			if (v == null) {
				v = st.lastView;
			}
			if (v != null) {
				ApiEvents.waiting(v, new SiteWait(id, false, 0L, List.of(), 0));
			}
		}
	}

	/** The end of a server tick: writes the file when a wait started or ended. */
	static void flush(MinecraftServer srv) {
		flush(srv, false);
	}

	private static void fire(MinecraftServer srv, String id, State st, WaitCalc.Edge e) {
		SiteWait w = e == WaitCalc.Edge.START ? view(srv, id) : new SiteWait(id, false, 0L, List.of(), 0);
		SiteView v = liveView(srv, id);
		if (w == null || v == null) {
			return;
		}
		if (e == WaitCalc.Edge.START) {
			st.lastView = v;
		} else {
			st.lastView = null;
		}
		ApiEvents.waiting(v, w);
	}

	private static @Nullable SiteView liveView(MinecraftServer srv, String id) {
		Site s = Sites.get(id);
		if (s != null) {
			return Views.site(srv, s);
		}
		Infra i = Infras.get(id);
		return i == null ? null : Views.infra(i);
	}

	// ------------------------------------------------------------------ the status

	/**
	 * The waiting status of a construction target (a site or a road), or null when the id is not one. A built target answers
	 * {@code waiting=false}. Server thread.
	 */
	public static @Nullable SiteWait view(MinecraftServer srv, String id) {
		Site s = Sites.get(id);
		Builder.Run r;
		Site probe;
		ServerLevel level;
		if (s != null) {
			if (s.construction() == null) {
				return null;
			}
			probe = s;
			level = Sites.levelOf(srv, s);
			r = s.building() && level != null ? Builder.run(srv, s) : null;
		} else {
			Infra i = Infras.get(id);
			if (i == null || i.construction() == null) {
				return null;
			}
			probe = RoadBuilder.probe(i);
			level = Sites.levelOf(srv, i.dimension());
			r = i.building() && level != null ? RoadBuilder.run(srv, i) : null;
		}
		State st = STATES.get(id);
		boolean waiting = st != null ? st.latch.waiting() : RESTORED.containsKey(id);
		long since = st != null ? st.latch.since() : waiting ? RESTORED.get(id) : 0L;
		if (r == null || level == null) {
			return new SiteWait(id, waiting, waiting ? CLOCK.held(id, since) : 0L, List.of(), 0);
		}
		Supply supply = source.supply(srv, level, probe);
		WaitCalc.Needs needs = WaitCalc.Needs.NONE;
		if (supply != null) {
			long built = r.built.cardinality();
			long ver = supply.version();
			if (st != null && st.cacheBuilt == built && st.cacheVersion == ver) {
				needs = st.cached;
			} else {
				needs = needs(r, supply);
				if (st != null) {
					st.cacheBuilt = built;
					st.cacheVersion = ver;
					st.cached = needs;
				}
			}
		}
		if (Sites.txnHeld(id)) { // (slice T3b) site: or road:
			// (slice T1, §3.12.3) held by an open txn: the feed skips it (Stockpiles.feed), not short of materials
			return new SiteWait(id, true, CLOCK.held(id, since), items(needs), needs.moreUnits(), SiteWait.TXN_HELD, List.of());
		}
		Map<String, Integer> capped = BILL_CAPPED.get(id);
		if (capped != null) {
			// (BC, S-M5-9) the next cell would draw past the realise's maxBill: STARVED, typed; nextNeeded the capped items' units over the cap
			return capWait(id, capped, CLOCK.held(id, sinceOf(since, CAP_SINCE.getOrDefault(id, 0L)))); // (LCAP-Q1) its scope
		}
		List<net.minecraft.core.BlockPos> held = FILL_BLOCKED.get(id);
		if (held != null) {
			// (M5 FK) a declared container not empty at the fill: a typed wait, not for materials
			return new SiteWait(id, true, CLOCK.held(id, sinceOf(since, FILL_SINCE.getOrDefault(id, 0L))), items(needs), needs.moreUnits(), SiteWait.FILL_BLOCKED, held);
		}
		return new SiteWait(id, waiting, waiting ? CLOCK.held(id, since) : 0L, items(needs), needs.moreUnits());
	}

	/** (8b review P2-4) Frees the canonical start when no wait of any kind (latch, cap, fill) holds the target. */
	static void freeIfIdle(String id) {
		State st = STATES.get(id);
		boolean latched = st != null ? st.latch.waiting() : RESTORED.containsKey(id);
		if (!latched && !BILL_CAPPED.containsKey(id) && !FILL_BLOCKED.containsKey(id)) {
			CLOCK.free(id);
		}
	}

	/**
	 * (8b BS, S-8b-1) A typed wait's {@code waitingSince}: the earlier of the materials latch's start and the typed wait's own start (each 0
	 * when absent). The latch starts 100 ticks after a cap or a fill began to hold, so preferring it would move {@code waitingSince} on the
	 * same wait; the earlier keeps it stable while the wait changes kind (materials to bill_cap: the latch's; bill_cap, then the latch: the
	 * cap's). Pure.
	 */
	static long sinceOf(long latch, long typed) {
		if (latch <= 0) {
			return Math.max(0L, typed);
		}
		return typed <= 0 ? latch : Math.min(latch, typed);
	}

	/** The {@code nextNeeded} walk over a run's unbuilt cells in build order. */
	static WaitCalc.Needs needs(Builder.Run r, Supply supply) {
		List<List<SurvivalItems.Cost>> unbuilt = new ArrayList<>();
		for (int i = r.built.nextClearBit(0); i < r.size(); i = r.built.nextClearBit(i + 1)) {
			List<SurvivalItems.Cost> c = r.cost.get(i);
			if (!c.isEmpty()) {
				unbuilt.add(c);
			}
		}
		if (!r.fillOwed.isEmpty()) {
			// (M5 FK) the fill comes after every cell: its items last, one step (it is written in one tick)
			List<SurvivalItems.Cost> fill = new ArrayList<>();
			r.fillOwed.forEach((k, v) -> fill.add(new SurvivalItems.Cost(k, v)));
			unbuilt.add(fill);
		}
		return WaitCalc.walk(unbuilt, supply::available);
	}

	private static List<ItemCount> items(WaitCalc.Needs n) {
		List<ItemCount> out = new ArrayList<>();
		for (WaitCalc.Need x : n.list()) {
			Identifier key = Identifier.tryParse(x.item());
			Item item = key == null ? null : BuiltInRegistries.ITEM.getOptional(key).orElse(null);
			if (item != null) {
				out.add(new ItemCount(item, x.count()));
			}
		}
		return out;
	}

	/** The DevBridge's and the gate's view of a wait. */
	public static JsonObject json(@Nullable SiteWait w, @Nullable ServerLevel level) {
		JsonObject o = new JsonObject();
		if (level != null) {
			o.addProperty("gameTime", level.getGameTime());
		}
		if (w == null) {
			return o;
		}
		o.addProperty("waiting", w.waiting());
		o.addProperty("waitingSince", w.waitingSince());
		com.google.gson.JsonArray a = new com.google.gson.JsonArray();
		for (ItemCount c : w.nextNeeded()) {
			JsonObject x = new JsonObject();
			x.addProperty("item", BuiltInRegistries.ITEM.getKey(c.item()).toString());
			x.addProperty("count", c.count());
			a.add(x);
		}
		o.add("nextNeeded", a);
		o.addProperty("moreUnits", w.moreUnits());
		if (w.blocked() != null) {
			o.addProperty("blocked", w.blocked()); // (M5 FK)
			if (w.capScope() != null) {
				o.addProperty("capScope", w.capScope()); // (LCAP-Q1)
			}
			com.google.gson.JsonArray cells = new com.google.gson.JsonArray();
			for (net.minecraft.core.BlockPos p : w.blockedCells()) {
				cells.add(p.getX() + "," + p.getY() + "," + p.getZ());
			}
			o.add("blockedCells", cells);
		}
		return o;
	}

	/** (M5 FK) The targets held at their fill by declared containers that are not empty, with those cells (live; the next step re-derives it). */
	private static final Map<String, List<net.minecraft.core.BlockPos>> FILL_BLOCKED = new java.util.concurrent.ConcurrentHashMap<>();
	private static final Map<String, Long> FILL_SINCE = new java.util.concurrent.ConcurrentHashMap<>();

	/** (M5 FK) The fill of {@code id} is held by {@code cells}: the typed wait {@link SiteWait#FILL_BLOCKED} (SITE_WAITING when it starts or moves). */
	static void fillBlocked(MinecraftServer srv, String id, List<net.minecraft.core.BlockPos> cells) {
		List<net.minecraft.core.BlockPos> was = FILL_BLOCKED.put(id, List.copyOf(cells));
		if (was == null) {
			FILL_SINCE.put(id, srv.overworld().getGameTime());
			CLOCK.held(id, FILL_SINCE.get(id));
			dirty = true;
		}
		if (!cells.equals(was)) {
			SiteView v = liveView(srv, id);
			SiteWait w = view(srv, id);
			if (v != null && w != null) {
				ApiEvents.waiting(v, w);
			}
		}
	}

	/** (M5 FK) The fill of {@code id} is no longer held (it ran, or the target went). */
	static void fillUnblocked(MinecraftServer srv, String id) {
		if (FILL_BLOCKED.remove(id) != null) {
			FILL_SINCE.remove(id);
			freeIfIdle(id);
			dirty = true;
			SiteView v = liveView(srv, id);
			if (v != null) {
				ApiEvents.waiting(v, new SiteWait(id, false, 0L, List.of(), 0));
			}
		}
	}

	/** (BC, S-M5-9) The targets held back by their realise's maxBill: the capped items' units over the cap. */
	private static final Map<String, Map<String, Integer>> BILL_CAPPED = new java.util.concurrent.ConcurrentHashMap<>();
	private static final Map<String, Long> CAP_SINCE = new java.util.concurrent.ConcurrentHashMap<>();
	/** (LCAP-Q1) Which cap holds each capped target ({@link SiteWait#capScope}). */
	private static final Map<String, String> CAP_SCOPE = new java.util.concurrent.ConcurrentHashMap<>();

	/** (BC, S-M5-9) {@code id}'s next cell would draw past its realise's maxBill: the typed wait {@link SiteWait#BILL_CAP}. */
	static void billCapped(MinecraftServer srv, String id, Map<String, Integer> over) {
		billCapped(srv, id, over, SiteWait.CAP_REGION);
	}

	/** (LCAP-Q1) {@link #billCapped} naming the cap that holds it ({@link SiteWait#capScope}). */
	static void billCapped(MinecraftServer srv, String id, Map<String, Integer> over, String scope) {
		Map<String, Integer> was = BILL_CAPPED.put(id, Map.copyOf(over));
		String wasScope = CAP_SCOPE.put(id, scope);
		if (was == null) {
			CAP_SINCE.put(id, srv.overworld().getGameTime());
			CLOCK.held(id, CAP_SINCE.get(id));
			dirty = true;
		}
		if (!over.equals(was) || !scope.equals(wasScope)) {
			SiteView v = liveView(srv, id);
			SiteWait w = view(srv, id);
			if (v != null && w != null) {
				ApiEvents.waiting(v, w);
			}
		}
	}

	/** (BC, S-M5-9) {@code id} is no longer held by the cap (it built a cell, or the target went). */
	static void billUncapped(MinecraftServer srv, String id) {
		if (BILL_CAPPED.remove(id) != null) {
			CAP_SINCE.remove(id);
			CAP_SCOPE.remove(id);
			freeIfIdle(id);
			dirty = true;
			SiteView v = liveView(srv, id);
			if (v != null) {
				ApiEvents.waiting(v, new SiteWait(id, false, 0L, List.of(), 0));
			}
		}
	}

	/**
	 * (8b BS) {@link #view} for a status read: a target that is not waiting (no latch, no typed hold) answers not waiting without the
	 * needs walk over its unbuilt cells (which a never-starved target would redo uncached on every read). Server thread.
	 */
	public static @Nullable SiteWait statusView(MinecraftServer srv, String id) {
		State st = STATES.get(id);
		boolean waiting = st != null ? st.latch.waiting() : RESTORED.containsKey(id);
		boolean txn = txnHeld.test("site:" + id);
		if (!waiting && !BILL_CAPPED.containsKey(id) && !FILL_BLOCKED.containsKey(id) && !txn) {
			return new SiteWait(id, false, 0L, List.of(), 0);
		}
		long since = st != null ? st.latch.since() : waiting ? RESTORED.getOrDefault(id, 0L) : 0L;
		// (8b review P2-6) the typed holds from their retained data, never the materials walk: the status shows a txn hold or a cap as
		// such (a cap's needs are its over-cap items), a blocked fill by its cells; only a materials wait reads its needs (view, cached by
		// its latch)
		if (txn) {
			return new SiteWait(id, true, CLOCK.held(id, since), List.of(), 0, SiteWait.TXN_HELD, List.of());
		}
		Map<String, Integer> capped = BILL_CAPPED.get(id);
		if (capped != null) {
			return capWait(id, capped, CLOCK.held(id, sinceOf(since, CAP_SINCE.getOrDefault(id, 0L))));
		}
		List<net.minecraft.core.BlockPos> held = FILL_BLOCKED.get(id);
		if (held != null) {
			return new SiteWait(id, true, CLOCK.held(id, sinceOf(since, FILL_SINCE.getOrDefault(id, 0L))), List.of(), 0, SiteWait.FILL_BLOCKED, held);
		}
		return srv == null ? new SiteWait(id, waiting, waiting ? CLOCK.held(id, since) : 0L, List.of(), 0) : view(srv, id);
	}

	/** A cap's wait from its retained over-cap items (at most 8 named, the rest in moreUnits), its start and its scope. */
	static SiteWait capWait(String id, Map<String, Integer> capped, long since) {
		List<ItemCount> its = new ArrayList<>();
		int more = 0;
		for (var e : capped.entrySet()) {
			Item item = BuiltInRegistries.ITEM.getOptional(Identifier.tryParse(e.getKey())).orElse(null);
			if (item == null || its.size() >= 8) {
				more += e.getValue();
			} else {
				its.add(new ItemCount(item, e.getValue()));
			}
		}
		return new SiteWait(id, true, since, its, more, SiteWait.BILL_CAP, List.of(), CAP_SCOPE.get(id));
	}

	/** Whether an open txn holds a resource (TxnServer.held; a test swaps it: the txn layer needs a server). */
	static java.util.function.Predicate<String> txnHeld = dev.larattalabs.architect.txn.TxnServer::held;

	/** (TEST) Holds {@code id} by a cap, as {@link #billCapped} records it, without a server. */
	static void testCap(String id, Map<String, Integer> over, long since, String scope) {
		BILL_CAPPED.put(id, Map.copyOf(over));
		CAP_SINCE.put(id, since);
		CAP_SCOPE.put(id, scope);
		CLOCK.held(id, since);
	}

	/** (TEST) Drops every cap and clock entry the test hooks made. */
	static void testClear() {
		BILL_CAPPED.clear();
		CAP_SINCE.clear();
		CAP_SCOPE.clear();
		CLOCK.clear();
	}

	/** {@code Sites.waiting}: empty when the id is not a construction target. */
	public static Optional<SiteWait> waiting(MinecraftServer srv, String id) {
		return Optional.ofNullable(view(srv, id));
	}

	// ------------------------------------------------------------------ the file

	private static Path file(MinecraftServer srv) {
		return srv.getWorldPath(LevelResource.ROOT).resolve("architect").resolve(FILE);
	}

	private static void load(MinecraftServer srv) {
		STATES.clear();
		RESTORED.clear();
		Path f = file(srv);
		if (!Files.isRegularFile(f)) {
			return;
		}
		try {
			JsonObject o = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			JsonObject w = o.has("waits") ? o.getAsJsonObject("waits") : new JsonObject();
			w.entrySet().forEach(e -> RESTORED.put(e.getKey(), e.getValue().getAsLong()));
			CLOCK.load(RESTORED); // (8b review P2-4) the canonical starts, as reported before the restart
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("{} could not be read; waits start over: {}", f, e.toString());
		}
	}

	private static void flush(MinecraftServer srv, boolean force) {
		if (!dirty && !force) {
			return;
		}
		dirty = false;
		Map<String, Long> out = new TreeMap<>();
		STATES.forEach((id, st) -> {
			if (st.latch.waiting()) {
				out.put(id, CLOCK.of(id) > 0 ? CLOCK.of(id) : st.latch.since()); // (8b review P2-4) the canonical start
			}
		});
		RESTORED.forEach((id, since) -> {
			if (Sites.get(id) != null || Infras.get(id) != null) {
				out.put(id, since); // not claimed yet (its chunks have not loaded): keep it
			}
		});
		// (8b review P2-4) a target held only by a cap or a fill (its latch not yet started) keeps its start too
		for (String id : new java.util.TreeSet<>(BILL_CAPPED.keySet())) {
			if (CLOCK.of(id) > 0) {
				out.putIfAbsent(id, CLOCK.of(id));
			}
		}
		for (String id : new java.util.TreeSet<>(FILL_BLOCKED.keySet())) {
			if (CLOCK.of(id) > 0) {
				out.putIfAbsent(id, CLOCK.of(id));
			}
		}
		Path f = file(srv);
		if (out.isEmpty() && !Files.exists(f)) {
			return;
		}
		JsonObject o = new JsonObject();
		o.addProperty("version", 1);
		JsonObject w = new JsonObject();
		out.forEach(w::addProperty);
		o.add("waits", w);
		try {
			Files.createDirectories(f.getParent());
			Path tmp = f.resolveSibling(FILE + ".tmp");
			Files.writeString(tmp, o.toString(), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("{} could not be written: {}", f, e.toString());
		}
	}

	/** Test hook: the waiting targets (id -> waitingSince). */
	public static Map<String, Long> waitingNow() {
		Map<String, Long> out = new TreeMap<>();
		STATES.forEach((id, st) -> {
			if (st.latch.waiting()) {
				out.put(id, st.latch.since());
			}
		});
		RESTORED.forEach(out::putIfAbsent);
		return out;
	}
}
