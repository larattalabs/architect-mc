package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.survival.Refunds;
import dev.larattalabs.architect.survival.SurvivalItems;
import java.util.BitSet;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-N, the final check of f7607b13's P1-2 "K6") A paid site removed with a player's blocks in its box (two sponges in place of
 * paid planks): the live removal drops them (PLAYER_DROP, in its refund). A crash at K6 (the undo committed, nothing written) leaves the
 * removal to its txn's W restore at the next start, which knows only its durable stash: before the fix the stash held the paid refund alone,
 * and the W wrote air over both sponges with no return (the player's blocks lost). The stash, saved before the commit, now carries each
 * player's cell (position, block, items), so the recovered W can give them back exactly as the live removal does.
 */
class T4RNK6PlayerBlocksTest {
	@Test
	void thePileStashCarriesThePlayersCells() {
		System.out.println("ROW T4RN-k6-stash (unit)");
		Refunds.Tally tally = new Refunds.Tally();
		long p0 = BlockPos.asLong(0, 64, 0), p1 = BlockPos.asLong(1, 64, 0), s0 = BlockPos.asLong(2, 64, 0), s1 = BlockPos.asLong(3, 64, 0);
		for (long p : new long[] {p0, p1}) {
			tally.add(Refunds.Outcome.REFUND, p, "minecraft:oak_planks", List.of(new SurvivalItems.Cost("minecraft:oak_planks", 1)), null);
		}
		for (long p : new long[] {s0, s1}) {
			tally.add(Refunds.Outcome.PLAYER_DROP, p, "minecraft:sponge", List.of(new SurvivalItems.Cost("minecraft:sponge", 1)), null);
		}
		Anchors.Bounds bx = new Anchors.Bounds(0, 64, 0, 3, 64, 0);
		Construction con = new Construction(Construction.BUILT, new int[] {0, 1, 2, 3}, "journal", null, new BitSet(), false, "owner");
		Site site = new Site("paid", "bp", "none", bx, bx, Map.of(), 1, "minecraft:overworld", bx, "snapshot", null, null, con);
		Builder.Deconstruction d = new Builder.Deconstruction(tally, Map.of(), BlockPos.ZERO, 4, 0, "owner", Builder.creditKey(site));
		assertEquals(Map.of("minecraft:sponge", 2), d.all(), "fixture: the live removal drops the player's 2 sponges");
		JsonObject stash = CrateSettle.pileStash(site, d);
		System.out.println("ROW T4RN-k6-stash: the durable pile stash: " + stash);
		assertNotNull(stash.get("player"), "T4RN-k6-stash: the durable stash has no record of the player's blocks (a K6-recovered removal loses them)");
		Map<String, Integer> items = new TreeMap<>();
		JsonArray a = stash.getAsJsonArray("player");
		for (JsonElement e : a) {
			JsonObject c = e.getAsJsonObject();
			assertEquals("minecraft:sponge", c.get("block").getAsString(), "T4RN-k6-stash: each player's cell names its block");
			assertTrue(c.get("pos").getAsLong() == s0 || c.get("pos").getAsLong() == s1, "T4RN-k6-stash: at its position");
			c.getAsJsonObject("items").entrySet().forEach(x -> items.merge(x.getKey(), x.getValue().getAsInt(), Integer::sum));
		}
		assertEquals(2, a.size(), "T4RN-k6-stash: both player's cells recorded");
		assertEquals(Map.of("minecraft:sponge", 2), items, "T4RN-k6-stash: what they return");
		assertEquals(Map.of("minecraft:oak_planks", 2), CrateSettle.refundOf(stash), "T4RN-k6-stash: the paid refund unchanged");
	}

	// (slice T4R-D) the T4R-N cascade predicate case is retired with its helpers: one owner txn writes every member (T4RDOwnerTest)
}
