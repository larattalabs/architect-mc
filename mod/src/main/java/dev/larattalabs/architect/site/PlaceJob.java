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
 * An instant placement written over ticks (docs/CONTRACT.md phase 4d "Ticked placement"). {@link Sites#beginPlacing} runs the
 * checks, writes the snapshot and records the site as placing; this job then writes, under the per-tick budget, exactly what
 * the atomic placement ({@code Sites.build}) writes and in its order: the template ({@link TemplateWriter}), the beds bed
 * safety takes out, the foundation fill, the cleared terrain, the approach (clear, fill, path, slabs), the outside halves of
 * cut tall plants; then the drops it caused are cleared and the ticks it held back are scheduled ({@link TickDeferral}).
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
	/** Set when the job can't go on (its design changed, its level is gone): it is rolled back instead. */
	@Nullable String broken;

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

	@Override
	public boolean step(MinecraftServer server, long deadline) {
		ServerLevel level = Sites.levelOf(server, dimension);
		if (level == null) {
			broken = dimension + " is not loaded";
			return true;
		}
		TickDeferral.begin(level, held);
		try {
			int n = 0;
			while (phase < FINISH) {
				if (n > 0 && n % CLOCK == 0 && System.nanoTime() >= deadline) {
					return false;
				}
				n += stepOnce(level, deadline);
				if (broken != null) {
					return true;
				}
			}
		} finally {
			TickDeferral.end();
		}
		if (phase == FINISH) {
			finish(server, level);
			phase = DONE;
		}
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

	private void finish(MinecraftServer server, ServerLevel level) {
		Sites.Drops drops = Sites.Drops.of(level, snapBox, dropsBefore);
		drops.clearNew(level);
		TickDeferral.release(level, held);
		held.clear();
		String bedNote = BedSafety.note(bedHeads.size(), Sites.dimensionId(level));
		if (bedNote != null) {
			notes.add(0, bedNote);
		}
		Sites.finishPlacing(server, this, bedCells, notes.isEmpty() ? null : String.join("; ", notes));
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
		j.phase = o.get("phase").getAsInt();
		j.cursor = o.get("cursor").getAsInt();
		o.getAsJsonArray("bedCells").forEach(e -> j.bedCells.add(e.getAsLong()));
		o.getAsJsonArray("bedHeads").forEach(e -> j.bedHeads.add(e.getAsLong()));
		if (o.has("writer")) {
			j.pendingWriter = o.getAsJsonObject("writer");
		}
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
