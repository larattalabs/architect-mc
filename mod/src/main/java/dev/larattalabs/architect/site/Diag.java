package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import java.io.IOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerChunkEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.status.ChunkStatus;

/**
 * Phase 6a step 1 (docs/CONTRACT.md "Chunks: prepare, loading and the NOT_LOADED fix"): a diagnostic log of the placement
 * queue's chunk tickets and waits, written as JSON lines to {@code $ARCHITECT_DIAG}. Off unless that variable is set. Not
 * shipped: lives on the diagnostic branch only.
 */
final class Diag {
	static final Path FILE = System.getenv("ARCHITECT_DIAG") == null ? null : Path.of(System.getenv("ARCHITECT_DIAG"));
	private static Writer out;
	private static long tickStart;
	private static int added;
	private static int removed;
	private static int generated;
	private static int loads;
	private static long genTotal;
	private static long loadTotal;
	private static int ticks;
	private static long lastSummary;
	private static final Map<String, Long> LAST_WAIT_LOG = new TreeMap<>();

	private Diag() {
	}

	static boolean on() {
		return FILE != null;
	}

	static void init() {
		if (!on()) {
			return;
		}
		try {
			Files.createDirectories(FILE.getParent());
			out = Files.newBufferedWriter(FILE, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
		} catch (IOException e) {
			Architect.LOGGER.error("diag: cannot open {}", FILE, e);
			return;
		}
		ServerTickEvents.START_SERVER_TICK.register(s -> tickStart = System.nanoTime());
		ServerTickEvents.END_SERVER_TICK.register(Diag::endTick);
		ServerChunkEvents.CHUNK_LOAD.register((level, chunk, gen) -> {
			loads++;
			if (gen) {
				generated++;
			}
		});
		Architect.LOGGER.info("diag: logging to {}", FILE);
	}

	private static synchronized void write(JsonObject o) {
		if (out == null) {
			return;
		}
		try {
			o.addProperty("ms", System.currentTimeMillis());
			out.write(o.toString());
			out.write('\n');
		} catch (IOException e) {
			// best effort
		}
	}

	static void ticketAdded(int n) {
		added += n;
	}

	static void ticketRemoved(int n) {
		removed += n;
	}

	private static void endTick(MinecraftServer server) {
		double ms = (System.nanoTime() - tickStart) / 1e6;
		ticks++;
		genTotal += generated;
		loadTotal += loads;
		if (ms > 50 || generated > 0 && ms > 25) {
			JsonObject o = new JsonObject();
			o.addProperty("ev", "slow");
			o.addProperty("tick", server.getTickCount());
			o.addProperty("tickMs", ms);
			o.addProperty("gen", generated);
			o.addProperty("loads", loads);
			o.addProperty("tAdd", added);
			o.addProperty("tRem", removed);
			o.addProperty("held", Batches.diagHeld());
			o.addProperty("jobs", Placement.active() ? 1 : 0);
			write(o);
		}
		long now = System.currentTimeMillis();
		if (now - lastSummary >= 10_000) {
			lastSummary = now;
			JsonObject o = new JsonObject();
			o.addProperty("ev", "sum");
			o.addProperty("tick", server.getTickCount());
			o.addProperty("genTotal", genTotal);
			o.addProperty("loadTotal", loadTotal);
			o.addProperty("held", Batches.diagHeld());
			o.addProperty("waiter", Batches.diagWaiters());
			ServerLevel ow = server.overworld();
			o.addProperty("loadedChunks", ow.getChunkSource().getLoadedChunksCount());
			write(o);
			try {
				out.flush();
			} catch (IOException e) {
				// best effort
			}
		}
		added = 0;
		removed = 0;
		generated = 0;
		loads = 0;
	}

	/** One wait of an item: why, how long, its tickets, and the status of every chunk it wants (at most one line per 10 s per item). */
	static void waiting(QBatch b, QItem i, String why, String msg, ServerLevel level, Set<Long> want, boolean holds, boolean isWaiter, int heldTotal) {
		if (!on()) {
			return;
		}
		long now = System.currentTimeMillis();
		Long last = LAST_WAIT_LOG.get(b.id + "/" + i.key);
		if (last != null && now - last < 10_000 && !"TIMED_OUT".equals(why)) {
			return;
		}
		LAST_WAIT_LOG.put(b.id + "/" + i.key, now);
		JsonObject o = new JsonObject();
		o.addProperty("ev", "wait");
		o.addProperty("key", i.key);
		o.addProperty("kind", i.itemKind);
		o.addProperty("why", why);
		o.addProperty("msg", msg);
		o.addProperty("waited", i.waited / 20);
		o.addProperty("holds", holds);
		o.addProperty("isWaiter", isWaiter);
		o.addProperty("want", want == null ? -1 : want.size());
		o.addProperty("heldTotal", heldTotal);
		o.addProperty("bound", b.loadChunks);
		if (want != null && level != null) {
			Map<String, Integer> st = new TreeMap<>();
			JsonArray missing = new JsonArray();
			for (long c : want) {
				ChunkStatus s = level.getChunkSource().chunkMap.getLatestStatus(c);
				boolean has = level.hasChunk(ChunkPos.getX(c), ChunkPos.getZ(c));
				String k = (s == null ? "none" : s.getName()) + (has ? "+full" : "");
				st.merge(k, 1, Integer::sum);
				if (!has && missing.size() < 12) {
					missing.add(ChunkPos.getX(c) + "," + ChunkPos.getZ(c));
				}
			}
			JsonObject so = new JsonObject();
			st.forEach(so::addProperty);
			o.add("status", so);
			o.add("notLoaded", missing);
		}
		write(o);
	}

	static void note(String ev, JsonObject o) {
		if (!on()) {
			return;
		}
		o.addProperty("ev", ev);
		write(o);
	}
}
