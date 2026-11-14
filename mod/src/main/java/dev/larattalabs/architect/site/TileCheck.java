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
import it.unimi.dsi.fastutil.ints.IntArrayList;
import it.unimi.dsi.fastutil.ints.IntArrays;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
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
 *
 * <p>(C31, v0.24.1) Felling never writes a cell the region may not: outside the window or the claim, owned by anything else
 * (another owner's region, site, road or cell site), inside a C17 protected area of the region's owner, or a log the voxel
 * table does not class LOG (a block it does not list is a player's block). It stops at that cell and the part of the tree
 * past it stays, possibly floating: counted as {@code M3:tree_kept} (and per reason, {@code tree_kept.<reason>}). A leaf held
 * persistent is a write too: never inside a protected area or on another owner's cell. Every cell felling does change is a
 * cell of the tile entry, so its undo restores it.
 */
final class TileCheck {
	/** At most this many logs flood-filled per tile (a giant tree is still removed whole within the window). */
	static final int MAX_FLOOD = 20_000;
	private static final int[][] FLUID_NB = {{1, 0, 0}, {-1, 0, 0}, {0, 0, 1}, {0, 0, -1}, {0, 1, 0}};

	/** (RP) {@code src}: each prepared cell's index in the checked tile; {@code fcode}: per checked-tile cell, CLIP for a clipped one. */
	private record Prep(long[] pos, Value[] values, BlockState[] states, byte[] cond, boolean[] walk, int clipped, int[] src, byte[] fcode) {
	}

	/** The check's result: a 4e check plus the tile's extras; (6c PT) the builds whose cells it kept, for the region's findings. */
	record Result(InfraPlace.Check check, long[] leafPos, Value[] leafBefore, Value[] leafAfter, long[] walk, Map<String, Long> skipped,
		List<dev.larattalabs.architect.api.BuildHit> builds, dev.larattalabs.architect.region.Realised.@Nullable Draft draft) {
		Result(InfraPlace.Check check, long[] leafPos, Value[] leafBefore, Value[] leafAfter, long[] walk, Map<String, Long> skipped) {
			this(check, leafPos, leafBefore, leafAfter, walk, skipped, List.of(), null);
		}
	}

	private final String regionGroup;
	/** (C31) The region owner's protected areas in this dimension at the check (felling and held leaves never enter them). */
	private final List<dev.larattalabs.architect.api.ProtectedArea> areas;
	/** (C31) Logs the flood reached but kept (past the window or the claim), and the count per reason. */
	private final LongOpenHashSet keptSeen = new LongOpenHashSet();
	private final Map<String, Long> keptBy = new LinkedHashMap<>();
	/** (6c B) A brush stroke's PLAYER_BLOCKS: unowned non-natural cells (block entities included) pass too (never unbreakable ones). */
	private final boolean playerBlocks;
	/** (6c B) A brush stroke's tile. */
	private final boolean stroke;
	/** (6c B) The groups of the stroke owner's other strokes: their tile entries are layered over as this region's own. */
	private final java.util.Set<String> layerGroups;
	private final String dim;
	/**
	 * (6c H §4.4) The tile's frozen heights (its window, resolution 1): a dependent cleared under a natural water surface (the column's
	 * surveyed water) becomes a water source, not air. Null: no heights (a dependent with a fluid state of its own still becomes water).
	 */
	private dev.larattalabs.architect.region.@Nullable Columns heights;
	/** (6c H) Dependents written as water because they stood under a natural water surface. */
	private int wetDeps;
	/** (6c PT) The builds the request's consent names (validated at realise or stroke time): their cells pass as natural. */
	private dev.larattalabs.architect.placed.Placed.Consent consent = dev.larattalabs.architect.placed.Placed.Consent.NONE;
	/** (6c PT) The kept builds' cells this tile skipped (the region's findings, at most 8 builds). */
	private final dev.larattalabs.architect.placed.BuildViews.Hits buildHits = new dev.larattalabs.architect.placed.BuildViews.Hits();
	/** (6c PT) Target cells kept because they hold up a build cell (a torch, door, ladder, rail, crop, sign or a gravity block). */
	private final LongOpenHashSet supportKept = new LongOpenHashSet();
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
	// the stages after the per-cell pass (each over ticks under the deadline; the last off the server thread)
	private int stage;
	/** The kept cells' target states, then the tree and dependent cells added. */
	private final Long2ObjectOpenHashMap<BlockState> target = new Long2ObjectOpenHashMap<>();
	private final IntArrayList drop = new IntArrayList();
	private java.util.@Nullable ArrayDeque<Long> flood;
	private @Nullable LongOpenHashSet floodSeen;
	private int treeCount;
	private final LongArrayList removedLogs = new LongArrayList();
	private long @Nullable [] cleared;
	private int deps;
	/** Gravity blocks on a changed cell left alone: their support stays solid ({@link #keepsGravity}). */
	private int gravityKept;
	private final LongArrayList added = new LongArrayList();
	private final List<Value> addedVals = new ArrayList<>();
	private final LongOpenHashSet held = new LongOpenHashSet();
	private final LongArrayList leafPos = new LongArrayList();
	private final IntArrayList leafCause = new IntArrayList();
	private final List<Value> leafBefore = new ArrayList<>();
	private final List<Value> leafAfter = new ArrayList<>();
	private @Nullable CompletableFuture<Result> assembled;
	/** (RP) The tile as evaluated (before the fluids gate's filter): the realised record is over its cells. Null: no record. */
	private Packed.@Nullable Tile original;
	/** (RP) The checked tile (filtered). */
	private final Packed.Tile checked;
	/** (RP) Each prepared cell's code ({@link dev.larattalabs.architect.region.Realised}). */
	private byte[] code = new byte[0];
	/** (RP) A written cell or extra -> the prepared index of the intended cell whose write caused it. */
	private final it.unimi.dsi.fastutil.longs.Long2IntOpenHashMap causeOf = new it.unimi.dsi.fastutil.longs.Long2IntOpenHashMap();
	/** (RP) The kind of each {@link #added} cell (TREE, DEPENDENT, DEPENDENT_WET). */
	private final it.unimi.dsi.fastutil.bytes.ByteArrayList addedKind = new it.unimi.dsi.fastutil.bytes.ByteArrayList();

	TileCheck(Packed.Tile tile, String regionGroup, String dim, int[] claim, Anchors.Bounds window) {
		this(tile, regionGroup, null, dim, claim, window);
	}

	/** (C31) With the region's owner: felling and held leaves stop at its protected areas. */
	TileCheck(Packed.Tile tile, String regionGroup, @Nullable String owner, String dim, int[] claim, Anchors.Bounds window) {
		this(tile, regionGroup, owner, dim, claim, window, false, java.util.Set.of(), false, null);
	}

	/** (6c D3) A reach plan's tile: its reach columns (the join's cells in a standing town's claim) are claimed land for writing. */
	TileCheck(Packed.Tile tile, String regionGroup, @Nullable String owner, String dim, int[] claim, Anchors.Bounds window,
		dev.larattalabs.architect.region.BesideReach.@Nullable Cols reach) {
		this(tile, regionGroup, owner, dim, claim, window, false, java.util.Set.of(), false, reach);
	}

	/** (6c B) A brush stroke's tile ({@code RegionRec.brush}): its destruction rule and the owner's other strokes. */
	TileCheck(Packed.Tile tile, String regionGroup, String dim, int[] claim, Anchors.Bounds window, boolean playerBlocks, java.util.Set<String> layerGroups) {
		this(tile, regionGroup, null, dim, claim, window, playerBlocks, layerGroups, true, null);
	}

	/** (C31) A brush stroke's tile with its owner (the stroke owner's protected areas bound felling and held leaves). */
	TileCheck(Packed.Tile tile, String regionGroup, @Nullable String owner, String dim, int[] claim, Anchors.Bounds window, boolean playerBlocks,
		java.util.Set<String> layerGroups) {
		this(tile, regionGroup, owner, dim, claim, window, playerBlocks, layerGroups, true, null);
	}

	private TileCheck(Packed.Tile tile, String regionGroup, @Nullable String owner, String dim, int[] claim, Anchors.Bounds window, boolean playerBlocks,
		java.util.Set<String> layerGroups, boolean stroke, dev.larattalabs.architect.region.BesideReach.@Nullable Cols reach) {
		this.areas = List.copyOf(Protected.of(dim, owner));
		this.stroke = stroke;
		this.playerBlocks = playerBlocks;
		this.layerGroups = java.util.Set.copyOf(layerGroups);
		this.regionGroup = regionGroup;
		this.dim = dim;
		this.claim = claim.clone();
		this.window = window;
		this.checked = tile;
		this.causeOf.defaultReturnValue(-1);
		this.prep = CompletableFuture.supplyAsync(() -> prepare(tile, claim, reach));
	}

	/**
	 * (6d RV, docs/CONTRACT.md "Phase 6d slice RV" §3.2, §5) A revision's tile: it layers only over the region's own terrain-set tile entries;
	 * a cell another entry holds (another site, a lot or its deltas, a road, another owner, or the region's own path-set, road or lot
	 * entries), a player's build cell or a cell in the owner's protected area refuses the tile (COVERED for a building site, OVERLAP for any
	 * other holder or a build, PROTECTED), never skipped. Its other cells are decided as a realise's.
	 */
	private boolean revision;
	private final it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<String> holderOf = new it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<>();

	TileCheck revision(boolean on) {
		this.revision = on;
		return this;
	}

	/** (6d GR) The revision this tile belongs to (its region and rid): its own path-set entries are its, not the region's standing ones. */
	private @Nullable String revisionRegion;
	private int revisionRid;

	TileCheck revisionOf(String region, int rid) {
		this.revisionRegion = region;
		this.revisionRid = rid;
		return this;
	}

	/**
	 * (6d GR) Whether a journal entry's site is this revision's own (its ext {@code architect_mc:revision {region, rid}}): a path-set tile of
	 * the same revision that a halt left PLACING and the resume wrote again (RP §6's leftover), which the revision's later tiles layer over
	 * as over any of its own cells. A standing path cell (the region's realised plan or an earlier revision) is never this revision's.
	 */
	private boolean ownRevisionSite(@Nullable String site) {
		if (revisionRegion == null || site == null) {
			return false;
		}
		Infra in = Infras.get(site);
		com.google.gson.JsonObject ext = in == null ? null : in.ext();
		return ext != null && ext.get("architect_mc:revision") instanceof com.google.gson.JsonObject rv && rv.get("rid") != null && rv.get("rid").getAsInt() == revisionRid
			&& rv.get("region") != null && revisionRegion.equals(rv.get("region").getAsString());
	}

	/** (6d RV, §8) A survival region's revision: a cell over a block the region built (not natural) refuses survival_paid. */
	private boolean survivalRevision;

	TileCheck survivalRevision(boolean on) {
		this.survivalRevision = on;
		return this;
	}

	/** (RP) Records the tile's realised draft over {@code t}, the tile as evaluated ({@code tile} is it after the fluids gate). */
	TileCheck provenance(Packed.@Nullable Tile t) {
		this.original = t;
		return this;
	}

	/** (6c H §4.4) With the tile's frozen heights (the natural water surface for dependents cleared under it). */
	TileCheck heights(dev.larattalabs.architect.region.@Nullable Columns h) {
		this.heights = h;
		return this;
	}

	/** (6c H §4.4) Whether a cell stands under the natural water surface of its column (the frozen heights: water flagged, y at most ground). */
	boolean underWater(int x, int y, int z) {
		var h = heights;
		if (h == null || x < h.minX || z < h.minZ || x >= h.minX + h.width * h.resolution || z >= h.minZ + h.depth * h.resolution) {
			return false;
		}
		int k = h.at(x, z);
		if (k < 0) {
			return false;
		}
		return (h.flags[k] & dev.larattalabs.architect.region.Columns.WATER) != 0 && (h.flags[k] & dev.larattalabs.architect.region.Columns.MISSING) == 0
			&& y <= h.ground[k] && y >= h.floor[k];
	}

	/** (6c PT) With the consented builds (a region realise's, or a PLAYER_BLOCKS stroke's). */
	TileCheck consent(dev.larattalabs.architect.placed.Placed.@Nullable Consent c) {
		this.consent = c == null ? dev.larattalabs.architect.placed.Placed.Consent.NONE : c;
		return this;
	}

	private static Prep prepare(Packed.Tile t, int[] claim, dev.larattalabs.architect.region.BesideReach.@Nullable Cols reach) {
		int n = t.size();
		int[] idx = new int[n];
		int k = 0;
		int clipped = 0;
		byte[] fcode = new byte[n];
		for (int i = 0; i < n; i++) {
			long p = t.pos()[i];
			int x = BlockPos.getX(p);
			int y = BlockPos.getY(p);
			int z = BlockPos.getZ(p);
			// ((6c D3) a reach column outside the claim's x/z is claimed land for writing: its y range is the claim's)
			boolean inXZ = x >= claim[0] && z >= claim[2] && x <= claim[3] && z <= claim[5] || reach != null && reach.has(x, z);
			if (!inXZ || y < claim[1] || y > claim[4]) {
				clipped++; // REGION_LIMIT: the mod never trusts the evaluator for the claim
				fcode[i] = dev.larattalabs.architect.region.Realised.CLIP;
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
		return new Prep(ps, vs, ss, cs, ws, clipped, order, fcode);
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
			code = new byte[p.pos().length];
			if (p.clipped() > 0) {
				skipped.merge("claim", (long) p.clipped(), Long::sum);
			}
			return null; // the owners' read took this tick's share
		}
		if (stage == 0) {
			if (!cells(level, p, deadline)) {
				return result;
			}
			stage = 1;
		}
		if (stage == 1) {
			if (!fluids(level, p, deadline)) {
				return null;
			}
			stage = 2;
		}
		if (stage == 2) {
			if (!trees(level, deadline)) {
				return null;
			}
			supports(level);
			stage = 3;
		}
		if (stage == 3) {
			if (!dependents(level, deadline)) {
				return null;
			}
			stage = 4;
		}
		if (stage == 4) {
			if (!leaves(level, deadline)) {
				return null;
			}
			stage = 5;
			assembled = CompletableFuture.supplyAsync(() -> assemble(p));
		}
		if (assembled == null || !assembled.isDone()) {
			return null;
		}
		try {
			return result = assembled.join();
		} catch (RuntimeException e) {
			return result = refused(dev.larattalabs.architect.api.Reason.OTHER, "the tile could not be assembled (" + e.getMessage() + ")");
		}
	}

	/** Stage 0: every cell against the world (condition, ownership, no-ops); false while unfinished (result set if refused). */
	private boolean cells(ServerLevel level, Prep p, long deadline) {
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		LevelChunk chunk = null;
		long chunkAt = Long.MIN_VALUE;
		int n = 0;
		while (cursor < p.pos().length) {
			if ((n++ & 1023) == 0 && n > 1 && System.nanoTime() >= deadline) {
				return false;
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
				result = refused(dev.larattalabs.architect.api.Reason.NOT_LOADED, "the tile is not loaded at " + x + ", " + z);
				return false;
			}
			boolean ok;
			// (RP) every branch's decision through Realised.decide, in the same order: ownership, a build, the world's state
			boolean owned = others.contains(q);
			String bd = owned ? null : dev.larattalabs.architect.placed.Placed.build(level, chunk, x, BlockPos.getY(q), z);
			boolean buildKept = bd != null && !consent.allows(bd);
			BlockState s = null;
			boolean unbreakable = false;
			boolean condPasses = true;
			boolean same = false;
			if (!owned && !buildKept) {
				s = chunk.getBlockState(m.set(x, BlockPos.getY(q), z));
				unbreakable = brushRefuses(s);
				if (!unbreakable) {
					boolean incidental = dev.larattalabs.architect.placed.Placed.naturalForWrites(level, chunk, x, BlockPos.getY(q), z, consent);
					condPasses = CellCond.passes(p.cond()[cursor], s, ours.contains(q)) || (playerBlocks && strokeMayClear(p.cond()[cursor])) || (incidental
						&& CellCond.passesIncidental(p.cond()[cursor], s));
					same = condPasses && s == p.states()[cursor];
				}
			}
			byte c = dev.larattalabs.architect.region.Realised.decide(owned, buildKept, unbreakable, condPasses, same);
			code[cursor] = c;
			if (revision) {
				// (6d RV, §3.2, §5.1) held, a player's build, the owner's area: the revision's tile refuses, nothing of it written
				String no = null;
				dev.larattalabs.architect.api.Reason why = null;
				if (c == dev.larattalabs.architect.region.Realised.HELD) {
					String site = holderOf.get(q);
					boolean box = site != null && Sites.get(site) != null;
					why = box ? dev.larattalabs.architect.api.Reason.COVERED : dev.larattalabs.architect.api.Reason.OVERLAP;
					no = "the revision's cell (" + x + ", " + BlockPos.getY(q) + ", " + z + ") is held by " + (site == null ? "another entry" : "site " + site)
						+ (box ? "" : " {kind: held}");
				} else if (c == dev.larattalabs.architect.region.Realised.BUILD) {
					why = dev.larattalabs.architect.api.Reason.OVERLAP;
					no = "the revision's cell (" + x + ", " + BlockPos.getY(q) + ", " + z + ") is a player's build " + bd + " (PLAYER_BUILD)";
				} else if (inArea(x, z)) {
					why = dev.larattalabs.architect.api.Reason.PROTECTED;
					no = "the revision's cell (" + x + ", " + BlockPos.getY(q) + ", " + z + ") is in the owner's protected area";
				} else if (survivalRevision && ours.contains(q) && s != null && !CellCond.natural(s, dev.larattalabs.architect.placement.TerrainFit.flags(s))) {
					why = dev.larattalabs.architect.api.Reason.NOT_ALLOWED;
					no = "the revision's cell (" + x + ", " + BlockPos.getY(q) + ", " + z + ") is over a block the region built and paid for (survival_paid)";
				}
				if (no != null) {
					result = refused(why, no);
					return false;
				}
			}
			switch (c) {
				case dev.larattalabs.architect.region.Realised.HELD -> {
					ok = false;
					skipped.merge("owned", 1L, Long::sum);
				}
				case dev.larattalabs.architect.region.Realised.BUILD -> {
					// (6c PT §7) a player's build cell: skipped as `build`, whatever the condition, the stroke or force
					ok = false;
					skipped.merge("player_build", 1L, Long::sum);
					skipped.merge("player_build." + bd, 1L, Long::sum);
					buildHits.add(level, bd, q);
				}
				case dev.larattalabs.architect.region.Realised.UNBREAKABLE -> {
					ok = false;
					skipped.merge("unbreakable", 1L, Long::sum);
				}
				case dev.larattalabs.architect.region.Realised.COND -> {
					ok = false;
					skipped.merge("condition", 1L, Long::sum);
				}
				case dev.larattalabs.architect.region.Realised.NOOP -> {
					ok = false;
					skipped.merge("same", 1L, Long::sum);
				}
				default -> {
					ok = true;
					if (treeLog(s)) {
						logs.add(q);
					}
					target.put(q, p.states()[cursor]);
					causeOf.put(q, cursor);
				}
			}
			keep[cursor] = ok;
			cursor++;
		}
		cursor = 0;
		return true;
	}

	/** (6c B) A stroke never writes over an unbreakable block (bedrock, barriers, portals, command and structure blocks). */
	private boolean brushRefuses(BlockState s) {
		return stroke && s.getBlock().defaultDestroyTime() < 0;
	}

	/**
	 * (6c B, Noah's destruction rule) With PLAYER_BLOCKS an unowned cell passes whatever it holds (a player's or another mod's
	 * blocks, block entities too: their data is journaled and nothing drops) for the conditions that may remove natural cells; it is
	 * never in {@code others} here (an owned cell was skipped first).
	 */
	static boolean strokeMayClear(int cond) {
		return cond == Packed.IF_NATURAL || cond == Packed.ALWAYS_OURS;
	}

	/**
	 * Stage 1, fluids (phase 6a, E-normal): an air write that would let water or lava in is skipped: the cell is a fluid, or a
	 * fluid lies beside or above it that this tile does not replace with a solid block (writes skip block updates, but the first
	 * neighbour update later lets the fluid flow, and the undo would find water where the entry wrote air). Decided against
	 * every kept cell first, then applied (no cascade).
	 */
	private boolean fluids(ServerLevel level, Prep p, long deadline) {
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		int n = 0;
		while (cursor < p.pos().length) {
			if ((n++ & 511) == 0 && n > 1 && System.nanoTime() >= deadline) {
				return false;
			}
			int c = cursor++;
			if (!keep[c] || !p.states()[c].isAir()) {
				continue;
			}
			long q = p.pos()[c];
			int x = BlockPos.getX(q);
			int y = BlockPos.getY(q);
			int z = BlockPos.getZ(q);
			if (!level.getBlockState(m.set(x, y, z)).getFluidState().isEmpty()) {
				drop.add(c);
				continue;
			}
			for (int[] d : FLUID_NB) {
				if (!level.hasChunk((x + d[0]) >> 4, (z + d[2]) >> 4)) {
					continue;
				}
				BlockState ns = level.getBlockState(m.set(x + d[0], y + d[1], z + d[2]));
				if (ns.getFluidState().isEmpty()) {
					continue;
				}
				BlockState nt = target.get(BlockPos.asLong(x + d[0], y + d[1], z + d[2]));
				if (nt == null || !nt.getFluidState().isEmpty() || !nt.isSolid()) {
					drop.add(c);
					break;
				}
			}
		}
		cursor = 0;
		if (!drop.isEmpty()) {
			skipped.merge("fluid", (long) drop.size(), Long::sum);
			LongOpenHashSet dropped = new LongOpenHashSet();
			for (int i = 0; i < drop.size(); i++) {
				int c = drop.getInt(i);
				keep[c] = false;
				code[c] = dev.larattalabs.architect.region.Realised.FLUID_EDGE;
				target.remove(p.pos()[c]);
				dropped.add(p.pos()[c]);
			}
			logs.removeIf(q -> dropped.contains(q));
		}
		return true;
	}

	/** Stage 2, trees: a trunk any of whose logs the tile removes goes whole (within the window and the claim), as cells of this entry. */
	private boolean trees(ServerLevel level, long deadline) {
		if (flood == null) {
			flood = new java.util.ArrayDeque<>(logs);
			floodSeen = new LongOpenHashSet(logs);
			removedLogs.addAll(logs);
		}
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		BlockState airState = Blocks.AIR.defaultBlockState();
		Value air = WorldJournal.value(airState);
		int n = 0;
		int trees = 0;
		while (!flood.isEmpty() && floodSeen.size() < MAX_FLOOD) {
			if ((n++ & 63) == 0 && n > 1 && System.nanoTime() >= deadline) {
				treeCount += trees;
				return false;
			}
			long q = flood.poll();
			int qc = causeOf.get(q);
			int x = BlockPos.getX(q);
			int y = BlockPos.getY(q);
			int z = BlockPos.getZ(q);
			for (int dx = -1; dx <= 1; dx++) {
				for (int dy = -1; dy <= 1; dy++) {
					for (int dz = -1; dz <= 1; dz++) {
						int nx = x + dx;
						int ny = y + dy;
						int nz = z + dz;
						long np = BlockPos.asLong(nx, ny, nz);
						if (nx < window.minX() || nx > window.maxX() || nz < window.minZ() || nz > window.maxZ() || nx < claim[0] || nx > claim[3]
							|| nz < claim[2] || nz > claim[5] || ny < claim[1] || ny > claim[4]) {
							// (C31) the tree goes on past the window or the claim: that part stays
							if (keptSeen.add(np) && level.hasChunk(nx >> 4, nz >> 4) && level.getBlockState(m.set(nx, ny, nz)).is(BlockTags.LOGS)) {
								kept("claim");
							}
							continue;
						}
						if (!floodSeen.add(np) || !level.hasChunk(nx >> 4, nz >> 4)) {
							continue;
						}
						BlockState s = level.getBlockState(m.set(nx, ny, nz));
						if (!s.is(BlockTags.LOGS)) {
							continue;
						}
						// (C31) never another owner's cell, a protected cell, or a log the voxel table calls a player's block; (6c PT) never a
						// player's build cell (an incidental log may be felled)
						String bdn = dev.larattalabs.architect.placed.Placed.build(level, null, nx, ny, nz);
						String why = others.contains(np) ? "owned" : bdn != null && !consent.allows(bdn) ? "build" : inArea(nx, nz) ? "protected" : !treeLog(s)
							? "player" : null;
						if (why != null) {
							kept(why);
							continue;
						}
						flood.add(np);
						removedLogs.add(np);
						causeOf.putIfAbsent(np, qc);
						if (!target.containsKey(np)) {
							added.add(np);
							addedKind.add(dev.larattalabs.architect.region.Realised.TREE);
							addedVals.add(air);
							target.put(np, airState);
							trees++;
						}
					}
				}
			}
		}
		treeCount += trees;
		if (treeCount > 0) {
			skipped.merge("treeCells", (long) treeCount, Long::sum);
		}
		long keptAll = keptBy.values().stream().mapToLong(Long::longValue).sum();
		if (keptAll > 0) {
			skipped.merge("M3:tree_kept", keptAll, Long::sum);
			keptBy.forEach((k, v) -> skipped.merge("tree_kept." + k, v, Long::sum));
		}
		return true;
	}

	private void kept(String why) {
		keptBy.merge(why, 1L, Long::sum);
	}

	/** (C31) Whether the column lies in one of the region owner's protected areas. */
	private boolean inArea(int x, int z) {
		for (dev.larattalabs.architect.api.ProtectedArea a : areas) {
			if (a.contains(x, z)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * (C31) A log felling may take: in {@code #logs} and classed LOG by the voxel table (the kit's natural/player split: a block it
	 * does not list, a modded log for one, is a player's block). The table cannot tell a log a player placed from a grown one.
	 */
	static boolean treeLog(BlockState s) {
		return s.is(BlockTags.LOGS) && !s.hasBlockEntity() && dev.larattalabs.architect.region.volume.VoxelTable.get().of(s.getBlock())
			== dev.larattalabs.architect.api.VoxelClass.LOG;
	}

	/**
	 * Stage 3: what stood on a cell this tile changes (snow layers, leaf litter, plants, sugar cane, kelp, sand and gravel) goes
	 * too, as cells of this entry (the undo puts it back); left alone it breaks or falls at the next update (phase 6a, E-normal).
	 * A plant can't stand on most new blocks either (grass on stone): any changed cell. A gravity block whose support is solid
	 * before and after stays ({@link #keepsGravity}, counted {@code gravityKept}): it would not fall, and clearing it lost the
	 * sand over T3b's lined tunnel roof.
	 */
	private boolean dependents(ServerLevel level, long deadline) {
		if (cleared == null) {
			cleared = target.keySet().toLongArray();
		}
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		Value air = WorldJournal.value(Blocks.AIR.defaultBlockState());
		Value water = WorldJournal.value(Blocks.WATER.defaultBlockState());
		int n = 0;
		while (cursor < cleared.length) {
			if ((n++ & 511) == 0 && n > 1 && System.nanoTime() >= deadline) {
				return false;
			}
			long q = cleared[cursor++];
			int qc = causeOf.get(q);
			int x = BlockPos.getX(q);
			int z = BlockPos.getZ(q);
			for (int y = BlockPos.getY(q) + 1; y <= claim[4]; y++) {
				long u = BlockPos.asLong(x, y, z);
				if (target.containsKey(u) || others.contains(u)) {
					break;
				}
				BlockState us = level.getBlockState(m.set(x, y, z));
				if (!dependent(us)) {
					break;
				}
				if (y == BlockPos.getY(q) + 1 && keepsGravity(us, level.getBlockState(m.set(x, y - 1, z)), target.get(q))) {
					gravityKept++; // its support is solid before and after: nothing makes it fall, so the writer leaves it (and what it holds up)
					break;
				}
				String bdu = dev.larattalabs.architect.placed.Placed.build(level, null, x, y, z);
				if (bdu != null && !consent.allows(bdu)) {
					break; // (6c PT) a build's cell is never a dependent written away (its support was kept: supports)
				}
				// (6c H §4.4) a dependent with a fluid state of its own, or one under the column's natural water surface, becomes a source
				boolean ownFluid = !us.getFluidState().isEmpty();
				boolean wet = ownFluid || underWater(x, y, z);
				if (wet && !ownFluid) {
					wetDeps++;
				}
				added.add(u);
				addedKind.add(wet ? dev.larattalabs.architect.region.Realised.DEPENDENT_WET : dev.larattalabs.architect.region.Realised.DEPENDENT);
				causeOf.putIfAbsent(u, qc);
				addedVals.add(wet ? water : air);
				target.put(u, wet ? Blocks.WATER.defaultBlockState() : Blocks.AIR.defaultBlockState());
				deps++;
			}
		}
		cursor = 0;
		if (deps > 0) {
			skipped.merge("dependentCells", (long) deps, Long::sum);
		}
		if (gravityKept > 0) {
			skipped.merge("gravityKept", (long) gravityKept, Long::sum);
		}
		if (wetDeps > 0) {
			skipped.merge("dependentsUnderWater", (long) wetDeps, Long::sum);
		}
		return true;
	}

	/**
	 * Whether a gravity block resting on a changed cell stays: its support holds it up now and the cell's new state holds it up too
	 * (vanilla's own rule, {@link net.minecraft.world.level.block.FallingBlock#isFree}: not air, fire, fluid or a replaceable block).
	 * It is no cell of the entry then, and the undo, which puts the support's old (solid) state back, leaves it exactly as it was. A
	 * gravity block hanging over a free cell (worldgen sand over air) is still cleared with the entry, so the undo restores it. Plants,
	 * snow and the other dependents are cleared as before (grass can't stand on stone).
	 */
	static boolean keepsGravity(BlockState above, BlockState supportNow, @Nullable BlockState supportNew) {
		return above.getBlock() instanceof net.minecraft.world.level.block.FallingBlock && supportNew != null
			&& !net.minecraft.world.level.block.FallingBlock.isFree(supportNow) && !net.minecraft.world.level.block.FallingBlock.isFree(supportNew);
	}

	/** Stage 4: leaves that may hang on the removed logs and stay: held persistent while the tile stands (4e's leaves entry). */
	private boolean leaves(ServerLevel level, long deadline) {
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		int r = dev.larattalabs.architect.placement.LeafGuard.RADIUS;
		while (cursor < removedLogs.size()) {
			if (System.nanoTime() >= deadline) {
				return false;
			}
			long q = removedLogs.getLong(cursor++);
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
						// (C31) a hold is a write: never on another owner's cell or inside a protected area; (6c PT) never a build's leaf
						if (held.contains(np) || target.containsKey(np) || others.contains(np) || inArea(nx, nz) || !level.hasChunk(nx >> 4, nz >> 4)
							|| dev.larattalabs.architect.placed.Placed.build(level, null, nx, ny, nz) != null) {
							continue;
						}
						BlockState s = level.getBlockState(m.set(nx, ny, nz));
						if (s.getBlock() instanceof LeavesBlock && !s.getValue(LeavesBlock.PERSISTENT)) {
							held.add(np);
							leafPos.add(np);
							leafCause.add(causeOf.get(q));
							leafBefore.add(WorldJournal.value(s));
							leafAfter.add(WorldJournal.value(s.setValue(LeavesBlock.PERSISTENT, true)));
						}
					}
				}
			}
		}
		cursor = 0;
		return true;
	}

	/**
	 * (6c PT §7) A changed cell that holds up a player's build cell stays as it is (counted {@code player_build.support}): the build
	 * cell above it when that one is not a full block or falls (a torch, door, rail, crop, sign, carpet, sand), or a build cell beside
	 * it attached to it (a wall torch, ladder, wall sign, button or lever facing away from it).
	 */
	private void supports(ServerLevel level) {
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		LongArrayList drop = new LongArrayList();
		for (var e : target.long2ObjectEntrySet()) {
			long q = e.getLongKey();
			int x = BlockPos.getX(q);
			int y = BlockPos.getY(q);
			int z = BlockPos.getZ(q);
			if (holdsBuild(level, m, x, y, z)) {
				drop.add(q);
			}
		}
		if (drop.isEmpty()) {
			return;
		}
		for (int i = 0; i < drop.size(); i++) {
			long q = drop.getLong(i);
			target.remove(q);
			supportKept.add(q);
		}
		skipped.merge("player_build.support", (long) drop.size(), Long::sum);
		logs.removeIf(q -> supportKept.contains(q));
		removedLogs.removeIf(q -> supportKept.contains(q));
		// the kept cells leave the entry: the planned ones, and the tree cells added
		Prep p = prep.join();
		for (int c = 0; c < p.pos().length; c++) {
			if (keep[c] && supportKept.contains(p.pos()[c])) {
				keep[c] = false;
				code[c] = dev.larattalabs.architect.region.Realised.BUILD_SUPPORT;
			}
		}
		LongArrayList a2 = new LongArrayList();
		List<Value> v2 = new ArrayList<>();
		it.unimi.dsi.fastutil.bytes.ByteArrayList k2 = new it.unimi.dsi.fastutil.bytes.ByteArrayList();
		for (int i = 0; i < added.size(); i++) {
			if (!supportKept.contains(added.getLong(i))) {
				a2.add(added.getLong(i));
				v2.add(addedVals.get(i));
				k2.add(addedKind.getByte(i));
			}
		}
		added.clear();
		added.addAll(a2);
		addedVals.clear();
		addedVals.addAll(v2);
		addedKind.clear();
		addedKind.addAll(k2);
	}

	private boolean holdsBuild(ServerLevel level, BlockPos.MutableBlockPos m, int x, int y, int z) {
		String up = dev.larattalabs.architect.placed.Placed.build(level, null, x, y + 1, z);
		if (up != null && !consent.allows(up)) {
			BlockState a = level.getBlockState(m.set(x, y + 1, z));
			if (a.getBlock() instanceof net.minecraft.world.level.block.FallingBlock || !a.isCollisionShapeFullBlock(level, m)) {
				return true;
			}
		}
		for (net.minecraft.core.Direction d : net.minecraft.core.Direction.Plane.HORIZONTAL) {
			int nx = x + d.getStepX();
			int nz = z + d.getStepZ();
			String side = dev.larattalabs.architect.placed.Placed.build(level, null, nx, y, nz);
			if (side == null || consent.allows(side)) {
				continue;
			}
			BlockState s = level.getBlockState(m.set(nx, y, nz));
			net.minecraft.core.Direction f = s.hasProperty(net.minecraft.world.level.block.state.properties.BlockStateProperties.HORIZONTAL_FACING) ? s.getValue(
				net.minecraft.world.level.block.state.properties.BlockStateProperties.HORIZONTAL_FACING) : s.hasProperty(
					net.minecraft.world.level.block.state.properties.BlockStateProperties.FACING) ? s.getValue(
						net.minecraft.world.level.block.state.properties.BlockStateProperties.FACING) : null;
			// attached to (x, y, z): it faces away from it (its back is on it), and it is no full block of its own
			if (f == d && !s.isCollisionShapeFullBlock(level, m)) {
				return true;
			}
		}
		return false;
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
				// (6c B) a brush stroke layers over its owner's other strokes' tile entries as over its own
				boolean mine = (mm.kind().equals(RegionKinds.TERRAIN) || mm.kind().equals(RegionKinds.PATH)) && (regionGroup.equals(mm.group())
					|| layerGroups.contains(mm.group()));
				if (revision && mm.kind().equals(RegionKinds.PATH) && !ownRevisionSite(mm.site())) {
					mine = false; // (6d RV, §5.2) a revision never writes over the region's own path-set cells ((6d GR) but its own)
				}
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
					if (revision && !mine) {
						holderOf.putIfAbsent(sc.pos(i), mm.site()); // (6d RV) the refusal names its holder
					}
				}
				if (mine) {
					overSites.merge(mm.site(), sc.size(), Integer::sum);
				}
			}
		}
		// a cell owned by one of ours and by anything else (a lot LAYERed on our pad) is someone else's: others are checked first
		return true;
	}

	/** Stage 5, off the server thread: the entry's cells lowest first, its box, the walk set and the result. */
	private Result assemble(Prep p) {
		LongArrayList pos = new LongArrayList();
		List<Value> vals = new ArrayList<>();
		LongArrayList walk = new LongArrayList();
		for (int i = 0; i < p.pos().length; i++) {
			if (keep[i]) {
				pos.add(p.pos()[i]);
				vals.add(p.values()[i]);
				if (p.walk()[i]) {
					walk.add(p.pos()[i]);
				}
			}
		}
		pos.addAll(added);
		vals.addAll(addedVals);
		LongArrayList extra = added;
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
		return new Result(c, leafPos.toLongArray(), leafBefore.toArray(new Value[0]), leafAfter.toArray(new Value[0]), w, Map.copyOf(skipped),
			buildHits.list(8), draft(p));
	}

	/**
	 * (RP) The realised draft (off the server thread, once every stage decided): each checked cell's code (kept cells WRITTEN), the
	 * extras with their cause (a prepared index, turned into the checked tile's index), over the unfiltered tile. Null without
	 * {@link #provenance}.
	 */
	private dev.larattalabs.architect.region.Realised.@Nullable Draft draft(Prep p) {
		Packed.Tile o = original;
		if (o == null) {
			return null;
		}
		byte[] fcode = p.fcode().clone();
		for (int j = 0; j < p.pos().length; j++) {
			fcode[p.src()[j]] = keep[j] ? dev.larattalabs.architect.region.Realised.WRITTEN : code[j];
		}
		List<dev.larattalabs.architect.region.Realised.Extra> ex = new ArrayList<>(added.size() + leafPos.size());
		for (int i = 0; i < added.size(); i++) {
			int cj = causeOf.get(added.getLong(i));
			ex.add(new dev.larattalabs.architect.region.Realised.Extra(addedKind.getByte(i), added.getLong(i), cj >= 0 ? p.src()[cj] : -1));
		}
		for (int i = 0; i < leafPos.size(); i++) {
			int cj = leafCause.getInt(i);
			ex.add(new dev.larattalabs.architect.region.Realised.Extra(dev.larattalabs.architect.region.Realised.LEAF, leafPos.getLong(i), cj >= 0 ? p.src()[cj]
				: -1));
		}
		return dev.larattalabs.architect.region.Realised.draft(o, checked, fcode, ex);
	}

	/** A block that stands on the one under it and breaks or falls without it. */
	static boolean dependent(BlockState s) {
		var b = s.getBlock();
		return b instanceof net.minecraft.world.level.block.FallingBlock || b instanceof net.minecraft.world.level.block.VegetationBlock
			|| b instanceof net.minecraft.world.level.block.SnowLayerBlock || b instanceof net.minecraft.world.level.block.LeafLitterBlock
			|| b instanceof net.minecraft.world.level.block.FlowerBedBlock || b instanceof net.minecraft.world.level.block.SugarCaneBlock
			|| b instanceof net.minecraft.world.level.block.CactusBlock || b instanceof net.minecraft.world.level.block.CactusFlowerBlock
			|| b instanceof net.minecraft.world.level.block.BambooStalkBlock || b instanceof net.minecraft.world.level.block.KelpBlock
			|| b instanceof net.minecraft.world.level.block.KelpPlantBlock || b instanceof net.minecraft.world.level.block.SeaPickleBlock
			|| b instanceof net.minecraft.world.level.block.CarpetBlock || b instanceof net.minecraft.world.level.block.DoublePlantBlock;
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
