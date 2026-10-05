package dev.larattalabs.architect.survival;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Deconstructing a construction site (docs/CONTRACT.md phase 3 "Remove / deconstruct in survival"): what each cell of the
 * box gives back before the snapshot is restored. Pure.
 *
 * <ul>
 * <li>A queued cell that still holds what the site placed there, and was <b>paid</b> for (not placed free by
 * {@code /architect site finish}): its item is <b>refunded</b>.</li>
 * <li>Else a cell whose block differs from the snapshot and is not air is the <b>player's</b> block: it drops as an item.
 * Changes nature makes on its own (fluids, fire, snow, grass and dirt turning into each other) are not the player's.</li>
 * <li>Else nothing: a cell the player mined is air (they already have the item: the no-dupe rule), and unbuilt cells are
 * air.</li>
 * </ul>
 */
public final class Refunds {
	public enum Outcome { REFUND, PLAYER_DROP, NONE }

	private Refunds() {
	}

	/**
	 * @param queued the site builds this cell
	 * @param asPlaced the cell holds what the site places there (same block; a door the player opened still counts)
	 * @param free the site placed it without payment
	 * @param air the cell is air now
	 * @param asSnapshot the cell holds what the snapshot holds there (the terrain before the site)
	 * @param natural the difference from the snapshot is one nature makes (fluid, fire, snow, grass/dirt)
	 */
	public static Outcome classify(boolean queued, boolean asPlaced, boolean free, boolean air, boolean asSnapshot, boolean natural) {
		if (queued && asPlaced) {
			return free ? Outcome.NONE : Outcome.REFUND;
		}
		if (air || asSnapshot || natural) {
			return Outcome.NONE;
		}
		return Outcome.PLAYER_DROP;
	}

	/** The ids of the terrain blocks that turn into each other on their own (a change between two of them is natural). */
	public static final List<String> SOIL = List.of("minecraft:grass_block", "minecraft:dirt", "minecraft:podzol", "minecraft:mycelium",
		"minecraft:coarse_dirt", "minecraft:rooted_dirt", "minecraft:farmland", "minecraft:dirt_path");

	/** Whether {@code now} where the snapshot had {@code was} is a change nature makes (both block ids). */
	public static boolean natural(String was, String now) {
		if (now.equals("minecraft:water") || now.equals("minecraft:lava") || now.equals("minecraft:fire") || now.equals("minecraft:soul_fire")
			|| now.equals("minecraft:snow") || now.equals("minecraft:ice") || now.equals("minecraft:frosted_ice")
			|| now.equals("minecraft:short_grass") || now.endsWith("_leaves")) {
			return true;
		}
		return SOIL.contains(was) && SOIL.contains(now);
	}

	/** The items a deconstruct gives back, summed per item: refunds and the player's blocks apart. */
	public static final class Tally {
		private final Map<String, Integer> refund = new TreeMap<>();
		private final Map<String, Integer> playerBlocks = new TreeMap<>();
		private int mined;

		/** Books one cell. {@code costs}: what the cell's block costs ({@link SurvivalItems#cost}). */
		public void add(Outcome o, List<SurvivalItems.Cost> costs) {
			Map<String, Integer> to = switch (o) {
				case REFUND -> refund;
				case PLAYER_DROP -> playerBlocks;
				case NONE -> null;
			};
			if (to != null) {
				costs.forEach(c -> to.merge(c.item(), c.count(), Integer::sum));
			}
		}

		/** A queued, paid cell that the player mined (air now): counted for the report, never refunded. */
		public void mined() {
			mined++;
		}

		public Map<String, Integer> refund() {
			return Map.copyOf(refund);
		}

		public Map<String, Integer> playerBlocks() {
			return Map.copyOf(playerBlocks);
		}

		public int minedCells() {
			return mined;
		}

		public static int total(Map<String, Integer> m) {
			return m.values().stream().mapToInt(Integer::intValue).sum();
		}
	}
}
