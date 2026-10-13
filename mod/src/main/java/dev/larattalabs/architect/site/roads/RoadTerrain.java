package dev.larattalabs.architect.site.roads;

import net.minecraft.core.BlockPos;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.BambooStalkBlock;
import net.minecraft.world.level.block.BaseFireBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CactusBlock;
import net.minecraft.world.level.block.DoublePlantBlock;
import net.minecraft.world.level.block.FarmlandBlock;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.LightBlock;
import net.minecraft.world.level.block.LilyPadBlock;
import net.minecraft.world.level.block.MushroomBlock;
import net.minecraft.world.level.block.SnowLayerBlock;
import net.minecraft.world.level.block.SugarCaneBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;

/**
 * A level as {@link RoadPlan} kinds (AgentCraft {@code RoadTerrain} at {@code ab08a02}, with exposed ores as their own kind):
 * only natural blocks are ever kinds a road changes; anything a player builds with is {@link RoadPlan#BUILT} or
 * {@link RoadPlan#BUILT_OPEN}. A chunk that is not loaded is {@link RoadPlan#UNLOADED}: nothing is loaded or generated.
 */
public final class RoadTerrain implements RoadPlan.World {
	private final Level level;
	private final BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();

	/** 6c PT: a kept build's cell (one the request's consent doesn't name) reads as built: a road never cuts, fills or clears it. */
	private final dev.larattalabs.architect.placed.Placed.@org.jspecify.annotations.Nullable Consent consent;

	public RoadTerrain(Level level) {
		this(level, dev.larattalabs.architect.placed.Placed.consentNow());
	}

	public RoadTerrain(Level level, dev.larattalabs.architect.placed.Placed.@org.jspecify.annotations.Nullable Consent consent) {
		this.level = level;
		this.consent = consent;
	}

	@Override
	public int at(int x, int y, int z) {
		if (!level.hasChunk(x >> 4, z >> 4)) {
			return RoadPlan.UNLOADED;
		}
		if (y < level.getMinY() || y > level.getMaxY()) {
			return y < level.getMinY() ? RoadPlan.BUILT : RoadPlan.AIR;
		}
		pos.set(x, y, z);
		if (consent != null) {
			String b = dev.larattalabs.architect.placed.Placed.build(level, null, x, y, z);
			if (b != null && !consent.allows(b)) {
				return RoadPlan.BUILT;
			}
		}
		return kind(level, pos, level.getBlockState(pos));
	}

	/** The {@link RoadPlan} kind of {@code s} at {@code pos}. */
	public static int kind(Level level, BlockPos pos, BlockState s) {
		if (s.isAir()) {
			return RoadPlan.AIR;
		}
		if (s.hasBlockEntity()) {
			return RoadPlan.BLOCK_ENTITY;
		}
		FluidState fl = s.getFluidState();
		if (fl.is(FluidTags.LAVA)) {
			return RoadPlan.LAVA;
		}
		if (!fl.isEmpty()) {
			return RoadPlan.WATER;
		}
		// 6c W: ice over water (a frozen river or sea) is water for the road's depth rules: a road over it is DEEP_WATER (a partial
		// road skips that span; a 1-deep crossing gets its deck as over open water)
		if (dev.larattalabs.architect.region.Columns.iceTop(s) && frozenBelow(level, pos)) {
			return RoadPlan.WATER;
		}
		Block b = s.getBlock();
		if (b instanceof BaseFireBlock || b instanceof LightBlock) {
			return RoadPlan.BUILT_OPEN;
		}
		if (b instanceof LeavesBlock || s.is(BlockTags.LEAVES)) {
			return RoadPlan.LEAVES;
		}
		if (s.is(BlockTags.LOGS) || b instanceof CactusBlock) {
			return RoadPlan.LOG;
		}
		if (b instanceof DoublePlantBlock || b instanceof SugarCaneBlock || b instanceof BambooStalkBlock) {
			return RoadPlan.STACK;
		}
		if (b instanceof SnowLayerBlock || b instanceof LilyPadBlock || b instanceof MushroomBlock || s.is(BlockTags.REPLACEABLE_BY_TREES)
			|| s.is(BlockTags.FLOWERS) || s.is(BlockTags.SAPLINGS) || s.is(BlockTags.SMALL_FLOWERS)) {
			return RoadPlan.PLANT;
		}
		if (s.is(Blocks.DIRT_PATH)) {
			return RoadPlan.PATH;
		}
		if (b instanceof FarmlandBlock) {
			return RoadPlan.BUILT;
		}
		if (s.is(BlockTags.ORES)) {
			return RoadPlan.ORE;
		}
		if (s.is(Blocks.MUD) || s.is(Blocks.MUDDY_MANGROVE_ROOTS)) {
			return RoadPlan.MUD;
		}
		if (s.is(BlockTags.DIRT) || s.is(BlockTags.SUBSTRATE_OVERWORLD) || s.is(BlockTags.GRASS_BLOCKS) || s.is(BlockTags.MOSS_BLOCKS)) {
			return RoadPlan.DIRT;
		}
		if (s.is(BlockTags.SAND) || s.is(Blocks.GRAVEL)) {
			return RoadPlan.SAND;
		}
		if (s.is(BlockTags.BASE_STONE_OVERWORLD) || s.is(BlockTags.BASE_STONE_NETHER) || s.is(BlockTags.BADLANDS_TERRACOTTA) || s.is(Blocks.SANDSTONE)
			|| s.is(Blocks.RED_SANDSTONE) || s.is(Blocks.CLAY) || s.is(Blocks.SNOW_BLOCK) || s.is(Blocks.TERRACOTTA)) {
			return RoadPlan.STONE;
		}
		if (s.canBeReplaced()) {
			return RoadPlan.PLANT;
		}
		return s.getCollisionShape(level, pos).isEmpty() ? RoadPlan.BUILT_OPEN : RoadPlan.BUILT;
	}

	/** 6c W: water within {@code Columns.FROZEN_DEPTH} under the ice at {@code pos}, only ice or water between. */
	static boolean frozenBelow(Level level, BlockPos pos) {
		BlockPos.MutableBlockPos p = pos.mutable();
		for (int dy = 1; dy <= dev.larattalabs.architect.region.Columns.FROZEN_DEPTH; dy++) {
			BlockState s = level.getBlockState(p.setY(pos.getY() - dy));
			if (s.getFluidState().is(FluidTags.WATER)) {
				return true;
			}
			if (!dev.larattalabs.architect.region.Columns.iceTop(s)) {
				return false;
			}
		}
		return false;
	}
}
