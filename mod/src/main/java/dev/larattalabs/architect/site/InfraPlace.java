package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.TerrainFit;
import dev.larattalabs.architect.site.roads.Roads;
import dev.larattalabs.architect.survival.SurvivalWorld;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * Placing and removing roads and cell sites (docs/CONTRACT.md phase 4e "Roads as sites", "Cell sites"): the checks, the
 * plan, the {@link InfraJob} that writes them, and a road's removal with its handover. Server thread.
 */
public final class InfraPlace {
	/** At most this many cells in one cell site. */
	public static final int MAX_CELLS = 1_000_000;

	private InfraPlace() {
	}

	/** A checked road or cell site: its cells and box, or the typed refusals; its notes and the sites it lies on. */
	public record Check(List<Sites.Refusal> refusals, List<String> notes, long[] positions, Value[] values, Anchors.@Nullable Bounds box,
		List<SiteJournal.Hit> overlaps, @Nullable JsonObject spec) {
		public boolean ok() {
			return refusals.isEmpty();
		}

		public int cells() {
			return positions.length;
		}
	}

	private static Check refused(Reason r, String why) {
		return new Check(List.of(new Sites.Refusal(r, why)), List.of(), new long[0], new Value[0], null, List.of(), null);
	}

	/**
	 * The mode rule of roads and cell sites (INSTANT only in 4e; no survival roads): CONSTRUCTION, or AUTO with the survival
	 * toggle on, refuses NOT_ALLOWED; INSTANT in a survival-toggle world needs a creative world (cell sites) or an actor with
	 * permission level 2 (roads, the buildings' rule).
	 */
	static @Nullable String modeRefusal(MinecraftServer server, dev.larattalabs.architect.api.Mode mode, @Nullable ServerPlayer actor, boolean cells) {
		boolean survival = SurvivalWorld.on();
		boolean creative = server.getDefaultGameType() == GameType.CREATIVE;
		if (mode == dev.larattalabs.architect.api.Mode.CONSTRUCTION) {
			return (cells ? "cell sites" : "roads") + " are INSTANT only in this version (no construction mode)";
		}
		if (!survival || creative) {
			return null;
		}
		if (mode == dev.larattalabs.architect.api.Mode.AUTO) {
			return "this world builds construction sites, and " + (cells ? "cell sites" : "roads") + " have no construction mode yet";
		}
		if (cells) {
			return "a cell site needs INSTANT placement, which this survival world does not allow";
		}
		boolean perm2 = actor != null && actor.createCommandSourceStack().permissions().hasPermission(
			net.minecraft.server.permissions.Permissions.COMMANDS_GAMEMASTER);
		return perm2 ? null : "Instant placement in a survival world needs an actor with permission level 2";
	}

	// ------------------------------------------------------------------ roads

	/** Checks and plans a road (never loads a chunk: an unloaded column refuses NOT_LOADED). */
	public static Check checkRoad(ServerLevel level, List<BlockPos> points, int width, @Nullable String surface, @Nullable String slab, boolean lanterns,
		boolean decks, @Nullable String owner, boolean force) {
		String why = WorldJournal.unavailable();
		if (why != null) {
			return refused(Reason.JOURNAL_UNAVAILABLE, why);
		}
		if (points.size() < 2 || points.size() > 256) {
			return refused(Reason.OTHER, "a road takes 2-256 points (got " + points.size() + ")");
		}
		int[] xs = new int[points.size()];
		int[] ys = new int[points.size()];
		int[] zs = new int[points.size()];
		for (int i = 0; i < xs.length; i++) {
			xs[i] = points.get(i).getX();
			ys[i] = points.get(i).getY();
			zs[i] = points.get(i).getZ();
		}
		Roads.Planned p;
		try {
			p = Roads.plan(level, xs, ys, zs, width, surface, slab, lanterns, decks, owner, force, Sites::ownerOf, Sites::busy);
		} catch (IllegalArgumentException e) {
			return refused(Reason.OTHER, e.getMessage());
		}
		if (!p.ok()) {
			return new Check(List.of(new Sites.Refusal(p.reason() == null ? Reason.OTHER : p.reason(), p.refusal())), p.notes(), new long[0], new Value[0],
				null, List.of(), null);
		}
		List<SiteJournal.Hit> hits = new ArrayList<>();
		for (String s : p.layeredOver()) {
			hits.add(new SiteJournal.Hit(s, "", "cells", Journal.Policy.CELL, Journal.Status.ACTIVE, 0, 0));
		}
		return new Check(List.of(), p.notes(), p.positions(), p.values(), p.box(), hits, Roads.spec(xs, ys, zs, width, surface, slab, lanterns, decks,
			p.plan()));
	}

	/** Starts placing a road ({@link InfraJob}); the caller adds it to {@link Placement}. */
	static InfraJob beginRoad(ServerLevel level, Check c, @Nullable String owner, @Nullable JsonObject ext, Site.@Nullable Member member)
		throws Sites.SiteException {
		if (!c.ok()) {
			throw new Sites.SiteException(c.refusals().get(0).reason(), c.refusals().get(0).message());
		}
		SiteJournal.requireAvailable();
		String id = "r" + SiteJournal.store().newRoad();
		Infra rec = new Infra(id, Infra.ROAD, owner, ext, Sites.dimensionId(level), c.box(), System.currentTimeMillis(), member, true, c.spec());
		InfraJob job = new InfraJob(id, rec.dimension(), WorldJournal.ROAD, Journal.Policy.CELL, rec, member == null ? null : member.batchId(),
			member == null ? null : member.itemKey());
		job.notes.addAll(c.notes());
		job.plan(level, c.positions(), c.values());
		Architect.LOGGER.info("Placing road {} ({} cells over {}){}", id, c.cells(), Anchors.str(c.box()), c.notes().isEmpty() ? "" : "; " + String.join("; ",
			c.notes()));
		return job;
	}

	// ------------------------------------------------------------------ cell sites

	/**
	 * Checks a cell site: at most {@link #MAX_CELLS}; {@code naturalOnly} skips cells whose block is not natural terrain, air
	 * or water, or holds a block entity (noted); overlap per cell (REFUSE, or LAYER with the busy, owner and depth rules).
	 */
	public static Check checkCells(ServerLevel level, String kind, Journal.Policy policy, List<BlockPos> pos, List<BlockState> states,
		List<@Nullable CompoundTag> nbt, boolean naturalOnly, boolean layer, @Nullable String owner, boolean force, boolean dryRun) {
		return checkCells(level, kind, policy, pos, states, nbt, null, naturalOnly, layer, owner, force, dryRun);
	}

	/**
	 * {@link #checkCells} with per-cell conditions (phase 6a, {@code CellWrite.Cond}; -1 or null = {@code naturalOnly}). A cell
	 * whose condition fails is skipped and noted. ALWAYS_OURS passes a cell an entry of the same owner owns.
	 */
	public static Check checkCells(ServerLevel level, String kind, Journal.Policy policy, List<BlockPos> pos, List<BlockState> states,
		List<@Nullable CompoundTag> nbt, byte @Nullable [] conds, boolean naturalOnly, boolean layer, @Nullable String owner, boolean force,
		boolean dryRun) {
		String why = WorldJournal.unavailable();
		if (why != null) {
			return refused(Reason.JOURNAL_UNAVAILABLE, why);
		}
		if (pos.size() > MAX_CELLS) {
			return refused(Reason.TOO_LARGE, pos.size() + " cells (at most " + MAX_CELLS + " per request: split it into several requests of one group)");
		}
		if (pos.isEmpty()) {
			return refused(Reason.OTHER, "no cells");
		}
		if (!kind.contains(":")) {
			return refused(Reason.OTHER, "a cell site's kind is namespaced (<modid>:<kind>), got " + kind);
		}
		Map<Long, Integer> at = new LinkedHashMap<>();
		for (int i = 0; i < pos.size(); i++) {
			at.put(pos.get(i).asLong(), i);
		}
		List<String> notes = new ArrayList<>();
		List<Long> keep = new ArrayList<>();
		int skipped = 0;
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (long p : at.keySet()) {
			int x = Journal.x(p);
			int y = Journal.y(p);
			int z = Journal.z(p);
			if (y < level.getMinY() || y > level.getMaxY()) {
				return refused(Reason.BUILD_HEIGHT, "cell " + x + "," + y + "," + z + " is outside the build height");
			}
			if (!level.hasChunk(x >> 4, z >> 4)) {
				if (dryRun) {
					return refused(Reason.NOT_LOADED, "the cell site is not loaded at " + x + ", " + z + " (walk closer)");
				}
			}
			int cond = conds == null ? -1 : conds[at.get(p)];
			if (cond >= 0) {
				BlockState s = level.getBlockState(m.set(x, y, z));
				if (!dev.larattalabs.architect.region.CellCond.passes(cond, s, cond == 3 && ownedBySameOwner(level, p, owner))) {
					skipped++;
					continue;
				}
			} else if (naturalOnly) {
				int f = TerrainFit.flags(level, m.set(x, y, z));
				BlockState s = level.getBlockState(m);
				boolean natural = (f & TerrainFit.BLOCK_ENTITY) == 0 && (s.isAir() || (f & TerrainFit.NATURAL) != 0 || (f & TerrainFit.WATER) != 0
					|| (f & TerrainFit.TREE) != 0);
				if (!natural) {
					skipped++;
					continue;
				}
			}
			keep.add(p);
		}
		if (skipped > 0) {
			notes.add(skipped + " cell" + (skipped == 1 ? "" : "s") + " not natural terrain left as they are (naturalOnly)");
		}
		if (keep.isEmpty()) {
			return new Check(List.of(new Sites.Refusal(Reason.OTHER, "every cell was skipped (naturalOnly)")), notes, new long[0], new Value[0], null, List.of(),
				null);
		}
		// overlap per cell
		String dim = Sites.dimensionId(level);
		Map<String, Integer> over = new LinkedHashMap<>();
		Map<String, Journal.Status> status = new HashMap<>();
		int deepest = 0;
		JournalStore js = WorldJournal.storeOrNull();
		TreeMap<Long, List<Long>> bySec = SiteJournal.bySection(keep);
		for (var e : bySec.entrySet()) {
			List<String> ids = js.inSection(dim, e.getKey());
			if (ids.isEmpty()) {
				continue;
			}
			Map<Integer, Integer> depth = new HashMap<>();
			for (String id : ids) {
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
				for (long p : e.getValue()) {
					int idx = Sections.index(p);
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
		over.forEach((s, n) -> hits.add(new SiteJournal.Hit(s, "", "", Journal.Policy.BOX, status.get(s), n, 0)));
		Check refusal = overlapRefusal(over, status, deepest, layer, owner, force, notes, hits);
		if (refusal != null) {
			return refusal;
		}
		long[] ps = new long[keep.size()];
		Value[] vs = new Value[keep.size()];
		int[] bb = {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE};
		for (int k = 0; k < ps.length; k++) {
			long p = keep.get(k);
			int i = at.get(p);
			ps[k] = p;
			Value v = WorldJournal.value(states.get(i));
			CompoundTag n = nbt.get(i);
			vs[k] = n == null ? v : v.withNbt(n);
			bb[0] = Math.min(bb[0], Journal.x(p));
			bb[1] = Math.min(bb[1], Journal.y(p));
			bb[2] = Math.min(bb[2], Journal.z(p));
			bb[3] = Math.max(bb[3], Journal.x(p));
			bb[4] = Math.max(bb[4], Journal.y(p));
			bb[5] = Math.max(bb[5], Journal.z(p));
		}
		JsonObject spec = new JsonObject();
		spec.addProperty("kind", kind);
		spec.addProperty("policy", policy.name());
		spec.addProperty("cells", ps.length);
		spec.addProperty("naturalOnly", naturalOnly);
		return new Check(List.of(), notes, ps, vs, new Anchors.Bounds(bb[0], bb[1], bb[2], bb[3], bb[4], bb[5]), hits, spec);
	}

	/** ALWAYS_OURS for a cell site: an active entry (not leaves) of a site with the same owner has the cell. */
	static boolean ownedBySameOwner(ServerLevel level, long p, @Nullable String owner) {
		JournalStore js = WorldJournal.storeOrNull();
		if (js == null) {
			return false;
		}
		long k = Sections.key(p);
		for (String id : js.inSection(Sites.dimensionId(level), k)) {
			JournalStore.Meta mm = js.meta(id);
			if (mm == null || !mm.active() || mm.kind().equals(WorldJournal.LEAVES) || !java.util.Objects.equals(Sites.ownerOf(mm.site()), owner)) {
				continue;
			}
			try {
				SectionCells sc = js.section(id, k);
				if (sc != null && sc.has(Sections.index(p))) {
					return true;
				}
			} catch (IOException e) {
				return false;
			}
		}
		return false;
	}

	/** The overlap rules of a cell site (REFUSE, OVERLAP_BUSY, OVERLAP_OWNED, LAYER_DEPTH), or null; notes the sites it goes on. */
	static @Nullable Check overlapRefusal(Map<String, Integer> over, Map<String, Journal.Status> status, int deepest, boolean layer, @Nullable String owner,
		boolean force, List<String> notes, List<SiteJournal.Hit> hits) {
		if (over.isEmpty()) {
			return null;
		}
		if (!layer) {
			String s = over.keySet().iterator().next();
			return new Check(List.of(new Sites.Refusal(Reason.OVERLAP, "the cells overlap " + Sites.describe(s) + " (" + over.get(s)
				+ " cells); place on top with LAYER or elsewhere")), notes, new long[0], new Value[0], null, hits, null);
		}
		for (String s : over.keySet()) {
			String busy = Sites.busy(s, status.get(s));
			if (busy != null) {
				return new Check(List.of(new Sites.Refusal(Reason.OVERLAP_BUSY, "Not yet: " + Sites.describe(s) + " " + busy)), notes, new long[0],
					new Value[0], null, hits, null);
			}
			String o = Sites.ownerOf(s);
			if (!force && !java.util.Objects.equals(o, owner)) {
				return new Check(List.of(new Sites.Refusal(Reason.OVERLAP_OWNED, Sites.describe(s) + " is owned by " + (o == null ? "the player" : o)
					+ "; placing on top of it needs force")), notes, new long[0], new Value[0], null, hits, null);
			}
		}
		if (deepest + 1 > SiteJournal.MAX_DEPTH) {
			return new Check(List.of(new Sites.Refusal(Reason.LAYER_DEPTH, "a cell would carry " + (deepest + 1) + " layers (at most "
				+ SiteJournal.MAX_DEPTH + ")")), notes, new long[0], new Value[0], null, hits, null);
		}
		over.forEach((s, n) -> notes.add("on top of " + Sites.describe(s) + " (" + n + " cells)"));
		return null;
	}

	/** Starts placing a cell site ({@link InfraJob}). */
	static InfraJob beginCells(ServerLevel level, String kind, Journal.Policy policy, Check c, @Nullable String owner, @Nullable JsonObject ext,
		Site.@Nullable Member member) throws Sites.SiteException {
		if (!c.ok()) {
			throw new Sites.SiteException(c.refusals().get(0).reason(), c.refusals().get(0).message());
		}
		SiteJournal.requireAvailable();
		String id = "c" + SiteJournal.store().newCells();
		Infra rec = new Infra(id, Infra.CELLS + kind, owner, ext, Sites.dimensionId(level), c.box(), System.currentTimeMillis(), member, true, c.spec());
		InfraJob job = new InfraJob(id, rec.dimension(), kind, policy, rec, member == null ? null : member.batchId(), member == null ? null
			: member.itemKey());
		job.notes.addAll(c.notes());
		job.plan(level, c.positions(), c.values());
		Architect.LOGGER.info("Placing cell site {} ({}, {} cells over {})", id, kind, c.cells(), Anchors.str(c.box()));
		return job;
	}

	/**
	 * Starts placing a region tile (phase 6a): a cell site of kind {@code architect:terrain} or {@code architect:path}, CELL,
	 * with the tile's held leaves as a {@code leaves} entry and its walk-surface cells in the record's spec.
	 */
	static InfraJob beginTile(ServerLevel level, String kind, Check c, @Nullable String owner, @Nullable JsonObject ext, Site.@Nullable Member member,
		TileCheck.Result r, String tile) throws Sites.SiteException {
		SiteJournal.requireAvailable();
		String id = "c" + SiteJournal.store().newCells();
		JsonObject spec = c.spec() == null ? new JsonObject() : c.spec().deepCopy();
		spec.addProperty("kind", kind);
		spec.addProperty("policy", Journal.Policy.CELL.name());
		spec.addProperty("tile", tile);
		Infra rec = new Infra(id, Infra.CELLS + kind, owner, ext, Sites.dimensionId(level), c.box(), System.currentTimeMillis(), member, true, spec);
		InfraJob job = new InfraJob(id, rec.dimension(), kind, Journal.Policy.CELL, rec, member == null ? null : member.batchId(), member == null ? null
			: member.itemKey());
		job.notes.addAll(c.notes());
		job.leafPos = r.leafPos();
		job.leafBefore = r.leafBefore();
		job.leafAfter = r.leafAfter();
		job.tile = tile;
		job.plan(level, c.positions(), c.values());
		return job;
	}

	// ------------------------------------------------------------------ removal

	/**
	 * Removes a road or cell site over ticks (R1-R4 in a {@link RestoreJob}). A road first hands its changed cells that another
	 * standing road runs on over to that road ({@code Journal.transfer}, keeping their layers; AgentCraft's handover). Covered
	 * cells are handed down (KEEP); REFUSE refuses {@code COVERED}; CASCADE removes the covering sites first (atomic, then this
	 * one over ticks).
	 */
	static CompletableFuture<Sites.Removed> remove(ServerLevel level, String id, Sites.Covered covered) throws Sites.SiteException {
		Infra i = Infras.get(id);
		if (i == null) {
			throw new Sites.SiteException("No road or cell site " + id);
		}
		SiteJournal.requireAvailable();
		if (i.placing()) {
			throw new Sites.SiteException(Reason.OVERLAP_BUSY, id + " is still being placed; wait until it is done");
		}
		List<String> cover = SiteJournal.coveringSites(id);
		if (!cover.isEmpty() && covered == Sites.Covered.REFUSE) {
			throw new Sites.SiteException(Reason.COVERED, cover.size() + " site(s) cover cells of " + id + " (" + String.join(", ", cover) + ")");
		}
		List<String> cascaded = new ArrayList<>();
		List<String> infraCover = new ArrayList<>();
		if (!cover.isEmpty() && covered == Sites.Covered.CASCADE) {
			for (String c : cover) {
				if (Sites.get(c) != null) {
					Sites.Removed r = Sites.removeDetailed(level, c, false, Sites.Covered.CASCADE);
					cascaded.addAll(r.cascaded());
					cascaded.add(c);
				} else if (Infras.get(c) != null) {
					infraCover.add(c);
				}
			}
			if (!infraCover.isEmpty()) {
				// roads and cell sites on top go first (over ticks, one after the other), then this one
				CompletableFuture<List<String>> chain = CompletableFuture.completedFuture(new ArrayList<>(cascaded));
				for (String c : infraCover) {
					chain = chain.thenCompose(done -> {
						if (Infras.get(c) == null) {
							return CompletableFuture.completedFuture(done);
						}
						try {
							return remove(level, c, Sites.Covered.CASCADE).thenApply(r -> {
								done.addAll(r.cascaded());
								done.add(c);
								return done;
							});
						} catch (Sites.SiteException e) {
							return CompletableFuture.failedFuture(e);
						}
					});
				}
				return chain.thenCompose(done -> {
					try {
						return remove(level, id, Sites.Covered.KEEP).thenApply(r -> new Sites.Removed(r.site(), r.returned(), r.restored(), r.kept(), r.handedDown(),
							List.copyOf(done), r.notes()));
					} catch (Sites.SiteException e) {
						return CompletableFuture.failedFuture(e);
					}
				});
			}
		}
		List<String> notes = new ArrayList<>();
		if (i.road()) {
			notes.addAll(handover(level, i));
		}
		RestoreJob job = new RestoreJob(id, RestoreJob.REMOVE, null, null);
		CompletableFuture<Sites.Removed> f = new CompletableFuture<>();
		job.futures.add(f);
		Placement.add(level.getServer(), job);
		return f.thenApply(r -> new Sites.Removed(r.site(), r.returned(), r.restored(), r.kept(), r.handedDown(), cascaded.isEmpty() ? r.cascaded()
			: List.copyOf(cascaded), notes));
	}

	/** The road handover: this road's changed cells another standing road runs on go to that road (one commit, before the undo). */
	static List<String> handover(ServerLevel level, Infra road) throws Sites.SiteException {
		List<Infra> others = new ArrayList<>();
		for (Infra o : Infras.all()) {
			if (o.road() && !o.id().equals(road.id()) && o.dimension().equals(road.dimension()) && !o.placing() && near(o.box(), road.box(), 2)) {
				others.add(o);
			}
		}
		if (others.isEmpty()) {
			return List.of();
		}
		JournalStore js = SiteJournal.store();
		JournalStore.Meta mine = SiteJournal.main(road.id());
		if (mine == null) {
			return List.of();
		}
		Map<Long, Cell> changed = new LinkedHashMap<>();
		try {
			for (long k : mine.sections()) {
				SectionCells sc = js.section(mine.id(), k);
				if (sc == null) {
					continue;
				}
				for (int i = 0; i < sc.size(); i++) {
					Value a = sc.after(i);
					if (a != null && !a.equals(sc.before(i))) {
						changed.put(sc.pos(i), sc.cell(i));
					}
				}
			}
		} catch (IOException e) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, e.getMessage());
		}
		Map<String, int[]> walks = new LinkedHashMap<>();
		Map<String, Long> created = new HashMap<>();
		for (Infra o : others) {
			walks.put(o.id(), Roads.walk(o.spec()));
			created.put(o.id(), o.placedAt());
		}
		Map<Long, String> to = Roads.handover(new ArrayList<>(changed.keySet()), walks, created);
		if (to.isEmpty()) {
			return List.of();
		}
		Map<String, List<Long>> byRoad = new LinkedHashMap<>();
		to.forEach((p, r) -> byRoad.computeIfAbsent(r, k -> new ArrayList<>()).add(p));
		JournalStore.Txn t = js.begin().label("handover:" + road.id());
		List<String> notes = new ArrayList<>();
		try {
			Map<Long, List<Cell>> mineBy = new TreeMap<>();
			for (long k : mine.sections()) {
				SectionCells sc = js.section(mine.id(), k);
				if (sc != null) {
					mineBy.put(k, new ArrayList<>(sc.cells()));
				}
			}
			for (var e : byRoad.entrySet()) {
				JournalStore.Meta theirs = SiteJournal.main(e.getKey());
				if (theirs == null) {
					continue;
				}
				Map<Long, List<Cell>> theirBy = new TreeMap<>();
				for (long p : e.getValue()) {
					long k = Sections.key(p);
					if (!theirBy.containsKey(k)) {
						SectionCells sc = js.section(theirs.id(), k);
						theirBy.put(k, sc == null ? new ArrayList<>() : new ArrayList<>(sc.cells()));
					}
				}
				int moved = 0;
				for (long p : e.getValue()) {
					long k = Sections.key(p);
					List<Cell> tl = theirBy.get(k);
					if (tl.stream().anyMatch(c -> c.pos() == p)) {
						continue; // a position the receiver has stays with this road (Journal.transfer)
					}
					Cell c = changed.get(p);
					tl.add(c);
					mineBy.get(k).removeIf(x -> x.pos() == p);
					moved++;
				}
				List<SectionCells> ts = new ArrayList<>();
				theirBy.forEach((k, l) -> ts.add(SectionCells.of(k, l, null)));
				t.sections(theirs.id(), ts);
				if (moved > 0) {
					notes.add(moved + " cells kept for road " + e.getKey());
				}
			}
			List<SectionCells> ms = new ArrayList<>();
			mineBy.forEach((k, l) -> ms.add(l.isEmpty() ? SectionCells.of(k, List.of(), null) : SectionCells.of(k, l, null)));
			t.sections(mine.id(), ms);
		} catch (IOException e) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, e.getMessage());
		}
		SiteJournal.await(js.submit(t), "the handover of " + road.id());
		return notes;
	}

	private static boolean near(Anchors.Bounds a, Anchors.Bounds b, int d) {
		return a.minX() - d <= b.maxX() && b.minX() <= a.maxX() + d && a.minZ() - d <= b.maxZ() && b.minZ() <= a.maxZ() + d;
	}
}
