package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.BedSafety;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.placement.TemplateGrid;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.jspecify.annotations.Nullable;

/**
 * An instant placement written over ticks (docs/CONTRACT.md phase 4d "Ticked placement", phase 4e "Crash safety"). {@link
 * Sites#beginPlacing} runs the checks and the reads; this job then captures the box into the journal (one tick up to 50k
 * cells, else sliced with change tracking), waits for the PLACING commit (P3, off the server thread), records the site as
 * placing (P4) and writes, under the per-tick budget, exactly what the atomic placement ({@code Sites.build}) writes and in its
 * order: the template ({@link TemplateWriter}), the beds bed safety takes out, the foundation fill, the cleared terrain, the
 * approach (clear, fill, path, slabs), the outside halves of cut tall plants; then the drops it caused are cleared and the
 * ticks it held back are scheduled ({@link TickDeferral}); then the {@code after} capture (P6) and the ACTIVE commit (P7)
 * before the record is placed (P8). A construction site's P6 is its target ({@link Builder#planConvert}), and its queued
 * cells are cleared over ticks after the commit.
 *
 * <p>Its state (phase, cursor, the plan's cell lists, placed bits, held ticks) is persisted in the queue file, so a relog
 * resumes where it stopped; the plan is never recomputed from a half-written world.
 */
final class PlaceJob implements Placement.Job {
	static final int TEMPLATE = 0;
	static final int BEDS = 1;
	static final int FILL = 2;
	static final int CLEAR = 3;
	static final int A_CLEAR = 4;
	static final int A_FILL = 5;
	static final int A_PATH = 6;
	static final int A_SLABS = 7;
	static final int PLANTS = 8;
	static final int FINISH = 9;
	static final int DONE = 10;
	/** P1, sliced: the {@code before} capture of a box over 50k cells. */
	static final int CAPTURE = 11;
	/** P3: waiting for the PLACING commit (and a re-capture of positions changed meanwhile). */
	static final int COMMIT = 12;
	/** P4: the record, held leaves, entities removed; then the writes. */
	static final int START = 13;
	/** P6, sliced: the {@code after} capture of a box over 50k cells. */
	static final int AFTER = 14;
	/** P7: waiting for the ACTIVE commit. */
	static final int AFTER_COMMIT = 15;
	/** A construction site's queued cells cleared over ticks (after P7). */
	static final int CONSTRUCTION_CLEAR = 16;
	private static final int CLOCK = 16;

	final String siteId;
	final String dimension;
	final String blueprint;
	final int turns;
	final Anchors.Bounds box;
	final Anchors.Bounds snapBox;
	final BlockPos placePos;
	final int[] fill;
	final int[] clear;
	final int[] aClear;
	final int[] aFill;
	final int[] aPath;
	final int[] aSlabs;
	final long[] plants;
	final List<String> dropsBefore;
	final List<String> notes;
	final List<TickDeferral.Held> held;
	/** The batch item it places (null for a placement outside a batch). */
	final @Nullable String batchId;
	final @Nullable String itemKey;
	int phase = TEMPLATE;
	int cursor;
	final Set<Long> bedCells = new HashSet<>();
	final Set<Long> bedHeads = new HashSet<>();
	@Nullable TemplateWriter writer;
	/** The placing record (P4), made when the job began. */
	@Nullable Site record;
	/** Its journal entries once committed. */
	@Nullable String siteEntry;
	@Nullable String leavesEntry;
	/** The leaves it holds (x, y, z, distance) and the leaf ring, read at P1. */
	List<Integer> heldLeaves = new ArrayList<>();
	int[] ring = new int[0];
	/** P1 in flight (not persisted: a stop before P3 releases and queues again). */
	transient SiteJournal.@Nullable Placing placing;
	transient dev.larattalabs.architect.journal.WorldJournal.@Nullable Captured capture;
	transient dev.larattalabs.architect.journal.@Nullable ChangeTracker tracker;
	int captureCursor;
	/** The commit the job waits for (P3 or P7); null after a load (the stop flushed it). */
	transient java.util.concurrent.@Nullable CompletableFuture<Void> commit;
	/** Nothing was written and no record exists yet (a failure before P4 only fails the item). */
	boolean beforeRecord = true;
	/** A construction site's conversion: its construction record (queue, crate), whether a new crate goes down, its group crate. */
	@Nullable Construction convert;
	boolean newCrate;
	@Nullable String sharedGroup;
	int clearCursor;
	/** The note and bed cells the placement finished with (for P8). */
	@Nullable String finishNote;
	@Nullable String layerOver;
	/** A survival construction site: converted when its last cell is written ({@link Sites#finishPlacing}). */
	boolean construction;
	/** The placing player's UUID, or null. */
	@Nullable String placer;
	/** The approach's end (the crate goes beside it), or null. */
	double @Nullable [] approachEnd;
	/** Set when the job can't go on (its design changed, its level is gone): it is rolled back instead. */
	@Nullable String broken;
	/** The ghost clients see while it places: the template's non-air cells, built as the writer passes them. */
	int @Nullable [] ghostOf;
	int ghostCells;
	int ghostSent;
	final java.util.Set<java.util.UUID> ghostTo = new java.util.HashSet<>();

	/**
	 * The ghost payload (the same as a construction site's): the template's non-air cells over the snapshot box, built up to
	 * the writer's cursor. Null before the writer exists.
	 */
	dev.larattalabs.architect.survival.SiteNet.@Nullable SiteGhost ghost() {
		TemplateWriter w = writer;
		if (w == null) {
			return null;
		}
		int dx = snapBox.maxX() - snapBox.minX() + 1;
		int dz = snapBox.maxZ() - snapBox.minZ() + 1;
		int n = w.cells.size();
		if (ghostOf == null) {
			ghostOf = new int[n];
			int k = 0;
			for (int i = 0; i < n; i++) {
				ghostOf[i] = w.cells.states()[i].isAir() ? -1 : k++;
			}
			ghostCells = k;
		}
		int[] queue = new int[ghostCells];
		int[] states = new int[ghostCells];
		java.util.BitSet built = new java.util.BitSet();
		int done = w.phase == TemplateWriter.SET ? w.cursor : n;
		for (int i = 0; i < n; i++) {
			int j = ghostOf[i];
			if (j < 0) {
				continue;
			}
			int x = w.px + w.cells.off()[i * 3] - snapBox.minX();
			int y = w.py + w.cells.off()[i * 3 + 1] - snapBox.minY();
			int z = w.pz + w.cells.off()[i * 3 + 2] - snapBox.minZ();
			queue[j] = Construction.index(x, y, z, dx, dz);
			states[j] = net.minecraft.world.level.block.Block.getId(w.cells.states()[i]);
			if (i < done) {
				built.set(j);
			}
		}
		ghostSent = done;
		Blueprint b = Blueprints.get(blueprint);
		return new dev.larattalabs.architect.survival.SiteNet.SiteGhost(siteId, blueprint, net.minecraft.world.level.block.Rotation.values()[turns].name()
			.toLowerCase(java.util.Locale.ROOT), b == null ? blueprint : b.name(), snapBox.minX(), snapBox.minY(), snapBox.minZ(), dx,
			snapBox.maxY() - snapBox.minY() + 1, dz, dev.larattalabs.architect.survival.CellBits.encodeInts(queue), states,
			dev.larattalabs.architect.survival.CellBits.words(built));
	}

	/** The ghost cells built since the last call (the writer's progress), or an empty array. */
	int[] ghostNewly() {
		TemplateWriter w = writer;
		if (w == null || ghostOf == null) {
			return new int[0];
		}
		int done = w.phase == TemplateWriter.SET ? w.cursor : w.cells.size();
		int[] out = new int[Math.max(0, done - ghostSent)];
		int c = 0;
		for (int i = ghostSent; i < done; i++) {
			if (ghostOf[i] >= 0) {
				out[c++] = ghostOf[i];
			}
		}
		ghostSent = Math.max(ghostSent, done);
		return java.util.Arrays.copyOf(out, c);
	}

	PlaceJob(String siteId, String dimension, String blueprint, int turns, Anchors.Bounds box, Anchors.Bounds snapBox, BlockPos placePos, int[] fill,
		int[] clear, int[] aClear, int[] aFill, int[] aPath, int[] aSlabs, long[] plants, List<String> dropsBefore, List<String> notes,
		List<TickDeferral.Held> held, @Nullable String batchId, @Nullable String itemKey) {
		this.siteId = siteId;
		this.dimension = dimension;
		this.blueprint = blueprint;
		this.turns = turns;
		this.box = box;
		this.snapBox = snapBox;
		this.placePos = placePos;
		this.fill = fill;
		this.clear = clear;
		this.aClear = aClear;
		this.aFill = aFill;
		this.aPath = aPath;
		this.aSlabs = aSlabs;
		this.plants = plants;
		this.dropsBefore = new ArrayList<>(dropsBefore);
		this.notes = new ArrayList<>(notes);
		this.held = held;
		this.batchId = batchId;
		this.itemKey = itemKey;
	}

	@Override
	public String siteId() {
		return siteId;
	}

	@Override
	public @Nullable String batchId() {
		return batchId;
	}

	@Override
	public String kind() {
		return "place";
	}

	/** The template writer, made on first use (and after a load) from the site's own template. */
	private @Nullable TemplateWriter writer(ServerLevel level) {
		if (writer != null) {
			return writer;
		}
		Blueprints.Entry e = Blueprints.entry(blueprint);
		Site s = Sites.get(siteId);
		TemplateGrid grid = e == null ? null : TemplateGrid.of(e);
		if (e == null || s == null || s.pin() == null || grid == null || !grid.fingerprint().equals(s.pin().template())) {
			broken = "the design " + blueprint + " changed or is gone while " + siteId + " was being placed";
			return null;
		}
		StructureTemplate t = e.template();
		writer = new TemplateWriter(TemplateWriter.cells(level, t, Sites.placeSettings(Rotation.values()[turns])), placePos, Sites.FLAGS);
		return writer;
	}

	/**
	 * P1 when the job is made: a box up to 50k cells is captured now (one tick) and its PLACING commit submitted; a larger one
	 * is captured over ticks ({@link #CAPTURE}) with change tracking. Server thread.
	 */
	void startCapture(ServerLevel level) throws Sites.SiteException {
		heldLeaves = SiteJournal.holdable(level, snapBox);
		ring = dev.larattalabs.architect.placement.LeafGuard.ring(level, snapBox);
		if (snapBox.volume() <= SiteJournal.ONE_TICK_CELLS) {
			submitBefore(level, dev.larattalabs.architect.journal.WorldJournal.capture(level, snapBox));
			return;
		}
		capture = dev.larattalabs.architect.journal.WorldJournal.empty(snapBox);
		tracker = dev.larattalabs.architect.journal.ChangeTracker.start(level, dev.larattalabs.architect.journal.WorldJournal.sectionsOf(snapBox));
		captureCursor = 0;
		phase = CAPTURE;
	}

	private void submitBefore(ServerLevel level, dev.larattalabs.architect.journal.WorldJournal.Captured c) throws Sites.SiteException {
		if (tracker != null) {
			dev.larattalabs.architect.journal.WorldJournal.recapture(level, c, tracker.drain());
			tracker.stop();
			tracker = null;
		}
		Site rec = java.util.Objects.requireNonNull(record, "record");
		placing = SiteJournal.begin(level, siteId, dev.larattalabs.architect.journal.WorldJournal.SITE, rec.group(), snapBox, heldLeaves, rec.toJson(),
			ring, c);
		siteEntry = placing.siteEntry;
		leavesEntry = placing.leavesEntry;
		commit = placing.commit;
		capture = null;
		phase = COMMIT;
	}

	@Override
	public boolean step(MinecraftServer server, long deadline) {
		ServerLevel level = Sites.levelOf(server, dimension);
		if (level == null) {
			broken = dimension + " is not loaded";
			return true;
		}
		try {
			if (phase == CAPTURE || phase == COMMIT) {
				return journalBefore(server, level, deadline);
			}
			if (phase == AFTER || phase == AFTER_COMMIT || phase == CONSTRUCTION_CLEAR) {
				return journalAfter(server, level, deadline);
			}
		} catch (Sites.SiteException e) {
			broken = e.getMessage();
			return true;
		}
		TickDeferral.begin(level, held);
		try {
			if (phase == START) {
				start(server, level);
			}
			int n = 0;
			while (phase < FINISH) {
				if (n > 0 && n % CLOCK == 0 && System.nanoTime() >= deadline) {
					return false;
				}
				n += stepOnce(level, deadline);
				if (broken != null) {
					return true;
				}
				if (n > 0) {
					dev.larattalabs.architect.journal.WorldJournal.kill("K3");
				}
			}
		} finally {
			TickDeferral.end();
		}
		if (phase == FINISH) {
			try {
				finish(server, level);
			} catch (Sites.SiteException e) {
				broken = e.getMessage();
				return true;
			}
			return phase == DONE || broken != null;
		}
		return true;
	}

	/** P1 sliced and P3: the capture, then the PLACING commit (and re-captures of what changed meanwhile). */
	private boolean journalBefore(MinecraftServer server, ServerLevel level, long deadline) throws Sites.SiteException {
		if (phase == CAPTURE) {
			var c = capture;
			if (c == null) {
				broken = "its capture was lost";
				return true;
			}
			int step = Math.max(4096, 1);
			while (captureCursor < c.size()) {
				int to = Math.min(c.size(), captureCursor + step);
				dev.larattalabs.architect.journal.WorldJournal.captureSlice(level, c, captureCursor, to);
				captureCursor = to;
				if (System.nanoTime() >= deadline && captureCursor < c.size()) {
					return false;
				}
			}
			submitBefore(level, c);
			return false;
		}
		var f = commit;
		if (f == null) {
			// resumed after a stop: the commit was flushed before the world stopped
			phase = START;
			return false;
		}
		if (!f.isDone()) {
			return false;
		}
		if (f.isCompletedExceptionally()) {
			broken = "its terrain could not be saved to the world journal";
			if (placing != null) {
				placing.stopTracking();
			}
			return true;
		}
		if (placing != null) {
			var again = SiteJournal.retake(level, placing);
			if (again != null) {
				commit = again;
				return false;
			}
			placing.stopTracking();
		}
		commit = null;
		dev.larattalabs.architect.journal.WorldJournal.kill("K2");
		phase = START;
		return false;
	}

	/** P4: the record (placing), the held leaves, removable entities gone; then the writes start. */
	private void start(MinecraftServer server, ServerLevel level) {
		if (record != null) {
			Sites.startPlacing(server, record);
		}
		beforeRecord = false;
		dev.larattalabs.architect.placement.LeafGuard.holdCells(level, heldLeaves, Sites.FLAGS);
		int removed = 0;
		for (net.minecraft.world.entity.Entity e : level.getEntities((net.minecraft.world.entity.Entity) null,
			dev.larattalabs.architect.placement.Occupancy.aabb(snapBox), e -> !(e instanceof net.minecraft.world.entity.player.Player) && e.isAlive())) {
			if (dev.larattalabs.architect.placement.Occupancy.classify(e).removable()) {
				e.discard();
				removed++;
			}
		}
		if (removed == 0) {
			notes.removeIf(n -> n.contains("removed"));
		}
		phase = TEMPLATE;
		cursor = 0;
	}

	/** P6-P7 (and a construction site's clearing), then P8. */
	private boolean journalAfter(MinecraftServer server, ServerLevel level, long deadline) throws Sites.SiteException {
		if (phase == AFTER) {
			var c = capture;
			if (c == null) {
				capture = c = dev.larattalabs.architect.journal.WorldJournal.empty(snapBox);
				captureCursor = 0;
				tracker = dev.larattalabs.architect.journal.ChangeTracker.start(level, dev.larattalabs.architect.journal.WorldJournal.sectionsOf(snapBox));
			}
			while (captureCursor < c.size()) {
				int to = Math.min(c.size(), captureCursor + 4096);
				dev.larattalabs.architect.journal.WorldJournal.captureSlice(level, c, captureCursor, to);
				captureCursor = to;
				if (System.nanoTime() >= deadline && captureCursor < c.size()) {
					return false;
				}
			}
			if (tracker != null) {
				dev.larattalabs.architect.journal.WorldJournal.recapture(level, c, tracker.drain());
				tracker.stop();
				tracker = null;
			}
			commit = SiteJournal.complete(siteId, c, null);
			capture = null;
			phase = AFTER_COMMIT;
			return false;
		}
		if (phase == AFTER_COMMIT) {
			var f = commit;
			if (f != null && !f.isDone()) {
				return false;
			}
			if (f != null && f.isCompletedExceptionally()) {
				broken = "its placement could not be saved to the world journal";
				return true;
			}
			commit = null;
			dev.larattalabs.architect.journal.WorldJournal.kill("K4");
			if (convert != null) {
				Builder.placeCrate(level, new Builder.ConvertPlan(siteId, convert, dev.larattalabs.architect.journal.WorldJournal.empty(snapBox), snapBox,
					newCrate, sharedGroup));
				newCrate = false;
				phase = CONSTRUCTION_CLEAR;
				clearCursor = 0;
				return false;
			}
			return placed(server);
		}
		// CLEAR
		clearCursor = Builder.clear(level, convert, snapBox, clearCursor, deadline);
		if (clearCursor < convert.size()) {
			return false;
		}
		return placed(server);
	}

	/** P8: the record placed (or a construction site, building), SITE_PLACED. */
	private boolean placed(MinecraftServer server) {
		if (Sites.finishPlacing(server, this, bedCells, finishNote) == null && broken == null) {
			broken = "its site record is gone";
		}
		phase = DONE;
		return true;
	}

	/** One unit of work (a cell, or a whole short step); returns the cells handled. */
	private int stepOnce(ServerLevel level, long deadline) {
		switch (phase) {
			case TEMPLATE -> {
				TemplateWriter w = writer(level);
				if (w == null) {
					return 1;
				}
				int n = w.step(level, deadline);
				if (w.done()) {
					next();
				}
				return Math.max(1, n);
			}
			case BEDS -> {
				TemplateGrid grid = TemplateGrid.of(blueprint);
				if (grid != null) {
					Sites.BedsOut beds = Sites.removeUnsafeBeds(level, grid, turns, box);
					bedCells.addAll(beds.cells());
					bedHeads.addAll(beds.heads());
				}
				next();
				return 8;
			}
			case FILL -> {
				return cells(level, fill, Sites.foundationState(bp()));
			}
			case CLEAR, A_CLEAR -> {
				return cells(level, phase == CLEAR ? clear : aClear, Blocks.AIR.defaultBlockState());
			}
			case A_FILL -> {
				return cells(level, aFill, Sites.foundationState(bp()));
			}
			case A_PATH -> {
				return cells(level, aPath, Sites.approachBlock(bp(), false));
			}
			case A_SLABS -> {
				return cells(level, aSlabs, Sites.approachBlock(bp(), true));
			}
			case PLANTS -> {
				if (cursor >= plants.length) {
					next();
					return 0;
				}
				BlockPos half = BlockPos.of(plants[cursor++]);
				BlockState outside = level.getBlockState(half);
				BlockPos inside = half.getY() < snapBox.minY() ? half.above() : half.below();
				if (!level.getBlockState(inside).is(outside.getBlock())) {
					level.setBlock(half, Blocks.AIR.defaultBlockState(), Sites.FLAGS);
				}
				return 1;
			}
			default -> {
				return 0;
			}
		}
	}

	private Blueprint bp() {
		Blueprint b = Blueprints.get(blueprint);
		if (b == null) {
			throw new IllegalStateException("design " + blueprint + " is gone");
		}
		return b;
	}

	/** Writes the next cell of {@code xyz} (x, y, z triples), or moves to the next phase. */
	private int cells(ServerLevel level, int[] xyz, BlockState state) {
		if (cursor * 3 >= xyz.length) {
			next();
			return 0;
		}
		int i = cursor * 3;
		level.setBlock(new BlockPos.MutableBlockPos(xyz[i], xyz[i + 1], xyz[i + 2]), state, Sites.FLAGS);
		cursor++;
		return 1;
	}

	private void next() {
		phase++;
		cursor = 0;
		// the approach only runs when it has rows (Sites.applyApproach)
		if (phase == A_CLEAR && aClear.length + aFill.length + aPath.length + aSlabs.length == 0) {
			phase = PLANTS;
		}
	}

	private void finish(MinecraftServer server, ServerLevel level) throws Sites.SiteException {
		Sites.Drops drops = Sites.Drops.of(level, snapBox, dropsBefore);
		drops.clearNew(level);
		TickDeferral.release(level, held);
		held.clear();
		String bedNote = BedSafety.note(bedHeads.size(), Sites.dimensionId(level));
		if (bedNote != null) {
			notes.add(0, bedNote);
		}
		finishNote = notes.isEmpty() ? null : String.join("; ", notes);
		if (construction) {
			// P6 of a construction site: its target (the converted site's queue, crate), then P7 with the crate's own entry
			Sites.Built built = Sites.builtOf(this);
			if (built == null) {
				broken = "its level or design is gone; it can't become a construction site";
				return;
			}
			Blueprint bp = bp();
			SiteGroupRec g = record == null || record.group() == null ? null : Sites.group(record.group());
			Builder.SHARED_CRATE.set(g != null && g.sharedCrate() ? g.id() : null);
			try {
				long t0 = System.nanoTime();
				Builder.ConvertPlan p = Builder.planConvert(level, bp, built, siteId, placer);
				commit = Builder.commitConvert(level, p);
				convert = p.construction();
				newCrate = p.newCrate();
				sharedGroup = p.sharedGroup();
				Placement.noteConvert(siteId, System.nanoTime() - t0);
			} finally {
				Builder.SHARED_CRATE.remove();
			}
			phase = AFTER_COMMIT;
			return;
		}
		if (snapBox.volume() <= SiteJournal.ONE_TICK_CELLS) {
			commit = SiteJournal.complete(siteId, dev.larattalabs.architect.journal.WorldJournal.capture(level, snapBox), null);
			phase = AFTER_COMMIT;
		} else {
			phase = AFTER;
		}
	}

	@Override
	public int progress() {
		if (phase == TEMPLATE) {
			return writer == null ? 0 : writer.progress();
		}
		return (writer == null ? 0 : writer.total()) + doneCells();
	}

	private int doneCells() {
		int n = 0;
		int[][] lists = {fill, clear, aClear, aFill, aPath, aSlabs};
		for (int k = 0; k < lists.length; k++) {
			int ph = FILL + k;
			if (phase > ph) {
				n += lists[k].length / 3;
			} else if (phase == ph) {
				n += cursor;
			}
		}
		return n;
	}

	@Override
	public int total() {
		int t = writer == null ? 0 : writer.done() ? writer.total() : writer.cells.size() * 2;
		return t + (fill.length + clear.length + aClear.length + aFill.length + aPath.length + aSlabs.length) / 3;
	}

	@Override
	public void aborted(MinecraftServer server) {
		// a cancelled job never schedules what it held back: the rollback restores the box as it was
		held.clear();
		if (tracker != null) {
			tracker.stop();
			tracker = null;
		}
		if (placing != null) {
			placing.stopTracking();
		}
	}

	// ------------------------------------------------------------------ persistence

	@Override
	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("kind", kind());
		o.addProperty("siteId", siteId);
		o.addProperty("dimension", dimension);
		o.addProperty("blueprint", blueprint);
		o.addProperty("turns", turns);
		o.add("box", Anchors.boundsJson(box));
		o.add("snapBox", Anchors.boundsJson(snapBox));
		o.add("placePos", ints(placePos.getX(), placePos.getY(), placePos.getZ()));
		o.add("fill", ints(fill));
		o.add("clear", ints(clear));
		o.add("aClear", ints(aClear));
		o.add("aFill", ints(aFill));
		o.add("aPath", ints(aPath));
		o.add("aSlabs", ints(aSlabs));
		JsonArray pl = new JsonArray();
		for (long p : plants) {
			pl.add(p);
		}
		o.add("plants", pl);
		JsonArray db = new JsonArray();
		dropsBefore.forEach(db::add);
		o.add("dropsBefore", db);
		JsonArray nt = new JsonArray();
		notes.forEach(nt::add);
		o.add("notes", nt);
		o.add("held", TickDeferral.toJson(held));
		if (batchId != null) {
			o.addProperty("batchId", batchId);
		}
		if (itemKey != null) {
			o.addProperty("itemKey", itemKey);
		}
		if (construction) {
			o.addProperty("construction", true);
		}
		if (placer != null) {
			o.addProperty("placer", placer);
		}
		if (approachEnd != null) {
			JsonArray e = new JsonArray();
			for (double v : approachEnd) {
				e.add(v);
			}
			o.add("approachEnd", e);
		}
		o.addProperty("phase", phase);
		o.addProperty("cursor", cursor);
		JsonArray bc = new JsonArray();
		bedCells.forEach(bc::add);
		o.add("bedCells", bc);
		JsonArray bh = new JsonArray();
		bedHeads.forEach(bh::add);
		o.add("bedHeads", bh);
		if (writer != null) {
			o.add("writer", writer.toJson());
		}
		if (record != null) {
			o.add("record", record.toJson());
		}
		if (siteEntry != null) {
			o.addProperty("siteEntry", siteEntry);
		}
		if (leavesEntry != null) {
			o.addProperty("leavesEntry", leavesEntry);
		}
		JsonArray hl = new JsonArray();
		heldLeaves.forEach(hl::add);
		o.add("heldLeaves", hl);
		o.add("ring", ints(ring));
		o.addProperty("beforeRecord", beforeRecord);
		if (convert != null) {
			o.add("convert", convert.toJson());
			o.addProperty("newCrate", newCrate);
			if (sharedGroup != null) {
				o.addProperty("sharedGroup", sharedGroup);
			}
			o.addProperty("clearCursor", clearCursor);
		}
		if (finishNote != null) {
			o.addProperty("finishNote", finishNote);
		}
		return o;
	}

	static PlaceJob fromJson(JsonObject o) {
		JsonArray pp = o.getAsJsonArray("placePos");
		JsonArray pl = o.getAsJsonArray("plants");
		long[] plants = new long[pl.size()];
		for (int i = 0; i < plants.length; i++) {
			plants[i] = pl.get(i).getAsLong();
		}
		List<String> db = new ArrayList<>();
		o.getAsJsonArray("dropsBefore").forEach(e -> db.add(e.getAsString()));
		List<String> nt = new ArrayList<>();
		o.getAsJsonArray("notes").forEach(e -> nt.add(e.getAsString()));
		PlaceJob j = new PlaceJob(o.get("siteId").getAsString(), o.get("dimension").getAsString(), o.get("blueprint").getAsString(),
			o.get("turns").getAsInt(), Anchors.boundsFromJson(o.getAsJsonObject("box")), Anchors.boundsFromJson(o.getAsJsonObject("snapBox")),
			new BlockPos(pp.get(0).getAsInt(), pp.get(1).getAsInt(), pp.get(2).getAsInt()), intArray(o, "fill"), intArray(o, "clear"),
			intArray(o, "aClear"), intArray(o, "aFill"), intArray(o, "aPath"), intArray(o, "aSlabs"), plants, db, nt,
			new ArrayList<>(TickDeferral.fromJson(o.get("held"))), o.has("batchId") ? o.get("batchId").getAsString() : null,
			o.has("itemKey") ? o.get("itemKey").getAsString() : null);
		j.construction = o.has("construction") && o.get("construction").getAsBoolean();
		j.placer = o.has("placer") ? o.get("placer").getAsString() : null;
		if (o.has("approachEnd")) {
			JsonArray e = o.getAsJsonArray("approachEnd");
			j.approachEnd = new double[] {e.get(0).getAsDouble(), e.get(1).getAsDouble(), e.get(2).getAsDouble()};
		}
		j.phase = o.get("phase").getAsInt();
		j.cursor = o.get("cursor").getAsInt();
		o.getAsJsonArray("bedCells").forEach(e -> j.bedCells.add(e.getAsLong()));
		o.getAsJsonArray("bedHeads").forEach(e -> j.bedHeads.add(e.getAsLong()));
		if (o.has("writer")) {
			j.pendingWriter = o.getAsJsonObject("writer");
		}
		if (o.has("record")) {
			j.record = Site.fromJson(o.getAsJsonObject("record"));
		}
		j.siteEntry = o.has("siteEntry") ? o.get("siteEntry").getAsString() : null;
		j.leavesEntry = o.has("leavesEntry") ? o.get("leavesEntry").getAsString() : null;
		if (o.has("heldLeaves")) {
			o.getAsJsonArray("heldLeaves").forEach(e -> j.heldLeaves.add(e.getAsInt()));
		}
		if (o.has("ring")) {
			j.ring = intArray(o, "ring");
		}
		j.beforeRecord = o.has("beforeRecord") && o.get("beforeRecord").getAsBoolean(); // a 4d job (migrated) had its record
		if (o.has("convert")) {
			j.convert = Construction.fromJson(o.getAsJsonObject("convert"));
			j.newCrate = o.has("newCrate") && o.get("newCrate").getAsBoolean();
			j.sharedGroup = o.has("sharedGroup") ? o.get("sharedGroup").getAsString() : null;
			j.clearCursor = o.has("clearCursor") ? o.get("clearCursor").getAsInt() : 0;
		}
		j.finishNote = o.has("finishNote") ? o.get("finishNote").getAsString() : null;
		return j;
	}

	/** A loaded writer state, applied once the template is at hand ({@link #resume}). */
	private @Nullable JsonObject pendingWriter;

	/** After a load: rebuilds the writer from the site's template and its saved cursor. False when it can't (then roll back). */
	boolean resume(ServerLevel level) {
		if (pendingWriter == null) {
			return true;
		}
		TemplateWriter w = writer(level);
		if (w == null) {
			return false;
		}
		w.load(pendingWriter);
		pendingWriter = null;
		return true;
	}

	private static JsonArray ints(int... v) {
		JsonArray a = new JsonArray();
		for (int x : v) {
			a.add(x);
		}
		return a;
	}

	private static int[] intArray(JsonObject o, String key) {
		JsonArray a = o.getAsJsonArray(key);
		int[] out = new int[a.size()];
		int i = 0;
		for (JsonElement e : a) {
			out[i++] = e.getAsInt();
		}
		return out;
	}

	@Override
	public String toString() {
		return "PlaceJob[" + siteId + " " + blueprint + " phase " + phase + " cursor " + cursor + "]";
	}

	static void log(String msg, Object... args) {
		Architect.LOGGER.info(msg, args);
	}
}
