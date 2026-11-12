package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.survival.Refunds;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CropBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (M5 FC, S-M5-4) A module lot's field: the ext's shape, the field rule (a crop cell holding air or a field crop at any age is unchanged),
 * and the deconstruct's seam ({@link Builder#fieldCell}): a player's field crop (a PT record) gives back its planting item once as cargo
 * (the player's blocks), a same-kind replant included, never as the construction refund; our crop, air, another block or a cell off the
 * field are left to {@link Builder#tallyCell} as before.
 */
class FieldCellsTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	/** A 3x1 field at y 64 (x 10..12, z 5), wheat and carrots; the ext as RegionsImpl writes it from nested IR runs. */
	static JsonObject ext() {
		JsonArray runs = JsonParser.parseString("[[10,5,64,64],[11,5,64,64],[12,5,64,64]]").getAsJsonArray();
		JsonArray crops = JsonParser.parseString("[\"minecraft:wheat\",\"minecraft:carrots\",\"minecraft:dirt\"]").getAsJsonArray();
		JsonObject e = new JsonObject();
		e.add(FieldCells.EXT, FieldCells.extOf(runs, crops));
		return e;
	}

	static BlockState wheat(int age) {
		return Blocks.WHEAT.defaultBlockState().setValue(CropBlock.AGE, age);
	}

	@Test
	void theExtKeepsKnownCropsAndFlatRuns() {
		JsonObject f = ext().getAsJsonObject(FieldCells.EXT);
		assertEquals("[10,5,64,64,11,5,64,64,12,5,64,64]", f.get("cells").toString());
		assertEquals("[\"minecraft:wheat\",\"minecraft:carrots\"]", f.get("crops").toString(), "a block that is no field crop is dropped");
		assertNull(FieldCells.of((JsonObject) null));
		assertNull(FieldCells.of(new JsonObject()));
		JsonObject noCrop = new JsonObject();
		noCrop.add(FieldCells.EXT, FieldCells.extOf(JsonParser.parseString("[[1,1,1,1]]").getAsJsonArray(), new JsonArray()));
		assertNull(FieldCells.of(noCrop), "no known crop: no field");
	}

	@Test
	void theFieldRuleReadsAirAnyAgeAndDriedFarmlandAsUnchanged() {
		FieldCells f = FieldCells.of(ext());
		assertNotNull(f);
		assertEquals(3, f.size());
		long crop = Journal.pos(11, 65, 5), farmland = Journal.pos(11, 64, 5), off = Journal.pos(13, 65, 5);
		assertTrue(f.cropCell(crop));
		assertTrue(f.farmlandCell(farmland));
		assertFalse(f.cropCell(farmland));
		for (int age = 0; age <= 7; age++) {
			assertTrue(f.unchanged(crop, wheat(age)), "wheat age " + age);
		}
		assertTrue(f.unchanged(crop, Blocks.CARROTS.defaultBlockState()));
		assertTrue(f.unchanged(crop, Blocks.AIR.defaultBlockState()), "harvested: air over our farmland");
		assertFalse(f.unchanged(crop, Blocks.POTATOES.defaultBlockState()), "not one of the field's crops");
		assertFalse(f.unchanged(crop, Blocks.TORCH.defaultBlockState()), "a player's torch stays as PT says");
		assertFalse(f.unchanged(off, Blocks.AIR.defaultBlockState()), "off the field");
		assertFalse(f.unchanged(farmland, Blocks.AIR.defaultBlockState()), "dug out: changed");
		assertTrue(f.unchanged(farmland, Blocks.FARMLAND.defaultBlockState()));
		assertTrue(f.unchanged(farmland, Blocks.DIRT.defaultBlockState()), "dried or trampled");
		assertFalse(f.unchanged(farmland, Blocks.STONE.defaultBlockState()));
	}

	@Test
	void aPlayersFieldCropIsCargoOnceNeverConstruction() {
		FieldCells f = FieldCells.of(ext());
		long crop = Journal.pos(10, 65, 5);
		// a same-kind replant (the contract's case): one wheat seed as the player's block, nothing refunded
		Refunds.Tally t = new Refunds.Tally();
		assertTrue(Builder.fieldCell(f, crop, wheat(7), true, t));
		assertEquals(Map.of("minecraft:wheat_seeds", 1), t.playerBlocks(), "one planting item, whatever the age");
		assertEquals(Map.of(), t.refund(), "never the construction seed");
		// another kind of the field's crops
		Refunds.Tally c = new Refunds.Tally();
		assertTrue(Builder.fieldCell(f, crop, Blocks.CARROTS.defaultBlockState(), true, c));
		assertEquals(Map.of("minecraft:carrot", 1), c.playerBlocks());
		// left to tallyCell: our crop (no record), air, a player's torch, a crop off the field, no field
		for (Object[] k : new Object[][] {{wheat(3), false, crop}, {Blocks.AIR.defaultBlockState(), true, crop},
			{Blocks.TORCH.defaultBlockState(), true, crop}, {wheat(7), true, Journal.pos(10, 64, 5)}, {wheat(7), true, Journal.pos(9, 65, 5)}}) {
			Refunds.Tally n = new Refunds.Tally();
			assertFalse(Builder.fieldCell(f, (long) k[2], (BlockState) k[0], (boolean) k[1], n), k[0] + " " + k[1]);
			assertTrue(n.playerBlocks().isEmpty() && n.refund().isEmpty());
		}
		assertFalse(Builder.fieldCell(null, crop, wheat(7), true, new Refunds.Tally()));
	}
}
