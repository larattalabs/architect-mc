package dev.larattalabs.architect.txn;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (slice T2b part 2b) {@code crate.settle}'s plan (R-1), the shape TxnCrateSettleModelTest proves: e0 the take (B, prepare, the stock planned
 * now), then the stock owed (O, reason crate_settle, site and region filled) or credited to the pile (L, keyed), a crate-fed site's refunds
 * owed as group_refund (or credited), the cell restored (W) and the journal entry released (R). An empty crate plans no take and no booking.
 */
class CrateSettlePlanTest {
	static final BlockPos P = new BlockPos(10, 64, -3);
	static final String KEY = CrateTxn.settleKey("s1", P, "site:s1@7");

	static List<Effect> built(CrateTxn.Settle in) {
		List<Effect.Builder> b = CrateTxn.plan(in);
		List<Effect> out = new java.util.ArrayList<>();
		for (int i = 0; i < b.size(); i++) {
			out.add(b.get(i).build(i));
		}
		return out;
	}

	@Test
	void noPileOwesTheStockAndTheRefund() {
		List<Effect> e = built(new CrateTxn.Settle(KEY, "minecraft:overworld", P, Map.of("minecraft:oak_planks", 12), Map.of("minecraft:cobblestone", 3),
			"uuid-1", null, "s1", "r9", "{Name:\"minecraft:grass_block\"}", null, "s1", true));
		assertEquals(List.of(CrateTxn.TAKE, CrateTxn.OWE, CrateTxn.OWE, CrateTxn.RESTORE, CrateTxn.RELEASE), e.stream().map(Effect::op).toList());
		assertTrue(e.get(0).prepare() && e.get(0).cls() == EffectClass.B && e.get(0).intoTransit());
		assertEquals(KEY, e.get(1).data().get("key").getAsString());
		assertEquals("crate_settle", e.get(1).data().get("reason").getAsString());
		assertEquals("s1", e.get(1).data().get("site").getAsString());
		assertEquals("r9", e.get(1).data().get("region").getAsString());
		assertEquals("group_refund", e.get(2).data().get("reason").getAsString());
		assertEquals("refund:" + KEY, e.get(2).data().get("key").getAsString());
		assertTrue(e.stream().skip(1).noneMatch(Effect::prepare), "only the take is a prepare effect");
		assertEquals(List.of(KEY, "refund:" + KEY), CrateTxn.owedOf(new CrateTxn.Settle(KEY, "d", P, Map.of("a", 1), Map.of("b", 1), "u", null, null, null,
			"x", null, "s1", true)));
	}

	@Test
	void aPileIsCreditedKeyedAndAnEmptyCrateOnlyRestores() {
		List<Effect> e = built(new CrateTxn.Settle(KEY, "minecraft:overworld", P, Map.of("minecraft:oak_planks", 12), Map.of(), "owner:x", "owner:x", "s1",
			null, "{Name:\"minecraft:air\"}", null, "group:g", true));
		assertEquals(List.of(CrateTxn.TAKE, CrateTxn.PILE_CREDIT, CrateTxn.RESTORE, CrateTxn.RELEASE), e.stream().map(Effect::op).toList());
		assertEquals(EffectClass.L, e.get(1).cls());
		assertEquals("group:g", e.get(3).data().get("owner").getAsString());
		List<Effect> empty = built(new CrateTxn.Settle(KEY, "minecraft:overworld", P, Map.of(), Map.of(), "u", null, null, null, "{Name:\"minecraft:air\"}",
			null, "s1", true));
		assertEquals(List.of(CrateTxn.RESTORE, CrateTxn.RELEASE), empty.stream().map(Effect::op).toList());
	}
}
