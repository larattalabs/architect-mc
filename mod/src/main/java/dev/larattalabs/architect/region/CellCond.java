package dev.larattalabs.architect.region;

import dev.larattalabs.architect.placement.TerrainFit;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/**
 * The write conditions of a region cell (CONTRACT §1 "Evaluation and conflicts within a program", {@code CellWrite.Cond}),
 * resolved against the live world at P1. A cell whose condition fails is skipped and noted, never forced. No condition ever
 * passes a block entity.
 */
public final class CellCond {
	private CellCond() {
	}

	/**
	 * @param cond {@link Packed#IF_NATURAL} .. {@link Packed#ALWAYS_OURS}
	 * @param s the world's block now
	 * @param ours the cell is owned by one of this region's own earlier tile entries (ALWAYS_OURS writes over it)
	 */
	public static boolean passes(int cond, BlockState s, boolean ours) {
		int f = TerrainFit.flags(s);
		if ((f & TerrainFit.BLOCK_ENTITY) != 0) {
			return false;
		}
		return switch (cond) {
			// (6c close-out B) a tree's solid cells too (logs, leaves, huge mushrooms), and the kit's other natural blocks, as the kit's
			// IF_SOLID_NATURAL (NaturalDriftTest)
			case Packed.IF_SOLID_NATURAL -> !s.isAir() && ((f & (TerrainFit.NATURAL | TerrainFit.TREE)) != 0 || alsoNatural(s)) && s.getFluidState().isEmpty()
				&& s.isSolid();
			case Packed.IF_AIR_OR_FLUID -> s.isAir() || s.is(Blocks.WATER) || s.is(Blocks.LAVA) || s.is(Blocks.BUBBLE_COLUMN);
			case Packed.ALWAYS_OURS -> ours || natural(s, f);
			default -> natural(s, f);
		};
	}

	/**
	 * 6c PT (§7): a write condition over an incidental player-placed cell (natural, whatever its voxel class): every condition but
	 * IF_AIR_OR_FLUID passes it (IF_SOLID_NATURAL a solid one); never a block entity.
	 */
	public static boolean passesIncidental(int cond, BlockState s) {
		if (s.hasBlockEntity()) {
			return false;
		}
		return switch (cond) {
			case Packed.IF_SOLID_NATURAL -> s.isSolid();
			case Packed.IF_AIR_OR_FLUID -> false;
			default -> true;
		};
	}

	/** 4e's {@code naturalOnly}: natural terrain, plants, trees, air or water. */
	public static boolean natural(BlockState s, int f) {
		return s.isAir() || (f & TerrainFit.NATURAL) != 0 || (f & TerrainFit.WATER) != 0 || (f & TerrainFit.TREE) != 0 || alsoNatural(s);
	}

	/**
	 * (6c close-out B, NaturalDriftTest) The blocks the kit's voxel classes count natural (ROCK, PLANT, ICE, huge mushrooms) that
	 * TerrainFit's natural rule doesn't: a region's write over them lands as in the plan's virtual world. Only the write conditions read
	 * this set; building placement's clearing and approaches keep TerrainFit's rule (moving it moved route_demo's lot approaches).
	 */
	public static boolean alsoNatural(BlockState s) {
		return s.is(net.minecraft.tags.BlockTags.TERRACOTTA) || s.is(net.minecraft.tags.BlockTags.CORAL_BLOCKS) || s.is(net.minecraft.tags.BlockTags.CROPS)
			|| s.is(net.minecraft.tags.BlockTags.CAVE_VINES) || ALSO.contains(s.getBlock());
	}

	private static final java.util.Set<net.minecraft.world.level.block.Block> ALSO = java.util.Set.of(Blocks.DEAD_BRAIN_CORAL_BLOCK,
		Blocks.DEAD_BUBBLE_CORAL_BLOCK, Blocks.DEAD_FIRE_CORAL_BLOCK, Blocks.DEAD_HORN_CORAL_BLOCK, Blocks.DEAD_TUBE_CORAL_BLOCK, Blocks.AMETHYST_BLOCK,
		Blocks.BUDDING_AMETHYST, Blocks.CALCITE, Blocks.DRIPSTONE_BLOCK, Blocks.SMOOTH_BASALT, Blocks.MAGMA_BLOCK, Blocks.OBSIDIAN, Blocks.CRYING_OBSIDIAN,
		Blocks.GILDED_BLACKSTONE, Blocks.SOUL_SOIL, Blocks.END_STONE, Blocks.INFESTED_STONE, Blocks.INFESTED_COBBLESTONE, Blocks.INFESTED_STONE_BRICKS,
		Blocks.INFESTED_MOSSY_STONE_BRICKS, Blocks.INFESTED_CRACKED_STONE_BRICKS, Blocks.INFESTED_CHISELED_STONE_BRICKS, Blocks.INFESTED_DEEPSLATE,
		Blocks.ATTACHED_MELON_STEM, Blocks.ATTACHED_PUMPKIN_STEM, Blocks.BROWN_MUSHROOM, Blocks.RED_MUSHROOM, Blocks.CRIMSON_FUNGUS, Blocks.WARPED_FUNGUS,
		Blocks.FIREFLY_BUSH, Blocks.FROGSPAWN, Blocks.LILY_PAD, Blocks.NETHER_WART, Blocks.PALE_HANGING_MOSS, Blocks.SCULK_VEIN, Blocks.SMALL_DRIPLEAF,
		Blocks.TWISTING_VINES, Blocks.TWISTING_VINES_PLANT, Blocks.WEEPING_VINES, Blocks.WEEPING_VINES_PLANT, Blocks.BAMBOO_SAPLING, Blocks.BAMBOO, Blocks.COCOA,
		Blocks.POINTED_DRIPSTONE, Blocks.SULFUR_SPIKE, Blocks.TURTLE_EGG, Blocks.FROSTED_ICE, Blocks.BROWN_MUSHROOM_BLOCK, Blocks.RED_MUSHROOM_BLOCK,
		Blocks.NETHER_WART_BLOCK, Blocks.WARPED_WART_BLOCK, Blocks.SHROOMLIGHT, Blocks.MUSHROOM_STEM);

	/** The condition's name (API {@code CellWrite.Cond}). */
	public static String name(int cond) {
		return switch (cond) {
			case Packed.IF_SOLID_NATURAL -> "IF_SOLID_NATURAL";
			case Packed.IF_AIR_OR_FLUID -> "IF_AIR_OR_FLUID";
			case Packed.ALWAYS_OURS -> "ALWAYS_OURS";
			default -> "IF_NATURAL";
		};
	}
}
