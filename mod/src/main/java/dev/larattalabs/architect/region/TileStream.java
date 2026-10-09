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
	/**
	 * REQUESTED .. DECODED as 6a; FAILED: the tile failed (the item fails); WAITING (6b): the helper keeps answering
	 * {@code ir_unknown} / {@code blob_unknown} after {@link #MAX_RESENDS} re-sends, so the item waits SIDECAR_UNAVAILABLE until the
	 * link changes (a reconnect or a restart asks again).
	 */
	public enum Phase { REQUESTED, RECEIVED, DECODED, FAILED, WAITING }

	/** At most this many re-requests of a tile per reason ({@code ir_unknown}, {@code blob_unknown}) (CONTRACT phase 6b §2.2). */
	public static final int MAX_RESENDS = 3;

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
		if (t != null && (t.phase == Phase.REQUESTED || t.phase == Phase.WAITING) && (l == null || !l.connected() || l.generation() != t.linkGen)) {
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

	/** Reads a side blob's bytes by sha from the world copy (null: not there). Called off the server thread. */
	@FunctionalInterface
	public interface BlobSource {
		byte @Nullable [] read(String sha);
	}

	/** Uploads a blob ({@code blob.put}, chunked, kind {@code region.blob}); completes with its blob id. A seam for tests. */
	static volatile java.util.function.BiFunction<byte[], String, CompletableFuture<String>> PUT = (b, kind) -> BlobPut.put(link, b, kind);
	/** Re-sends by reason since the last reset (dev.region.state, the gate's 10(a)). */
	public static final java.util.concurrent.ConcurrentHashMap<String, AtomicInteger> RESENDS = new java.util.concurrent.ConcurrentHashMap<>();

	/** 6a's signature (no side blobs). */
	public static boolean request(String region, String planId, String irSha, Function<Void, JsonObject> ir, String stage, String set, String key,
		byte[] heights) {
		return request(region, planId, irSha, ir, sha -> null, stage, set, key, heights);
	}

	/**
	 * Requests one tile ({@code region.tiles.request}). The IR goes along only when the sidecar answers {@code ir_unknown}; side
	 * blobs (6b) only when it answers {@code blob_unknown <sha>,<sha>}: they are read from the world copy ({@code blobs}),
	 * uploaded with {@code blob.put} and the tile is asked again with {@code blobs: {sha: blobId}}. IR first, then blobs (the
	 * sidecar resolves in that order). At most {@link #MAX_RESENDS} re-requests per reason; then the tile is {@link Phase#WAITING}
	 * with the message (the item waits SIDECAR_UNAVAILABLE). Returns false when the link is down.
	 */
	public static boolean request(String region, String planId, String irSha, Function<Void, JsonObject> ir, BlobSource blobs, String stage, String set,
		String key, byte[] heights) {
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
		send(l, t, m, ir, blobs, new int[2]);
		return true;
	}

	/** One send of a tile request and what its ack asks for. {@code tries}: {ir_unknown, blob_unknown} re-requests so far. */
	private static void send(Link l, Tile t, JsonObject m, Function<Void, JsonObject> ir, BlobSource blobs, int[] tries) {
		l.send(m).whenComplete((ack, ex) -> {
			if (TILES.get(id(t.region, t.stage, t.set, t.key)) != t) {
				return; // released or asked again meanwhile
			}
			if (ex != null) {
				t.error = "the request failed: " + ex.getMessage();
				TILES.remove(id(t.region, t.stage, t.set, t.key), t);
				return;
			}
			if (!ack.has("ok") || ack.get("ok").getAsBoolean()) {
				return;
			}
			String err = ack.has("error") && !ack.get("error").isJsonNull() ? ack.get("error").getAsString() : "refused";
			if (err.contains("ir_unknown")) {
				if (tries[0] >= MAX_RESENDS) {
					waiting(t, "the helper still lacks plan " + t.planId + "'s IR after " + MAX_RESENDS + " re-sends (" + err + ")");
					return;
				}
				tries[0]++;
				RESENDS.computeIfAbsent("ir", k -> new AtomicInteger()).incrementAndGet();
				JsonObject again = m.deepCopy();
				again.add("ir", ir.apply(null));
				send(l, t, again, ir, blobs, tries);
			} else if (err.contains("blob_unknown")) {
				if (tries[1] >= MAX_RESENDS) {
					waiting(t, "the helper still lacks side blobs of plan " + t.planId + " after " + MAX_RESENDS + " re-sends (" + err + ")");
					return;
				}
				tries[1]++;
				RESENDS.computeIfAbsent("blob", k -> new AtomicInteger()).incrementAndGet();
				List<String> shas = blobUnknown(err);
				resendBlobs(shas, blobs).whenComplete((ids, e2) -> {
					if (e2 != null) {
						waiting(t, "side blobs could not be re-sent: " + (e2.getCause() != null ? e2.getCause().getMessage() : e2.getMessage()));
						return;
					}
					JsonObject again = m.deepCopy();
					JsonObject bl = again.has("blobs") && again.get("blobs").isJsonObject() ? again.getAsJsonObject("blobs") : new JsonObject();
					ids.forEach(bl::addProperty);
					again.add("blobs", bl);
					if (!again.has("ir") && tries[0] > 0) {
						again.add("ir", ir.apply(null));
					}
					send(l, t, again, ir, blobs, tries);
				});
			} else {
				fail(t, "the helper refused the tile: " + err);
			}
		});
	}

	/** The shas of a {@code blob_unknown <sha>,<sha>...} error (also {@code blob_unknown {shas: [...]}}). Pure. */
	public static List<String> blobUnknown(String err) {
		List<String> out = new ArrayList<>();
		java.util.regex.Matcher mm = java.util.regex.Pattern.compile("[0-9a-f]{64}").matcher(err);
		while (mm.find()) {
			if (!out.contains(mm.group())) {
				out.add(mm.group());
			}
		}
		return out;
	}

	/** Uploads each sha's world copy as kind {@code region.blob}; sha -> blob id. A missing copy fails it. */
	static CompletableFuture<Map<String, String>> resendBlobs(List<String> shas, BlobSource blobs) {
		Map<String, String> out = new java.util.concurrent.ConcurrentHashMap<>();
		CompletableFuture<Void> chain = CompletableFuture.completedFuture(null);
		for (String sha : shas) {
			chain = chain.thenCompose(v -> {
				byte[] b = blobs.read(sha);
				if (b == null) {
					return CompletableFuture.failedFuture(new IllegalStateException("blob " + sha + " missing in the world copy"));
				}
				return PUT.apply(b, "region.blob").thenAccept(id -> out.put(sha, id));
			});
		}
		if (shas.isEmpty()) {
			return CompletableFuture.failedFuture(new IllegalStateException("blob_unknown named no sha"));
		}
		return chain.thenApply(v -> out);
	}

	private static void waiting(Tile t, String why) {
		t.error = why;
		t.phase = Phase.WAITING;
		Architect.LOGGER.warn("Region {} tile {} {} {}: {}", t.region, t.key, t.stage, t.set, why);
	}

	// ------------------------------------------------------------------ preview tiles (the region ghost, 6b)

	/** A preview tile ({@code preview: true}): drawn by the ghost, never written. */
	public static final class PreviewTile {
		public final String planId;
		public final String key;
		public volatile Packed.@Nullable Tile cells;
		public volatile @Nullable String error;
		public volatile boolean done;
		final List<byte[]> frames = new ArrayList<>();
		int nextSeq;
		final CompletableFuture<PreviewTile> future = new CompletableFuture<>();

		PreviewTile(String planId, String key) {
			this.planId = planId;
			this.key = key;
		}
	}

	private static final Map<String, PreviewTile> PREVIEWS = new ConcurrentHashMap<>();

	/**
	 * Asks the helper for preview tiles of a plan (kit/REGIONS.md "Ghost tiles": every stage up to and including {@code stage},
	 * both sets, over the plan survey); each future completes with the tile's cells (or its error). A request already out for
	 * the same key is reused.
	 */
	public static List<CompletableFuture<PreviewTile>> requestPreview(String planId, String irSha, @Nullable String stage, List<String> keys) {
		Link l = link;
		List<CompletableFuture<PreviewTile>> out = new ArrayList<>();
		if (l == null || !l.connected()) {
			for (String k : keys) {
				out.add(CompletableFuture.failedFuture(new IllegalStateException("the helper (sidecar) is not connected")));
			}
			return out;
		}
		JsonArray tiles = new JsonArray();
		for (String k : keys) {
			String pid = planId + "|" + (stage == null ? "" : stage) + "|" + k;
			PreviewTile have = PREVIEWS.get(pid);
			if (have != null) {
				out.add(have.future);
				continue;
			}
			PreviewTile t = new PreviewTile(planId, k);
			PREVIEWS.put(pid, t);
			out.add(t.future);
			JsonObject one = new JsonObject();
			one.addProperty("key", k);
			if (stage != null) {
				one.addProperty("stage", stage);
			}
			tiles.add(one);
		}
		if (tiles.isEmpty()) {
			return out;
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "region.tiles.request");
		m.addProperty("planId", planId);
		m.addProperty("irSha", irSha);
		m.addProperty("preview", true);
		m.add("tiles", tiles);
		l.send(m).whenComplete((ack, ex) -> {
			String err = ex != null ? ex.getMessage() : ack.has("ok") && !ack.get("ok").getAsBoolean() ? String.valueOf(ack.get("error")) : null;
			if (err != null) {
				for (var e : tiles) {
					String k = e.getAsJsonObject().get("key").getAsString();
					PreviewTile t = PREVIEWS.remove(planId + "|" + (stage == null ? "" : stage) + "|" + k);
					if (t != null) {
						t.error = "the helper refused the preview: " + err;
						t.done = true;
						t.future.complete(t);
					}
				}
			}
		});
		return out;
	}

	/** Forgets the preview tiles of a plan (the ghost was hidden; null: all). */
	public static void forgetPreviews(@Nullable String planId) {
		PREVIEWS.values().removeIf(t -> planId == null || t.planId.equals(planId));
	}

	private static void previewFrame(JsonObject m, String type) {
		String planId = m.has("planId") ? m.get("planId").getAsString() : "";
		String key = m.has("key") ? m.get("key").getAsString() : "";
		PreviewTile t = null;
		for (var e : PREVIEWS.entrySet()) {
			PreviewTile x = e.getValue();
			if (x.planId.equals(planId) && x.key.equals(key) && !x.done) {
				t = x;
				break;
			}
		}
		if (t == null) {
			return;
		}
		PreviewTile tt = t;
		if ("region.tile.error".equals(type)) {
			tt.error = m.has("message") ? m.get("message").getAsString() : "the tile could not be evaluated";
			tt.done = true;
			tt.future.complete(tt);
			return;
		}
		synchronized (tt) {
			int seq = m.get("seq").getAsInt();
			if (seq != tt.nextSeq) {
				tt.error = "frame " + seq + " out of order";
				tt.done = true;
				tt.future.complete(tt);
				return;
			}
			tt.frames.add(Base64.getDecoder().decode(m.get("data").getAsString()));
			tt.nextSeq++;
			if (m.has("more") && m.get("more").getAsBoolean()) {
				return;
			}
		}
		tt.done = true;
		String sha = m.get("sha").getAsString();
		CompletableFuture.runAsync(() -> {
			try {
				tt.cells = Packed.decode(Packed.payload(tt.frames, sha));
			} catch (Exception e) {
				tt.error = "the preview tile could not be read: " + e.getMessage();
			}
			tt.frames.clear();
			tt.future.complete(tt);
		}, DECODE);
	}

	private static void fail(Tile t, String why) {
		t.error = why;
		t.phase = Phase.FAILED;
	}

	/** {@code region.tile} / {@code region.tile.error} (the link's thread). */
	public static void onMessage(JsonObject m) {
		String type = m.get("type").getAsString();
		if (m.has("preview") && m.get("preview").getAsBoolean()) {
			previewFrame(m, type); // the ghost's tiles: never mixed with a realise of the same plan
			return;
		}
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

	/** (6b) A region's WAITING tiles are asked again (the START_SIDECAR nudge on a connected helper); how many. */
	public static int retryWaiting(String region) {
		int n = 0;
		for (var e : TILES.entrySet()) {
			if (e.getValue().region.equals(region) && e.getValue().phase == Phase.WAITING && TILES.remove(e.getKey(), e.getValue())) {
				n++;
			}
		}
		return n;
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
		if (region == null) {
			PREVIEWS.clear();
		}
	}
}
