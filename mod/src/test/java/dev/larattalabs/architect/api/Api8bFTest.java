package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Method;
import java.util.List;
import org.junit.jupiter.api.Test;

/** (8bF) The 8b members are defaults on the API interfaces (an older Architect throws), the event is declared, the page limit is 256. */
class Api8bFTest {
	@Test
	void theNewMembersAreDefaults() throws Exception {
		for (Method m : List.of(Regions.class.getMethod("layout", String.class), Regions.class.getMethod("bill", String.class, int.class, int.class),
			Regions.class.getMethod("bill", String.class, java.util.Set.class), Sites.class.getMethod("checkConnector", ConnectorRequest.class),
			Sites.class.getMethod("targetBill", String.class))) {
			assertTrue(m.isDefault(), m.getName());
		}
		assertEquals(256, Limits.BILL_PAGE_MAX);
		assertTrue(SiteEvents.SETTLEMENT_CHANGED != null);
	}

	@Test
	void recordsNormalise() {
		var b = new RegionBill("rg1", null, java.util.Map.of(), java.util.Map.of(), java.util.Map.of(), java.util.Map.of(), List.of(), 0, null, null, true, null);
		assertTrue(b.owed().isEmpty() && b.notes().isEmpty());
		var s = new PartShape("p", "tile", null, new net.minecraft.world.level.levelgen.structure.BoundingBox(0, 0, 0, 1, 1, 1), null, 0, null, null);
		assertTrue(s.ends().isEmpty() && s.targets().isEmpty());
		assertEquals(64, PartShape.MAX_ENDS);
	}
}
