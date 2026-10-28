package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.Journal;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.function.LongPredicate;
import org.jspecify.annotations.Nullable;

/**
 * (6c IRR, CONTRACT IRR §4) A lot site's mask: the region's irrigation cells inside the lot's box (each source, its bed, its four
 * farmland sides and the cell over it) that the lot's design never writes and its site never owns. The region owns them until the
 * region is removed.
 *
 * <p>Carried on the lot site's ext as {@link #EXT} {@code {cells: [x, z, y0, y1, ...]}} (flat column runs, the IR's
 * {@code lots[].irrigation.cells}), so it persists with the queue item, the site record and the journal head. Read by the template
 * writer and the foundation/approach writes ({@link PlaceJob}: masked blocks are dropped), the site's BOX entry ({@link SiteJournal}:
 * masked cells are never captured, so removal, undo, a {@code versionOf} delta, PT2's adopt and Steward's claim and release never touch
 * them) and the delta planner (no growth into a masked cell).
 *
 * <p>(7a K3, CONTRACT K3 §5) A gatehouse lot on a wall carries its passage the same way, under {@link #EXT_PASSAGE}: the mask is the
 * union of both keys, so every consumer above honours the passage too. Only the irrigation key drains fluids at removal
 * ({@code Sites.drainIrrigation}).
 */
public final class LotMask {
	private LotMask() {
	}

	/** The site ext key holding the mask. */
	public static final String EXT = "architect_mc:irrigation";
	/** The site ext key reporting how many of the entry's non-air blocks the mask dropped. */
	public static final String EXT_DROPPED = "architect_mc:irrigationDropped";

	/** (7a K3) The site ext key holding a gatehouse lot's passage cells (the same {@code {cells: [flat runs]}} value as {@link #EXT}). */
	public static final String EXT_PASSAGE = "architect_mc:passage";
	/** (7a K3) The site ext key reporting how many of the entry's non-air blocks the passage mask dropped. */
	public static final String EXT_PASSAGE_DROPPED = "architect_mc:passageDropped";

	/** The mask's cells (packed positions): the union of {@link #EXT} and {@link #EXT_PASSAGE}; null when {@code ext} has neither. */
	public static @Nullable LongOpenHashSet cells(@Nullable JsonObject ext) {
		if (ext == null) {
			return null;
		}
		LongOpenHashSet out = new LongOpenHashSet();
		for (String key : new String[] {EXT, EXT_PASSAGE}) {
			if (ext.get(key) instanceof JsonObject m && m.get("cells") instanceof JsonArray a) {
				addRuns(a, out);
			}
		}
		return out.isEmpty() ? null : out;
	}

	/**
	 * Adds the cells of column runs {@code [x, z, y0, y1, ...]} (flat) or {@code [[x, z, y0, y1], ...]} (nested) to {@code out}; a
	 * malformed run is skipped (never throws).
	 */
	public static void addRuns(@Nullable JsonArray a, LongOpenHashSet out) {
		int[] flat = flatRuns(a);
		for (int i = 0; i + 3 < flat.length; i += 4) {
			for (int y = flat[i + 2]; y <= flat[i + 3]; y++) {
				out.add(Journal.pos(flat[i], y, flat[i + 1]));
			}
		}
	}

	/**
	 * Column runs, flat ({@code [x, z, y0, y1, ...]}) or nested ({@code [[x, z, y0, y1], ...]}), as a flat int array; malformed
	 * entries are skipped (a nested run without 4 ints, a flat tail short of 4, a non-number). Never throws; empty for null.
	 */
	public static int[] flatRuns(@Nullable JsonArray a) {
		if (a == null || a.isEmpty()) {
			return new int[0];
		}
		it.unimi.dsi.fastutil.ints.IntArrayList out = new it.unimi.dsi.fastutil.ints.IntArrayList();
		if (a.get(0) instanceof JsonArray) {
			for (JsonElement r : a) {
				int[] v = r instanceof JsonArray ra && ra.size() == 4 ? ints(ra) : null;
				if (v != null) {
					out.addElements(out.size(), v);
				}
			}
		} else {
			int[] v = ints(a);
			if (v != null) {
				out.addElements(out.size(), v, 0, v.length - v.length % 4);
			}
		}
		return out.toIntArray();
	}

	/** Every element of {@code a} as an int, or null when one is not a number. */
	static int @Nullable [] ints(JsonArray a) {
		int[] v = new int[a.size()];
		for (int i = 0; i < v.length; i++) {
			if (!(a.get(i) instanceof com.google.gson.JsonPrimitive p) || !p.isNumber()) {
				return null;
			}
			v[i] = p.getAsInt();
		}
		return v;
	}

	/** The mask as a predicate over packed positions, or null when there is none. */
	public static @Nullable LongPredicate of(@Nullable JsonObject ext) {
		LongOpenHashSet s = cells(ext);
		return s == null ? null : s::contains;
	}

	/** The mask of a site record's JSON ({@code ext}), or null. */
	public static @Nullable LongPredicate ofRecord(@Nullable JsonObject record) {
		return record != null && record.get("ext") instanceof JsonObject e ? of(e) : null;
	}

	/** The mask's ext value from IR column runs ({@code [[x, z, y0, y1], ...]}): {@code {cells: [flat runs]}}. */
	public static JsonObject extOf(JsonArray runs) {
		JsonArray flat = new JsonArray();
		for (JsonElement r : runs) {
			for (JsonElement v : r.getAsJsonArray()) {
				flat.add(v.getAsInt());
			}
		}
		JsonObject o = new JsonObject();
		o.add("cells", flat);
		return o;
	}

	/** (7a K3) The mask's ext value from column runs, flat or nested: {@code {cells: [flat runs]}} (malformed runs skipped). */
	public static JsonObject extOfAny(@Nullable JsonArray runs) {
		JsonArray flat = new JsonArray();
		for (int v : flatRuns(runs)) {
			flat.add(v);
		}
		JsonObject o = new JsonObject();
		o.add("cells", flat);
		return o;
	}

	/** {@code xyz} (x, y, z triples) less the masked positions. */
	public static int[] filter(int[] xyz, @Nullable LongPredicate mask) {
		if (mask == null || xyz.length == 0) {
			return xyz;
		}
		int[] out = new int[xyz.length];
		int n = 0;
		for (int i = 0; i + 2 < xyz.length; i += 3) {
			if (!mask.test(Journal.pos(xyz[i], xyz[i + 1], xyz[i + 2]))) {
				out[n++] = xyz[i];
				out[n++] = xyz[i + 1];
				out[n++] = xyz[i + 2];
			}
		}
		return n == out.length ? xyz : java.util.Arrays.copyOf(out, n);
	}
}
