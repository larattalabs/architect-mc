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
	private static boolean dirty;

	private SiteWaits() {
	}

	public static void init() {
		ServerLifecycleEvents.SERVER_STARTED.register(SiteWaits::load);
		ServerLifecycleEvents.SERVER_STOPPING.register(srv -> flush(srv, true));
		ServerLifecycleEvents.SERVER_STOPPED.register(srv -> {
			STATES.clear();
			RESTORED.clear();
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
			return new SiteWait(id, waiting, since, List.of(), 0);
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
		return new SiteWait(id, waiting, since, items(needs), needs.moreUnits());
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
		return o;
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
				out.put(id, st.latch.since());
			}
		});
		RESTORED.forEach((id, since) -> {
			if (Sites.get(id) != null || Infras.get(id) != null) {
				out.put(id, since); // not claimed yet (its chunks have not loaded): keep it
			}
		});
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
