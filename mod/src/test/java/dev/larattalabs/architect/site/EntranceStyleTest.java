package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** The entrance style's pure parts (docs/CONTRACT.md "6b addition: region lot entrances"). */
class EntranceStyleTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@Test
	void plainStyleFromPathStyle() {
		assertNull(EntranceStyle.plain(null));
		assertNull(EntranceStyle.plain(" "));
		EntranceStyle s = EntranceStyle.plain("Stone_Bricks");
		assertEquals(new EntranceStyle("minecraft:stone_bricks", null, null), s);
		assertEquals("-", EntranceStyle.key(null));
		assertTrue(EntranceStyle.key(s).startsWith("minecraft:stone_bricks/"));
	}

	@Test
	void refusals() {
		assertNull(EntranceStyle.refusal(null));
		assertNull(EntranceStyle.refusal("minecraft:stone_bricks"));
		assertNotNull(EntranceStyle.refusal("minecraft:no_such_block"));
		assertNotNull(EntranceStyle.refusal("minecraft:air"));
	}

	@Test
	void statesParseWithProperties() {
		assertEquals(Blocks.OAK_LOG.defaultBlockState().setValue(BlockStateProperties.AXIS, net.minecraft.core.Direction.Axis.X), EntranceStyle.state(
			"minecraft:oak_log[axis=x]", Blocks.DIRT_PATH.defaultBlockState()));
		assertEquals(Blocks.DIRT_PATH.defaultBlockState(), EntranceStyle.state(null, Blocks.DIRT_PATH.defaultBlockState()));
		assertEquals(Blocks.DIRT_PATH.defaultBlockState(), EntranceStyle.state("nope:nope", Blocks.DIRT_PATH.defaultBlockState()));
	}
}
