package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import dev.larattalabs.architect.placement.Anchors;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-M) The admission rule's pure core ({@link RemovalAreas#first}): a removal's box meeting another in-flight removal's area, in
 * the same dimension, is refused; its own areas never; a box that only touches another dimension or misses it is free.
 */
class T4RMRemovalAreasTest {
	@Test
	void anOverlappingAreaIsFoundItsOwnIsNot() {
		System.out.println("ROW T4RM-areas (unit)");
		RemovalAreas.Area legacy = new RemovalAreas.Area("minecraft:overworld", new Anchors.Bounds(0, 64, 0, 26, 64, 0), "the removal of group g1", "group:g1");
		RemovalAreas.Area stash = new RemovalAreas.Area("minecraft:overworld", new Anchors.Bounds(40, 60, 40, 50, 70, 50), "the removal of s7", "s7");
		List<RemovalAreas.Area> areas = List.of(legacy, stash);
		Anchors.Bounds u = new Anchors.Bounds(6, 64, -4, 20, 64, 4); // a U crossing the line twice
		assertEquals(legacy, RemovalAreas.first(areas, "minecraft:overworld", List.of(u), Set.of("group:g2")));
		assertNull(RemovalAreas.first(areas, "minecraft:overworld", List.of(u), Set.of("group:g1")), "its own area");
		assertNull(RemovalAreas.first(areas, "minecraft:the_nether", List.of(u), Set.of()), "another dimension");
		assertNull(RemovalAreas.first(areas, "minecraft:overworld", List.of(new Anchors.Bounds(30, 64, 30, 35, 64, 35)), Set.of()), "no overlap");
		assertEquals(stash, RemovalAreas.first(areas, "minecraft:overworld", List.of(new Anchors.Bounds(30, 64, 30, 35, 64, 35), new Anchors.Bounds(45, 64, 45,
			60, 64, 60)), Set.of("s8")), "any of its boxes");
	}
}
