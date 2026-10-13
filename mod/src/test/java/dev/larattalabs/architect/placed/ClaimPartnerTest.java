package dev.larattalabs.architect.placed;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * C34: a claim whose box cuts a door (or bed) in two takes the other half too, so a door in the floor row below a box that starts
 * at the player's feet is still the build's entrance (Builds counts a door's lower half only). The classifier itself is given
 * a component with the entrance and an enclosure: HOUSE, as for a build placed by use.
 */
class ClaimPartnerTest {
	@BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	@Test
	void doorHalvesPointAtEachOther() {
		BlockState door = Blocks.OAK_DOOR.defaultBlockState();
		BlockPos p = new BlockPos(5, 65, 5);
		assertEquals(p.above(), PlacedRules.partner(door.setValue(DoorBlock.HALF, DoubleBlockHalf.LOWER), p), "lower -> upper");
		assertEquals(p.below(), PlacedRules.partner(door.setValue(DoorBlock.HALF, DoubleBlockHalf.UPPER), p), "upper -> lower: the entrance cell");
	}

	@Test
	void bedPartsPointAtEachOther() {
		BlockState foot = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getValue(net.minecraft.resources.Identifier.parse("minecraft:red_bed")).defaultBlockState().setValue(BedBlock.PART, BedPart.FOOT).setValue(BedBlock.FACING, Direction.SOUTH);
		BlockPos p = new BlockPos(1, 64, 1);
		assertEquals(p.south(), PlacedRules.partner(foot, p), "the foot's head is the way it faces");
		BlockState head = foot.setValue(BedBlock.PART, BedPart.HEAD);
		assertEquals(p.north(), PlacedRules.partner(head, p));
	}

	@Test
	void otherBlocksHaveNoPartner() {
		assertNull(PlacedRules.partner(Blocks.OAK_PLANKS.defaultBlockState(), BlockPos.ZERO));
		assertNull(PlacedRules.partner(Blocks.OAK_TRAPDOOR.defaultBlockState(), BlockPos.ZERO));
	}

	@Test
	void houseNeedsEnclosureAndEntrance() {
		Builds.Comp c = new Builds.Comp();
		for (int x = 0; x < 7; x++) {
			for (int y = 0; y < 5; y++) {
				c.add(BlockPos.asLong(x, y, 0), 0, null, Blocks.OAK_PLANKS.defaultBlockState());
			}
		}
		c.enclosed = 20;
		c.footprint = new int[] {0, 0, 6};
		Builds.Rec r = new Builds.Rec();
		Builds.kind(r, c);
		assertEquals(dev.larattalabs.architect.api.BuildKind.OTHER, r.kind, "an enclosure with no entrance and no bed is not told to be a house");
		c.entrances.add(new Builds.Ent(BlockPos.asLong(3, 1, 0), Direction.SOUTH, "minecraft:oak_door"));
		Builds.kind(r, c);
		assertEquals(dev.larattalabs.architect.api.BuildKind.HOUSE, r.kind);
	}
}
