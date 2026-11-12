package dev.larattalabs.architect.survival;

import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.material.MapColor;
import net.minecraft.world.level.material.PushReaction;

/**
 * (7b slice SO-b) The cosmetic scaffolding of a site-aware building under construction ({@code architect_mc:scaffold}): vanilla
 * scaffolding's look (its blockstate uses {@code minecraft:block/scaffolding_stable}) without its behaviour. It costs nothing, so it gives
 * nothing back: no loot table (mined by hand, blown up or broken any other way it drops nothing), a piston can't move it (a moved cell
 * would leave its {@code architect:scaffold} entry and stand for good), and it never ticks, collapses or falls (vanilla scaffolding
 * breaks and drops when the block under it goes). No item: pick-block gives none.
 */
public final class ScaffoldBlock extends Block {
	public ScaffoldBlock(BlockBehaviour.Properties p) {
		super(p);
	}

	/** Its properties (the registered block's; the unit test builds one from them). */
	public static BlockBehaviour.Properties properties(ResourceKey<Block> key) {
		return BlockBehaviour.Properties.of().setId(key).mapColor(MapColor.SAND).sound(SoundType.SCAFFOLDING).instabreak().noLootTable().noOcclusion()
			.pushReaction(PushReaction.IMMOVEABLE);
	}
}
