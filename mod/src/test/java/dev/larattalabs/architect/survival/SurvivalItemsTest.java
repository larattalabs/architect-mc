package dev.larattalabs.architect.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.survival.SurvivalItems.Cost;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/** The BOM mapping (docs/CONTRACT.md phase 3 "Materials"): items, the special cases and the obtainability map. */
class SurvivalItemsTest {
	static final SurvivalItems RULES = SurvivalItems.bundled();
	/** A stand-in for {@code Block.asItem()}: the block's own id, except blocks vanilla registers no item for. */
	static final Function<String, String> AS_ITEM = id -> switch (id) {
		case "minecraft:fire", "minecraft:soul_fire", "minecraft:air", "minecraft:water", "minecraft:wall_torch", "minecraft:oak_wall_sign",
			"minecraft:potted_poppy", "minecraft:potted_azalea_bush", "minecraft:dirt_path", "minecraft:farmland", "minecraft:white_wall_banner",
			"minecraft:skeleton_wall_skull", "minecraft:soul_wall_torch", "minecraft:oak_wall_hanging_sign", "minecraft:tube_coral_wall_fan" -> null;
		default -> id;
	};

	static List<Cost> cost(String block, String... kv) {
		Map<String, String> props = new HashMap<>();
		for (int i = 0; i + 1 < kv.length; i += 2) {
			props.put(kv[i], kv[i + 1]);
		}
		return RULES.cost(block, props, AS_ITEM);
	}

	static List<Cost> one(String item, int n) {
		return List.of(new Cost(item, n));
	}

	@Test
	void plainBlocksCostTheirItem() {
		assertEquals(one("minecraft:spruce_planks", 1), cost("minecraft:spruce_planks"));
		assertEquals(one("minecraft:spruce_stairs", 1), cost("minecraft:spruce_stairs", "half", "top", "facing", "north"));
		assertEquals(one("minecraft:spruce_slab", 1), cost("minecraft:spruce_slab", "type", "bottom"));
	}

	@Test
	void pairsCostOneItemOnTheirFirstCell() {
		assertEquals(one("minecraft:spruce_door", 1), cost("minecraft:spruce_door", "half", "lower"));
		assertEquals(List.of(), cost("minecraft:spruce_door", "half", "upper"));
		assertEquals(one("minecraft:red_bed", 1), cost("minecraft:red_bed", "part", "foot"));
		assertEquals(List.of(), cost("minecraft:red_bed", "part", "head"));
		assertEquals(one("minecraft:sunflower", 1), cost("minecraft:sunflower", "half", "lower"));
		assertEquals(List.of(), cost("minecraft:sunflower", "half", "upper"));
	}

	@Test
	void countsAndDoubleSlabs() {
		assertEquals(one("minecraft:spruce_slab", 2), cost("minecraft:spruce_slab", "type", "double"));
		assertEquals(one("minecraft:candle", 3), cost("minecraft:candle", "candles", "3", "lit", "false"));
		assertEquals(one("minecraft:sea_pickle", 4), cost("minecraft:sea_pickle", "pickles", "4"));
		assertEquals(one("minecraft:snow", 5), cost("minecraft:snow", "layers", "5"));
	}

	@Test
	void wallBlocksCostTheirStandingItem() {
		assertEquals(one("minecraft:torch", 1), cost("minecraft:wall_torch", "facing", "east"));
		assertEquals(one("minecraft:soul_torch", 1), cost("minecraft:soul_wall_torch"));
		assertEquals(one("minecraft:oak_sign", 1), cost("minecraft:oak_wall_sign"));
		assertEquals(one("minecraft:oak_hanging_sign", 1), cost("minecraft:oak_wall_hanging_sign"));
		assertEquals(one("minecraft:white_banner", 1), cost("minecraft:white_wall_banner"));
		assertEquals(one("minecraft:skeleton_skull", 1), cost("minecraft:skeleton_wall_skull"));
		assertEquals(one("minecraft:tube_coral_fan", 1), cost("minecraft:tube_coral_wall_fan"));
	}

	@Test
	void noItemCostsNothing() {
		assertEquals(List.of(), cost("minecraft:fire", "age", "0"));
		assertEquals(List.of(), cost("minecraft:soul_fire"));
		assertEquals(List.of(), cost("minecraft:air"));
	}

	@Test
	void obtainabilityMap() {
		assertEquals(one("minecraft:dirt", 1), cost("minecraft:dirt_path"));
		assertEquals(one("minecraft:dirt", 1), cost("minecraft:farmland", "moisture", "7"));
		assertEquals(one("minecraft:dirt", 1), cost("minecraft:grass_block", "snowy", "false"));
		assertEquals(List.of(new Cost("minecraft:flower_pot", 1), new Cost("minecraft:poppy", 1)), cost("minecraft:potted_poppy"));
		assertEquals(List.of(new Cost("minecraft:flower_pot", 1), new Cost("minecraft:azalea", 1)), cost("minecraft:potted_azalea_bush"));
	}

	@Test
	void creativeOnlyBlocksAreKnown() {
		for (String b : List.of("minecraft:spawner", "minecraft:budding_amethyst", "minecraft:reinforced_deepslate", "minecraft:bedrock",
			"minecraft:end_portal_frame", "minecraft:command_block", "minecraft:barrier", "minecraft:light", "minecraft:structure_block")) {
			assertTrue(RULES.creativeOnly(b), b);
		}
		assertFalse(RULES.creativeOnly("minecraft:spruce_planks"));
		assertFalse(RULES.creativeOnly("minecraft:dirt_path"));
		assertEquals(List.of(), cost("minecraft:bedrock"));
	}

	@Test
	void standingNames() {
		assertEquals("minecraft:torch", SurvivalItems.standing("minecraft:wall_torch"));
		assertEquals("minecraft:redstone_torch", SurvivalItems.standing("minecraft:redstone_wall_torch"));
		assertEquals("minecraft:copper_torch", SurvivalItems.standing("minecraft:copper_wall_torch"));
		assertEquals("minecraft:stone", SurvivalItems.standing("minecraft:stone"));
	}
}
