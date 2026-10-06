package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.TerrainFit;
import it.unimi.dsi.fastutil.ints.IntArrays;
import it.unimi.dsi.fastutil.longs.Long2IntOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * A large cell site's checks (phase 4e: a 256x256 terrain pad is 655k cells; the gate allows no tick over 50 ms) spread
 * over ticks: the request is decoded, de-duplicated, sorted lowest first and turned into journal values off the server
 * thread; the natural-terrain filter reads the world under the placement budget, section by section of the sorted cells;
 * the per-cell overlap test reads only the sections the journal has entries in. The result is {@link InfraPlace#checkCells}'s,
 * in the order {@link InfraJob#plan} writes (it does not sort again).
 */
final class CellsCheck {
	/** Cell items above this many cells check like this; smaller ones at once. */
	static final int LARGE = 50_000;

	private record Prep(long[] pos, Value[] values, Anchors.Bounds box, @Nullable String refusal, @Nullable Reason reason) {
	}

	private final String kind;
	private final Journal.Policy policy;
	private final boolean naturalOnly;
	private final boolean layer;
	private final @Nullable String owner;
	private final boolean force;
	private final CompletableFuture<Prep> prep;
	private boolean[] keep;
	private int cursor;
	private int skipped;
	private InfraPlace.@Nullable Check result;

	CellsCheck(JsonObject spec, String kind, Journal.Policy policy, boolean naturalOnly, boolean layer, @Nullable String owner, boolean force, int minY,
		int maxY) {
		this.kind = kind;
		this.policy = policy;
		this.naturalOnly = naturalOnly;
		this.layer = layer;
		this.owner = owner;
		this.force = force;
		this.prep = CompletableFuture.supplyAsync(() -> prepare(spec, minY, maxY));
	}

	/** Whether the spec has more cells than {@link #LARGE}. */
	static boolean large(JsonObject spec) {
		return spec.has("pos") && spec.get("pos").getAsString().length() / 4 * 3 / 8 > LARGE;
	}

	private static Prep prepare(JsonObject spec, int minY, int maxY) {
		InfraSpec.Cells c = InfraSpec.cellsOf(spec);
		int n = c.pos().size();
		Anchors.Bounds none = new Anchors.Bounds(0, 0, 0, 0, 0, 0);
		if (n > InfraPlace.MAX_CELLS) {
			return new Prep(new long[0], new Value[0], none, n + " cells (at most " + InfraPlace.MAX_CELLS + " per request: split it into several requests of one group)",
				Reason.TOO_LARGE);
		}
		// de-duplicated: the last write of a position wins
		Long2IntOpenHashMap last = new Long2IntOpenHashMap(n);
		for (int i = 0; i < n; i++) {
			last.put(c.pos().get(i).asLong(), i);
		}
		int[] idx = last.values().toIntArray();
		long[] posOf = new long[n];
		for (int i = 0; i < n; i++) {
			posOf[i] = c.pos().get(i).asLong();
		}
		IntArrays.quickSort(idx, (a, b) -> {
			long pa = posOf[a];
			long pb = posOf[b];
			int r = Integer.compare(Journal.y(pa), Journal.y(pb));
			if (r != 0) {
				return r;
			}
			r = Integer.compare(Journal.x(pa), Journal.x(pb));
			return r != 0 ? r : Integer.compare(Journal.z(pa), Journal.z(pb));
		});
		long[] ps = new long[idx.length];
		Value[] vs = new Value[idx.length];
		int[] bb = {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE};
		Map<BlockState, Value> byState = new HashMap<>();
		for (int k = 0; k < idx.length; k++) {
			int i = idx[k];
			long p = posOf[i];
			int y = Journal.y(p);
			if (y < minY || y > maxY) {
				return new Prep(new long[0], new Value[0], none, "cell " + Journal.x(p) + "," + y + "," + Journal.z(p) + " is outside the build height",
					Reason.BUILD_HEIGHT);
			}
			ps[k] = p;
			Value v = byState.computeIfAbsent(c.states().get(i), WorldJournal::value);
			CompoundTag t = c.nbt().get(i);
			vs[k] = t == null ? v : v.withNbt(t);
			bb[0] = Math.min(bb[0], Journal.x(p));
			bb[1] = Math.min(bb[1], y);
			bb[2] = Math.min(bb[2], Journal.z(p));
			bb[3] = Math.max(bb[3], Journal.x(p));
			bb[4] = Math.max(bb[4], y);
			bb[5] = Math.max(bb[5], Journal.z(p));
		}
		return new Prep(ps, vs, new Anchors.Bounds(bb[0], bb[1], bb[2], bb[3], bb[4], bb[5]), null, null);
	}

	/** The cells' box once prepared (for the chunk tickets), else null. */
	Anchors.@Nullable Bounds box() {
		return prep.isDone() && !prep.isCompletedExceptionally() ? prep.join().box() : null;
	}

	/** Works until {@code deadline}; the check once done, else null. Server thread. */
	InfraPlace.@Nullable Check step(ServerLevel level, long deadline) {
		if (result != null) {
			return result;
		}
		if (!prep.isDone()) {
			return null;
		}
		Prep p;
		try {
			p = prep.join();
		} catch (RuntimeException e) {
			return result = refused(Reason.OTHER, "the cells could not be read (" + e.getMessage() + ")");
		}
		if (p.refusal() != null) {
			return result = refused(p.reason(), p.refusal());
		}
		if (p.pos().length == 0) {
			return result = refused(Reason.OTHER, "no cells");
		}
		if (!kind.contains(":")) {
			return result = refused(Reason.OTHER, "a cell site's kind is namespaced (<modid>:<kind>), got " + kind);
		}
		String why = WorldJournal.unavailable();
		if (why != null) {
			return result = refused(Reason.JOURNAL_UNAVAILABLE, why);
		}
		if (keep == null) {
			keep = new boolean[p.pos().length];
		}
		// the natural-terrain filter over ticks (the cells are sorted lowest row first: one chunk lookup per run of a column)
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		LevelChunk chunk = null;
		long chunkAt = Long.MIN_VALUE;
		int n = 0;
		while (cursor < p.pos().length) {
			if ((n++ & 1023) == 0 && n > 1 && System.nanoTime() >= deadline) {
				return null;
			}
			long q = p.pos()[cursor];
			int x = Journal.x(q);
			int z = Journal.z(q);
			long ck = net.minecraft.world.level.ChunkPos.pack(x >> 4, z >> 4);
			if (ck != chunkAt) {
				chunkAt = ck;
				chunk = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
			}
			if (chunk == null) {
				return result = refused(Reason.NOT_LOADED, "the cell site is not loaded at " + x + ", " + z + " (walk closer)");
			}
			boolean ok = true;
			if (naturalOnly) {
				BlockState s = chunk.getBlockState(m.set(x, Journal.y(q), z));
				int f = TerrainFit.flags(s);
				ok = (f & TerrainFit.BLOCK_ENTITY) == 0 && (s.isAir() || (f & TerrainFit.NATURAL) != 0 || (f & TerrainFit.WATER) != 0
					|| (f & TerrainFit.TREE) != 0);
			}
			keep[cursor] = ok;
			if (!ok) {
				skipped++;
			}
			cursor++;
		}
		return result = finish(level, p);
	}

	private InfraPlace.Check finish(ServerLevel level, Prep p) {
		List<String> notes = new ArrayList<>();
		if (skipped > 0) {
			notes.add(skipped + " cell" + (skipped == 1 ? "" : "s") + " not natural terrain left as they are (naturalOnly)");
		}
		int kept = p.pos().length - skipped;
		if (kept == 0) {
			return new InfraPlace.Check(List.of(new Sites.Refusal(Reason.OTHER, "every cell was skipped (naturalOnly)")), notes, new long[0], new Value[0], null,
				List.of(), null);
		}
		long[] ps = new long[kept];
		Value[] vs = new Value[kept];
		for (int i = 0, k = 0; i < p.pos().length; i++) {
			if (keep[i]) {
				ps[k] = p.pos()[i];
				vs[k++] = p.values()[i];
			}
		}
		// overlap per cell, only in the sections the journal has entries in
		String dim = Sites.dimensionId(level);
		JournalStore js = WorldJournal.storeOrNull();
		Set<Long> occupied = js.sectionsOf(dim);
		Map<Long, List<Long>> bySec = new HashMap<>();
		if (!occupied.isEmpty()) {
			LongOpenHashSet occ = new LongOpenHashSet(occupied.size());
			occupied.forEach(occ::add);
			for (long q : ps) {
				long key = Sections.key(q);
				if (occ.contains(key)) {
					bySec.computeIfAbsent(key, k -> new ArrayList<>()).add(q);
				}
			}
		}
		Map<String, Integer> over = new LinkedHashMap<>();
		Map<String, Journal.Status> status = new HashMap<>();
		int deepest = 0;
		for (var e : bySec.entrySet()) {
			Map<Integer, Integer> depth = new HashMap<>();
			for (String id : js.inSection(dim, e.getKey())) {
				JournalStore.Meta mm = js.meta(id);
				if (mm == null || !mm.active() || mm.kind().equals(WorldJournal.LEAVES)) {
					continue;
				}
				SectionCells sc;
				try {
					sc = js.section(id, e.getKey());
				} catch (IOException ex) {
					return refused(Reason.JOURNAL_UNAVAILABLE, ex.getMessage());
				}
				if (sc == null) {
					continue;
				}
				for (long q : e.getValue()) {
					int idx = Sections.index(q);
					if (sc.has(idx)) {
						over.merge(mm.site(), 1, Integer::sum);
						status.merge(mm.site(), mm.status(), (a, b) -> a == Journal.Status.PLACING ? a : b);
						depth.merge(idx, 1, Integer::sum);
					}
				}
			}
			for (int d : depth.values()) {
				deepest = Math.max(deepest, d);
			}
		}
		List<SiteJournal.Hit> hits = new ArrayList<>();
		over.forEach((s, c) -> hits.add(new SiteJournal.Hit(s, "", "", Journal.Policy.BOX, status.get(s), c, 0)));
		InfraPlace.Check refusal = InfraPlace.overlapRefusal(over, status, deepest, layer, owner, force, notes, hits);
		if (refusal != null) {
			return refusal;
		}
		JsonObject spec = new JsonObject();
		spec.addProperty("kind", kind);
		spec.addProperty("policy", policy.name());
		spec.addProperty("cells", ps.length);
		spec.addProperty("naturalOnly", naturalOnly);
		Anchors.Bounds b = p.box();
		return new InfraPlace.Check(List.of(), notes, ps, vs, b, hits, spec);
	}

	private static InfraPlace.Check refused(Reason r, String why) {
		return new InfraPlace.Check(List.of(new Sites.Refusal(r, why)), List.of(), new long[0], new Value[0], null, List.of(), null);
	}
}
