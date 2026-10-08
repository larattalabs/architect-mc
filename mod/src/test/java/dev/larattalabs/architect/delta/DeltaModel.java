package dev.larattalabs.architect.delta;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.StillOurs;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.TerrainFit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * A pure model of a world, its journal and one site S, changed the way {@code site.SiteDeltas} changes them (the world seam of
 * the phase 5b property tests, as 5a's {@code MigrationWorld}): instant placement (one BOX {@code site} entry over the restore
 * box), delta apply ({@link DeltaPlanner}: plan against plan on the pre-site view, KEEP/OVERWRITE/REFUSE, a BOX {@code delta}
 * entry over {@code Δ'} plus guards, the history fold), revert (one undo of a suffix of deltas, {@link Journal#planUndo}) and
 * Remove. No vanilla shape updates: the model writes exactly the planned values (shape updates are checked in game).
 */
final class DeltaModel {
	static final int GROUND = 60;
	static final Value GRASS = WorldJournal.value(Blocks.GRASS_BLOCK.defaultBlockState());
	static final Value DIRT = WorldJournal.value(Blocks.DIRT.defaultBlockState());
	static final Value AIR = WorldJournal.value(Blocks.AIR.defaultBlockState());
	static final BlockState[] PALETTE = {Blocks.STONE_BRICKS.defaultBlockState(), Blocks.OAK_PLANKS.defaultBlockState(), Blocks.GLASS.defaultBlockState(),
		Blocks.AIR.defaultBlockState(), Blocks.COBBLESTONE.defaultBlockState(), Blocks.SPRUCE_LOG.defaultBlockState()};

	/** A version: design cells (design coordinates -> state), its template, blueprint and frame origin. */
	record Version(int n, Map<Long, BlockState> design, SitePlanner.VersionCells cells, Blueprint bp, int[] origin) {
		/** A version from design cells: origin = -min design coordinate, the feet row is design y 1, front south. */
		static Version of(int n, Map<Long, BlockState> design) {
			int[] lo = {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE};
			int[] hi = {Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE};
			for (long d : design.keySet()) {
				int[] c = {Journal.x(d), Journal.y(d), Journal.z(d)};
				for (int i = 0; i < 3; i++) {
					lo[i] = Math.min(lo[i], c[i]);
					hi[i] = Math.max(hi[i], c[i]);
				}
			}
			int[] origin = {-lo[0], -lo[1], -lo[2]};
			int sx = hi[0] - lo[0] + 1;
			int sy = hi[1] - lo[1] + 1;
			int sz = hi[2] - lo[2] + 1;
			int[] xyz = new int[design.size() * 3];
			BlockState[] states = new BlockState[design.size()];
			int k = 0;
			for (var e : design.entrySet()) {
				xyz[k * 3] = Journal.x(e.getKey()) + origin[0];
				xyz[k * 3 + 1] = Journal.y(e.getKey()) + origin[1];
				xyz[k * 3 + 2] = Journal.z(e.getKey()) + origin[2];
				states[k] = e.getValue();
				k++;
			}
			JsonObject j = new JsonObject();
			j.addProperty("id", "model");
			JsonObject size = new JsonObject();
			size.addProperty("x", sx);
			size.addProperty("y", sy);
			size.addProperty("z", sz);
			j.add("size", size);
			j.addProperty("groundY", 1 + origin[1]);
			j.addProperty("front", "south");
			j.addProperty("approach", false);
			return new Version(n, Map.copyOf(design), new SitePlanner.VersionCells(sx, sy, sz, xyz, states, new net.minecraft.nbt.CompoundTag[states
				.length]), Blueprint.fromJson(j), origin);
		}
	}

	/** A random building: a floor (design y 0), walls and a roof over x 0..w-1, z 0..d-1. */
	static Map<Long, BlockState> building(Random r, int w, int h, int d) {
		Map<Long, BlockState> m = new LinkedHashMap<>();
		for (int y = 0; y <= h; y++) {
			for (int z = 0; z < d; z++) {
				for (int x = 0; x < w; x++) {
					boolean wall = x == 0 || z == 0 || x == w - 1 || z == d - 1;
					BlockState s = y == 0 || y == h ? PALETTE[0] : wall ? PALETTE[r.nextInt(3) == 0 ? 2 : 1] : Blocks.AIR.defaultBlockState();
					m.put(Journal.pos(x, y, z), s);
				}
			}
		}
		return m;
	}

	/** A random edit of a building: re-materials, removes or adds cells; may grow or shrink (the frame moves with it). */
	static Map<Long, BlockState> edit(Random r, Map<Long, BlockState> in) {
		Map<Long, BlockState> m = new LinkedHashMap<>(in);
		List<Long> keys = new ArrayList<>(m.keySet());
		int kind = r.nextInt(4);
		if (kind == 0) { // re-material a few cells
			for (int i = 0; i < 1 + r.nextInt(8); i++) {
				m.put(keys.get(r.nextInt(keys.size())), PALETTE[r.nextInt(PALETTE.length)]);
			}
		} else if (kind == 1) { // grow toward -x or +z (a wing): new cells outside the old bounds
			int[] lo = bounds(m, true);
			int[] hi = bounds(m, false);
			boolean west = r.nextBoolean();
			int depth = 1 + r.nextInt(3);
			for (int y = 0; y <= Math.min(3, hi[1]); y++) {
				for (int k = 0; k < depth; k++) {
					for (int z = lo[2]; z <= hi[2]; z++) {
						int x = west ? lo[0] - 1 - k : hi[0] + 1 + k;
						m.put(Journal.pos(x, y, z), y == 0 ? PALETTE[0] : PALETTE[4]);
					}
				}
			}
		} else if (kind == 2) { // shrink: drop the cells of the last x column(s)
			int[] hi = bounds(m, false);
			int[] lo = bounds(m, true);
			if (hi[0] - lo[0] > 3) {
				m.keySet().removeIf(p -> Journal.x(p) == hi[0]);
			}
		} else { // remove a few cells (unwritten: terrain stays)
			for (int i = 0; i < 1 + r.nextInt(5); i++) {
				long p = keys.get(r.nextInt(keys.size()));
				if (Journal.y(p) > 0) {
					m.remove(p);
				}
			}
		}
		return m;
	}

	static int[] bounds(Map<Long, BlockState> m, boolean low) {
		int[] b = low ? new int[] {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE} : new int[] {Integer.MIN_VALUE, Integer.MIN_VALUE,
			Integer.MIN_VALUE};
		for (long p : m.keySet()) {
			int[] c = {Journal.x(p), Journal.y(p), Journal.z(p)};
			for (int i = 0; i < 3; i++) {
				b[i] = low ? Math.min(b[i], c[i]) : Math.max(b[i], c[i]);
			}
		}
		return b;
	}

	// ------------------------------------------------------------------ the world and journal

	final Map<Long, Value> world = new HashMap<>();
	final Map<String, Entry> entries = new LinkedHashMap<>();
	long layer = 1;
	int nextId = 1;
	/** Positions written by the last operation (E4). */
	final java.util.Set<Long> touched = new java.util.HashSet<>();

	static Value terrain(long p) {
		int y = Journal.y(p);
		return y < GROUND ? DIRT : y == GROUND ? GRASS : AIR;
	}

	Value at(long p) {
		return world.getOrDefault(p, terrain(p));
	}

	void set(long p, Value v) {
		if (!at(p).equals(v)) {
			touched.add(p);
		}
		world.put(p, v);
	}

	DeltaModel copy() {
		DeltaModel m = new DeltaModel();
		m.world.putAll(world);
		m.entries.putAll(entries);
		m.layer = layer;
		m.nextId = nextId;
		m.site = site;
		m.maxDeltas = maxDeltas;
		m.layerOver = layerOver;
		return m;
	}

	List<Entry> active() {
		return entries.values().stream().filter(Entry::active).toList();
	}

	/** The active cells at {@code p}, bottom first. */
	List<Map.Entry<Entry, Cell>> stack(long p) {
		return Journal.stack(active(), p);
	}

	// ------------------------------------------------------------------ the site

	/** The site's state: its version, box corner, rotation and its delta entries (oldest first) with the versions they reached. */
	static final class Site {
		Version version;
		int[] boxMin;
		int turns;
		String base;
		final List<String> deltas = new ArrayList<>();
		/** versions[i] = the version after deltas[i-1] (versions[0] = the placed or folded base). */
		final List<Version> chain = new ArrayList<>();
		final List<int[]> mins = new ArrayList<>();
	}

	@Nullable Site site;

	SitePlanner.World view(java.util.function.LongFunction<Value> values) {
		return new SitePlanner.World() {
			@Override
			public Value value(long pos) {
				return values.apply(pos);
			}

			@Override
			public int flags(int x, int y, int z) {
				return TerrainFit.flags(WorldJournal.state(values.apply(Journal.pos(x, y, z))));
			}
		};
	}

	SitePlanner.Plan plan(Version v, int[] min, int turns, SitePlanner.World w) {
		return SitePlanner.plan(v.cells(), v.bp(), turns, min[0], min[1], min[2], w, SitePlanner.Beds.SAFE, Blocks.STONE_BRICKS.defaultBlockState(),
			Blocks.DIRT_PATH.defaultBlockState(), Blocks.STONE_BRICK_SLAB.defaultBlockState(), null);
	}

	/** An instant placement: the site entry over the restore box (before = the world), the plan written, after captured. */
	void place(Version v, int[] min, int turns) {
		SitePlanner.Plan p = plan(v, min, turns, view(this::at));
		String id = "j" + nextId++;
		long l = layer++;
		List<Long> box = positions(p.snapBox());
		Map<Long, Value> before = new LinkedHashMap<>();
		for (long q : box) {
			before.put(q, at(q));
		}
		touched.clear();
		p.writes().forEach(this::set);
		List<Cell> cells = new ArrayList<>();
		for (long q : box) {
			cells.add(new Cell(q, l, before.get(q), at(q)));
		}
		entries.put(id, new Entry(id, WorldJournal.SITE, "S", "minecraft:overworld", Policy.BOX, 0L, Status.ACTIVE, cells, null, null));
		Site s = new Site();
		s.version = v;
		s.boxMin = min;
		s.turns = turns;
		s.base = id;
		s.chain.add(v);
		s.mins.add(min);
		site = s;
	}

	static List<Long> positions(Anchors.Bounds b) {
		List<Long> out = new ArrayList<>();
		for (int y = b.minY(); y <= b.maxY(); y++) {
			for (int z = b.minZ(); z <= b.maxZ(); z++) {
				for (int x = b.minX(); x <= b.maxX(); x++) {
					out.add(Journal.pos(x, y, z));
				}
			}
		}
		return out;
	}

	boolean siteHas(long p) {
		for (var e : stack(p)) {
			if (e.getKey().site().equals("S")) {
				return true;
			}
		}
		return false;
	}

	/** The pre-site view: S's lowest cell's before where S has cells, the world elsewhere. */
	Value preSite(long p) {
		for (var e : stack(p)) {
			if (e.getKey().site().equals("S")) {
				return e.getValue().before();
			}
		}
		return at(p);
	}

	DeltaPlanner.Stacks stacks() {
		return new DeltaPlanner.Stacks() {
			@Override
			public DeltaPlanner.Holder holder(long pos) {
				var st = stack(pos);
				if (st.isEmpty()) {
					return DeltaPlanner.Holder.NONE;
				}
				return st.get(st.size() - 1).getKey().site().equals("S") ? DeltaPlanner.Holder.SITE : DeltaPlanner.Holder.OTHER;
			}

			@Override
			public boolean siteHas(long pos) {
				return DeltaModel.this.siteHas(pos);
			}

			@Override
			public @Nullable Value siteAfter(long pos) {
				var st = stack(pos);
				return st.isEmpty() ? null : st.get(st.size() - 1).getValue().after();
			}

			@Override
			public @Nullable String topSite(long pos) {
				var st = stack(pos);
				return st.isEmpty() ? null : st.get(st.size() - 1).getKey().site();
			}
		};
	}

	DeltaPlanner.Now now() {
		return new DeltaPlanner.Now() {
			@Override
			public Value value(long pos) {
				return at(pos);
			}

			@Override
			public boolean holds(long pos, Value after) {
				Value v = at(pos);
				return StillOurs.holds(WorldJournal.state(v), v.nbt(), WorldJournal.state(after), after.nbt());
			}
		};
	}

	/** The result of an apply: refused (why), or the outcome. */
	record Applied(@Nullable String refused, DeltaPlanner.@Nullable Outcome outcome, DeltaPlanner.Set3 set) {
	}

	static final int MAX_DELTAS = 6;
	/** At most this many deltas before the oldest folds into the base (E6's reference model never folds). */
	int maxDeltas = MAX_DELTAS;
	/** The overlap policy of applies: LAYER (growth onto another site's cells goes on top), else REFUSE. */
	boolean layerOver = true;

	/** Applies version {@code b} to S (frame aligned), as {@code SiteDeltas.apply} does. */
	Applied apply(Version b, DeltaPlanner.Edits mode) {
		Site s = site;
		SitePlanner.World pre = view(this::preSite);
		SitePlanner.Plan pa = plan(s.version, s.boxMin, s.turns, pre);
		int[] minB = SitePlanner.alignedMin(s.boxMin, s.version.origin(), s.version.cells().sizeX(), s.version.cells().sizeZ(), b.origin(), b.cells()
			.sizeX(), b.cells().sizeZ(), s.turns);
		SitePlanner.Plan pb = plan(b, minB, s.turns, pre);
		DeltaPlanner.Set3 set = DeltaPlanner.deltaSet(pa, pb, pre);
		DeltaPlanner.Outcome o = DeltaPlanner.outcome(set.delta(), pb.snapBox(), stacks(), now(), mode);
		touched.clear();
		if (!o.covered().isEmpty()) {
			return new Applied("COVERED " + o.covered(), o, set);
		}
		if (o.refusedForEdits(mode)) {
			return new Applied("PLAYER_EDITS " + o.edited().size(), o, set);
		}
		if (!o.overlaps().isEmpty() && !layerOver) {
			return new Applied("OVERLAP " + o.overlaps(), o, set);
		}
		if (s.deltas.size() >= maxDeltas) {
			fold();
		}
		String id = "j" + nextId++;
		long l = layer++;
		Map<Long, Value> before = new LinkedHashMap<>();
		for (long q : o.entryCells()) {
			before.put(q, at(q));
		}
		o.write().forEach(this::set);
		List<Cell> cells = new ArrayList<>();
		for (long q : o.entryCells()) {
			cells.add(new Cell(q, l, before.get(q), at(q)));
		}
		entries.put(id, new Entry(id, "delta", "S", "minecraft:overworld", Policy.BOX, 0L, Status.ACTIVE, cells, null, null));
		s.deltas.add(id);
		s.version = b;
		s.boxMin = minB;
		s.chain.add(b);
		s.mins.add(minB);
		return new Applied(null, o, set);
	}

	/** Folds the oldest delta into the base (the 7th delta's commit). */
	void fold() {
		Site s = site;
		String d = s.deltas.remove(0);
		Entry nb = DeltaPlanner.fold(entries.get(s.base), entries.get(d));
		entries.put(s.base, nb);
		entries.remove(d);
		s.chain.remove(0);
		s.mins.remove(0);
	}

	/** Whether version index {@code k} of the chain can be reached by undoing a suffix (creative revert). */
	boolean inChain(int k) {
		return k >= 0 && k < site.chain.size();
	}

	/** Reverts S to chain index {@code k}: the deltas above it undone as one undo. */
	void revert(int k) {
		Site s = site;
		List<String> ids = new ArrayList<>(s.deltas.subList(k, s.deltas.size()));
		touched.clear();
		undo(ids);
		s.deltas.subList(k, s.deltas.size()).clear();
		s.chain.subList(k + 1, s.chain.size()).clear();
		s.mins.subList(k + 1, s.mins.size()).clear();
		s.version = s.chain.get(k);
		s.boxMin = s.mins.get(k);
	}

	/** Remove: the whole group undone (base and every delta). */
	void remove() {
		Site s = site;
		List<String> ids = new ArrayList<>();
		ids.add(s.base);
		ids.addAll(s.deltas);
		touched.clear();
		undo(ids);
		site = null;
	}

	void undo(List<String> ids) {
		Journal.UndoPlan p = Journal.planUndo(active(), ids, "g", 0L, (pos, after) -> now().holds(pos, after), Journal.Match.EQUAL);
		for (Journal.Write w : p.writes()) {
			set(w.pos(), w.value());
		}
		for (var e : p.updated().entrySet()) {
			if (ids.contains(e.getKey())) {
				entries.remove(e.getKey()); // settled and released
			} else {
				entries.put(e.getKey(), e.getValue());
			}
		}
	}

	/** A fresh instant placement of {@code v} at {@code min} on a copy of {@code base}'s world (the E1 reference). */
	static DeltaModel fresh(DeltaModel base, Version v, int[] min, int turns) {
		DeltaModel m = new DeltaModel();
		m.world.putAll(base.world);
		m.place(v, min, turns);
		return m;
	}

	/** The positions where two models' worlds differ within {@code box} grown by 8. */
	static List<Long> diff(DeltaModel a, DeltaModel b, Anchors.Bounds box) {
		List<Long> out = new ArrayList<>();
		Anchors.Bounds g = new Anchors.Bounds(box.minX() - 8, box.minY() - 8, box.minZ() - 8, box.maxX() + 8, box.maxY() + 8, box.maxZ() + 8);
		for (long p : positions(g)) {
			if (!a.at(p).equals(b.at(p))) {
				out.add(p);
			}
		}
		return out;
	}

	static Version randomChainVersion(Random r, int n, Map<Long, BlockState> design) {
		return Version.of(n, design);
	}
}
