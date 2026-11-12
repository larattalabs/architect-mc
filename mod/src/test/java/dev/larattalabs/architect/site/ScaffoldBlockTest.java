package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.survival.ScaffoldBlock;
import java.nio.file.Files;
import java.nio.file.Path;
import net.minecraft.SharedConstants;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.Fallable;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.PushReaction;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (7b slice SO-b) The cosmetic scaffolding never turns into items: Architect's own block ({@link ScaffoldBlock}, the registered one is built
 * from the same {@link ScaffoldBlock#properties}) has no loot table (mined, blown up or broken otherwise it drops nothing), a piston can't
 * move it, it has no random tick and never falls (vanilla scaffolding collapses and drops when its support goes); the builder's predicates
 * treat it as scaffolding (never an anchor; left out of a Deconstruct's tally), and its blockstate shows vanilla's scaffolding.
 */
class ScaffoldBlockTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	private static ScaffoldBlock block;

	/**
	 * A block built from the registered one's properties, never registered: the frozen block registry is opened (reflection) for the one
	 * intrusive holder a block's constructor asks for, then put back as it was.
	 */
	static synchronized ScaffoldBlock block() throws Exception {
		if (block == null) {
			java.lang.reflect.Field f = net.minecraft.core.MappedRegistry.class.getDeclaredField("unregisteredIntrusiveHolders");
			f.setAccessible(true);
			java.lang.reflect.Field frozen = net.minecraft.core.MappedRegistry.class.getDeclaredField("frozen");
			frozen.setAccessible(true);
			Object reg = net.minecraft.core.registries.BuiltInRegistries.BLOCK;
			Object was = f.get(reg);
			boolean wasFrozen = frozen.getBoolean(reg);
			f.set(reg, new java.util.IdentityHashMap<>());
			frozen.setBoolean(reg, false);
			try {
				ResourceKey<Block> key = ResourceKey.create(Registries.BLOCK, Architect.id("scaffold"));
				block = new ScaffoldBlock(ScaffoldBlock.properties(key));
			} finally {
				f.set(reg, was);
				frozen.setBoolean(reg, wasFrozen);
			}
		}
		return block;
	}

	@Test
	void dropsNothingAndNeverMoves() throws Exception {
		ScaffoldBlock b = block();
		BlockState st = b.defaultBlockState();
		assertTrue(b.getLootTable().isEmpty(), "no loot table: mining or an explosion drops nothing");
		assertEquals(PushReaction.IMMOVEABLE, st.getPistonPushReaction(), "a piston can't push or pull it (nor break it into items)");
		assertFalse(st.isRandomlyTicking(), "no random tick");
		assertFalse((Object) b instanceof Fallable, "it never falls");
		assertFalse(Builder.gravity(st), "not a gravity block for the builder");
		assertFalse((Object) b instanceof net.minecraft.world.level.block.ScaffoldingBlock, "not vanilla scaffolding (which collapses and drops)");
		assertTrue(st.getProperties().isEmpty(), "one state: nothing to settle or tick");
		// vanilla scaffolding, for contrast: it has a loot table (the dupe SO-b closes)
		assertTrue(Blocks.SCAFFOLDING.getLootTable().isPresent());
	}

	@Test
	void theBuilderTreatsItAsScaffolding() throws Exception {
		BlockState st = block().defaultBlockState();
		assertTrue(Builder.isScaffold(st));
		assertFalse(Builder.isScaffold(Blocks.SCAFFOLDING.defaultBlockState()));
		assertFalse(Builder.anchorState(st), "never an anchor for the support order or the attach gate");
		assertFalse(Builder.anchorState(Blocks.SCAFFOLDING.defaultBlockState()));
		assertTrue(Builder.anchorState(Blocks.STONE.defaultBlockState()));
	}

	@Test
	void itLooksLikeVanillaScaffolding() throws Exception {
		String bs = Files.readString(Path.of("src/main/resources/assets/architect_mc/blockstates/scaffold.json"));
		assertTrue(bs.contains("\"minecraft:block/scaffolding_stable\""), bs);
	}
}
