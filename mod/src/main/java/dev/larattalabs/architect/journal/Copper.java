package dev.larattalabs.architect.journal;

import net.minecraft.world.item.HoneycombItem;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.WeatheringCopper;
import net.minecraft.world.level.block.state.BlockState;

/**
 * (6c CU §2.1) The copper chain: a copper block at any weathering stage, waxed or not, has one canonical form, its chain's first stage
 * unwaxed ({@code waxed_exposed_cut_copper_stairs} -> {@code cut_copper_stairs}). Read from vanilla's own tables
 * ({@link HoneycombItem#WAX_OFF_BY_BLOCK}, then {@link WeatheringCopper#getFirst}), never a hand table, so a copper form a later
 * Minecraft version adds joins by itself. {@code CopperTest} pins the table against kit/lib/blocks.mjs's {@code wx} (the kit's dump of the
 * same vanilla maps).
 */
public final class Copper {
	private Copper() {
	}

	/** The canonical form of {@code b}: unwaxed, then the chain's first stage; {@code b} itself when it is outside the chain. */
	public static Block canonical(Block b) {
		Block u = HoneycombItem.WAX_OFF_BY_BLOCK.get().get(b);
		return WeatheringCopper.getFirst(u != null ? u : b);
	}

	/** Whether {@code b} is in a copper chain (a weathering stage of one, or a waxed one). */
	public static boolean inChain(Block b) {
		return HoneycombItem.WAX_OFF_BY_BLOCK.get().containsKey(b) || WeatheringCopper.NEXT_BY_BLOCK.get().containsKey(b)
			|| WeatheringCopper.PREVIOUS_BY_BLOCK.get().containsKey(b);
	}

	/**
	 * Whether {@code a} and {@code b} are the same block for "still ours": the same block, or two copper blocks of the same form (any
	 * stage, waxed or not).
	 */
	public static boolean sameBlock(Block a, Block b) {
		return a == b || inChain(a) && inChain(b) && canonical(a) == canonical(b);
	}

	/** {@link #sameBlock} over two states' blocks. */
	public static boolean sameBlock(BlockState a, BlockState b) {
		return sameBlock(a.getBlock(), b.getBlock());
	}

	/** Whether {@code s} is {@code b}'s block, or another stage (or the waxed form) of its copper chain. */
	public static boolean is(BlockState s, Block b) {
		return sameBlock(s.getBlock(), b);
	}
}
