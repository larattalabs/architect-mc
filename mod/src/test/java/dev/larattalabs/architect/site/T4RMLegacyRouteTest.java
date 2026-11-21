package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-M, Noah's design 1) A removal a pre-T4R build left in flight finishes on main's path: nothing of it is converted into T4R's
 * transactions. Through production deserialization:
 * <ul>
 * <li>a main group queue entry with a committed undo keeps its member credits ({@code decCredit}, main's {@code credit} key): no pile stash
 * is made of them (eca131b6 turned each into a {@code legacy} pile stash its removal.group txn credited);</li>
 * <li>a main group queue entry that never committed carries no credit into its fresh (T4R) plan (eca131b6 kept it: R1's held pending credits
 * would then hold it beside the new plan's stash);</li>
 * <li>an entry this build writes says so ({@code "txn": 1}) and keeps its stashes across the queue file;</li>
 * <li>a main single removal's held pending credit (J2) in the stockpiles file is no durable stash at the start's check (eca131b6 made one:
 * a removal.site txn paid it).</li>
 * </ul>
 */
class T4RMLegacyRouteTest {
	/** Main's Removal.toJson (v0.89.0) of a group removal whose undo committed: no "txn", its member's credit under "credit". */
	static final String MAIN_COMMITTED = "{\"group\":\"g1\",\"sites\":[\"s2\"],\"force\":false,\"covered\":\"KEEP\",\"started\":true,\"waited\":0,"
		+ "\"refund\":{},\"undo\":\"u:group-g1:1\",\"undoSites\":[\"s2\"],\"handed\":{},\"restoredCells\":10,\"keptCells\":0,"
		+ "\"dec\":{\"s2\":{\"items\":{},\"at\":0}},\"credit\":{\"s2\":{\"owner\":\"tcc:o\",\"key\":\"site:s2@5\",\"items\":{\"minecraft:oak_planks\":3},\"at\":0}}}";
	/** Main's entry saved while R1 ran (neither planned nor committed), its credit tallied already. */
	static final String MAIN_UNPLANNED = "{\"group\":\"g2\",\"sites\":[\"s3\"],\"force\":false,\"covered\":\"KEEP\",\"started\":true,\"waited\":0,"
		+ "\"refund\":{},\"credit\":{\"s3\":{\"owner\":\"tcc:o\",\"key\":\"site:s3@6\",\"items\":{\"minecraft:oak_planks\":2},\"at\":0}}}";

	@Test
	void aMainGroupEntryKeepsItsCredits() {
		System.out.println("ROW T4RM-legacy-group (unit)");
		Groups.Removal r = Groups.Removal.fromJson(JsonParser.parseString(MAIN_COMMITTED).getAsJsonObject());
		System.out.println("ROW T4RM-legacy-group loaded: credit " + r.decCredit.keySet() + ", settle " + r.decSettle);
		assertEquals(java.util.Set.of("s2"), r.decCredit.keySet(), "T4RM: a main entry's member credit stays main's decCredit (credited by main's path)");
		assertTrue(r.decSettle.isEmpty(), "T4RM: no pile stash is made of a main entry's credit (no removal.group txn credits it): " + r.decSettle);
		JsonObject again = r.toJson();
		assertTrue(!again.has("txn") && again.has("credit"), "T4RM: saved again, it stays a main entry (no txn marker, its credit kept): " + again);
		Groups.Removal r2 = Groups.Removal.fromJson(again);
		assertTrue(r2.decSettle.isEmpty() && r2.decCredit.containsKey("s2"), "T4RM: and loads again the same");
	}

	@Test
	void anUnplannedMainEntryPlansFresh() {
		System.out.println("ROW T4RM-legacy-unplanned (unit)");
		Groups.Removal r = Groups.Removal.fromJson(JsonParser.parseString(MAIN_UNPLANNED).getAsJsonObject());
		assertTrue(r.decCredit.isEmpty() && r.decSettle.isEmpty(), "T4RM: a main entry that decided nothing carries no credit into its fresh T4R plan: "
			+ r.decCredit + " " + r.decSettle);
		assertEquals(1, r.toJson().has("txn") ? r.toJson().get("txn").getAsInt() : 0, "T4RM: it is this build's removal from now on (txn marker)");
	}

	@Test
	void anEntryOfThisBuildSaysSo() {
		Groups.Removal r = new Groups.Removal("g3", null, null, false);
		r.sites.add("s4");
		r.undo = "u:group-g3:1";
		r.undoSites.add("s4");
		JsonObject st = new JsonObject();
		st.addProperty("key", "pile-refund:site:s4@7");
		st.addProperty("pileKey", "site:s4@7");
		st.add("refund", new JsonObject());
		r.decSettle.put("s4", st);
		JsonObject j = r.toJson();
		assertTrue(j.has("txn") && j.get("txn").getAsInt() == 1, "T4RM: an entry this build writes carries the txn marker: " + j);
		Groups.Removal b = Groups.Removal.fromJson(j);
		assertTrue(b.decSettle.containsKey("s4") && b.decCredit.isEmpty(), "T4RM: its stash survives the queue file");
	}

	@Test
	void aMainPendingCreditIsNoStash() throws Exception {
		System.out.println("ROW T4RM-legacy-single (unit)");
		Path dir = Files.createTempDirectory("t4rm-legacy-single");
		Path f = dir.resolve("stockpiles.json");
		Files.writeString(f, "{\"stockpiles\":[{\"owner\":\"tcc:o\",\"dimension\":\"minecraft:overworld\",\"ledger\":{\"pendingCredit\":{\"site:s4@99\":"
			+ "{\"items\":{\"minecraft:cobblestone\":5},\"at\":123},\"road:r2@7\":{\"items\":{\"minecraft:gravel\":4},\"at\":0}}}}]}", StandardCharsets.UTF_8);
		Map<String, JsonObject> early = CrateSettle.durableAtStart(f);
		System.out.println("ROW T4RM-legacy-single durable stashes at the start: " + early);
		assertTrue(early != null && early.isEmpty(), "T4RM: a main single removal's pending credit stays main's (settlePendingCredits books it), no stash: "
			+ early);
	}
}
