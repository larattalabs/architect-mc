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
import net.minecraft.world.level.block.entity.CampfireBlockEntity;
import net.minecraft.world.level.block.entity.ChiseledBookShelfBlockEntity;
import net.minecraft.world.level.block.entity.CrafterBlockEntity;
import net.minecraft.world.level.block.entity.DecoratedPotBlockEntity;
import net.minecraft.world.level.block.entity.JukeboxBlockEntity;
import net.minecraft.world.level.block.entity.LecternBlockEntity;
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

/** (slice T1b, widened in T2a) test.move takes the held container types (a double chest's half with its partner); every other cell is refused. */
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
		assertNull(TestMoveCells.partner(P, Blocks.CHEST.defaultBlockState()));
	}

	@Test
	void bothHalvesOfADoubleChestAreAcceptedWithTheirPartner() {
		for (ChestType t : new ChestType[] {ChestType.LEFT, ChestType.RIGHT}) {
			var st = Blocks.CHEST.defaultBlockState().setValue(ChestBlock.TYPE, t);
			assertNull(TestMoveCells.refusal(P, new ChestBlockEntity(P, st)), t.name());
			BlockPos q = TestMoveCells.partner(P, st);
			assertNotNull(q, t.name());
			assertEquals(1, P.distManhattan(q), t.name());
			assertEquals(ChestBlock.getConnectedBlockPos(P, st), q);
		}
	}

	@Test
	void everyHeldTypeIsAccepted() {
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
		cells.put("minecraft:crafter", new CrafterBlockEntity(P, Blocks.CRAFTER.defaultBlockState()));
		var copper = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getOptional(net.minecraft.resources.Identifier.parse("minecraft:copper_chest"))
			.orElseThrow();
		cells.put("minecraft:copper_chest", new ChestBlockEntity(P, copper.defaultBlockState()));
		cells.forEach((type, be) -> assertNull(TestMoveCells.refusal(P, be), type));
	}

	@Test
	void unenumeratedTypesAndUnpackedLootAreRefused() {
		Map<String, BlockEntity> cells = new LinkedHashMap<>();
		cells.put("minecraft:campfire", new CampfireBlockEntity(P, Blocks.CAMPFIRE.defaultBlockState()));
		cells.put("minecraft:lectern", new LecternBlockEntity(P, Blocks.LECTERN.defaultBlockState()));
		cells.put("minecraft:jukebox", new JukeboxBlockEntity(P, Blocks.JUKEBOX.defaultBlockState()));
		cells.put("minecraft:chiseled_bookshelf", new ChiseledBookShelfBlockEntity(P, Blocks.CHISELED_BOOKSHELF.defaultBlockState()));
		cells.put("minecraft:decorated_pot", new DecoratedPotBlockEntity(P, Blocks.DECORATED_POT.defaultBlockState()));
		cells.forEach((type, be) -> {
			String why = TestMoveCells.refusal(P, be);
			assertNotNull(why, type);
			assertTrue(why.contains("[1, 64, -2] is " + type), why);
		});
		ChestBlockEntity loot = new ChestBlockEntity(P, Blocks.CHEST.defaultBlockState());
		loot.setLootTable(net.minecraft.world.level.storage.loot.BuiltInLootTables.SIMPLE_DUNGEON, 1L);
		assertTrue(TestMoveCells.refusal(P, loot).contains("loot table"));
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
