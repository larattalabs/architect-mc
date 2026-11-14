package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Set;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (SAD, SAC2) The world start's crate-reference repair ({@code Stockpiles.repairJoinedCrates}) decides by {@code Stockpiles.namesJoined}:
 * with no adoption key credited (every ordinary start, a world that never ran adoptCrates or whose adoptCrates finished) nothing is named,
 * so the repair clears nothing and saves nothing; after a stop between adoptCrates' two saves, the site's own crate key or its group's
 * shared crate key names it.
 */
class StockpileRepairSADTest {
	static final String AT = "@" + new BlockPos(10, 64, -5).asLong();

	@Test
	void anOrdinaryStartNamesNothing() {
		assertFalse(Stockpiles.namesJoined(Set.<String>of()::contains, "s3", "g2", 10, 64, -5), "no key credited: nothing to repair");
		// another crate's key, or another place's, names nothing
		Set<String> other = Set.of("adopt:group:g9" + AT, "adopt:group:g2@" + new BlockPos(11, 64, -5).asLong(), "site:s3@1");
		assertFalse(Stockpiles.namesJoined(other::contains, "s3", "g2", 10, 64, -5));
		assertFalse(Stockpiles.namesJoined(other::contains, "s3", null, 10, 64, -5));
	}

	@Test
	void aJoinedCrateIsNamedByItsOwnOrItsGroupsKey() {
		assertTrue(Stockpiles.namesJoined(Set.of("adopt:group:g2" + AT)::contains, "s3", "g2", 10, 64, -5), "the group's shared crate");
		assertTrue(Stockpiles.namesJoined(Set.of("adopt:s3" + AT)::contains, "s3", "g2", 10, 64, -5), "the site's own crate");
		assertTrue(Stockpiles.namesJoined(Set.of("adopt:group:g2" + AT)::contains, "group:g2", null, 10, 64, -5), "a group record's crate");
	}
}
