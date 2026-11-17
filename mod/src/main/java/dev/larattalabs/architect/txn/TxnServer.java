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
 * <li><b>recovery</b> on the first server tick, after every store has loaded: each open txn by the §3.6 table;</li>
 * <li><b>events</b> a recovery owes fire on the tick after it (never inside SERVER_STARTED, §3.12.9);</li>
 * <li>each later tick re-drives held and retiring txns.</li>
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

	public static void init() {
		TestMove.init();
		ServerLifecycleEvents.SERVER_STARTING.register(TxnServer::load);
		ServerTickEvents.END_SERVER_TICK.register(TxnServer::tick);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			server = null;
			file = null;
			recovered = false;
			NEXT_TICK.clear();
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
		NEXT_TICK.clear();
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

	static void tick(MinecraftServer srv) {
		if (srv != server) {
			return;
		}
		for (int n = NEXT_TICK.size(); n > 0; n--) {
			Runnable r = NEXT_TICK.poll();
			if (r != null) {
				r.run();
			}
		}
		if (!recovered) {
			recovered = true;
			if (core.anyOpen()) {
				Architect.LOGGER.info("Txn: recovering {} open txn(s)", core.open().size());
				core.recover();
			}
			return;
		}
		if (!core.open().isEmpty() || core.unsynced()) {
			core.tick();
		}
	}

	// ------------------------------------------------------------------ the holds every writer honours (O(1) with none open)

	/** Whether {@code resource} is held by an open, retiring or quarantined txn. */
	public static boolean held(String resource) {
		TxnCore c = core;
		return !c.holds().isEmpty() && c.holds().holder(resource) != null;
	}

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
		public void emit(TxnEntry t, String event, JsonObject payload, boolean replayed) {
			String line = t.id + " " + event + (replayed ? " (replayed)" : "") + " " + payload;
			Runnable fire = () -> {
				Architect.LOGGER.info("Txn event: {}", line);
				EVENTS.addLast(line);
				while (EVENTS.size() > 32) {
					EVENTS.pollFirst();
				}
			};
			if (replayed) {
				NEXT_TICK.add(fire); // a re-fired event: on the tick after recovery, with every store loaded
			} else {
				fire.run();
			}
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
		return o;
	}
}
