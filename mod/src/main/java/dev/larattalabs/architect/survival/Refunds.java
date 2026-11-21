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

	/** (slice T4b fix round, N3) One refunded cell: its position ({@code BlockPos.asLong}), its block's id, what it refunds. */
	public record Cell(long pos, String block, Map<String, Integer> items) {
	}

	/** The items a deconstruct gives back, summed per item: refunds and the player's blocks apart. */
	public static final class Tally {
		private final Map<String, Integer> refund = new TreeMap<>();
		private final Map<String, Integer> playerBlocks = new TreeMap<>();
		private int mined;
		/** (slice T4b fix round, N3) Each refunded cell: its position, the block it refunds, its items (in tally order). */
		private final Map<Long, Cell> cells = new java.util.LinkedHashMap<>();
		/** (slice T4R-N) Each player's cell (PLAYER_DROP): its position, the player's block, what it returns (in tally order). */
		private final Map<Long, Cell> playerCells = new java.util.LinkedHashMap<>();
		private long atPos = Long.MIN_VALUE;
		private boolean unplaced;
		private @org.jspecify.annotations.Nullable String atBlock;

		/** (N3) The cell the next {@link #add} books: a REFUND there is recorded per cell (pos, block id), for the restore's min. */
		public void at(long pos, String block) {
			atPos = pos;
			atBlock = block;
		}

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
			if (o == Outcome.REFUND && !costs.isEmpty() && (atPos == Long.MIN_VALUE || atBlock == null)) {
				unplaced = true; // a refund booked without its cell: no per-cell record (the planned amounts stand, no min)
			}
			if (o == Outcome.REFUND && atPos != Long.MIN_VALUE && atBlock != null && !costs.isEmpty()) {
				Map<String, Integer> items = new TreeMap<>();
				Cell was = cells.get(atPos);
				if (was != null) {
					items.putAll(was.items());
				}
				costs.forEach(c -> items.merge(c.item(), c.count(), Integer::sum));
				cells.put(atPos, new Cell(atPos, atBlock, Map.copyOf(items)));
			}
			if (o == Outcome.PLAYER_DROP && atPos != Long.MIN_VALUE && atBlock != null && !costs.isEmpty()) {
				Map<String, Integer> items = new TreeMap<>();
				Cell was = playerCells.get(atPos);
				if (was != null) {
					items.putAll(was.items());
				}
				costs.forEach(c -> items.merge(c.item(), c.count(), Integer::sum));
				playerCells.put(atPos, new Cell(atPos, atBlock, Map.copyOf(items)));
			}
			atPos = Long.MIN_VALUE;
			atBlock = null;
		}

		/**
		 * (slice T4R-N, the final check of f7607b13's P1-2) The player's cells by position (a PLAYER_DROP booked at its cell); a player's block
		 * booked without its cell is in {@link #playerBlocks} only.
		 */
		public List<Cell> playerCells() {
			return List.copyOf(playerCells.values());
		}

		/** (N3) The refunded cells, by position; null when a refund was booked without its cell (then no per-cell record at all). */
		public java.util.@org.jspecify.annotations.Nullable Collection<Cell> cells() {
			return unplaced ? null : List.copyOf(cells.values());
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
