package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.LandReport;
import dev.larattalabs.architect.api.LotLand;
import dev.larattalabs.architect.api.PartLand;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placed.Placed;
import dev.larattalabs.architect.site.Infra;
import dev.larattalabs.architect.site.Infras;
import dev.larattalabs.architect.site.RealisedRecords;
import dev.larattalabs.architect.site.RegionKinds;
import dev.larattalabs.architect.site.RegionTargets;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.Sites;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * (6d LC, docs/CONTRACT.md "Phase 6d slice LC") {@code Regions.landCheck}: a standing region's land against what it wrote, part by part and
 * lot by lot. Reads only: the journal (the region group's ACTIVE entries, the writer on top per cell), the realised records (RP: a tile
 * cell's part is its winning op's IR part, ARWR), the world through loaded chunks only (never a load or a ticket) and PT's records. Sliced
 * over server ticks at the queue's budget (8 ms per tick). Nothing is written anywhere.
 *
 * <p>Attribution of a tile cell without the payload (the record stores codes in payload order, no positions): the tile's entry cells are
 * exactly its WRITTEN cells plus its TREE and DEPENDENT extras (RP's verify invariant), so the entry cells less the extras, sorted in
 * ARTL payload order (chunk x, chunk z, section y, then {@code y<<8 | z<<4 | x} within the section), are the WRITTEN cells in payload
 * order; the k-th is the k-th WRITTEN code's payload index, whose winning op names the part. An extra takes its cause's part. When the
 * counts disagree (a record realised before writers, a survival tile whose targets marked cells WRITTEN) the tile's cells are
 * {@link #UNATTRIBUTED}.
 */
public final class LandCheck {
	/** The cells one call reads at most. */
	public static final long MAX_CELLS = 4_000_000L;
	/** A tick's budget (the queue's). */
	static final long BUDGET_NS = 8_000_000L;
	/** The part of a cell no record attributes. */
	public static final String UNATTRIBUTED = "unattributed";
	static final int SAMPLE = 16;
	/** A gate mechanism cell site's entry kind (GM-a: {@code mech:<lot>}, kind architect:mechanism). */
	static final String MECH_KIND = "architect:mechanism";
	/** GM §4 item 4: the dynamic properties of a gate mechanism's blocks, never judged. */
	static final Set<String> DYNAMIC = Set.of("extended", "powered", "power", "open", "short", "locked");

	/** A changed cell's class (each changed cell in exactly one). */
	public enum Cls { SAME, REMOVED, PLAYER, VOLATILE, CHANGED }

	private LandCheck() {
	}

	// ------------------------------------------------------------------ pure: the payload order and the writers

	/** ARTL's payload order of positions (chunk x, chunk z, section y, then y, z, x within the section). */
	public static int artlCompare(long a, long b) {
		int ax = BlockPos.getX(a), ay = BlockPos.getY(a), az = BlockPos.getZ(a);
		int bx = BlockPos.getX(b), by = BlockPos.getY(b), bz = BlockPos.getZ(b);
		int c = Integer.compare(ax >> 4, bx >> 4);
		if (c != 0) {
			return c;
		}
		c = Integer.compare(az >> 4, bz >> 4);
		if (c != 0) {
			return c;
		}
		c = Integer.compare(ay >> 4, by >> 4);
		if (c != 0) {
			return c;
		}
		return Integer.compare((ay & 15) << 8 | (az & 15) << 4 | (ax & 15), (by & 15) << 8 | (bz & 15) << 4 | (bx & 15));
	}

	/** The positions sorted in ARTL payload order (a copy). */
	public static long[] artlSorted(long[] pos) {
		Long[] b = new Long[pos.length];
		for (int i = 0; i < pos.length; i++) {
			b[i] = pos[i];
		}
		java.util.Arrays.sort(b, LandCheck::artlCompare);
		long[] out = new long[b.length];
		for (int i = 0; i < b.length; i++) {
			out[i] = b[i];
		}
		return out;
	}

	/**
	 * The winning op's IR part id of every payload cell of ARWR v1 writers ({@code kit/lib/realise.mjs encodeWriters}), or null when they
	 * can't be read or cover another cell count than {@code nCells}.
	 */
	public static String @Nullable [] winners(byte @Nullable [] w, int nCells) {
		if (w == null || w.length < 5 || w[0] != 'A' || w[1] != 'R' || w[2] != 'W' || w[3] != 'R' || w[4] != 1) {
			return null;
		}
		try {
			Realised.In in = new Realised.In(w, 5, w.length);
			int ops = (int) in.varint();
			String[] part = new String[ops];
			for (int i = 0; i < ops; i++) {
				part[i] = in.str();
				in.varint();
				in.varint();
				in.u8();
			}
			int cells = (int) in.varint();
			if (cells != nCells) {
				return null;
			}
			String[] out = new String[cells];
			int runs = (int) in.varint();
			int at = 0;
			for (int r = 0; r < runs; r++) {
				int op = (int) in.varint();
				int len = (int) in.varint();
				if (op < 0 || op >= ops || at + len > cells) {
					return null;
				}
				java.util.Arrays.fill(out, at, at + len, part[op]);
				at += len;
			}
			return at == cells ? out : null;
		} catch (IOException | RuntimeException e) {
			return null;
		}
	}

	/**
	 * A tile record's cells by part: {@code entryCells} (the union of its main entries' cells) less its TREE and DEPENDENT extras are its
	 * WRITTEN cells in payload order; the extras (and LEAF extras, the leaves entry's) take their cause's part (unknown: {@link
	 * #UNATTRIBUTED}). Null when the counts disagree or the writers can't be read: the caller counts the tile's cells unattributed.
	 */
	public static @Nullable Map<Long, String> partMap(Realised.Tile rec, LongOpenHashSet entryCells) {
		String[] parts = winners(rec.writers(), rec.codes().length);
		if (parts == null) {
			return null;
		}
		LongOpenHashSet extra = new LongOpenHashSet();
		for (Realised.Extra e : rec.extras()) {
			if (e.kind() != Realised.LEAF) {
				extra.add(e.pos());
			}
		}
		LongArrayList written = new LongArrayList();
		for (long p : entryCells) {
			if (!extra.contains(p)) {
				written.add(p);
			}
		}
		int[] idx = new int[rec.codes().length];
		int n = 0;
		for (int i = 0; i < rec.codes().length; i++) {
			if (rec.codes()[i] == Realised.WRITTEN) {
				idx[n++] = i;
			}
		}
		if (n != written.size()) {
			return null;
		}
		long[] sorted = artlSorted(written.toLongArray());
		Map<Long, String> out = new HashMap<>();
		for (int k = 0; k < n; k++) {
			out.put(sorted[k], parts[idx[k]]);
		}
		for (Realised.Extra e : rec.extras()) {
			out.putIfAbsent(e.pos(), e.cause() >= 0 && e.cause() < parts.length ? parts[e.cause()] : UNATTRIBUTED);
		}
		return out;
	}

	// ------------------------------------------------------------------ pure: the classes

	/** Leaves, snow, plants and fluids: kinds the world changes by itself. */
	public static boolean volatileKind(BlockState s) {
		Block b = s.getBlock();
		return b instanceof net.minecraft.world.level.block.LeavesBlock || b instanceof net.minecraft.world.level.block.SnowLayerBlock
			|| b instanceof net.minecraft.world.level.block.VegetationBlock || b instanceof net.minecraft.world.level.block.BushBlock
			|| b instanceof net.minecraft.world.level.block.LiquidBlock
			|| b instanceof net.minecraft.world.level.block.BubbleColumnBlock || b instanceof net.minecraft.world.level.block.SugarCaneBlock
			|| b instanceof net.minecraft.world.level.block.VineBlock || b instanceof net.minecraft.world.level.block.CactusBlock
			|| b instanceof net.minecraft.world.level.block.GrowingPlantBlock || b instanceof net.minecraft.world.level.block.BambooStalkBlock
			|| b instanceof net.minecraft.world.level.block.BaseFireBlock || b == Blocks.ICE || b == Blocks.FROSTED_ICE || b == Blocks.POWDER_SNOW;
	}

	private static boolean pistonPart(BlockState s) {
		return s.is(Blocks.PISTON) || s.is(Blocks.STICKY_PISTON) || s.is(Blocks.PISTON_HEAD) || s.is(Blocks.MOVING_PISTON);
	}

	/**
	 * (GM §4 item 4) A gate mechanism's cell still holds what was written: the same block with only dynamic properties changed, or a
	 * moving piston where a piston or its head belongs (and a retracted head's air, its moving piston's cell).
	 */
	public static boolean mechHolds(BlockState now, BlockState want) {
		if (now.getBlock() == want.getBlock()) {
			for (Property<?> p : now.getProperties()) {
				if (!DYNAMIC.contains(p.getName()) && !dev.larattalabs.architect.journal.StillOurs.volatileProperty(now, p.getName()) && !now.getValue(p).equals(want
					.getValue(p))) {
					return false;
				}
			}
			return true;
		}
		if (pistonPart(want)) {
			return now.is(Blocks.MOVING_PISTON) || (want.is(Blocks.PISTON_HEAD) || want.is(Blocks.MOVING_PISTON)) && (now.isAir() || now.is(Blocks.PISTON_HEAD));
		}
		return want.isAir() && (now.is(Blocks.MOVING_PISTON) || now.is(Blocks.PISTON_HEAD));
	}

	/**
	 * A region cell's class, the cell written as {@code after}: SAME when the world still holds it ({@link WorldJournal#holdsOurs}, the
	 * undo's rule: volatile properties, copper and coral, spread, fluids in cleared air, a player's record over an equivalence wins), or,
	 * in a gate mechanism ({@code mech}), {@link #mechHolds}. Else PLAYER when a player's record is there now; VOLATILE when a volatile
	 * kind was written; REMOVED when air or a fluid stands there now; VOLATILE when a volatile kind stands there now; else CHANGED.
	 */
	public static Cls classify(BlockState now, Supplier<@Nullable CompoundTag> nowNbt, boolean playerRecord, Journal.Value after, boolean mech) {
		if (WorldJournal.holdsOurs(now, nowNbt, () -> playerRecord, after)) {
			return Cls.SAME;
		}
		BlockState want = WorldJournal.state(after);
		if (mech && mechHolds(now, want)) {
			return Cls.SAME;
		}
		if (playerRecord) {
			return Cls.PLAYER;
		}
		if (volatileKind(want)) {
			return Cls.VOLATILE;
		}
		if (now.isAir() || now.getBlock() instanceof net.minecraft.world.level.block.LiquidBlock) {
			return Cls.REMOVED;
		}
		return volatileKind(now) ? Cls.VOLATILE : Cls.CHANGED;
	}

	/**
	 * A region cell's class with the gate mechanism's rule: a moving or trigger cell of a mechanism ({@code mechMoving}, {@link
	 * #mechVolatile}) is never judged for its state (open, closed, mid-move: GM §4 item 4), but a block a player placed there is still the
	 * player's (§2: a PT record is {@link Cls#PLAYER}; LCi, a player's block in an open lane), judged as {@link #classify} does.
	 */
	public static Cls classifyCell(BlockState now, Supplier<@Nullable CompoundTag> nowNbt, boolean playerRecord, Journal.Value after, boolean mech,
		boolean mechMoving) {
		return classifyCell(now, nowNbt, playerRecord, after, mech, mechMoving, false);
	}

	/**
	 * (SA, A47; LCi finding 2, Steward yes 2026-11-11) As {@link #classifyCell(BlockState, Supplier, boolean, Journal.Value, boolean, boolean)},
	 * and a mechanism's trigger cell ({@code triggers[].at}, {@link #mechTriggers}): its state stays excused (a lever pulled, a button
	 * pressed), but a written trigger block gone (air or a fluid there now) is {@link Cls#REMOVED}. Lanes and rungs stay excused: an empty
	 * lane can't be told from an open gate.
	 */
	public static Cls classifyCell(BlockState now, Supplier<@Nullable CompoundTag> nowNbt, boolean playerRecord, Journal.Value after, boolean mech,
		boolean mechMoving, boolean trigger) {
		if (trigger && !playerRecord && !WorldJournal.state(after).isAir()
			&& (now.isAir() || now.getBlock() instanceof net.minecraft.world.level.block.LiquidBlock)) {
			return Cls.REMOVED;
		}
		return mechMoving && !playerRecord ? Cls.SAME : classify(now, nowNbt, playerRecord, after, mech);
	}

	/** (SA, A47) Every gate mechanism's trigger cells ({@code triggers[].at}, not its rungs) in an IR: a subset of {@link #mechVolatile}. */
	public static LongOpenHashSet mechTriggers(JsonObject ir) {
		LongOpenHashSet vol = new LongOpenHashSet();
		LongOpenHashSet out = new LongOpenHashSet();
		walk(ir, null, vol, out, 0);
		return out;
	}

	/**
	 * (GM, PG rule 6) Every gate mechanism's moving and trigger cells in an IR (any {@code mechanism} object's {@code states} runs
	 * [x, z, y0, y1]... and {@code triggers[].at} / {@code rungs}): a player who flips its lever has not changed the land.
	 */
	public static LongOpenHashSet mechVolatile(JsonObject ir) {
		LongOpenHashSet out = new LongOpenHashSet();
		walk(ir, null, out, new LongOpenHashSet(), 0);
		return out;
	}

	private static void walk(JsonElement e, @Nullable String key, LongOpenHashSet out, LongOpenHashSet triggers, int depth) {
		if (depth > 24) {
			return;
		}
		if (e instanceof JsonArray a) {
			for (JsonElement x : a) {
				if (x.isJsonObject() || x.isJsonArray()) {
					walk(x, null, out, triggers, depth + 1);
				}
			}
			return;
		}
		if (!(e instanceof JsonObject o)) {
			return;
		}
		if ("mechanism".equals(key)) {
			if (o.get("states") instanceof JsonObject st) {
				for (var se : st.entrySet()) {
					if (se.getValue() instanceof JsonArray r) {
						runs(r, out);
					}
				}
			}
			if (o.get("triggers") instanceof JsonArray ts) {
				for (JsonElement te : ts) {
					if (te instanceof JsonObject t) {
						point(t.get("at"), out);
						point(t.get("at"), triggers);
						if (t.get("rungs") instanceof JsonArray rs) {
							rs.forEach(r -> point(r, out));
						}
					}
				}
			}
		}
		for (var c : o.entrySet()) {
			if (c.getValue().isJsonObject() || c.getValue().isJsonArray()) {
				walk(c.getValue(), c.getKey(), out, triggers, depth + 1);
			}
		}
	}

	private static void runs(JsonArray a, LongOpenHashSet out) {
		try {
			for (int i = 0; i + 3 < a.size(); i += 4) {
				int x = a.get(i).getAsInt(), z = a.get(i + 1).getAsInt();
				for (int y = a.get(i + 2).getAsInt(); y <= a.get(i + 3).getAsInt(); y++) {
					out.add(BlockPos.asLong(x, y, z));
				}
			}
		} catch (RuntimeException ignored) {
			// not a run list
		}
	}

	private static void point(@Nullable JsonElement e, LongOpenHashSet out) {
		if (e instanceof JsonArray p && p.size() >= 3) {
			try {
				out.add(BlockPos.asLong(p.get(0).getAsInt(), p.get(1).getAsInt(), p.get(2).getAsInt()));
			} catch (RuntimeException ignored) {
				// not a point
			}
		}
	}

	// ------------------------------------------------------------------ the call

	/** Who holds a cell on top: a part (tiles: per cell), a lot, or nothing to count yet (a writer still building). */
	private record Owner(int kind, @Nullable String name, @Nullable Map<Long, String> parts, boolean mech,
		dev.larattalabs.architect.site.@Nullable FieldCells field) {
		Owner(int kind, @Nullable String name, @Nullable Map<Long, String> parts, boolean mech) {
			this(kind, name, parts, mech, null);
		}
		static final int PART = 0, TILE = 1, LOT = 2, SKIP = 3;
	}

	private static final class Acc {
		long cells, changed, removed, player, vol;
		final Map<String, Long> kinds = new TreeMap<>();
		final List<BlockPos> sample = new ArrayList<>();
	}

	private static final class Job {
		final ServerLevel level;
		final RegionsImpl.Live l;
		final @Nullable String part;
		final JournalStore js;
		final List<Long> sections;
		final Set<String> ours = new java.util.HashSet<>();
		final Map<String, String> lotOfSite = new HashMap<>();
		final Map<String, String> roadOfSite = new HashMap<>();
		final Map<String, Owner> owners = new HashMap<>();
		final LongOpenHashSet mechVol;
		final LongOpenHashSet mechTrig;
		final Map<String, Acc> parts = new TreeMap<>();
		final Map<String, long[]> lots = new LinkedHashMap<>();
		final CompletableFuture<LandReport> future = new CompletableFuture<>();
		final long t0 = System.nanoTime();
		int at;
		long checked, unloaded, counted;

		Job(ServerLevel level, RegionsImpl.Live l, @Nullable String part, JournalStore js, List<Long> sections) {
			this.level = level;
			this.l = l;
			this.part = part;
			this.js = js;
			this.sections = sections;
			this.mechVol = mechVolatile(l.ir().json());
			this.mechTrig = mechTriggers(l.ir().json());
		}
	}

	private static final List<Job> JOBS = new ArrayList<>();

	/** Starts a land check (server thread); see {@code Regions.landCheck}. */
	public static CompletableFuture<LandReport> start(MinecraftServer server, String regionId, @Nullable String part) {
		RegionsImpl.Live l = RegionsImpl.live(regionId);
		if (l == null) {
			return CompletableFuture.failedFuture(RegionsImpl.refusal(Reason.OTHER, "no region " + regionId));
		}
		RegionRec rec = l.rec();
		if (rec.state == dev.larattalabs.architect.api.RegionState.REMOVED || rec.state == dev.larattalabs.architect.api.RegionState.REMOVING) {
			return CompletableFuture.failedFuture(RegionsImpl.refusal(Reason.NOT_ALLOWED, "region " + regionId + " is " + rec.state));
		}
		ServerLevel level = l.level(server);
		JournalStore js = WorldJournal.storeOrNull();
		if (level == null || js == null) {
			return CompletableFuture.failedFuture(RegionsImpl.refusal(Reason.JOURNAL_UNAVAILABLE, "the journal or the region's dimension is not available"));
		}
		String group = rec.groupId;
		List<JournalStore.Meta> mine = js.find(m -> group != null && !group.isEmpty() && group.equals(m.group()) && m.status() == Journal.Status.ACTIVE
			&& rec.dimension.equals(m.dimension()));
		long total = 0;
		TreeSet<Long> secs = new TreeSet<>();
		for (JournalStore.Meta m : mine) {
			total += m.cells();
			for (long k : m.sections()) {
				secs.add(k);
			}
		}
		if (part == null && total > MAX_CELLS) {
			return CompletableFuture.failedFuture(RegionsImpl.refusal(Reason.REGION_LIMIT, "region " + regionId + " holds " + total + " journal cells, over "
				+ MAX_CELLS + " per land check: ask per part"));
		}
		Job j = new Job(level, l, part, js, new ArrayList<>(secs));
		mine.forEach(m -> j.ours.add(m.id()));
		rec.lots.forEach((id, ls) -> {
			if (ls.siteId != null) {
				j.lotOfSite.put(ls.siteId, id);
			}
		});
		List<Integer> layers = new ArrayList<>(List.of(0));
		for (var rv : rec.revisions) {
			layers.add(rv.rid);
		}
		for (int layer : layers) {
			JsonObject sj = Realised.sites(l.world(), rec.id, layer);
			if (sj != null && sj.get("roads") instanceof JsonObject roads) {
				for (var e : roads.entrySet()) {
					if (e.getValue() instanceof JsonObject ro && ro.get("site") != null && ro.get("site").isJsonPrimitive()) {
						j.roadOfSite.put(ro.get("site").getAsString(), e.getKey());
					}
				}
			}
		}
		JOBS.add(j);
		return j.future;
	}

	/** Runs the checks' next sections within the tick's budget (RegionsImpl's tick). */
	public static void tick(MinecraftServer server) {
		if (JOBS.isEmpty()) {
			return;
		}
		long end = System.nanoTime() + BUDGET_NS;
		while (!JOBS.isEmpty() && System.nanoTime() < end) {
			Job j = JOBS.get(0);
			try {
				while (j.at < j.sections.size() && System.nanoTime() < end) {
					section(j, j.sections.get(j.at++));
					if (j.part != null && j.counted > MAX_CELLS) {
						throw RegionsImpl.refusal(Reason.REGION_LIMIT, "part " + j.part + " holds over " + MAX_CELLS + " cells");
					}
				}
				if (j.at >= j.sections.size()) {
					JOBS.remove(0);
					j.future.complete(finish(server, j));
				}
			} catch (Exception e) {
				JOBS.remove(0);
				Architect.LOGGER.warn("land check of {}: {}", j.l.rec().id, e.toString());
				j.future.completeExceptionally(e);
			}
		}
	}

	private static void section(Job j, long key) throws IOException {
		String dim = j.l.rec().dimension;
		// the writer on top per cell index: the highest cell layer, ties by entry id (WorldJournal.stack's order); ACTIVE and PLACING count
		String[] topId = new String[4096];
		long[] topLayer = new long[4096];
		SectionCells[] topSc = new SectionCells[4096];
		int[] topK = new int[4096];
		for (String id : j.js.inSection(dim, key)) {
			JournalStore.Meta m = j.js.meta(id);
			if (m == null || !m.active()) {
				continue;
			}
			SectionCells sc = j.js.section(id, key);
			if (sc == null) {
				continue;
			}
			for (int k = 0; k < sc.size(); k++) {
				int i = sc.index(k);
				long ly = sc.layer(k);
				if (topId[i] == null || ly > topLayer[i] || ly == topLayer[i] && id.compareTo(topId[i]) > 0) {
					topId[i] = id;
					topLayer[i] = ly;
					topSc[i] = sc;
					topK[i] = k;
				}
			}
		}
		Long2ObjectOpenHashMap<LevelChunk> chunks = new Long2ObjectOpenHashMap<>();
		for (int i = 0; i < 4096; i++) {
			if (topId[i] == null || !j.ours.contains(topId[i])) {
				continue;
			}
			Owner o = owner(j, topId[i]);
			if (o.kind == Owner.SKIP) {
				continue;
			}
			SectionCells sc = topSc[i];
			int k = topK[i];
			long pos = sc.pos(k);
			String lot = o.kind == Owner.LOT ? o.name : null;
			String name = o.kind == Owner.TILE ? (o.parts == null ? UNATTRIBUTED : o.parts.getOrDefault(pos, UNATTRIBUTED)) : o.name;
			if (j.part != null && (lot != null || !j.part.equals(name))) {
				continue;
			}
			j.counted++;
			int x = BlockPos.getX(pos), y = BlockPos.getY(pos), z = BlockPos.getZ(pos);
			long ck = net.minecraft.world.level.ChunkPos.pack(x >> 4, z >> 4);
			LevelChunk c = chunks.get(ck);
			if (c == null && !chunks.containsKey(ck)) {
				c = j.level.getChunkSource().getChunkNow(x >> 4, z >> 4);
				chunks.put(ck, c);
			}
			if (c == null) {
				j.unloaded++;
				continue;
			}
			j.checked++;
			Journal.Value after = sc.after(k) != null ? sc.after(k) : sc.before(k);
			BlockPos bp = new BlockPos(x, y, z);
			BlockState now = c.getBlockState(bp);
			boolean pt = Placed.record(c, x, y, z) != null;
			boolean mech = o.mech;
			Cls cls = o.field != null && o.field.unchanged(pos, now) ? Cls.SAME // (M5 FC) air or a field crop over our farmland
				: classifyCell(now, () -> WorldJournal.beNbt(j.level, bp), pt, after, mech, mech && j.mechVol.contains(pos),
					mech && j.mechTrig.contains(pos));
			if (lot != null) {
				long[] a = j.lots.computeIfAbsent(lot, q -> new long[2]);
				if (cls == Cls.PLAYER) {
					a[1]++;
				} else if (cls == Cls.REMOVED || cls == Cls.CHANGED) {
					a[0]++;
				}
				continue;
			}
			Acc a = j.parts.computeIfAbsent(name, q -> new Acc());
			a.cells++;
			switch (cls) {
				case SAME -> {
					continue;
				}
				case REMOVED -> a.removed++;
				case PLAYER -> a.player++;
				case VOLATILE -> a.vol++;
				case CHANGED -> {
					a.changed++;
					a.kinds.merge(BuiltInRegistries.BLOCK.getKey(now.getBlock()).toString(), 1L, Long::sum);
				}
			}
			if (a.sample.size() < SAMPLE) {
				a.sample.add(bp);
			}
		}
	}

	/** The owner of one of the region's entries (cached per entry id). */
	private static Owner owner(Job j, String entryId) throws IOException {
		Owner o = j.owners.get(entryId);
		if (o != null) {
			return o;
		}
		JournalStore.Meta m = j.js.meta(entryId);
		o = m == null ? new Owner(Owner.PART, UNATTRIBUTED, null, false) : ownerOf(j, m);
		j.owners.put(entryId, o);
		return o;
	}

	private static Owner ownerOf(Job j, JournalStore.Meta m) throws IOException {
		String site = m.site();
		String lot = j.lotOfSite.get(site);
		if (lot != null) {
			Site s = Sites.get(site);
			boolean building = s != null && s.construction() != null && s.construction().building();
			// (M5 FC) a lot with a field: its crop cells are judged by the field rule
			return new Owner(building ? Owner.SKIP : Owner.LOT, lot, null, false, dev.larattalabs.architect.site.FieldCells.of(s));
		}
		Infra inf = Infras.get(site);
		if (inf != null && inf.building()) {
			return new Owner(Owner.SKIP, null, null, false); // a construction road or survival target still building (RS, XR)
		}
		if (MECH_KIND.equals(m.kind())) {
			String key = inf != null && inf.member() != null ? inf.member().itemKey() : null;
			return new Owner(Owner.PART, key != null && key.startsWith("mech:") ? key : "mech:" + site, null, true);
		}
		if (WorldJournal.ROAD.equals(m.kind())) {
			return new Owner(Owner.PART, j.roadOfSite.getOrDefault(site, UNATTRIBUTED), null, false);
		}
		if (RegionKinds.tile(m.kind()) || WorldJournal.LEAVES.equals(m.kind())) {
			if (inf != null && inf.spec().has("tile")) {
				return new Owner(Owner.TILE, null, tileParts(j, inf), false);
			}
		}
		if (RegionTargets.is(inf)) {
			String p = RegionTargets.partOf(inf);
			return new Owner(Owner.PART, p == null ? UNATTRIBUTED : p, null, false);
		}
		if (inf != null && inf.ext().get(RegionTargets.EXT_PART) instanceof com.google.gson.JsonPrimitive p) {
			return new Owner(Owner.PART, p.getAsString(), null, false);
		}
		return new Owner(Owner.PART, UNATTRIBUTED, null, false);
	}

	/** A tile site's cells by part, from its realised record (null: unattributed). Cached per tile with the record's other sites. */
	private static @Nullable Map<Long, String> tileParts(Job j, Infra inf) throws IOException {
		String[] t = inf.spec().get("tile").getAsString().split("\\|", -1);
		if (t.length != 4) {
			return null;
		}
		int layer = Revisions.layerOf(t[1]);
		Realised.Tile rec = Realised.read(j.l.world(), j.l.rec().id, layer, Revisions.plainStage(t[1]), t[2], t[3]);
		if (rec == null || !"committed".equals(RealisedRecords.status(j.l, rec))) {
			return null;
		}
		LongOpenHashSet cells = new LongOpenHashSet();
		for (String sid : rec.sites()) {
			for (JournalStore.Meta mm : j.js.find(x -> sid.equals(x.site()) && x.status() == Journal.Status.ACTIVE && RegionKinds.tile(x.kind()))) {
				for (long k : mm.sections()) {
					SectionCells sc = j.js.section(mm.id(), k);
					if (sc != null) {
						for (int i = 0; i < sc.size(); i++) {
							cells.add(sc.pos(i));
						}
					}
				}
			}
		}
		Map<Long, String> out = partMap(rec, cells);
		if (out == null && inf.member() != null && inf.member().itemKey() != null) {
			// (RS) a survival tile: the cells its targets built are WRITTEN in its record too; with every target of the item built, their
			// cells complete the WRITTEN set
			String item = inf.member().itemKey();
			boolean all = true;
			LongOpenHashSet more = new LongOpenHashSet(cells);
			for (JournalStore.Meta mm : j.js.find(x -> x.status() == Journal.Status.ACTIVE && j.l.rec().groupId.equals(x.group()))) {
				Infra ti = Infras.get(mm.site());
				if (RegionTargets.is(ti) && ti.member() != null && item.equals(ti.member().itemKey())) {
					all &= !ti.building();
					for (long k : mm.sections()) {
						SectionCells sc = j.js.section(mm.id(), k);
						if (sc != null) {
							for (int i = 0; i < sc.size(); i++) {
								more.add(sc.pos(i));
							}
						}
					}
				}
			}
			if (all && more.size() > cells.size()) {
				out = partMap(rec, more);
			}
		}
		return out;
	}

	private static LandReport finish(MinecraftServer server, Job j) {
		List<PartLand> parts = new ArrayList<>();
		j.parts.forEach((name, a) -> parts.add(new PartLand(name, a.cells, a.changed, a.removed, a.player, a.vol, a.kinds, a.sample)));
		List<LotLand> lots = new ArrayList<>();
		if (j.part == null) {
			j.l.rec().lots.forEach((id, ls) -> {
				if (ls.siteId == null) {
					return;
				}
				Site s = Sites.get(ls.siteId);
				double standing = s == null ? -1 : Sites.standingScore(server, s);
				long[] a = j.lots.getOrDefault(id, new long[2]);
				lots.add(new LotLand(id, ls.siteId, ls.state, standing, a[0], a[1]));
			});
		}
		return new LandReport(j.l.rec().id, j.l.rec().position, parts, lots, j.checked, j.unloaded, (System.nanoTime() - j.t0) / 1_000_000L);
	}

	/** The report as JSON (DevBridge {@code dev.region.landCheck}). */
	public static JsonObject json(LandReport r) {
		JsonObject o = new JsonObject();
		o.addProperty("region", r.region());
		o.addProperty("position", r.position());
		JsonArray pa = new JsonArray();
		for (PartLand p : r.parts()) {
			JsonObject q = new JsonObject();
			q.addProperty("part", p.part());
			q.addProperty("cells", p.cells());
			q.addProperty("changed", p.changed());
			q.addProperty("removed", p.removed());
			q.addProperty("playerPlaced", p.playerPlaced());
			q.addProperty("volatileChanged", p.volatileChanged());
			JsonObject k = new JsonObject();
			new TreeMap<>(p.kinds()).forEach(k::addProperty);
			q.add("kinds", k);
			JsonArray s = new JsonArray();
			p.sample().forEach(b -> {
				JsonArray c = new JsonArray();
				c.add(b.getX());
				c.add(b.getY());
				c.add(b.getZ());
				s.add(c);
			});
			q.add("sample", s);
			pa.add(q);
		}
		o.add("parts", pa);
		JsonArray la = new JsonArray();
		for (LotLand t : r.lots()) {
			JsonObject q = new JsonObject();
			q.addProperty("lot", t.lot());
			q.addProperty("siteId", t.siteId());
			q.addProperty("state", t.state());
			q.addProperty("standing", t.standing());
			q.addProperty("changed", t.changed());
			q.addProperty("playerPlaced", t.playerPlaced());
			la.add(q);
		}
		o.add("lots", la);
		o.addProperty("cellsChecked", r.cellsChecked());
		o.addProperty("unloaded", r.unloaded());
		o.addProperty("ms", r.ms());
		return o;
	}
}
