package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.region.GenCounter;
import dev.larattalabs.architect.region.Heights;
import dev.larattalabs.architect.region.RegionsImpl;
import dev.larattalabs.architect.region.TileStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * Region tile items in the placement queue (CONTRACT §3): a tile item's chunks (its 80x80 window, at most 6x6) are ticketed
 * under the batch's bound (GENERATED_ONLY by default), its heights frozen (H0), then it is requested from the sidecar,
 * checked (conditions, ownership, trees) over ticks, and written as a CELL entry through {@link InfraJob} (P1-P8). The
 * W tiles after the one being written are frozen and requested ahead (one freeze at a time, sharing the batch's ticket
 * budget), so the writer rarely waits for the sidecar. Waits for NOT_LOADED, NOT_GENERATED and SIDECAR_UNAVAILABLE do not
 * count toward a region item's wait limit. Server thread.
 */
public final class RegionItems {
	/** The batch ext key naming the region (a region's batch). */
	public static final String EXT_REGION = "architect_mc:region";
	/** The item ext key of a tile item ({@code stage|set|tx,tz}). */
	public static final String EXT_TILE = "architect_mc:tile";
	static final Set<Reason> UNCOUNTED = Set.of(Reason.NOT_LOADED, Reason.NOT_GENERATED, Reason.SIDECAR_UNAVAILABLE);

	/** Per tile item: its freeze, whether its heights are on disk, its check. */
	private static final class Pipe {
		Heights.@Nullable Freeze freeze;
		boolean frozen;
		@Nullable TileCheck check;
	}

	private static final Map<String, Pipe> PIPES = new HashMap<>();
	/** Writer starvation (the gate's "no ready tile" share): ticks a region batch had no job and its head tile was not ready. */
	public static long starvedTicks;
	public static long writerTicks;

	private RegionItems() {
	}

	public static boolean isRegion(QBatch b) {
		return b.ext.has(EXT_REGION);
	}

	static @Nullable String regionOf(QBatch b) {
		return isRegion(b) ? b.ext.get(EXT_REGION).getAsString() : null;
	}

	/** The tile item's spec: region, stage, set, key. */
	static String[] tileOf(QItem i) {
		JsonObject s = i.spec;
		return new String[] {s.get("region").getAsString(), s.get("stage").getAsString(), s.get("set").getAsString(), s.get("tile").getAsString()};
	}

	private static Pipe pipe(QBatch b, QItem i) {
		return PIPES.computeIfAbsent(b.id + "/" + i.key, k -> new Pipe());
	}

	/** A tile's window: its columns + 8, over the claim's y range. */
	static Anchors.Bounds window(String key, int[] claim) {
		int[] t = dev.larattalabs.architect.region.Ir.tile(key);
		return new Anchors.Bounds(Heights.TILE * t[0] - Heights.MARGIN, claim[1], Heights.TILE * t[1] - Heights.MARGIN, Heights.TILE * t[0]
			+ Heights.TILE + Heights.MARGIN - 1, claim[4], Heights.TILE * t[1] + Heights.TILE + Heights.MARGIN - 1);
	}

	// ------------------------------------------------------------------ the head: start a tile

	static void tryStartTile(MinecraftServer server, QBatch b, QItem i) {
		String[] t = tileOf(i);
		RegionsImpl.Live r = RegionsImpl.live(t[0]);
		if (r == null) {
			Batches.fail(b, i, Reason.OTHER, "region " + t[0] + " is not loaded");
			return;
		}
		ServerLevel level = r.level(server);
		if (level == null) {
			Batches.fail(b, i, Reason.NOT_LOADED, r.rec().dimension + " is not loaded");
			return;
		}
		Pipe p = pipe(b, i);
		Anchors.Bounds win = window(t[3], r.rec().claim);
		long deadline = Placement.deadline();
		if (!p.frozen || p.check == null) {
			// chunks: the window, under the batch's bound
			if (b.loadChunks > 0 && !i.ticketed) {
				Batches.ticketBox(server, b, i, level, win);
				if (Batches.notGeneratedWait(b, i)) {
					return;
				}
				Map<String, Set<Long>> held = Batches.TICKETS.get(b.id);
				i.ticketed = held != null && held.containsKey(i.key);
				if (!i.ticketed) {
					Batches.waitFor(b, i, Reason.NOT_LOADED, "waiting for the region's chunk budget");
					return;
				}
			}
			if (!Batches.loaded(level, win)) {
				heldWait(b, i, level, win);
				Batches.waitFor(b, i, Reason.NOT_LOADED, "the tile's chunks are not loaded on the server" + (b.loadChunks > 0 ? " yet" : " (walk closer)"));
				return;
			}
			HELD_SINCE.remove(b.id + "/" + i.key);
		}
		if (!p.frozen) {
			int st = freezeStep(r, p, t[3], level, deadline);
			if (st == -1) {
				Batches.waitFor(b, i, Reason.NOT_LOADED, "the tile's chunks are not loaded on the server");
				return;
			}
			if (st == -2) {
				Batches.fail(b, i, Reason.OTHER, "the tile's frozen heights could not be written");
				return;
			}
			if (st == 0) {
				return;
			}
		}
		TileStream.Tile tile = TileStream.get(t[0], t[1], t[2], t[3]);
		if (tile == null) {
			if (!TileStream.available()) {
				Batches.waitFor(b, i, Reason.SIDECAR_UNAVAILABLE, "the helper (sidecar) is not connected");
				return;
			}
			request(r, t);
			return;
		}
		if (tile.phase == TileStream.Phase.FAILED) {
			String why = tile.error == null ? "the tile could not be evaluated" : tile.error;
			TileStream.release(t[0], t[1], t[2], t[3]);
			Batches.fail(b, i, Reason.OTHER, why);
			return;
		}
		if (tile.phase != TileStream.Phase.DECODED) {
			return; // evaluating or decoding: tried again next tick
		}
		if (i.status == QItem.Status.WAITING) {
			i.status = QItem.Status.QUEUED; // it got what it waited for
			i.reason = null;
		}
		if (p.check == null) {
			p.check = new TileCheck(tile.cells(), r.rec().groupId, r.rec().dimension, r.rec().claim, win);
		}
		TileCheck.Result res = p.check.step(level, deadline);
		if (res == null) {
			return;
		}
		p.check = null;
		InfraPlace.Check c = res.check();
		if (!c.ok()) {
			Sites.Refusal ref = c.refusals().get(0);
			if (Batches.TEMPORARY.contains(ref.reason())) {
				Batches.waitFor(b, i, ref.reason(), ref.message());
			} else {
				Batches.fail(b, i, ref.reason(), ref.message());
			}
			return;
		}
		RegionsImpl.tileChecked(t[0], t[1], res.skipped());
		if (c.cells() == 0) {
			// nothing to write here (every cell skipped or already so): done without an entry
			TileStream.release(t[0], t[1], t[2], t[3]);
			PIPES.remove(b.id + "/" + i.key);
			Batches.startStage(server, b, i);
			Batches.placedItem(server, b, i);
			RegionsImpl.tilePlaced(t[0], t[1], t[2], t[3], null, 0);
			return;
		}
		Site.Member member = new Site.Member(b.group, b.id, i.key);
		try {
			InfraJob job = InfraPlace.beginTile(level, dev.larattalabs.architect.site.RegionKinds.of(t[2]), c, b.owner, i.ext, member, res, String.join("|",
				t));
			i.status = QItem.Status.PLACING;
			i.siteId = job.siteId;
			i.reason = null;
			i.message = "";
			Batches.startStage(server, b, i);
			Placement.add(server, job);
			Batches.CHANGED.add(b.id);
		} catch (Sites.SiteException e) {
			if (Batches.TEMPORARY.contains(e.reason())) {
				Batches.waitFor(b, i, e.reason(), e.getMessage());
			} else {
				Batches.fail(b, i, e.reason(), e.getMessage());
			}
		}
	}

	/** Liveness (gate item 4): when a tile item holding its tickets first waited for its (all generated) chunks to load. */
	private static final Map<String, Long> HELD_SINCE = new HashMap<>();
	/** The longest such wait (seconds) and every wait over 10 s with its chunk statuses (dev.region.state). */
	public static double maxHeldWaitSeconds;
	public static final java.util.List<String> LONG_WAITS = new java.util.ArrayList<>();

	private static void heldWait(QBatch b, QItem i, ServerLevel level, Anchors.Bounds win) {
		if (!i.ticketed) {
			return;
		}
		long now = System.currentTimeMillis();
		Long since = HELD_SINCE.putIfAbsent(b.id + "/" + i.key, now);
		if (since == null) {
			return;
		}
		double s = (now - since) / 1000.0;
		maxHeldWaitSeconds = Math.max(maxHeldWaitSeconds, s);
		if (s > 10 && LONG_WAITS.size() < 200 && (LONG_WAITS.isEmpty() || !LONG_WAITS.get(LONG_WAITS.size() - 1).startsWith(i.key + " "))) {
			Map<String, Integer> st = new java.util.TreeMap<>();
			for (long c : Batches.chunks(win)) {
				var ls = level.getChunkSource().chunkMap.getLatestStatus(c);
				st.merge((ls == null ? "none" : ls.getName()) + (level.hasChunk(net.minecraft.world.level.ChunkPos.getX(c), net.minecraft.world.level.ChunkPos
					.getZ(c)) ? "+loaded" : ""), 1, Integer::sum);
			}
			LONG_WAITS.add(i.key + " " + String.format(java.util.Locale.ROOT, "%.0f", s) + " s " + st);
		}
	}

	/** One slice of a tile's freeze; on H0 the RG3 kill point. 1 done, 0 more, -1 not loaded, -2 failed. */
	private static int freezeStep(RegionsImpl.Live r, Pipe p, String key, ServerLevel level, long deadline) {
		if (p.freeze == null) {
			Anchors.Bounds w = window(key, r.rec().claim);
			p.freeze = new Heights.Freeze(r.world(), r.rec().id, w.minX(), w.minZ(), w.maxX(), w.maxZ());
		}
		int st = p.freeze.step(level, deadline);
		if (st == 1) {
			p.frozen = true;
			p.freeze = null;
			WorldJournal.kill("RG3"); // heights on disk, nothing of the tile written yet
		}
		return st;
	}

	private static void request(RegionsImpl.Live r, String[] t) {
		int[] k = dev.larattalabs.architect.region.Ir.tile(t[3]);
		dev.larattalabs.architect.region.Columns w = Heights.window(r.world(), r.rec().id, k[0], k[1]);
		if (w == null) {
			Architect.LOGGER.warn("Region {}: tile {} has unfrozen columns after its freeze", r.rec().id, t[3]);
			return;
		}
		TileStream.request(t[0], r.rec().planId, r.rec().irSha, x -> r.irJson(), t[1], t[2], t[3], w.encode());
	}

	// ------------------------------------------------------------------ ahead of the writer

	/**
	 * Per tick, for a running region batch: freezes and requests the next W tile items after the head (in queue order), one
	 * freeze at a time. Under a ticket-holding policy a freeze takes the window's tickets from the batch's bound under the
	 * key {@code freeze:<item>} and gives them back once the heights are on disk.
	 */
	static void ahead(MinecraftServer server, QBatch b, @Nullable String runningStage) {
		String region = regionOf(b);
		if (region == null || runningStage == null) {
			return;
		}
		RegionsImpl.Live r = RegionsImpl.live(region);
		if (r == null) {
			return;
		}
		ServerLevel level = r.level(server);
		if (level == null) {
			return;
		}
		writerTicks++;
		boolean jobRunning = b.items.stream().anyMatch(x -> x.status == QItem.Status.PLACING && !x.committing);
		int w = RegionsImpl.window();
		List<QItem> next = new ArrayList<>();
		for (QItem i : b.items) {
			if (!"tile".equals(i.itemKind) || i.status == QItem.Status.PLACED || i.status == QItem.Status.FAILED || i.status == QItem.Status.PLACING) {
				continue;
			}
			next.add(i);
			if (next.size() > w) {
				break;
			}
		}
		if (!jobRunning && !next.isEmpty()) {
			String[] t = tileOf(next.get(0));
			TileStream.Tile tile = TileStream.get(t[0], t[1], t[2], t[3]);
			if (tile == null || tile.phase != TileStream.Phase.DECODED) {
				starvedTicks++;
			}
		}
		long deadline = Placement.deadline();
		boolean freezing = false;
		for (int n = 1; n < next.size(); n++) {
			QItem i = next.get(n);
			String[] t = tileOf(i);
			Pipe p = pipe(b, i);
			if (p.frozen) {
				if (TileStream.get(t[0], t[1], t[2], t[3]) == null && TileStream.available() && TileStream.outstanding(region) < w) {
					request(r, t);
				}
				continue;
			}
			if (freezing) {
				break; // one freeze at a time
			}
			freezing = true;
			Anchors.Bounds win = window(t[3], r.rec().claim);
			String fk = "freeze:" + i.key;
			if (b.loadChunks > 0) {
				Map<String, Set<Long>> held = Batches.TICKETS.computeIfAbsent(b.id, x -> new HashMap<>());
				if (!held.containsKey(fk) && Batches.hasWaiter(b)) {
					break; // an item waits for the budget: it goes first
				}
				if (!held.containsKey(fk)) {
					Set<Long> want = Batches.chunks(win);
					int count = held.values().stream().mapToInt(Set::size).sum();
					if (count + want.size() > b.loadChunks) {
						break; // the writer's budget first
					}
					if (!b.generate) {
						boolean ok = true;
						for (long c : want) {
							if (dev.larattalabs.architect.region.ChunkGen.state(level, c) != dev.larattalabs.architect.region.ChunkGen.State.GENERATED) {
								ok = false;
								break;
							}
						}
						if (!ok) {
							break;
						}
					}
					ChunkTickets.acquire(i.dimension, want, Batches.source(level));
					held.put(fk, want);
					Batches.levels.put(b.id + "/" + fk, i.dimension);
				}
			}
			if (!Batches.loaded(level, win)) {
				break;
			}
			int st = freezeStep(r, p, t[3], level, deadline);
			if (st == 1) {
				Batches.untickItem(server, b, fk);
				if (TileStream.available() && TileStream.outstanding(region) < w) {
					request(r, t);
				}
			}
			break;
		}
		GenCounter.holders(Batches.TICKETS.getOrDefault(b.id, Map.of()).isEmpty() ? 0 : 1);
	}

	/** A region item's wait for these reasons does not count toward its wait limit (CONTRACT "Waiting without a time limit"). */
	static boolean uncounted(QBatch b, Reason why) {
		return isRegion(b) && UNCOUNTED.contains(why);
	}

	/** The item is gone (placed, failed, cancelled): its pipe and any streamed cells go. */
	static void forget(QBatch b, QItem i) {
		PIPES.remove(b.id + "/" + i.key);
		if ("tile".equals(i.itemKind) && i.spec != null) {
			String[] t = tileOf(i);
			TileStream.release(t[0], t[1], t[2], t[3]);
		}
	}

	/** Whether a site (tile, road or lot) belongs to a region's group. */
	static boolean inRegion(String siteId) {
		String g = null;
		Infra in = Infras.get(siteId);
		if (in != null) {
			g = in.group();
		} else {
			Site s = Sites.get(siteId);
			g = s == null ? null : s.group();
		}
		SiteGroupRec rec = g == null ? null : Sites.group(g);
		return rec != null && rec.ext().has(EXT_REGION);
	}

	public static void reset() {
		PIPES.clear();
		HELD_SINCE.clear();
		LONG_WAITS.clear();
		maxHeldWaitSeconds = 0;
		starvedTicks = 0;
		writerTicks = 0;
	}

}
