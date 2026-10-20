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
 */
public final class LotMask {
	private LotMask() {
	}

	/** The site ext key holding the mask. */
	public static final String EXT = "architect_mc:irrigation";
	/** The site ext key reporting how many of the entry's non-air blocks the mask dropped. */
	public static final String EXT_DROPPED = "architect_mc:irrigationDropped";

	/** The mask's cells (packed positions), or null when {@code ext} has none. */
	public static @Nullable LongOpenHashSet cells(@Nullable JsonObject ext) {
		if (ext == null || !(ext.get(EXT) instanceof JsonObject m) || !(m.get("cells") instanceof JsonArray a) || a.isEmpty()) {
			return null;
		}
		LongOpenHashSet out = new LongOpenHashSet();
		for (int i = 0; i + 3 < a.size(); i += 4) {
			int x = a.get(i).getAsInt(), z = a.get(i + 1).getAsInt(), y0 = a.get(i + 2).getAsInt(), y1 = a.get(i + 3).getAsInt();
			for (int y = y0; y <= y1; y++) {
				out.add(Journal.pos(x, y, z));
			}
		}
		return out.isEmpty() ? null : out;
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
