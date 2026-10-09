package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;

/**
 * The mod's side of region streaming (CONTRACT §3 "Streaming", D5): the mod pulls, the sidecar never pushes. A tile is
 * requested once its heights are frozen, with at most W outstanding per region; its frames are reassembled, the sha checked,
 * and the payload decoded off the server thread. Received cells live in memory only until the tile's P7 commit (never in the
 * queue file). When the link drops, requests in flight are dropped and asked again on reconnect.
 */
public final class TileStream {
	public enum Phase { REQUESTED, RECEIVED, DECODED, FAILED }

	/** The link to the sidecar (the client's {@code ClientBridge} in a singleplayer game; a seam for tests). */
	public interface Link {
		boolean connected();

		/** A counter that changes on every reconnect (requests of an older link are asked again). */
		int generation();

		CompletableFuture<JsonObject> send(JsonObject message);
	}

	public static final class Tile {
		public final String region;
		public final String planId;
		public final String stage;
		public final String set;
		public final String key;
		public volatile Phase phase = Phase.REQUESTED;
		volatile int linkGen;
		final List<byte[]> frames = new ArrayList<>();
		int nextSeq;
		volatile @Nullable CompletableFuture<Packed.Tile> decoded;
		public volatile @Nullable String error;
		public volatile long requestedAt;
		public volatile long receivedAt;
		public volatile int wireBytes;
		public volatile int count;

		Tile(String region, String planId, String stage, String set, String key) {
			this.region = region;
			this.planId = planId;
			this.stage = stage;
			this.set = set;
			this.key = key;
		}

		public Packed.@Nullable Tile cells() {
			CompletableFuture<Packed.Tile> d = decoded;
			return d != null && d.isDone() && !d.isCompletedExceptionally() ? d.join() : null;
		}
	}

	private static final Map<String, Tile> TILES = new ConcurrentHashMap<>();
	private static final ExecutorService DECODE = Executors.newFixedThreadPool(2, r -> {
		Thread t = new Thread(r, "Architect tile decode");
		t.setDaemon(true);
		return t;
	});
	static volatile @Nullable Link link;
	/** Stats for the gate: tiles received, wire bytes, cells. */
	public static final AtomicInteger RECEIVED = new AtomicInteger();
	/** Request to last frame, per tile (ms): the evaluation as the mod sees it (queue, evaluate, send). */
	public static final List<Double> LATENCY = new ArrayList<>();
	public static final java.util.concurrent.atomic.AtomicLong WIRE_BYTES = new java.util.concurrent.atomic.AtomicLong();
	public static final java.util.concurrent.atomic.AtomicLong WIRE_CELLS = new java.util.concurrent.atomic.AtomicLong();

	private TileStream() {
	}

	public static void setLink(@Nullable Link l) {
		link = l;
	}

	public static boolean available() {
		Link l = link;
		return l != null && l.connected();
	}

	static String id(String region, String stage, String set, String key) {
		return region + "|" + stage + "|" + set + "|" + key;
	}

	public static @Nullable Tile get(String region, String stage, String set, String key) {
		Tile t = TILES.get(id(region, stage, set, key));
		Link l = link;
		if (t != null && t.phase == Phase.REQUESTED && (l == null || !l.connected() || l.generation() != t.linkGen)) {
			TILES.remove(id(region, stage, set, key), t); // asked on a link that is gone: ask again
			return null;
		}
		return t;
	}

	/** Tiles of a region requested and not yet released (the window). */
	public static int outstanding(String region) {
		int n = 0;
		for (Tile t : TILES.values()) {
			if (t.region.equals(region) && t.phase != Phase.FAILED) {
				n++;
			}
		}
		return n;
	}

	/**
	 * Requests one tile ({@code region.tiles.request}); the IR goes along only when the sidecar answers {@code ir_unknown}.
	 * Returns false when the link is down.
	 */
	public static boolean request(String region, String planId, String irSha, Function<Void, JsonObject> ir, String stage, String set, String key,
		byte[] heights) {
		Link l = link;
		if (l == null || !l.connected()) {
			return false;
		}
		Tile t = new Tile(region, planId, stage, set, key);
		t.linkGen = l.generation();
		t.requestedAt = System.nanoTime();
		TILES.put(id(region, stage, set, key), t);
		JsonObject m = new JsonObject();
		m.addProperty("type", "region.tiles.request");
		m.addProperty("planId", planId);
		m.addProperty("irSha", irSha);
		JsonArray tiles = new JsonArray();
		JsonObject one = new JsonObject();
		one.addProperty("key", key);
		one.addProperty("stage", stage);
		one.addProperty("set", set);
		one.addProperty("heights", Base64.getEncoder().encodeToString(heights));
		tiles.add(one);
		m.add("tiles", tiles);
		l.send(m).whenComplete((ack, ex) -> {
			if (ex != null) {
				t.error = "the request failed: " + ex.getMessage();
				TILES.remove(id(region, stage, set, key), t);
				return;
			}
			if (ack.has("ok") && !ack.get("ok").getAsBoolean()) {
				String err = ack.has("error") && !ack.get("error").isJsonNull() ? ack.get("error").getAsString() : "refused";
				if (err.contains("ir_unknown")) {
					JsonObject again = m.deepCopy();
					again.add("ir", ir.apply(null));
					l.send(again).whenComplete((a2, e2) -> {
						if (e2 != null || a2.has("ok") && !a2.get("ok").getAsBoolean()) {
							fail(t, "the helper refused the tile: " + (e2 != null ? e2.getMessage() : a2));
						}
					});
				} else {
					fail(t, "the helper refused the tile: " + err);
				}
			}
		});
		return true;
	}

	private static void fail(Tile t, String why) {
		t.error = why;
		t.phase = Phase.FAILED;
	}

	/** {@code region.tile} / {@code region.tile.error} (the link's thread). */
	public static void onMessage(JsonObject m) {
		String type = m.get("type").getAsString();
		String region = null;
		Tile t = null;
		String key = m.has("key") ? m.get("key").getAsString() : "";
		String stage = m.has("stage") ? m.get("stage").getAsString() : "";
		String set = m.has("set") ? m.get("set").getAsString() : "";
		String planId = m.has("planId") ? m.get("planId").getAsString() : "";
		for (Tile x : TILES.values()) {
			if (x.planId.equals(planId) && x.key.equals(key) && x.stage.equals(stage) && x.set.equals(set) && x.phase == Phase.REQUESTED) {
				t = x;
				break;
			}
		}
		if (t == null) {
			return; // dropped (a reconnect, a released region)
		}
		if ("region.tile.error".equals(type)) {
			fail(t, m.has("message") ? m.get("message").getAsString() : "the tile could not be evaluated");
			return;
		}
		int seq = m.get("seq").getAsInt();
		synchronized (t) {
			if (seq != t.nextSeq) {
				fail(t, "frame " + seq + " out of order (expected " + t.nextSeq + ")");
				return;
			}
			byte[] data = Base64.getDecoder().decode(m.get("data").getAsString());
			t.frames.add(data);
			t.wireBytes += data.length;
			t.nextSeq++;
			if (m.has("more") && m.get("more").getAsBoolean()) {
				return;
			}
		}
		String sha = m.get("sha").getAsString();
		int count = m.get("count").getAsInt();
		t.count = count;
		t.receivedAt = System.nanoTime();
		t.phase = Phase.RECEIVED;
		RECEIVED.incrementAndGet();
		synchronized (LATENCY) {
			LATENCY.add((t.receivedAt - t.requestedAt) / 1e6);
		}
		WIRE_BYTES.addAndGet(t.wireBytes);
		WIRE_CELLS.addAndGet(count);
		Tile tt = t;
		t.decoded = CompletableFuture.supplyAsync(() -> {
			try {
				Packed.Tile p = Packed.decode(Packed.payload(tt.frames, sha));
				if (p.size() != count) {
					throw new IllegalStateException("tile " + tt.key + ": " + p.size() + " cells, the helper said " + count);
				}
				tt.frames.clear();
				return p;
			} catch (Exception e) {
				throw new java.util.concurrent.CompletionException(e);
			}
		}, DECODE).whenComplete((p, ex) -> {
			if (ex != null) {
				Architect.LOGGER.warn("Region tile {} {} {}: {}", tt.key, tt.stage, tt.set, ex.toString());
				fail(tt, "the tile could not be read: " + (ex.getCause() != null ? ex.getCause().getMessage() : ex.getMessage()));
			} else {
				tt.phase = Phase.DECODED;
			}
		});
	}

	/** The tile's cells are committed (P7) or the item is gone: its memory goes. */
	public static void release(String region, String stage, String set, String key) {
		TILES.remove(id(region, stage, set, key));
	}

	/** A failed tile is asked again (after a fix, a resume). */
	public static void retry(String region, String stage, String set, String key) {
		Tile t = TILES.get(id(region, stage, set, key));
		if (t != null && t.phase == Phase.FAILED) {
			TILES.remove(id(region, stage, set, key));
		}
	}

	public static void forgetRegion(@Nullable String region) {
		TILES.values().removeIf(t -> region == null || t.region.equals(region));
	}
}
