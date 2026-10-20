package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.JournalNbt;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.Pt;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.journal.UpdateMask;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Reconcile;
import dev.larattalabs.architect.site.UmtOps.Crash;
import dev.larattalabs.architect.site.UmtOps.Kind;
import dev.larattalabs.architect.site.UmtOps.Op;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ExecutionException;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.WeatheringCopper;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.level.block.state.properties.SlabType;
import org.jspecify.annotations.Nullable;

/**
 * One run of a UMT scenario (docs/UMT.md): the production journal ({@link JournalStore} on disk, {@link WorldJournal.UndoPlanner},
 * {@link WorldJournal#undoTxn}, {@link SiteJournal#begin}/{@link SiteJournal#complete}/{@link SiteJournal#restore}/
 * {@link SiteJournal#writeCells}/{@link SiteJournal#reactivate}/{@link SiteJournal#releaseGroup}, {@code Sites.evidence},
 * {@link Reconcile#decide}, {@link TileCheck#dependent}/{@link TileCheck#keepsGravity}) driven against {@link UmtWorld}. What is
 * modelled here is the glue between those calls: the P1-P8 and R1-R5 sequencing of PlaceJob/InfraJob/RestoreJob/Groups, their saved
 * state, the world-start settle loop of {@code Sites.reconcile}, and a structure template's placement. Each modelled step names the
 * production code it follows.
 */
final class UmtSim {
	/** A crash: the JVM halts here (thrown up to the operation, which restarts the world). */
	static final class Halt extends RuntimeException {
		Halt(String where) {
			super(where, null, false, false);
		}
	}

	/** A site, road or region record (Sites / Infras / RegionsImpl), saved at each change (the records file). */
	static final class Rec {
		final String id;
		final Kind kind;
		final int group;
		final Anchors.Bounds box;
		final int order;
		boolean placing = true;
		boolean pending;
		/** Drift and edits are aimed at its cells. */
		Rec(String id, Kind kind, int group, Anchors.Bounds box, int order) {
			this.id = id;
			this.kind = kind;
			this.group = group;
			this.box = box;
			this.order = order;
		}

		Rec copy() {
			Rec r = new Rec(id, kind, group, box, order);
			r.placing = placing;
			r.pending = pending;
			return r;
		}

		@Override
		public String toString() {
			return id + (placing ? "(placing)" : "") + (pending ? "(pending)" : "");
		}
	}

	/** A saved removal (the queue file): a single site's RestoreJob, or a Groups removal. */
	static final class Job {
		final List<String> sites = new ArrayList<>();
		/** Groups: the undo group once R2 was submitted (Groups.committed saves it before the commit is durable). RestoreJob: its group. */
		@Nullable String undo;
		final boolean group;

		Job(boolean group) {
			this.group = group;
		}

		Job copy() {
			Job j = new Job(group);
			j.sites.addAll(sites);
			j.undo = undo;
			return j;
		}
	}

	final UmtOps.Scenario sc;
	final Path dir;
	final UmtWorld initial;
	UmtWorld world;
	JournalStore store;
	final Map<String, Rec> recs = new LinkedHashMap<>();
	final List<Job> jobs = new ArrayList<>();
	/** Cells a player changed (and what their changes set off): not judged by the final comparison. */
	final LongOpenHashSet tainted = new LongOpenHashSet();
	final List<String> trace = new ArrayList<>();
	/** Invariant violations found on the way (a standing site's cell overwritten by another's removal, ...). */
	final List<String> violations = new ArrayList<>();
	private int nextRec = 1;
	private int nextGroupUndo = 1;
	private long clock = 1_000_000L;

	UmtSim(UmtOps.Scenario sc, Path dir) throws IOException {
		this.sc = sc;
		this.dir = dir;
		this.initial = UmtWorld.generate(sc.worldSeed());
		this.world = initial.copy();
		world.autosave();
		Files.createDirectories(dir);
		this.store = JournalStore.open(dir);
		WorldJournal.install(store, dir);
		WorldJournal.clock = () -> clock;
		JournalStore.ptSource = this::annotate;
	}

	/** Releases the statics (the store closes). */
	void close() {
		JournalStore.faultHook = null;
		JournalStore.ptSource = null;
		WorldJournal.clock = System::currentTimeMillis;
		WorldJournal.install(null, null);
		UpdateMask.end();
		FluidRearm.clear();
		store.close();
	}

	// ------------------------------------------------------------------ the run

	/** Runs the scenario, then removes everything left and settles; returns the violations (empty: exact). */
	List<String> run() throws Exception {
		int i = 0;
		for (Op op : sc.ops()) {
			trace.add("#" + i++ + " " + op);
			try {
				apply(op);
			} catch (Halt h) {
				trace.add("  crash at " + h.getMessage());
				restart(true);
			}
			if (violations.size() > 20) {
				break;
			}
		}
		finish();
		return violations;
	}

	void apply(Op op) throws Exception {
		switch (op) {
			case UmtOps.Place p -> place(p);
			case UmtOps.Remove r -> {
				List<Rec> st = standing();
				if (!st.isEmpty()) {
					Rec x = st.get(Math.floorMod(r.ordinal(), st.size()));
					if (x.kind == Kind.TILE) {
						removeGroup(List.of(x), r.crash()); // a region is removed as its group (Groups)
					} else {
						remove(x, r.crash());
					}
				}
			}
			case UmtOps.RemoveGroup g -> {
				List<Rec> members = standing().stream().filter(x -> x.group == g.group()).toList();
				if (!members.isEmpty()) {
					removeGroup(members, g.crash());
				}
			}
			case UmtOps.Drift d -> drift(d);
			case UmtOps.Edit e -> edit(e);
			case UmtOps.Autosave a -> world.autosave();
			case UmtOps.Restart r -> restart(false);
		}
	}

	List<Rec> standing() {
		return recs.values().stream().filter(r -> !r.placing && !r.pending).toList();
	}

	/** The end: every standing record removed (one by one, last placed first), two clean restarts, then the checks. */
	void finish() throws Exception {
		trace.add("finish");
		for (int round = 0; round < 3; round++) {
			finishRound();
			if (standing().isEmpty()) {
				break;
			}
		}
		checks();
	}

	private void finishRound() throws Exception {
		for (int guard = 0; guard < 50; guard++) {
			List<Rec> st = new ArrayList<>(standing());
			if (st.isEmpty()) {
				break;
			}
			Rec x = st.get(st.size() - 1);
			if (x.kind == Kind.TILE) {
				removeGroup(List.of(x), null);
			} else {
				remove(x, null);
			}
		}
		restart(false);
		restart(false);
	}

	private void checks() {
		for (Rec x : recs.values()) {
			Sites.Evidence ev = kept.get(x.id);
			boolean f1 = ev != null && Boolean.FALSE.equals(ev.restored()) && Boolean.FALSE.equals(ev.stands());
			violations.add((f1 ? "[F1] " : "") + "record left after everything was removed and settled: " + x + (ev != null ? " (kept on " + ev + ")" : ""));
		}
		List<String> entries = new ArrayList<>();
		store.index().entries().values().forEach(m -> {
			Sites.Evidence ev = kept.get(m.site());
			boolean f1 = ev != null && Boolean.FALSE.equals(ev.restored()) && Boolean.FALSE.equals(ev.stands());
			entries.add((f1 ? "[F1] " : "") + m.id() + " " + m.kind() + " " + m.site() + " " + m.status());
		});
		for (String e : entries) {
			violations.add((e.startsWith("[F1] ") ? "[F1] " : "") + "journal entry left after everything was removed and settled: " + e.replace("[F1] ", ""));
		}
		Map<String, List<String>> byTag = new java.util.TreeMap<>();
		for (String c : world.diff(initial, tainted::contains)) {
			String[] xyz = c.substring(0, c.indexOf(':')).split(",");
			long p = BlockPos.asLong(Integer.parseInt(xyz[0]), Integer.parseInt(xyz[1]), Integer.parseInt(xyz[2]));
			byTag.computeIfAbsent(tag(p), k -> new ArrayList<>()).add(c);
		}
		byTag.forEach((t, d) -> violations.add(t + "the world is not the world before everything (" + d.size() + " cell(s)): " + d.subList(0, Math.min(12,
			d.size()))));
	}

	private boolean rolledBackRestored(String siteId, String g) throws IOException {
		for (JournalStore.Meta m : SiteJournal.undone(siteId, g)) {
			for (long k : m.sections()) {
				SectionCells sc = store.section(m.id(), k);
				for (int i = 0; sc != null && i < sc.size(); i++) {
					Value w = sc.written(i);
					if (w != null && WorldJournal.state(w).getBlock() != world.get(sc.pos(i)).getBlock()) {
						return false;
					}
				}
			}
		}
		return true;
	}

	/** Whether {@code p} is a worldgen gravity block or under one in its column. */
	private boolean fallsInto(long p) {
		for (int y = BlockPos.getY(p); y <= UmtWorld.Y1; y++) {
			if (initial.get(BlockPos.asLong(BlockPos.getX(p), y, BlockPos.getZ(p))).getBlock() instanceof net.minecraft.world.level.block.FallingBlock) {
				return true;
			}
		}
		return false;
	}

	/** Positions some entry wrote as a dirt path (its after), or that were a dirt path before anything. */
	final LongOpenHashSet pathAfter = new LongOpenHashSet();
	/** Positions some entry wrote a gravity block at, and the cells below them. */
	final LongOpenHashSet fallAfter = new LongOpenHashSet();
	/** The evidence a pending record was last kept on (KEEP at a start). */
	final Map<String, Sites.Evidence> kept = new LinkedHashMap<>();
	/** Sites a group reactivation brought back although their own cells did not show them (F6). */
	final java.util.Set<String> phantom = new java.util.HashSet<>();
	/** Sites whose rollback was kept unsettled (F5). */
	final java.util.Set<String> f5 = new java.util.HashSet<>();

	/**
	 * The finding a world difference belongs to (docs/UMT.md "Findings"), or "" (an unexplained one):
	 * F2 a restored gravity block that hung over a free cell fell (its column); LP a dirt path turned to dirt.
	 */
	String tag(long p) {
		int x = BlockPos.getX(p);
		int z = BlockPos.getZ(p);
		for (int y = UmtWorld.Y0 + 1; y <= UmtWorld.Y1; y++) {
			long q = BlockPos.asLong(x, y, z);
			if (initial.get(q).getBlock() instanceof net.minecraft.world.level.block.FallingBlock && net.minecraft.world.level.block.FallingBlock.isFree(initial.get(
				BlockPos.offset(q, Direction.DOWN)))) {
				int top = y;
				while (initial.get(BlockPos.asLong(x, top + 1, z)).getBlock() instanceof net.minecraft.world.level.block.FallingBlock) {
					top++;
				}
				if (BlockPos.getY(p) <= top) {
					return "[F2] ";
				}
			}
		}
		for (String id : f5) {
			Rec rb = recs.get(id);
			if (rb != null && rb.box.contains(BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p))) {
				return "[F5] ";
			}
		}
		for (String id : kept.keySet()) {
			Rec rb = recs.get(id);
			if (rb != null && f5.contains(id) && rb.box.contains(BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p))) {
				return "[F5] ";
			}
		}
		BlockState now = world.get(p);
		if (fallsInto(p) || now.getBlock() instanceof net.minecraft.world.level.block.FallingBlock
			|| fallAfter.contains(p)) {
			return "[F3] ";
		}
		if ((pathAfter.contains(p) || initial.get(p).is(Blocks.DIRT_PATH)) && (now.is(Blocks.DIRT) || now.is(Blocks.GRASS_BLOCK))) {
			return "[LP] ";
		}
		if (reverted.contains(p)) {
			return "[UC] "; // a crash lost world writes the journal had already recorded (unsaved chunks)
		}
		return "";
	}

	// ------------------------------------------------------------------ placement (P1-P8)

	void place(UmtOps.Place p) throws Exception {
		String id = switch (p.kind()) {
			case SITE -> "s";
			case LOT -> "lot";
			case ROAD -> "r";
			case TILE -> "t";
		} + nextRec++;
		Random r = new Random(p.design());
		int y0 = UmtWorld.GROUND - 1;
		Anchors.Bounds box = new Anchors.Bounds(p.x(), y0, p.z(), p.x() + p.w() - 1, y0 + p.h(), p.z() + p.d() - 1);
		Rec rec = new Rec(id, p.kind(), p.group(), box, nextRec);
		switch (p.kind()) {
			case SITE, LOT -> placeSite(rec, r, p.crash(), p.kind() == Kind.LOT);
			case ROAD, TILE -> placeCells(rec, r, p.crash());
		}
	}

	private void crashPoint(@Nullable Crash c, String point) {
		if (c != null && c.point().equals(point) && c.io() == null) {
			if (c.save()) {
				world.autosave();
			}
			throw new Halt(point);
		}
	}

	/** Submits a commit and waits for it; a crash armed at {@code point}'s I/O step {@code io} halts inside (or right after) it. */
	private void commit(JournalStore.Txn t, @Nullable Crash c, String point) throws Exception {
		boolean armed = c != null && c.point().equals(point) && c.io() != null;
		if (armed) {
			if (c.save()) {
				world.autosave();
			}
			String io = c.io();
			JournalStore.faultHook = step -> {
				if (step.startsWith(io)) {
					throw new IllegalStateException("UMT kill at " + step);
				}
			};
		}
		try {
			store.submit(t).get();
		} catch (ExecutionException e) {
			if (!armed) {
				throw e;
			}
		} finally {
			JournalStore.faultHook = null;
		}
		if (armed) {
			throw new Halt(point + "/" + c.io());
		}
	}

	private void placeSite(Rec rec, Random r, @Nullable Crash c, boolean lot) throws Exception {
		Anchors.Bounds b = rec.box;
		Map<Long, BlockState> design = new LinkedHashMap<>();
		Map<Long, CompoundTag> data = new LinkedHashMap<>();
		BlockState wall = pick(r, Blocks.OAK_PLANKS, Blocks.COBBLESTONE, Blocks.CUT_COPPER.asList().get(0), Blocks.GLASS, Blocks.STONE_BRICKS);
		BlockState floor = pick(r, Blocks.STONE_BRICKS, Blocks.OAK_PLANKS, Blocks.COPPER_BLOCK.asList().get(0), Blocks.DIRT_PATH, Blocks.FARMLAND, Blocks.GRASS_BLOCK);
		BlockState found = pick(r, Blocks.STONE_BRICKS, Blocks.DIRT, Blocks.SAND, Blocks.COBBLESTONE, Blocks.WATER);
		BlockState roof = r.nextInt(4) == 0 ? Blocks.SAND.defaultBlockState() : r.nextBoolean() ? Blocks.OAK_SLAB.defaultBlockState().setValue(SlabBlock.TYPE,
			SlabType.BOTTOM) : Blocks.AIR.defaultBlockState();
		for (int y = b.minY(); y <= b.maxY(); y++) {
			for (int z = b.minZ(); z <= b.maxZ(); z++) {
				for (int x = b.minX(); x <= b.maxX(); x++) {
					long p = BlockPos.asLong(x, y, z);
					boolean edge = x == b.minX() || x == b.maxX() || z == b.minZ() || z == b.maxZ();
					BlockState s;
					if (y == b.minY()) {
						s = found;
					} else if (y == b.minY() + 1) {
						s = floor;
					} else if (y == b.maxY() && b.maxY() > b.minY() + 2) {
						s = roof;
					} else if (edge) {
						s = r.nextInt(10) == 0 ? Blocks.LANTERN.defaultBlockState() : wall;
					} else {
						s = Blocks.AIR.defaultBlockState();
					}
					design.put(p, s);
				}
			}
		}
		// a door in a wall (two halves: Restore.halves), a chest with items (block entity data)
		if (b.maxY() - b.minY() >= 4 && r.nextBoolean()) {
			int dx = b.minX() + (b.maxX() - b.minX()) / 2;
			design.put(BlockPos.asLong(dx, b.minY() + 2, b.minZ()), Blocks.OAK_DOOR.defaultBlockState().setValue(DoorBlock.HALF, DoubleBlockHalf.LOWER));
			design.put(BlockPos.asLong(dx, b.minY() + 3, b.minZ()), Blocks.OAK_DOOR.defaultBlockState().setValue(DoorBlock.HALF, DoubleBlockHalf.UPPER));
		}
		if (b.maxX() - b.minX() >= 2 && b.maxZ() - b.minZ() >= 2 && b.maxY() - b.minY() >= 3 && r.nextBoolean()) {
			long cp = BlockPos.asLong(b.minX() + 1, b.minY() + 2, b.minZ() + 1);
			design.put(cp, Blocks.CHEST.defaultBlockState());
			data.put(cp, UmtWorld.chestNbt(cp, "minecraft:apple", 1 + r.nextInt(5)));
		}
		JsonObject meta = new JsonObject();
		meta.addProperty("id", rec.id);
		LongOpenHashSet masked = new LongOpenHashSet();
		int mx = b.minX() + r.nextInt(b.maxX() - b.minX() + 1);
		int mz = b.minZ() + r.nextInt(b.maxZ() - b.minZ() + 1);
		if (lot) {
			// an irrigation cell holds the farm's water (IRR writes it, outside the lot's entry): never ground vanilla converts or a
			// gravity block (UMT leaves the cell as it is, so it picks one that a write beside it can't change)
			BlockState mc = world.get(BlockPos.asLong(mx, b.minY() + 1, mz));
			lot = !(mc.is(Blocks.DIRT_PATH) || mc.is(Blocks.FARMLAND) || mc.getBlock() instanceof net.minecraft.world.level.block.FallingBlock);
		}
		if (lot) {
			// (6c IRR) the lot's irrigation cells: never its own (LotMask), never written by its placement
			JsonArray cells = new JsonArray();
			cells.add(mx);
			cells.add(mz);
			cells.add(b.minY() + 1);
			cells.add(b.minY() + 1);
			JsonObject irr = new JsonObject();
			irr.add("cells", cells);
			JsonObject ext = new JsonObject();
			ext.add(LotMask.EXT, irr);
			meta.add("ext", ext);
			masked.add(BlockPos.asLong(mx, b.minY() + 1, mz));
		}
		// P1: the capture (WorldJournal.capture's values: the cell as the journal keeps it)
		WorldJournal.Captured before = WorldJournal.empty(b);
		fill(before);
		// P3: the PLACING commit (production: SiteJournal.begin, its commit awaited)
		SiteJournal.Placing pl;
		boolean armed = c != null && c.point().equals("P3") && c.io() != null;
		if (armed) {
			if (c.save()) {
				world.autosave();
			}
			String io = c.io();
			JournalStore.faultHook = step -> {
				if (step.startsWith(io)) {
					throw new IllegalStateException("UMT kill at " + step);
				}
			};
		}
		try {
			pl = SiteJournal.begin(null, UmtWorld.DIM_ID, rec.id, WorldJournal.SITE, group(rec), b, List.of(), new long[0], meta, new int[0], before);
			try {
				pl.commit.get();
			} catch (ExecutionException e) {
				if (!armed) {
					throw e;
				}
			}
		} finally {
			JournalStore.faultHook = null;
		}
		if (armed) {
			throw new Halt("P3/" + c.io());
		}
		crashPoint(c, "K2");
		// P4: the record, placing
		recs.put(rec.id, rec);
		// P5: the template's cells (TemplateWriter, Sites.FLAGS), lot cells skipped
		int n = 0;
		for (var e : design.entrySet()) {
			if (masked.contains(e.getKey().longValue())) {
				continue;
			}
			if (c != null && c.point().equals("P5") && n++ == c.n()) {
				world.tick();
				crashPoint(c, "P5");
			}
			if (e.getValue().is(Blocks.DIRT_PATH)) {
				pathAfter.add(e.getKey().longValue());
			}
			if (e.getValue().getBlock() instanceof net.minecraft.world.level.block.FallingBlock) {
				for (long q = e.getKey(); BlockPos.getY(q) > UmtWorld.Y0 - 4; q = BlockPos.offset(q, Direction.DOWN)) {
					fallAfter.add(q);
				}
			}
			world.write(e.getKey(), e.getValue(), data.get(e.getKey()), Sites.FLAGS);
		}
		world.tick();
		crashPoint(c, "P6");
		// P6-P7: the after capture, every PLACING entry ACTIVE (SiteJournal.complete)
		WorldJournal.Captured after = WorldJournal.empty(b);
		fill(after);
		armed = c != null && c.point().equals("P7") && c.io() != null;
		if (armed) {
			commitFault(c);
		}
		try {
			SiteJournal.complete(rec.id, after, null).get();
		} catch (ExecutionException e) {
			if (!armed) {
				throw e;
			}
		} finally {
			JournalStore.faultHook = null;
		}
		if (armed) {
			throw new Halt("P7/" + c.io());
		}
		crashPoint(c, "P8");
		rec.placing = false;
		trace.add("  placed " + rec.id + " " + b);
	}

	private void commitFault(Crash c) {
		if (c.save()) {
			world.autosave();
		}
		String io = c.io();
		JournalStore.faultHook = step -> {
			if (step.startsWith(io)) {
				throw new IllegalStateException("UMT kill at " + step);
			}
		};
	}

	private void fill(WorldJournal.Captured cap) {
		Anchors.Bounds b = cap.box();
		for (int y = b.minY(); y <= b.maxY(); y++) {
			for (int z = b.minZ(); z <= b.maxZ(); z++) {
				for (int x = b.minX(); x <= b.maxX(); x++) {
					cap.values()[cap.index(x, y, z)] = world.value(BlockPos.asLong(x, y, z));
				}
			}
		}
	}

	static BlockState pick(Random r, Block... bs) {
		return bs[r.nextInt(bs.length)].defaultBlockState();
	}

	static @Nullable String group(Rec r) {
		return r.group == 0 ? null : "g" + r.group;
	}

	/** A road or a region tile: a CELL entry with planned afters (InfraJob P3, CELL_FLAGS writes, SiteJournal.complete for P7). */
	private void placeCells(Rec rec, Random r, @Nullable Crash c) throws Exception {
		Anchors.Bounds b = rec.box;
		Map<Long, BlockState> target = new LinkedHashMap<>();
		if (rec.kind == Kind.ROAD) {
			BlockState top = pick(r, Blocks.DIRT_PATH, Blocks.GRAVEL, Blocks.STONE_BRICKS, Blocks.COBBLESTONE);
			for (int z = b.minZ(); z <= b.maxZ(); z++) {
				for (int x = b.minX(); x <= b.maxX(); x++) {
					target.put(BlockPos.asLong(x, UmtWorld.GROUND, z), top);
					target.put(BlockPos.asLong(x, UmtWorld.GROUND + 1, z), Blocks.AIR.defaultBlockState());
				}
			}
			// lamp posts beside the road's first and last cell
			for (long post : new long[] {BlockPos.asLong(b.minX() - 1, UmtWorld.GROUND + 1, b.minZ()), BlockPos.asLong(b.maxX() + 1, UmtWorld.GROUND + 1,
				b.maxZ())}) {
				if (!UmtWorld.inArena(post) || r.nextBoolean()) {
					continue;
				}
				BlockState ground = world.get(BlockPos.offset(post, Direction.DOWN));
				if (!sc.gen().findings() && (ground.is(Blocks.DIRT_PATH) || ground.is(Blocks.FARMLAND))) {
					continue; // fix/lamp-path: no road post on a dirt path (a finding on main: kept out of the CI set)
				}
				target.put(post, Blocks.OAK_FENCE.defaultBlockState());
				target.put(BlockPos.offset(post, Direction.UP), Blocks.LANTERN.defaultBlockState());
			}
		} else {
			int op = r.nextInt(5);
			for (int z = b.minZ(); z <= b.maxZ(); z++) {
				for (int x = b.minX(); x <= b.maxX(); x++) {
					int top = UmtWorld.Y1;
					while (top > UmtWorld.Y0 && world.get(BlockPos.asLong(x, top, z)).isAir()) {
						top--;
					}
					long tp = BlockPos.asLong(x, top, z);
					switch (op) {
						case 0 -> { // lower
							target.put(tp, Blocks.AIR.defaultBlockState());
							target.put(BlockPos.offset(tp, Direction.DOWN), Blocks.AIR.defaultBlockState());
						}
						case 1 -> target.put(BlockPos.offset(tp, Direction.UP), Blocks.DIRT.defaultBlockState()); // raise
						case 2 -> target.put(tp, pick(r, Blocks.DIRT_PATH, Blocks.GRAVEL, Blocks.COBBLESTONE)); // pave
						case 3 -> target.put(tp, Blocks.WATER.defaultBlockState()); // a pond's sources
						default -> target.put(tp, pick(r, Blocks.COPPER_BLOCK.asList().get(0), Blocks.FARMLAND, Blocks.SAND));
					}
				}
			}
			// TileCheck: cells owned by anything but this region's own tiles are skipped; no-op cells too
			target.entrySet().removeIf(e -> !UmtWorld.inArena(e.getKey()) || ownedByOthers(e.getKey(), rec) || world.get(e.getKey()) == e.getValue());
			// TileCheck stage 3: what stands on a changed cell goes too, but a supported gravity block (keepsGravity)
			Map<Long, BlockState> deps = new LinkedHashMap<>();
			for (var e : List.copyOf(target.entrySet())) {
				long q = e.getKey();
				for (int y = BlockPos.getY(q) + 1; y <= UmtWorld.Y1; y++) {
					long a = BlockPos.asLong(BlockPos.getX(q), y, BlockPos.getZ(q));
					BlockState us = world.get(a);
					if (!TileCheck.dependent(us)) {
						break;
					}
					if (y == BlockPos.getY(q) + 1 && keepsGravity(us, world.get(q), e.getValue())) {
						break;
					}
					if (target.containsKey(a) || ownedByOthers(a, rec)) {
						break;
					}
					deps.put(a, Blocks.AIR.defaultBlockState());
				}
			}
			target.putAll(deps);
		}
		target.entrySet().removeIf(e -> !UmtWorld.inArena(e.getKey()));
		if (target.isEmpty()) {
			return;
		}
		JournalStore s = store;
		long layer = s.newLayer();
		String eid = s.newId();
		List<Cell> cells = new ArrayList<>();
		for (var e : target.entrySet()) {
			cells.add(new Cell(e.getKey(), layer, world.value(e.getKey()), WorldJournal.value(e.getValue())));
		}
		JsonObject meta = new JsonObject();
		meta.addProperty("id", rec.id);
		String kind = rec.kind == Kind.ROAD ? WorldJournal.ROAD : RegionKinds.TERRAIN;
		JournalStore.Txn t = s.begin().label("P3:" + rec.id).create(JournalStore.Meta.header(eid, kind, rec.id, group(rec), UmtWorld.DIM_ID, Policy.CELL,
			layer, Status.PLACING, clock), JournalStore.bySection(cells), new JournalNbt.Head(meta, new int[0]));
		commit(t, c, "P3");
		crashPoint(c, "K2");
		recs.put(rec.id, rec);
		int n = 0;
		for (var e : target.entrySet()) {
			if (c != null && c.point().equals("P5") && n++ == c.n()) {
				crashPoint(c, "P5");
			}
			if (e.getValue().is(Blocks.DIRT_PATH)) {
				pathAfter.add(e.getKey().longValue());
			}
			if (e.getValue().getBlock() instanceof net.minecraft.world.level.block.FallingBlock) {
				for (long q = e.getKey(); BlockPos.getY(q) > UmtWorld.Y0 - 4; q = BlockPos.offset(q, Direction.DOWN)) {
					fallAfter.add(q);
				}
			}
			world.write(e.getKey(), e.getValue(), null, Sites.CELL_FLAGS);
		}
		world.tick();
		crashPoint(c, "P6");
		boolean armed = c != null && c.point().equals("P7") && c.io() != null;
		if (armed) {
			commitFault(c);
		}
		try {
			SiteJournal.complete(rec.id, WorldJournal.empty(new Anchors.Bounds(0, 0, 0, 0, 0, 0)), null).get();
		} catch (ExecutionException e) {
			if (!armed) {
				throw e;
			}
		} finally {
			JournalStore.faultHook = null;
		}
		if (armed) {
			throw new Halt("P7/" + c.io());
		}
		crashPoint(c, "P8");
		rec.placing = false;
		trace.add("  placed " + rec.id + " " + cells.size() + " cell(s)");
	}

	/** The gravity rule the tile writer applies (production {@code TileCheck.keepsGravity}); a test may swap it to show a seed goes red. */
	static java.util.function.BiPredicate<BlockState[], BlockState> gravityRule = (a, n) -> TileCheck.keepsGravity(a[0], a[1], n);

	private static boolean keepsGravity(BlockState above, BlockState now, BlockState next) {
		return gravityRule.test(new BlockState[] {above, now}, next);
	}

	/** TileCheck.owners: a cell of an active entry other than this region's own tile entries (leaves aside). */
	private boolean ownedByOthers(long p, Rec rec) {
		long key = Sections.key(p);
		int i = Sections.index(p);
		for (String id : store.inSection(UmtWorld.DIM_ID, key)) {
			JournalStore.Meta m = store.meta(id);
			if (m == null || !m.active() || m.kind().equals(WorldJournal.LEAVES)) {
				continue;
			}
			boolean mine = RegionKinds.TERRAIN.equals(m.kind()) && m.group() != null && m.group().equals(group(rec));
			try {
				SectionCells sc = store.section(id, key);
				if (sc != null && sc.has(i) && !mine) {
					return true;
				}
			} catch (IOException e) {
				return true;
			}
		}
		return false;
	}

	// ------------------------------------------------------------------ removal (R1-R5)

	/** A single site or road removal (RestoreJob: plan, commit, the record pending, the writes; settled at the next start). */
	void remove(Rec x, @Nullable Crash c) throws Exception {
		String g = "u:remove-" + x.id + ":" + nextGroupUndo++;
		clock += 10;
		Job job = new Job(false);
		job.sites.add(x.id);
		job.undo = g;
		jobs.add(job); // the job is in the queue from the start (RestoreJob.fromJson decides its phase from the journal)
		List<String> ids = SiteJournal.active(x.id).stream().map(JournalStore.Meta::id).toList();
		if (ids.isEmpty()) {
			jobs.remove(job);
			return;
		}
		WorldJournal.UndoWork w = plan(ids, g);
		commit(WorldJournal.undoTxn(w), c, "R2");
		crashPoint(c, "K6");
		x.pending = true; // R3
		writeRestore(x.id, g, c, 0);
		crashPoint(c, "R5");
		jobs.remove(job);
		checkStanding("after removing " + x.id);
		trace.add("  removed " + x.id + " (" + g + ")");
	}

	/** A Groups removal: one plan over every member, one commit, records pending, the writes last placed first. */
	void removeGroup(List<Rec> members, @Nullable Crash c) throws Exception {
		List<Rec> sorted = new ArrayList<>(members);
		sorted.sort((a, b) -> Integer.compare(b.order, a.order));
		Job job = new Job(true);
		sorted.forEach(m -> job.sites.add(m.id));
		jobs.add(job);
		String g = "u:group-" + nextGroupUndo++;
		clock += 10;
		List<String> ids = new ArrayList<>();
		for (Rec m : sorted) {
			SiteJournal.active(m.id).forEach(e -> ids.add(e.id()));
		}
		if (ids.isEmpty()) {
			jobs.remove(job);
			return;
		}
		WorldJournal.UndoWork w = plan(ids, g);
		// Groups.committed: the removal is saved with its undo group as the commit is submitted (before it is durable)
		job.undo = g;
		commit(WorldJournal.undoTxn(w), c, "R2");
		crashPoint(c, "K6");
		groupWrites(job, c);
		checkStanding("after removing group " + job.sites);
		trace.add("  removed group " + job.sites + " (" + g + ")");
	}

	/** Groups.tick after the commit (or after a load): pendAll, then each member's restore, last placed first. */
	private void groupWrites(Job job, @Nullable Crash c) throws Exception {
		for (String id : job.sites) {
			Rec m = recs.get(id);
			if (m != null) {
				m.pending = true;
			}
		}
		int k = 0;
		for (String id : List.copyOf(job.sites)) {
			if (c != null && c.point().equals("K7") && k++ == c.n() % Math.max(1, job.sites.size())) {
				writeRestore(id, job.undo, c, 0);
			} else {
				writeRestore(id, job.undo, null, 0);
			}
			job.sites.remove(id);
		}
		crashPoint(c, "R5");
		jobs.remove(job);
	}

	private WorldJournal.UndoWork plan(List<String> ids, String g) throws IOException {
		WorldJournal.UndoPlanner p = new WorldJournal.UndoPlanner(UmtWorld.DIM_ID, world::holdsOurs, ids, g);
		p.step(Long.MAX_VALUE);
		return p.work();
	}

	/**
	 * R4 of one site (RestoreJob's writes): SiteJournal.restore's pre cells, its template (TemplateWriter, Sites.FLAGS, under the
	 * restore's mask, records restored), its cells and halves (SiteJournal.writeCells / fixHalves into the world), then the ticks.
	 * A crash at K7 halts after {@code c.n()} template cells.
	 */
	void writeRestore(String siteId, String g, @Nullable Crash c, int unused) throws Exception {
		SiteJournal.Restore r = SiteJournal.restore(null, siteId, g);
		trace.add("  restore " + siteId + " " + g + ": box " + r.box() + ", template " + (r.template() == null ? 0 : r.template().getListOrEmpty("blocks").size())
			+ ", cells " + r.cells().size() + ", pre " + r.pre().size() + ", holes " + r.holes() + ", entries " + SiteJournal.undone(siteId, g).stream().map(m -> m.id()
				+ ":" + m.kind() + ":" + m.status()).toList());
		world.restoring = r.pts();
		try {
			SiteJournal.writeCells(world, r.pre()); // Restore.writing's record restore is the world's (world.restoring): Placed can't load without the game
			if (r.template() != null && r.box() != null) {
				if (r.mask() != null) {
					UpdateMask.begin(r.mask());
				}
				try {
					CompoundTag t = r.template();
					ListTag pal = t.getListOrEmpty("palette");
					ListTag blocks = t.getListOrEmpty("blocks");
					for (int i = 0; i < blocks.size(); i++) {
						if (c != null && c.point().equals("K7") && i == c.n() % Math.max(1, blocks.size())) {
							world.tick();
							crashPoint(c, "K7");
						}
						CompoundTag bt = blocks.getCompoundOrEmpty(i);
						ListTag pos = bt.getListOrEmpty("pos");
						long p = BlockPos.asLong(r.box().minX() + pos.getIntOr(0, 0), r.box().minY() + pos.getIntOr(1, 0), r.box().minZ() + pos.getIntOr(2, 0));
						BlockState s = WorldJournal.state(new Value(pal.getCompoundOrEmpty(bt.getIntOr("state", 0)), null));
						world.write(p, s, bt.getCompound("nbt").orElse(null), Sites.FLAGS);
					}
				} finally {
					UpdateMask.end();
				}
			}
			world.tick();
			SiteJournal.writeCells(world, r.cells());
			SiteJournal.fixHalves(world, r.halves());
		} finally {
			world.restoring = null;
		}
		world.tick();
		if (c != null && c.point().equals("K7")) {
			crashPoint(c, "K7");
		}
	}

	/**
	 * Every standing record's journal cells that are on top of their stacks still hold their {@code after} (the production rule,
	 * {@code WorldJournal.holds}), unless a player or the world changed them: no removal wrote over a standing site.
	 */
	void checkStanding(String when) throws IOException {
		for (Rec x : standing()) {
			for (JournalStore.Meta m : SiteJournal.active(x.id)) {
				Journal.Entry e = store.load(m.id());
				for (Cell cell : e.cells()) {
					if (cell.after() == null || tainted.contains(cell.pos()) || drifted.contains(cell.pos()) || reverted.contains(cell.pos())) {
						continue;
					}
					List<WorldJournal.Layer> st = WorldJournal.stack(UmtWorld.DIM_ID, cell.pos());
					if (st.isEmpty() || !st.get(st.size() - 1).meta().id().equals(m.id())) {
						continue;
					}
					if (!world.holdsOurs(cell.pos(), cell.after())) {
						BlockState now = world.get(cell.pos());
						boolean lp = WorldJournal.state(cell.after()).is(Blocks.DIRT_PATH) && (now.is(Blocks.DIRT) || now.is(Blocks.GRASS_BLOCK));
						boolean f3 = now.getBlock() instanceof net.minecraft.world.level.block.FallingBlock || WorldJournal.state(cell.after())
							.getBlock() instanceof net.minecraft.world.level.block.FallingBlock;
						violations.add((lp ? "[LP] " : f3 ? "[F3] " : phantom.contains(x.id) ? "[F6] " : f7.contains(x.id) ? "[F7] " : reverted.isEmpty() ? "" : "[UC] ")
							+ when + ": standing " + x.id + "'s cell " + BlockPos.of(cell.pos()).toShortString() + " should hold " + cell.after()
							+ ", holds " + world.get(cell.pos()));
					}
				}
			}
		}
	}

	// ------------------------------------------------------------------ the world changing by itself, players

	/** Cells the world changed by itself: an undo must put them back (they are not tainted), but a standing check skips them. */
	final LongOpenHashSet drifted = new LongOpenHashSet();
	/** Cells a crash put back to the last autosave. */
	final LongOpenHashSet reverted = new LongOpenHashSet();

	void drift(UmtOps.Drift d) throws IOException {
		List<Rec> st = standing();
		if (st.isEmpty()) {
			return;
		}
		Random r = new Random(d.seed());
		Rec x = st.get(Math.floorMod(d.ordinal(), st.size()));
		List<Long> cells = topCells(x);
		for (int tries = 0; tries < 12 && !cells.isEmpty(); tries++) {
			long p = cells.get(r.nextInt(cells.size()));
			BlockState s = world.get(p);
			BlockState to = null;
			var next = WeatheringCopper.getNext(s.getBlock());
			if (next.isPresent()) {
				to = next.get().withPropertiesOf(s); // weathering
			} else if (s.is(Blocks.FARMLAND)) {
				to = Blocks.DIRT.defaultBlockState(); // dried, trampled
			} else if (s.is(Blocks.DIRT)) {
				to = Blocks.GRASS_BLOCK.defaultBlockState(); // grass spread
			} else if (s.is(Blocks.GRASS_BLOCK)) {
				to = Blocks.DIRT.defaultBlockState();
			} else if (s.is(Blocks.WATER) && s.getFluidState().isSource()) {
				to = Blocks.ICE.defaultBlockState(); // froze
			} else if (s.isAir() && nextToWater(p)) {
				to = Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 7); // flowed in
			} else if (s.getBlock() instanceof WeatheringCopper && r.nextBoolean()) {
				Block waxed = net.minecraft.world.item.HoneycombItem.WAXABLES.get().get(s.getBlock());
				if (waxed != null) {
					to = waxed.withPropertiesOf(s); // a player waxed it in place: placed nothing, still ours (CU)
				}
			}
			if (to != null) {
				world.natural(p, to);
				drifted.add(p);
				trace.add("  drift " + BlockPos.of(p).toShortString() + " " + s + " -> " + to);
				return;
			}
		}
	}

	private boolean nextToWater(long p) {
		for (Direction d : Direction.values()) {
			if (d != Direction.DOWN && world.get(BlockPos.offset(p, d)).getFluidState().is(net.minecraft.tags.FluidTags.WATER)) {
				return true;
			}
		}
		return false;
	}

	void edit(UmtOps.Edit e) throws IOException {
		List<Rec> st = standing();
		if (st.isEmpty()) {
			return;
		}
		Random r = new Random(e.seed());
		Rec x = st.get(Math.floorMod(e.ordinal(), st.size()));
		List<Long> cells = topCells(x);
		if (cells.isEmpty()) {
			return;
		}
		long p = cells.get(r.nextInt(cells.size()));
		int before = world.natural.size();
		Pt rec = new Pt(new java.util.UUID(7L, 7L), null);
		BlockState s = world.get(p);
		String what;
		if (s.isAir()) {
			world.player(p, Blocks.COBBLESTONE.defaultBlockState(), rec, null);
			what = "placed cobblestone";
		} else if (Copper(s) && r.nextBoolean()) {
			world.player(p, Blocks.AIR.defaultBlockState(), null, null);
			world.player(p, Blocks.COPPER_BLOCK.asList().get(3).defaultBlockState(), rec, null);
			what = "mined it, placed oxidized copper";
		} else {
			world.player(p, Blocks.AIR.defaultBlockState(), null, null);
			what = "mined";
		}
		tainted.add(p);
		for (String n : world.natural.subList(before, world.natural.size())) {
			// what the edit set off (a fall): the player's doing too
			String[] xyz = n.substring("natural ".length(), n.indexOf(" -> ")).split(", ");
			tainted.add(BlockPos.asLong(Integer.parseInt(xyz[0]), Integer.parseInt(xyz[1]), Integer.parseInt(xyz[2])));
		}
		trace.add("  edit " + BlockPos.of(p).toShortString() + " " + what);
	}

	private static boolean Copper(BlockState s) {
		return dev.larattalabs.architect.journal.Copper.inChain(s.getBlock());
	}

	/** The cells where one of {@code x}'s active entries is on top. */
	List<Long> topCells(Rec x) throws IOException {
		List<Long> out = new ArrayList<>();
		for (JournalStore.Meta m : SiteJournal.active(x.id)) {
			for (Cell cell : store.load(m.id()).cells()) {
				List<WorldJournal.Layer> st = WorldJournal.stack(UmtWorld.DIM_ID, cell.pos());
				if (!st.isEmpty() && st.get(st.size() - 1).meta().id().equals(m.id()) && UmtWorld.inArena(cell.pos()) && cell.after() != null
					&& world.holdsOurs(cell.pos(), cell.after())) {
					out.add(cell.pos());
				}
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ restart and the world-start settle

	/**
	 * A stop and a start. {@code crash}: the JVM halted (the world goes back to its last autosave; the journal, the records and the
	 * queue file are as last saved); else a clean stop (the world saved). Then the start, as the mod runs it: the journal opens, the
	 * sites check ({@code Sites.reconcile}, modelled around the production evidence and decisions), then the queue resumes.
	 */
	void restart(boolean crash) throws Exception {
		JournalStore.faultHook = null;
		UpdateMask.end();
		if (crash) {
			UmtWorld lost = world.copy();
			world.crash();
			// the writes the crash lost: the journal may still name them (a placement past P7, a removal past R2); the standing check
			// can't judge those cells (Sites.reconcile reports such a site), the final comparison still does
			for (String d : world.diff(lost, p -> false)) {
				String[] xyz = d.substring(0, d.indexOf(':')).split(",");
				reverted.add(BlockPos.asLong(Integer.parseInt(xyz[0]), Integer.parseInt(xyz[1]), Integer.parseInt(xyz[2])));
			}
		} else {
			world.autosave();
		}
		store.close();
		store = JournalStore.open(dir);
		WorldJournal.install(store, dir);
		FluidRearm.clear();
		clock += 1000;
		trace.add("  restart" + (crash ? " (crash)" : "") + ": records " + recs.values() + ", jobs " + jobs.size());
		recoveredNow.clear();
		java.util.Set<String> jobSites = new java.util.HashSet<>();
		for (Job j : jobs) {
			jobSites.addAll(j.sites);
		}
		// K2: journal entries with no record: PLACING ones were never written (released); ACTIVE ones get their record back
		Map<String, List<JournalStore.Meta>> bySite = new LinkedHashMap<>();
		for (JournalStore.Meta m : store.index().entries().values()) {
			if (m.active()) {
				bySite.computeIfAbsent(m.site(), k -> new ArrayList<>()).add(m);
			}
		}
		List<String> releaseNow = new ArrayList<>();
		for (var e : bySite.entrySet()) {
			if (recs.containsKey(e.getKey())) {
				continue;
			}
			if (e.getValue().stream().anyMatch(m -> m.status() == Status.PLACING)) {
				e.getValue().forEach(m -> releaseNow.add(m.id()));
			} else {
				violations.add("restart: " + e.getKey() + " has ACTIVE entries but no record (the model saves records at P4: should not happen)");
			}
		}
		if (!releaseNow.isEmpty()) {
			SiteJournal.releaseGroup(releaseNow);
			store.flush();
		}
		// K6 (Sites.reconcile): a standing record with no active entry but an undone group goes pending (a job's site is left to its job)
		for (Rec x : recs.values()) {
			if (x.placing || x.pending || jobSites.contains(x.id) || !SiteJournal.active(x.id).isEmpty()) {
				continue;
			}
			if (SiteJournal.lastGroup(x.id) != null) {
				x.pending = true;
			}
		}
		// pending records settle on the evidence (production Sites.evidence and Reconcile.decide); a job's site waits for its job
		for (Rec x : List.copyOf(recs.values())) {
			if (!x.pending || jobSites.contains(x.id)) {
				continue;
			}
			String g = SiteJournal.lastGroup(x.id);
			if (g == null) {
				if (!SiteJournal.active(x.id).isEmpty()) {
					x.pending = false; // never undone: stands again ("remove it again")
					trace.add("  settle " + x.id + ": no undo committed, stands again");
				} else {
					recs.remove(x.id);
				}
				continue;
			}
			Sites.Evidence ev = Sites.evidence(world, x.id, g);
			if (g.startsWith("u:rollback-") && ev.restored() == null && ev.stands() == null) {
				// a rolled-back placement's entries have no afters (PLACING): production's evidence reads the record's blueprint grid
				// (ownGrid), which UMT has not; modelled: restored when the world holds every value the rollback wrote
				ev = new Sites.Evidence(rolledBackRestored(x.id, g), false, false);
			}
			List<String> groupIds = SiteJournal.undone(x.id, g).stream().map(JournalStore.Meta::id).toList();
			boolean release;
			boolean recover;
			if (x.kind == Kind.SITE || x.kind == Kind.LOT) {
				Reconcile.Action a = ev.covered() ? Reconcile.Action.RELEASE : Reconcile.decide(false, ev.stands(), ev.restored(), Reconcile.Overlap.NONE,
					false, null);
				release = a == Reconcile.Action.RELEASE;
				recover = a == Reconcile.Action.RECOVER;
				trace.add("  settle " + x.id + " " + g + ": " + ev + " -> " + a);
			} else {
				release = ev.covered() || Boolean.TRUE.equals(ev.restored()) || ev.restored() == null && ev.stands() == null;
				recover = !release && Boolean.TRUE.equals(ev.stands());
				trace.add("  settle " + x.id + " " + g + ": " + ev + " -> " + (release ? "RELEASE" : recover ? "RECOVER" : "KEEP"));
			}
			if (release) {
				SiteJournal.releaseGroup(groupIds);
				store.flush();
				recs.remove(x.id);
			} else if (recover) {
				// SiteJournal.reactivate takes back the whole undo group: other sites' members too, whatever their own evidence says
				for (JournalStore.Meta m : store.find(mm -> mm.status() == Status.UNDONE && g.equals(mm.undoGroup()) && !mm.site().equals(x.id))) {
					Sites.Evidence other = Sites.evidence(world, m.site(), g);
					if (!Boolean.TRUE.equals(other.stands()) && phantom.add(m.site())) {
						violations.add("[F6] settling " + x.id + " (stands) reactivated its whole undo group " + g + ": " + m.site() + " comes back too on "
							+ other + " (its own cells don't show it)");
					}
				}
				SiteJournal.reactivate(g);
				store.flush();
				x.pending = false;
				recoveredNow.add(x.id);
			} else {
				kept.put(x.id, ev);
				boolean lost = false;
				for (long q : reverted) {
					lost |= x.box.contains(BlockPos.getX(q), BlockPos.getY(q), BlockPos.getZ(q));
				}
				if ((g.startsWith("u:rollback-") || lost) && Boolean.FALSE.equals(ev.stands()) && f5.add(x.id)) {
					violations.add("[F5] " + (g.startsWith("u:rollback-") ? "a rolled-back placement " : "a removed site ") + x.id + " is kept unsettled on " + ev
						+ ": the writes of its restore were lost to a crash before the world saved (its job had ended), so it is neither restored nor "
						+ "standing, and the settle keeps it so at every start");
				}
			}
		}
		// placements in the queue: a placing record rolls back (Placement: its job resumes or rolls back; UMT rolls back)
		for (Rec x : List.copyOf(recs.values())) {
			if (!x.placing) {
				continue;
			}
			List<JournalStore.Meta> act = SiteJournal.active(x.id);
			if (!act.isEmpty() && act.stream().allMatch(m -> m.status() == Status.ACTIVE)) {
				x.placing = false; // P7 was durable: the job finishes (P8)
				continue;
			}
			// a RestoreJob ROLLBACK: plan, commit, the record pending (R3), the writes; settled at the next start like a removal
			String g = "u:rollback-" + x.id + ":" + nextGroupUndo++;
			List<String> ids = act.stream().map(JournalStore.Meta::id).toList();
			x.placing = false;
			if (ids.isEmpty()) {
				recs.remove(x.id);
				continue;
			}
			WorldJournal.UndoWork w = plan(ids, g);
			store.submit(WorldJournal.undoTxn(w)).get();
			x.pending = true;
			writeRestore(x.id, g, null, 0);
			trace.add("  rolled back " + x.id);
		}
		// removals in the queue resume
		for (Job j : List.copyOf(jobs)) {
			if (j.group) {
				if (j.undo == null) {
					// planned again from the start (R1 is not saved)
					jobs.remove(j);
					List<Rec> members = j.sites.stream().map(recs::get).filter(java.util.Objects::nonNull).toList();
					if (!members.isEmpty()) {
						removeGroup(members, null);
					}
				} else {
					// Groups.Removal.fromJson keeps its undo group as committed; Groups.tick: pendAll, then the writes
					String ug = j.undo;
					boolean committed = j.sites.stream().anyMatch(id -> !SiteJournal.undone(id, ug).isEmpty());
					if (!committed) {
						violations.add("[F4] a resumed group removal of " + j.sites + " found its undo group " + ug + " not in the journal (the R2 commit never "
							+ "reached the disk, Groups.committed saved the removal before it did): it marks the records pending and writes nothing; the "
							+ "removal ends as done with every cell unrestored");
					}
					groupWrites(j, null);
				}
			} else {
				// RestoreJob.fromJson: undone in the journal -> written again from the start; else planned again
				String id = j.sites.get(0);
				Rec x = recs.get(id);
				boolean undone = SiteJournal.entries(id).stream().anyMatch(m -> m.status() == Status.UNDONE && j.undo.equals(m.undoGroup()));
				jobs.remove(j);
				if (x == null) {
					continue;
				}
				if (undone) {
					x.pending = true;
					writeRestore(id, j.undo, null, 0);
				} else if (!x.placing) {
					x.pending = false;
					remove(x, null);
				}
			}
		}
		world.tick();
		if (recoveredNow.size() > 1) {
			f7.addAll(recoveredNow);
		}
	}

	/** Records the settle of this start brought back (RECOVER). */
	final java.util.Set<String> recoveredNow = new java.util.LinkedHashSet<>();
	/** Records brought back with another at the same start (F7: a hand-down to an entry still undone is not given back). */
	final java.util.Set<String> f7 = new java.util.HashSet<>();

	// ------------------------------------------------------------------ PT (JournalStore.ptSource, as Placed.annotate)

	private List<SectionCells> annotate(String dim, java.util.Collection<SectionCells> cells) {
		List<SectionCells> out = new ArrayList<>(cells.size());
		for (SectionCells sc : cells) {
			Pt[] pt = new Pt[sc.size()];
			boolean any = false;
			for (int k = 0; k < sc.size(); k++) {
				Pt rec = world.record(sc.pos(k));
				if (rec != null) {
					pt[k] = rec;
					any = true;
				}
			}
			out.add(any || sc.hasPt() ? sc.withPt(any ? pt : null) : sc);
		}
		return out;
	}

	String report() {
		return sc + "\ntrace:\n" + String.join("\n", trace) + "\nviolations:\n" + String.join("\n", violations);
	}
}
