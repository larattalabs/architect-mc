package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.survival.SurvivalItems;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (T4 final round, the GPT check of 8b742e1d) Behavioural units for P1 1 (a crate-fed settle's pile destination holds the pile), P1 2 (a
 * pre-T4 queued standalone road converts), P1 3 (no bill for a held or rejected write; a CELL road holds its footprint; only the owning
 * removal's adapter is exempt). Each fails first on the seam commit (8b742e1d's behaviour behind the same seams).
 */
class FinalRoundT4Test {
	/** A purse over a plain stock map. */
	static final class FakePurse implements Builder.Purse {
		final Map<String, Integer> stock = new TreeMap<>();

		@Override
		public int stock(String item) {
			return stock.getOrDefault(item, 0);
		}

		@Override
		public boolean pay(List<SurvivalItems.Cost> costs) {
			for (SurvivalItems.Cost c : costs) {
				if (stock(c.item()) < c.count()) {
					return false;
				}
			}
			costs.forEach(c -> stock.merge(c.item(), -c.count(), Integer::sum));
			return true;
		}

		@Override
		public void giveBack(Map<String, Integer> items, BlockPos fallback) {
			items.forEach((k, v) -> stock.merge(k, v, Integer::sum));
		}

		@Override
		public void changed() {
		}
	}

	static final List<SurvivalItems.Cost> STONE = List.of(new SurvivalItems.Cost("minecraft:stone", 1));

	/** P1 3: a held cell is neither paid nor written; a write the world rejects is paid back and not built. */
	@Test
	void aHeldOrRejectedWriteBillsNothing() {
		FakePurse p = new FakePurse();
		p.stock.put("minecraft:stone", 4);
		boolean[] wrote = {false};
		assertFalse(Builder.payPut(p, STONE, List.of(), true, () -> wrote[0] = true, null, BlockPos.ZERO), "held: not placed");
		assertFalse(wrote[0], "held: nothing written");
		assertEquals(4, p.stock("minecraft:stone"), "held: nothing billed");
		assertFalse(Builder.payPut(p, STONE, STONE, false, () -> false, () -> true, BlockPos.ZERO), "rejected: not placed");
		assertEquals(4, p.stock("minecraft:stone"), "rejected: paid back");
		assertTrue(Builder.payPut(p, STONE, STONE, false, () -> true, () -> false, BlockPos.ZERO), "its cell placed");
		assertEquals(3, p.stock("minecraft:stone"), "its pair's rejected write paid back");
	}

	static JsonObject road(String site, String hold) {
		return JsonParser.parseString("{\"dim\":\"minecraft:overworld\",\"site\":\"" + site + "\",\"box\":[0,64,0,10,64,10]" + (hold == null ? ""
			: ",\"hold\":" + hold) + "}").getAsJsonObject();
	}

	/** P1 3: a CELL road's hold is its footprint, not its bounding rectangle; a site's stash (no footprint) holds its box. */
	@Test
	void aCellRoadHoldsItsFootprint() {
		long a = BlockPos.asLong(0, 64, 0), b = BlockPos.asLong(10, 64, 10);
		List<CrateSettle.HeldBox> h = CrateSettle.heldOf(List.of(road("r1", "[" + a + "," + b + "]")));
		assertTrue(CrateSettle.heldFor(h, "minecraft:overworld", 0, 64, 0, null));
		assertFalse(CrateSettle.heldFor(h, "minecraft:overworld", 5, 64, 5, null), "inside the rectangle, off the bent road");
		List<CrateSettle.HeldBox> s = CrateSettle.heldOf(List.of(road("s1", null)));
		assertTrue(CrateSettle.heldFor(s, "minecraft:overworld", 5, 64, 5, null));
	}

	/** P1 3: only the adapter of the txn that owns the removal writes in its hold; any other txn's adapter is refused. */
	@Test
	void onlyTheOwningRemovalIsExempt() {
		List<CrateSettle.HeldBox> s = CrateSettle.heldOf(List.of(road("s1", null)));
		assertFalse(CrateSettle.heldFor(s, "minecraft:overworld", 5, 64, 5, "s1"), "its own removal's adapter writes");
		assertTrue(CrateSettle.heldFor(s, "minecraft:overworld", 5, 64, 5, "s2"), "another removal's adapter is refused");
		assertTrue(CrateSettle.heldFor(s, "minecraft:overworld", 5, 64, 5, ""), "a txn that is no removal's is refused");
	}

	/** P1 1: a crate-fed settle whose refund or stock credits a pile holds that pile (against removeStockpileCrate and dissolve). */
	@Test
	void aCrateFedSettlesPileIsHeld() {
		JsonObject root = JsonParser.parseString("{\"s7\":{\"key\":\"crate-settle:s7\",\"dim\":\"minecraft:overworld\",\"pos\":0,\"recipient\":\"tcc:o\","
			+ "\"pile\":\"tcc:o\",\"site\":\"s7\",\"crateOwner\":\"s7\",\"refund\":{\"minecraft:stone\":2}}}").getAsJsonObject();
		CrateSettle.durableRead(root);
		try {
			assertNotNull(CrateSettle.stashCrediting("tcc:o"));
		} finally {
			CrateSettle.durableRead(null);
		}
	}

	/** P1 2: a pre-T4 queued standalone road removal (C29's credit, no stash) converts; a group's road keeps its credit until T4c. */
	@Test
	void aQueuedPreT4RoadConverts() {
		JsonObject o = JsonParser.parseString("{\"siteId\":\"r2\",\"kind\":\"remove\",\"group\":\"u:remove-r2\",\"phase\":2,\"credit\":{\"owner\":\"tcc:o\","
			+ "\"key\":\"road:r2@7\",\"items\":{\"minecraft:stone\":13},\"at\":0}}").getAsJsonObject();
		RestoreJob j = RestoreJob.fromJson(o);
		assertTrue(j.legacyRoad(), "a standalone road's C29 credit");
		o.addProperty("group", "u:group-g1");
		assertFalse(RestoreJob.fromJson(o).legacyRoad(), "a group's road (T4c converts group credits)");
	}
}
