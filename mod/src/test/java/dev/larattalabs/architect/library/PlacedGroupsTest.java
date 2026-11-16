package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.library.PlacedGroups.Group;
import dev.larattalabs.architect.library.PlacedGroups.Kind;
import dev.larattalabs.architect.library.PlacedGroups.Row;
import java.util.List;
import org.junit.jupiter.api.Test;

class PlacedGroupsTest {
	@Test
	void groupsYoursCompositesRegionsThenManaged() {
		List<Row> rows = List.of(
			new Row("s1", "Log Cabin", null, null, null),
			new Row("s2", "Keep", null, "castle", null),
			new Row("s3", "Mill", "steward_mc:settlement/3", null, "r1"),
			new Row("s4", "Tower", null, "castle", null),
			new Row("s5", "House", null, null, "r2"),
			new Row("s6", "Hut", null, null, null));
		List<Group> g = PlacedGroups.group(rows, id -> id.equals("castle") ? "Castle" : id);
		assertEquals(List.of(Kind.YOURS, Kind.COMPOSITE, Kind.REGION, Kind.MANAGED), g.stream().map(Group::kind).toList());
		assertEquals(List.of("s1", "s6"), g.get(0).rows().stream().map(Row::id).toList());
		assertEquals("Castle (one building in parts)", g.get(1).title());
		assertEquals(List.of("s2", "s4"), g.get(1).rows().stream().map(Row::id).toList());
		assertEquals("Managed by Steward", g.get(3).title());
		assertTrue(g.get(3).readOnly());
		assertFalse(g.get(0).readOnly());
		// an owned site is managed even when it is in a region
		assertEquals(List.of("s3"), g.get(3).rows().stream().map(Row::id).toList());
	}

	@Test
	void namesAndComposites() {
		assertEquals("Steward", PlacedGroups.modName(PlacedGroups.ownerMod("steward_mc:settlement/3")));
		assertEquals("Agentcraft", PlacedGroups.modName("agentcraft"));
		assertEquals("castle", PlacedGroups.compositeOf("castle__keep", "__"));
		assertEquals(null, PlacedGroups.compositeOf("cabin", "__"));
		assertTrue(PlacedGroups.group(List.of(), x -> x).isEmpty());
	}
}
