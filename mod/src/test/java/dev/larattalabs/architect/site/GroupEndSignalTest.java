package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;

import dev.larattalabs.architect.apiimpl.SettlementSignals;
import java.util.List;
import org.junit.jupiter.api.Test;

/** (8b review P2-5) A whole-group removal's end (a stop, a refusal part-way, a timeout) marks its owner's settlement changed. */
class GroupEndSignalTest {
	@Test
	void theEndIsSignalled() {
		var c = SettlementSignals.coalescer();
		c.clear();
		Groups.signalEnd("steward_mc:settlement/1", "g-none");
		assertEquals(List.of(new SettlementSignals.Key("steward_mc:settlement/1", null)), c.due(1_000_000L));
		Groups.signalEnd(null, "g-player");
		assertEquals(List.of(), c.due(2_000_000L), "a player's own group has no settlement");
	}
}
