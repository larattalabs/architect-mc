package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.SharedConstants;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.HugeMushroomBlock;
import net.minecraft.world.level.block.SpeleothemBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.SpeleothemThickness;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (6c F3 §6, §10 items 6 and 8) "Still ours" for F3's blocks: a huge mushroom block's six faces and pointed dripstone's thickness are
 * volatile (vertical_direction and every other block's faces still compare); {@link Coral#canonical} read from vanilla equals what
 * kit/lib/blocks.mjs lists (every dead coral row's live form, both ways), and a dead coral holds the live coral written, a wall fan's
 * facing still compares; leaves keep distance volatile and persistent compared.
 */
class StillOursF3Test {
	static final Path BLOCKS = Path.of("../kit/lib/blocks.mjs");
	static final Pattern ROW = Pattern.compile("^b\\('((?:dead_)?(?:tube|brain|bubble|fire|horn)_coral(?:_block|_fan|_wall_fan)?)'", Pattern.MULTILINE);

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static Block block(String id) {
		Identifier k = Identifier.parse("minecraft:" + id);
		assertTrue(BuiltInRegistries.BLOCK.containsKey(k), "no block " + id);
		return BuiltInRegistries.BLOCK.getValue(k);
	}

	static boolean holds(BlockState now, BlockState after) {
		return StillOurs.holds(now, null, after, null);
	}

	@Test
	void mushroomFacesAreVolatile() {
		for (Block b : new Block[] {Blocks.BROWN_MUSHROOM_BLOCK, Blocks.RED_MUSHROOM_BLOCK, Blocks.MUSHROOM_STEM}) {
			assertTrue(b instanceof HugeMushroomBlock);
			BlockState wrote = b.defaultBlockState();
			BlockState now = wrote.setValue(HugeMushroomBlock.UP, false).setValue(HugeMushroomBlock.DOWN, false).setValue(HugeMushroomBlock.NORTH, false);
			assertTrue(holds(now, wrote), b + ": a face set false by a neighbour holds");
			assertTrue(WorldJournal.same(WorldJournal.value(now), WorldJournal.value(wrote)), b + ": same");
			for (String f : new String[] {"north", "east", "south", "west", "up", "down"}) {
				assertTrue(StillOurs.volatileProperty(wrote, f), b + "." + f);
			}
		}
		// another block's faces still compare (a fence's connections are its own rule; a mushroom cap is not a stem)
		assertFalse(holds(Blocks.MUSHROOM_STEM.defaultBlockState(), Blocks.RED_MUSHROOM_BLOCK.defaultBlockState()));
		assertFalse(StillOurs.volatileProperty(Blocks.CHERRY_LOG.defaultBlockState(), "up"));
		assertFalse(StillOurs.volatileProperty(Blocks.STONE.defaultBlockState(), "down"));
	}

	@Test
	void dripstoneThicknessIsVolatileItsDirectionIsNot() {
		BlockState tip = Blocks.POINTED_DRIPSTONE.defaultBlockState().setValue(SpeleothemBlock.TIP_DIRECTION, Direction.DOWN)
			.setValue(SpeleothemBlock.THICKNESS, SpeleothemThickness.TIP);
		assertTrue(Blocks.POINTED_DRIPSTONE instanceof SpeleothemBlock);
		assertEquals("thickness", SpeleothemBlock.THICKNESS.getName());
		assertEquals("vertical_direction", SpeleothemBlock.TIP_DIRECTION.getName());
		for (SpeleothemThickness t : SpeleothemThickness.values()) {
			assertTrue(holds(tip.setValue(SpeleothemBlock.THICKNESS, t), tip), "thickness " + t);
		}
		assertFalse(holds(tip.setValue(SpeleothemBlock.TIP_DIRECTION, Direction.UP), tip), "a stalagmite is not the stalactite we wrote");
		assertFalse(StillOurs.volatileProperty(Blocks.STONE.defaultBlockState(), "thickness"));
	}

	@Test
	void leavesKeepTheirRule() {
		BlockState w = Blocks.OAK_LEAVES.defaultBlockState().setValue(BlockStateProperties.DISTANCE, 3).setValue(BlockStateProperties.PERSISTENT, true);
		assertTrue(holds(w.setValue(BlockStateProperties.DISTANCE, 7), w), "distance volatile");
		assertFalse(holds(w.setValue(BlockStateProperties.PERSISTENT, false), w), "persistent compared");
	}

	@Test
	void coralCanonicalEqualsTheKitsRows() throws IOException {
		String src = Files.readString(BLOCKS);
		Set<String> kit = new TreeSet<>();
		Matcher m = ROW.matcher(src);
		while (m.find()) {
			kit.add(m.group(1));
		}
		assertEquals(40, kit.size(), "kit/lib/blocks.mjs: 5 corals x (block, plant, fan, wall fan) x (live, dead): " + kit);
		Set<String> chain = new TreeSet<>();
		for (Block b : BuiltInRegistries.BLOCK) {
			if (Coral.inChain(b)) {
				chain.add(BuiltInRegistries.BLOCK.getKey(b).getPath());
			}
		}
		assertEquals(kit, chain, "vanilla's coral chain is the kit's 40 rows");
		for (String id : kit) {
			String live = id.startsWith("dead_") ? id.substring(5) : id;
			assertSame(block(live), Coral.canonical(block(id)), id + " -> " + live);
		}
		for (Block b : new Block[] {Blocks.STONE, Blocks.SEA_PICKLE, Blocks.KELP, Blocks.SEAGRASS}) {
			assertSame(b, Coral.canonical(b));
			assertFalse(Coral.inChain(b), b.toString());
		}
	}

	@Test
	void aDeadCoralHoldsTheLiveOneWritten() {
		for (String c : new String[] {"tube", "brain", "bubble", "fire", "horn"}) {
			for (String form : new String[] {"_coral_block", "_coral", "_coral_fan", "_coral_wall_fan"}) {
				Block liveB = block(c + form), deadB = block("dead_" + c + form);
				BlockState live = liveB.defaultBlockState(), dead = deadB.withPropertiesOf(live);
				assertTrue(holds(dead, live), "dead " + c + form + " holds the live one written");
				assertTrue(holds(live, live));
				assertTrue(WorldJournal.same(WorldJournal.value(dead), WorldJournal.value(live)), "same: " + c + form);
				assertTrue(WorldJournal.cuEquivalent(dead, live), "a player's record wins over the equivalence: " + c + form);
				// the live coral written dead (never by the generator) does not turn live by itself: a live one over a dead write holds too
				assertTrue(holds(live, dead));
			}
			// a wall fan's facing still compares; another coral never holds
			BlockState fan = block(c + "_coral_wall_fan").defaultBlockState();
			assertFalse(holds(block("dead_" + c + "_coral_wall_fan").withPropertiesOf(fan).setValue(BlockStateProperties.HORIZONTAL_FACING, Direction.EAST),
				fan.setValue(BlockStateProperties.HORIZONTAL_FACING, Direction.NORTH)));
			assertFalse(holds(block("dead_" + c + "_coral_block").defaultBlockState(), block(c + "_coral").defaultBlockState()), "a block is not a plant");
		}
		assertFalse(holds(block("dead_brain_coral_block").defaultBlockState(), block("tube_coral_block").defaultBlockState()), "another coral");
	}
}
