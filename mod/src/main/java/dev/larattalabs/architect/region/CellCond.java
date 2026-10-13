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
			case Packed.IF_SOLID_NATURAL -> !s.isAir() && (f & TerrainFit.NATURAL) != 0 && s.getFluidState().isEmpty() && s.isSolid();
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
		return s.isAir() || (f & TerrainFit.NATURAL) != 0 || (f & TerrainFit.WATER) != 0 || (f & TerrainFit.TREE) != 0;
	}

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
