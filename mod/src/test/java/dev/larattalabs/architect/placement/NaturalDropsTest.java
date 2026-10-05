package dev.larattalabs.architect.placement;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** Natural drops never block a Remove (docs/BUILDINGS.md "Safe remove"). */
class NaturalDropsTest {
	@Test
	void treeAndPlantDropsAreNatural() {
		for (String id : new String[] {"minecraft:stick", "minecraft:apple", "minecraft:wheat_seeds", "minecraft:leaf_litter", "minecraft:pink_petals",
			"minecraft:mangrove_propagule"}) {
			assertTrue(NaturalDrops.natural(id, false, false, false), id);
		}
		assertTrue(NaturalDrops.natural("minecraft:oak_sapling", true, false, false), "a sapling, by tag");
		assertTrue(NaturalDrops.natural("minecraft:dandelion", false, true, false), "a flower, by tag");
		assertTrue(NaturalDrops.natural("minecraft:cherry_sapling", true, true, false));
	}

	@Test
	void anythingAPlayerThrewIsThePlayers() {
		assertFalse(NaturalDrops.natural("minecraft:stick", false, false, true));
		assertFalse(NaturalDrops.natural("minecraft:oak_sapling", true, false, true));
		assertFalse(NaturalDrops.natural("minecraft:poppy", false, true, true));
	}

	@Test
	void otherItemsAreThePlayers() {
		for (String id : new String[] {"minecraft:diamond", "minecraft:oak_log", "minecraft:oak_leaves", "minecraft:cobblestone", "minecraft:dirt",
			"minecraft:bread", "minecraft:wheat", "minecraft:oak_planks", "minecraft:torch"}) {
			assertFalse(NaturalDrops.natural(id, false, false, false), id);
		}
	}

	@Test
	void naturalDropsNeverRefuseAPlacementAndAreNoted() {
		java.util.List<Occupancy.Found> found = java.util.List.of(new Occupancy.Found(Occupancy.Kind.DROP, "Leaf Litter", false),
			new Occupancy.Found(Occupancy.Kind.DROP, "Stick", false));
		assertTrue(Occupancy.refusals(found).isEmpty());
		assertTrue(found.stream().allMatch(Occupancy.Found::removable));
		org.junit.jupiter.api.Assertions.assertEquals("clears 2 natural drops (sticks, saplings, leaf litter...)", Occupancy.removalNote(found));
		// the player's items still refuse
		java.util.List<Occupancy.Found> mine = java.util.List.of(new Occupancy.Found(Occupancy.Kind.ITEM, "Diamond", true));
		assertFalse(Occupancy.refusals(mine).isEmpty());
	}
}
