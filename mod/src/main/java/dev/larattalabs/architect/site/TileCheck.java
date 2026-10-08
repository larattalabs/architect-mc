package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.region.CellCond;
import dev.larattalabs.architect.region.Packed;
import it.unimi.dsi.fastutil.ints.IntArrays;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * A region tile's P1 checks (CONTRACT §1 "Evaluation and conflicts", §3 "The unit of writing: tile entries"), over ticks like
 * 4e's {@link CellsCheck}: the decoded cells sorted lowest first off the server thread; then against the live world each
 * cell's condition, ownership (cells owned by any site, delta or road entry, or by another owner, are skipped: a region never
 * writes CELL over BOX; its own earlier tile entries are layered over), no-op cells (the world already holds the state) and
 * the claim; worldgen trees an op cuts are removed whole (within the window) and the leaves that hung on them are held. The
 * PLACING entry then holds only the cells that passed, so its planned {@code after} is exact.
 */
final class TileCheck {
	/** At most this many logs flood-filled per tile (a giant tree is still removed whole within the window). */
	static final int MAX_FLOOD = 20_000;

	private record Prep(long[] pos, Value[] values, BlockState[] states, byte[] cond, boolean[] walk, int clipped) {
	}

	/** The check's result: a 4e check plus the tile's extras. */
	record Result(InfraPlace.Check check, long[] leafPos, Value[] leafBefore, Value[] leafAfter, long[] walk, Map<String, Long> skipped) {
	}

	private final String regionGroup;
	private final String dim;
	private final Anchors.Bounds window;
	private final int[] claim;
	private final CompletableFuture<Prep> prep;
	private @Nullable LongOpenHashSet ours;
	private @Nullable LongOpenHashSet others;
	private final Map<String, Integer> overSites = new LinkedHashMap<>();
	private boolean[] keep;
	private int cursor;
	private final LongArrayList logs = new LongArrayList();
	private final Map<String, Long> skipped = new LinkedHashMap<>();
	private @Nullable Result result;
	private boolean warmed;

	TileCheck(Packed.Tile tile, String regionGroup, String dim, int[] claim, Anchors.Bounds window) {
		this.regionGroup = regionGroup;
		this.dim = dim;
		this.claim = claim.clone();
		this.window = window;
		this.prep = CompletableFuture.supplyAsync(() -> prepare(tile, claim));
	}

	private static Prep prepare(Packed.Tile t, int[] claim) {
		int n = t.size();
		int[] idx = new int[n];
		int k = 0;
		int clipped = 0;
		for (int i = 0; i < n; i++) {
			long p = t.pos()[i];
			int x = BlockPos.getX(p);
			int y = BlockPos.getY(p);
			int z = BlockPos.getZ(p);
			if (x < claim[0] || y < claim[1] || z < claim[2] || x > claim[3] || y > claim[4] || z > claim[5]) {
				clipped++; // REGION_LIMIT: the mod never trusts the evaluator for the claim
				continue;
			}
			idx[k++] = i;
		}
		int[] order = java.util.Arrays.copyOf(idx, k);
		long[] posOf = t.pos();
		IntArrays.quickSort(order, (a, b) -> {
			long pa = posOf[a];
			long pb = posOf[b];
			int r = Integer.compare(BlockPos.getY(pa), BlockPos.getY(pb));
			if (r != 0) {
				return r;
			}
			r = Integer.compare(BlockPos.getX(pa), BlockPos.getX(pb));
			return r != 0 ? r : Integer.compare(BlockPos.getZ(pa), BlockPos.getZ(pb));
		});
		Value[] byState = new Value[t.states().size()];
		for (int s = 0; s < byState.length; s++) {
			byState[s] = WorldJournal.value(t.states().get(s));
		}
		long[] ps = new long[k];
		Value[] vs = new Value[k];
		BlockState[] ss = new BlockState[k];
		byte[] cs = new byte[k];
		boolean[] ws = new boolean[k];
		for (int j = 0; j < k; j++) {
			int i = order[j];
			ps[j] = posOf[i];
			vs[j] = byState[t.state()[i]];
			ss[j] = t.states().get(t.state()[i]);
			cs[j] = t.cond()[i];
			ws[j] = t.walk()[i];
		}
		return new Prep(ps, vs, ss, cs, ws, clipped);
	}

	/** Works until {@code deadline}: the result once done, else null. Server thread. */
	@Nullable Result step(ServerLevel level, long deadline) {
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
			return result = refused(dev.larattalabs.architect.api.Reason.OTHER, "the tile's cells could not be read (" + e.getMessage() + ")");
		}
		String why = WorldJournal.unavailable();
		if (why != null) {
			return result = refused(dev.larattalabs.architect.api.Reason.JOURNAL_UNAVAILABLE, why);
		}
		if (!warmed) {
			if (!SiteJournal.warm(dim, window)) {
				return null;
			}
			warmed = true;
		}
		if (ours == null) {
			if (!owners(p)) {
				return result = refused(dev.larattalabs.architect.api.Reason.JOURNAL_UNAVAILABLE, "the journal could not be read");
			}
			keep = new boolean[p.pos().length];
			if (p.clipped() > 0) {
				skipped.merge("claim", (long) p.clipped(), Long::sum);
			}
		}
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		LevelChunk chunk = null;
		long chunkAt = Long.MIN_VALUE;
		int n = 0;
		while (cursor < p.pos().length) {
			if ((n++ & 1023) == 0 && n > 1 && System.nanoTime() >= deadline) {
				return null;
			}
			long q = p.pos()[cursor];
			int x = BlockPos.getX(q);
			int z = BlockPos.getZ(q);
			long ck = ChunkPos.pack(x >> 4, z >> 4);
			if (ck != chunkAt) {
				chunkAt = ck;
				chunk = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
			}
			if (chunk == null) {
				return result = refused(dev.larattalabs.architect.api.Reason.NOT_LOADED, "the tile is not loaded at " + x + ", " + z);
			}
			boolean ok;
			if (others.contains(q)) {
				ok = false;
				skipped.merge("owned", 1L, Long::sum);
			} else {
				BlockState s = chunk.getBlockState(m.set(x, BlockPos.getY(q), z));
				if (!CellCond.passes(p.cond()[cursor], s, ours.contains(q))) {
					ok = false;
					skipped.merge("condition", 1L, Long::sum);
				} else if (s == p.states()[cursor]) {
					ok = false;
					skipped.merge("same", 1L, Long::sum);
				} else {
					ok = true;
					if (s.is(BlockTags.LOGS)) {
						logs.add(q);
					}
				}
			}
			keep[cursor] = ok;
			cursor++;
		}
		return result = finish(level, p);
	}

	/** The cells of this window owned by this region's own tile entries (ours) and by anything else (others). */
	private boolean owners(Prep p) {
		ours = new LongOpenHashSet();
		others = new LongOpenHashSet();
		JournalStore js = WorldJournal.storeOrNull();
		if (js == null) {
			return false;
		}
		LongOpenHashSet secs = new LongOpenHashSet();
		for (long q : p.pos()) {
			secs.add(Sections.key(q));
		}
		for (int sx = window.minX() >> 4; sx <= window.maxX() >> 4; sx++) {
			for (int sz = window.minZ() >> 4; sz <= window.maxZ() >> 4; sz++) {
				for (int sy = claim[1] >> 4; sy <= claim[4] >> 4; sy++) {
					secs.add(Sections.key(sx, sy, sz)); // tree cells may lie outside the tile's own sections
				}
			}
		}
		for (long k : secs) {
			for (String id : js.inSection(dim, k)) {
				JournalStore.Meta mm = js.meta(id);
				if (mm == null || !mm.active() || mm.kind().equals(WorldJournal.LEAVES)) {
					continue;
				}
				boolean mine = (mm.kind().equals(RegionKinds.TERRAIN) || mm.kind().equals(RegionKinds.PATH)) && regionGroup.equals(mm.group());
				SectionCells sc;
				try {
					sc = js.section(id, k);
				} catch (IOException e) {
					return false;
				}
				if (sc == null) {
					continue;
				}
				LongOpenHashSet into = mine ? ours : others;
				for (int i = 0; i < sc.size(); i++) {
					into.add(sc.pos(i));
				}
				if (mine) {
					overSites.merge(mm.site(), sc.size(), Integer::sum);
				}
			}
		}
		// a cell owned by one of ours and by anything else (a lot LAYERed on our pad) is someone else's: others are checked first
		return true;
	}

	private Result finish(ServerLevel level, Prep p) {
		LongOpenHashSet writes = new LongOpenHashSet();
		LongArrayList pos = new LongArrayList();
		List<Value> vals = new ArrayList<>();
		LongArrayList walk = new LongArrayList();
		for (int i = 0; i < p.pos().length; i++) {
			if (keep[i]) {
				pos.add(p.pos()[i]);
				vals.add(p.values()[i]);
				writes.add(p.pos()[i]);
				if (p.walk()[i]) {
					walk.add(p.pos()[i]);
				}
			}
		}
		// trees: a trunk any of whose logs the tile removes goes whole (within the window and the claim), as cells of this entry
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		LongArrayList extra = new LongArrayList();
		LongOpenHashSet seen = new LongOpenHashSet(logs);
		java.util.ArrayDeque<Long> todo = new java.util.ArrayDeque<>(logs);
		LongArrayList removedLogs = new LongArrayList(logs);
		while (!todo.isEmpty() && seen.size() < MAX_FLOOD) {
			long q = todo.poll();
			int x = BlockPos.getX(q);
			int y = BlockPos.getY(q);
			int z = BlockPos.getZ(q);
			for (int dx = -1; dx <= 1; dx++) {
				for (int dy = -1; dy <= 1; dy++) {
					for (int dz = -1; dz <= 1; dz++) {
						int nx = x + dx;
						int ny = y + dy;
						int nz = z + dz;
						if (nx < window.minX() || nx > window.maxX() || nz < window.minZ() || nz > window.maxZ() || nx < claim[0] || nx > claim[3]
							|| nz < claim[2] || nz > claim[5] || ny < claim[1] || ny > claim[4]) {
							continue;
						}
						long np = BlockPos.asLong(nx, ny, nz);
						if (seen.contains(np)) {
							continue;
						}
						seen.add(np);
						if (!level.hasChunk(nx >> 4, nz >> 4)) {
							continue;
						}
						BlockState s = level.getBlockState(m.set(nx, ny, nz));
						if (!s.is(BlockTags.LOGS) || others.contains(np)) {
							continue;
						}
						todo.add(np);
						removedLogs.add(np);
						if (!writes.contains(np)) {
							extra.add(np);
						}
					}
				}
			}
		}
		Value air = WorldJournal.value(Blocks.AIR.defaultBlockState());
		for (long q : extra) {
			pos.add(q);
			vals.add(air);
			writes.add(q);
		}
		if (!extra.isEmpty()) {
			skipped.merge("treeCells", (long) extra.size(), Long::sum);
		}
		// leaves that may hang on the removed logs and stay: held persistent while the tile stands (4e's leaves entry)
		LongArrayList leafPos = new LongArrayList();
		List<Value> leafBefore = new ArrayList<>();
		List<Value> leafAfter = new ArrayList<>();
		LongOpenHashSet held = new LongOpenHashSet();
		int r = dev.larattalabs.architect.placement.LeafGuard.RADIUS;
		for (long q : removedLogs) {
			int x = BlockPos.getX(q);
			int y = BlockPos.getY(q);
			int z = BlockPos.getZ(q);
			for (int dx = -r; dx <= r; dx++) {
				for (int dy = -r; dy <= r; dy++) {
					for (int dz = -r; dz <= r; dz++) {
						if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > r) {
							continue;
						}
						int nx = x + dx;
						int ny = y + dy;
						int nz = z + dz;
						long np = BlockPos.asLong(nx, ny, nz);
						if (held.contains(np) || writes.contains(np) || others.contains(np) || !level.hasChunk(nx >> 4, nz >> 4)) {
							continue;
						}
						BlockState s = level.getBlockState(m.set(nx, ny, nz));
						if (s.getBlock() instanceof LeavesBlock && !s.getValue(LeavesBlock.PERSISTENT)) {
							held.add(np);
							leafPos.add(np);
							leafBefore.add(WorldJournal.value(s));
							leafAfter.add(WorldJournal.value(s.setValue(LeavesBlock.PERSISTENT, true)));
						}
					}
				}
			}
		}
		long[] ps = pos.toLongArray();
		Value[] vs = vals.toArray(new Value[0]);
		if (!extra.isEmpty()) {
			// the tree cells were appended: lowest first again (InfraJob writes in that order)
			Integer[] order = new Integer[ps.length];
			for (int i = 0; i < order.length; i++) {
				order[i] = i;
			}
			java.util.Arrays.sort(order, (a, b) -> {
				int c = Integer.compare(BlockPos.getY(ps[a]), BlockPos.getY(ps[b]));
				if (c != 0) {
					return c;
				}
				c = Integer.compare(BlockPos.getX(ps[a]), BlockPos.getX(ps[b]));
				return c != 0 ? c : Integer.compare(BlockPos.getZ(ps[a]), BlockPos.getZ(ps[b]));
			});
			long[] ps2 = new long[ps.length];
			Value[] vs2 = new Value[vs.length];
			for (int i = 0; i < order.length; i++) {
				ps2[i] = ps[order[i]];
				vs2[i] = vs[order[i]];
			}
			System.arraycopy(ps2, 0, ps, 0, ps.length);
			System.arraycopy(vs2, 0, vs, 0, vs.length);
		}
		List<String> notes = new ArrayList<>();
		skipped.forEach((k, v) -> notes.add(v + " " + k));
		List<SiteJournal.Hit> hits = new ArrayList<>();
		overSites.forEach((s, c) -> hits.add(new SiteJournal.Hit(s, "", "", Journal.Policy.CELL, Journal.Status.ACTIVE, c, 0)));
		JsonObject spec = new JsonObject();
		spec.addProperty("cells", ps.length);
		Anchors.Bounds box = null;
		if (ps.length > 0) {
			int[] bb = {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE};
			for (long q : ps) {
				bb[0] = Math.min(bb[0], BlockPos.getX(q));
				bb[1] = Math.min(bb[1], BlockPos.getY(q));
				bb[2] = Math.min(bb[2], BlockPos.getZ(q));
				bb[3] = Math.max(bb[3], BlockPos.getX(q));
				bb[4] = Math.max(bb[4], BlockPos.getY(q));
				bb[5] = Math.max(bb[5], BlockPos.getZ(q));
			}
			box = new Anchors.Bounds(bb[0], bb[1], bb[2], bb[3], bb[4], bb[5]);
		}
		long[] w = walk.toLongArray();
		java.util.Arrays.sort(w);
		if (w.length > 0) {
			spec.addProperty("walk", walkB64(w));
		}
		InfraPlace.Check c = new InfraPlace.Check(List.of(), notes, ps, vs, box, hits, spec);
		return new Result(c, leafPos.toLongArray(), leafBefore.toArray(new Value[0]), leafAfter.toArray(new Value[0]), w, Map.copyOf(skipped));
	}

	static String walkB64(long[] w) {
		java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(w.length * 8);
		for (long v : w) {
			b.putLong(v);
		}
		return Base64.getEncoder().encodeToString(b.array());
	}

	static long[] walkOf(String b64) {
		java.nio.ByteBuffer b = java.nio.ByteBuffer.wrap(Base64.getDecoder().decode(b64));
		long[] out = new long[b.capacity() / 8];
		for (int i = 0; i < out.length; i++) {
			out[i] = b.getLong();
		}
		return out;
	}

	private static Result refused(dev.larattalabs.architect.api.Reason r, String why) {
		return new Result(new InfraPlace.Check(List.of(new Sites.Refusal(r, why)), List.of(), new long[0], new Value[0], null, List.of(), null), new long[0],
			new Value[0], new Value[0], new long[0], Map.of());
	}

}
