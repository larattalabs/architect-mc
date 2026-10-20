package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.batch.LotFitting;
import dev.larattalabs.architect.delta.DeltaPlanner;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.BlueprintTransform;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (6c IRR, docs/CONTRACT.md "Phase 6c slice IRR" §4, S-IRR-2) A lot site's mask: read from its ext (the IR's column runs), filtering
 * foundation and approach writes, kept out of a delta's writes and growth; and the placement table the kit's frame agrees with
 * (kit/test/irr.test.mjs FIT_TABLE): LotFitting plus rotateBlock put a smaller, rotated design's cell on the same world cell.
 */
class LotMaskTest {
	@Test
	void readsTheExtAndFilters() {
		JsonArray runs = JsonParser.parseString("[[10,20,64,66],[11,20,65,65]]").getAsJsonArray();
		JsonObject ext = new JsonObject();
		assertNull(LotMask.of(ext), "no mask: every other site");
		ext.add(LotMask.EXT, LotMask.extOf(runs));
		assertEquals("[10,20,64,66,11,20,65,65]", ext.getAsJsonObject(LotMask.EXT).get("cells").toString());
		var m = LotMask.of(ext);
		assertTrue(m.test(Journal.pos(10, 64, 20)) && m.test(Journal.pos(10, 66, 20)) && m.test(Journal.pos(11, 65, 20)));
		assertFalse(m.test(Journal.pos(11, 64, 20)) || m.test(Journal.pos(10, 67, 20)));
		JsonObject rec = new JsonObject();
		rec.add("ext", ext);
		assertTrue(LotMask.ofRecord(rec).test(Journal.pos(10, 65, 20)));
		assertArrayEquals(new int[] {1, 2, 3}, LotMask.filter(new int[] {10, 65, 20, 1, 2, 3, 11, 65, 20}, m));
		int[] same = {1, 2, 3};
		assertTrue(same == LotMask.filter(same, m), "nothing masked: the same array");
	}

	@Test
	void aDeltaNeverWritesOrGrowsIntoTheMask() {
		long a = Journal.pos(0, 0, 0), masked = Journal.pos(1, 0, 0), c = Journal.pos(2, 0, 0);
		Map<Long, Value> delta = new LinkedHashMap<>();
		delta.put(a, Value.of("minecraft:oak_planks"));
		delta.put(masked, Value.of("minecraft:oak_planks"));
		DeltaPlanner.Stacks st = new DeltaPlanner.Stacks() {
			@Override
			public DeltaPlanner.Holder holder(long pos) {
				return pos == masked ? DeltaPlanner.Holder.OTHER : pos == a ? DeltaPlanner.Holder.SITE : DeltaPlanner.Holder.NONE;
			}

			@Override
			public boolean siteHas(long pos) {
				return pos == a;
			}

			@Override
			public Value siteAfter(long pos) {
				return pos == a ? Value.of("minecraft:dirt") : null;
			}

			@Override
			public String topSite(long pos) {
				return pos == masked ? "region-tile" : null;
			}
		};
		DeltaPlanner.Now now = new DeltaPlanner.Now() {
			@Override
			public Value value(long pos) {
				return Value.of("minecraft:dirt");
			}

			@Override
			public boolean holds(long pos, Value after) {
				return true;
			}
		};
		Anchors.Bounds box = new Anchors.Bounds(0, 0, 0, 2, 0, 0);
		DeltaPlanner.Outcome without = DeltaPlanner.outcome(delta, box, st, now, DeltaPlanner.Edits.KEEP);
		assertTrue(without.write().containsKey(masked) && without.growth().contains(masked), "unmasked: the region's cell is taken as growth");
		DeltaPlanner.Outcome with = DeltaPlanner.outcome(delta, box, st, now, DeltaPlanner.Edits.KEEP, p -> p == masked);
		assertFalse(with.write().containsKey(masked) || with.growth().contains(masked) || with.entryCells().contains(masked) || with.overlaps().containsKey(
			"region-tile"), "masked: never written, never the site's");
		assertTrue(with.write().containsKey(a) && with.growth().contains(c));
	}

	/** kit/test/irr.test.mjs FIT_TABLE: [lot front, lot box x0 z0 x1 z1, design sx sz front, template bx bz, world x z]. */
	private static final Object[][] FIT_TABLE = {
		{"south", new int[] {100, 200, 108, 205}, new Object[] {4, 3, "south"}, new int[] {0, 0}, new int[] {102, 203}},
		{"north", new int[] {100, 200, 108, 205}, new Object[] {4, 3, "south"}, new int[] {0, 0}, new int[] {105, 202}},
		{"east", new int[] {100, 200, 105, 208}, new Object[] {4, 3, "south"}, new int[] {0, 0}, new int[] {103, 205}},
		{"west", new int[] {100, 200, 105, 208}, new Object[] {4, 3, "south"}, new int[] {0, 0}, new int[] {102, 202}},
		{"south", new int[] {100, 200, 108, 205}, new Object[] {5, 3, "west"}, new int[] {4, 2}, new int[] {105, 201}},
		{"east", new int[] {100, 200, 105, 208}, new Object[] {5, 3, "north"}, new int[] {1, 0}, new int[] {105, 203}},
		{"north", new int[] {100, 200, 109, 205}, new Object[] {3, 2, "east"}, new int[] {2, 1}, new int[] {105, 200}},
		{"west", new int[] {100, 200, 106, 209}, new Object[] {4, 2, "west"}, new int[] {3, 1}, new int[] {103, 205}},
	};

	@Test
	void thePlacementTableTheKitsFrameAgreesWith() {
		for (Object[] row : FIT_TABLE) {
			int[] b = (int[]) row[1];
			Object[] d = (Object[]) row[2];
			int sx = (int) d[0], sz = (int) d[1];
			int[] t = (int[]) row[3], w = (int[]) row[4];
			LotFitting.Fit f = LotFitting.fit(sx, 4, sz, (String) d[2], 0, 0, false, 0, 0, new Anchors.Bounds(b[0], 65, b[1], b[2], 80, b[3]), (String) row[0], true, 0,
				true);
			assertTrue(f.fits(), row[0] + " " + f.why());
			int[] r = BlueprintTransform.rotateBlock(t[0], t[1], sx, sz, f.turns());
			assertArrayEquals(w, new int[] {f.ox() + r[0], f.oz() + r[1]}, row[0] + " " + sx + "x" + sz + " " + d[2]);
		}
	}
}
