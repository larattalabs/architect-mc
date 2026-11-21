package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R fix round, P1-6 of the T4R early review) A group removal's result survives the queue file, through production serialization:
 * planned (R2q: the undo committed, the queue not saved after it) and durable, its restore and kept counts, its hand-down (this member's
 * and the whole), its cascade, and the owed keys of its data cargo; and the txn payload built from the reloaded removal carries them.
 */
class T4RResultPersistTest {
	static Groups.Removal sample(boolean durable) {
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		r.sites.add("s2");
		r.cascaded.add("c1");
		r.handedAll = new java.util.TreeMap<>(Map.of("s0", 3));
		r.handed = new java.util.TreeMap<>(Map.of("s0", 3));
		r.restoredCells = 120;
		r.keptCells = 4;
		if (durable) {
			r.undo = "u:group-g1:1";
			r.undoSites.add("s2");
		} else {
			r.planned = "u:group-g1:1";
			r.plannedSites.add("s2");
		}
		return r;
	}

	@Test
	void theResultSurvivesTheQueueFile() throws Exception {
		System.out.println("ROW T4R-P1-6 (unit)");
		for (boolean durable : new boolean[] {false, true}) {
			Groups.Removal r = sample(durable);
			java.lang.reflect.Field co = Groups.Removal.class.getDeclaredField("cargoOwed");
			co.setAccessible(true);
			@SuppressWarnings("unchecked")
			java.util.List<String> owed = (java.util.List<String>) co.get(r);
			owed.add("cargo:test-3");
			JsonObject j = r.toJson();
			System.out.println("ROW T4R-P1-6 queue entry (" + (durable ? "durable" : "planned, R2q") + "): " + j);
			Groups.Removal b = Groups.Removal.fromJson(j);
			String what = durable ? "durable" : "planned (R2q)";
			assertEquals(java.util.List.of("c1"), b.cascaded, "T4R-P1-6: the cascade survives (" + what + ")");
			assertEquals(Map.of("s0", 3), b.handedAll, "T4R-P1-6: the whole hand-down survives (" + what + ")");
			assertEquals(120, b.restoredCells, "T4R-P1-6: the restore count survives (" + what + ")");
			assertEquals(4, b.keptCells, "T4R-P1-6: the kept count survives (" + what + ")");
			@SuppressWarnings("unchecked")
			java.util.List<String> owed2 = (java.util.List<String>) co.get(b);
			assertEquals(java.util.List.of("cargo:test-3"), owed2, "T4R-P1-6: the data cargo's owed keys survive (" + what + ")");
			JsonObject p = GroupTxn.payload(b);
			assertTrue(p.get("restored").getAsInt() == 120 && p.get("kept").getAsInt() == 4 && p.getAsJsonObject("handed").has("s0") && p.getAsJsonArray(
				"cascaded").size() == 1 && p.getAsJsonArray("owed").size() == 1, "T4R-P1-6: the txn payload from the reloaded removal is complete: " + p);
		}
	}
}
