package dev.larattalabs.architect.txn;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.entity.BarrelBlockEntity;
import net.minecraft.world.level.block.entity.BlastFurnaceBlockEntity;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BrewingStandBlockEntity;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.minecraft.world.level.block.entity.DispenserBlockEntity;
import net.minecraft.world.level.block.entity.DropperBlockEntity;
import net.minecraft.world.level.block.entity.FurnaceBlockEntity;
import net.minecraft.world.level.block.entity.HopperBlockEntity;
import net.minecraft.world.level.block.entity.ShulkerBoxBlockEntity;
import net.minecraft.world.level.block.entity.SmokerBlockEntity;
import net.minecraft.world.level.block.entity.TrappedChestBlockEntity;
import net.minecraft.world.level.block.state.properties.ChestType;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** (slice T1b) test.move takes single plain chests only; every other cell is refused with its reason. Dimensions are canonical keys. */
class TestMoveCellsTest {
	static final BlockPos P = new BlockPos(1, 64, -2);

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@Test
	void aSinglePlainChestIsAccepted() {
		assertNull(TestMoveCells.refusal(P, new ChestBlockEntity(P, Blocks.CHEST.defaultBlockState())));
		assertEquals(ChestType.SINGLE, Blocks.CHEST.defaultBlockState().getValue(ChestBlock.TYPE));
	}

	@Test
	void bothHalvesOfADoubleChestAreRefused() {
		for (ChestType t : new ChestType[] {ChestType.LEFT, ChestType.RIGHT}) {
			String why = TestMoveCells.refusal(P, new ChestBlockEntity(P, Blocks.CHEST.defaultBlockState().setValue(ChestBlock.TYPE, t)));
			assertNotNull(why, t.name());
			assertTrue(why.contains("double chest"), why);
		}
	}

	@Test
	void everyOtherBlockEntityTypeIsRefused() {
		Map<String, BlockEntity> cells = new LinkedHashMap<>();
		cells.put("minecraft:dropper", new DropperBlockEntity(P, Blocks.DROPPER.defaultBlockState()));
		cells.put("minecraft:dispenser", new DispenserBlockEntity(P, Blocks.DISPENSER.defaultBlockState()));
		cells.put("minecraft:furnace", new FurnaceBlockEntity(P, Blocks.FURNACE.defaultBlockState()));
		cells.put("minecraft:blast_furnace", new BlastFurnaceBlockEntity(P, Blocks.BLAST_FURNACE.defaultBlockState()));
		cells.put("minecraft:smoker", new SmokerBlockEntity(P, Blocks.SMOKER.defaultBlockState()));
		cells.put("minecraft:hopper", new HopperBlockEntity(P, Blocks.HOPPER.defaultBlockState()));
		cells.put("minecraft:barrel", new BarrelBlockEntity(P, Blocks.BARREL.defaultBlockState()));
		cells.put("minecraft:trapped_chest", new TrappedChestBlockEntity(P, Blocks.TRAPPED_CHEST.defaultBlockState()));
		cells.put("minecraft:shulker_box", new ShulkerBoxBlockEntity(P, Blocks.SHULKER_BOX.defaultBlockState()));
		cells.put("minecraft:brewing_stand", new BrewingStandBlockEntity(P, Blocks.BREWING_STAND.defaultBlockState()));
		// a copper chest shares the chest's block entity type: refused by its block
		var copper = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getOptional(net.minecraft.resources.Identifier.parse("minecraft:copper_chest"))
			.orElseThrow();
		cells.put("minecraft:chest (minecraft:copper_chest)", new ChestBlockEntity(P, copper.defaultBlockState()));
		cells.forEach((type, be) -> {
			String why = TestMoveCells.refusal(P, be);
			assertNotNull(why, type);
			assertTrue(why.startsWith("test.move moves only between single plain chests; [1, 64, -2] is " + type), why);
		});
	}

	@Test
	void anEmptyCellIsRefused() {
		String why = TestMoveCells.refusal(P, null);
		assertNotNull(why);
		assertTrue(why.contains("no block entity"), why);
	}

	@Test
	void dimensionsMustBeCanonicalKeys() {
		assertNull(TestMoveCells.dimRefusal("minecraft:overworld"));
		assertNull(TestMoveCells.dimRefusal("minecraft:the_nether"));
		assertEquals("minecraft:the_end", TestMoveCells.canonicalDim("minecraft:the_end"));
		// "overworld" parses as minecraft:overworld but would key a box ("box:overworld@...") the hold mixins never look up
		assertTrue(TestMoveCells.dimRefusal("overworld").contains("not canonical (use minecraft:overworld)"));
		assertNull(TestMoveCells.canonicalDim("overworld"));
		for (String bad : new String[] {"Minecraft:Overworld", "minecraft:over world", "::", "a:b:c"}) {
			assertNotNull(TestMoveCells.dimRefusal(bad), bad);
			assertNull(TestMoveCells.canonicalDim(bad), bad);
		}
		assertEquals("dimension is required", TestMoveCells.dimRefusal(""));
		assertEquals("dimension is required", TestMoveCells.dimRefusal(null));
	}
}
