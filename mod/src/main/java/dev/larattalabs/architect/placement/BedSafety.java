package dev.larattalabs.architect.placement;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * Beds where they would hurt the player (ported from AgentCraft's {@code BedSafety}). A design may bring vanilla beds; in a
 * dimension whose bed rule does not allow sleeping (the Nether and the End: the bed explodes with power 5 and fire when
 * used, the end of a Hardcore world) a placement leaves them out: both halves become air and the site's pin forgets those
 * block-entity cells (a bed the player puts there later is the player's). Pure logic; {@code Sites.build} reads the rule
 * from the level and writes the air. Any thread.
 */
public final class BedSafety {
	/**
	 * Whether a bed with this rule must not be placed: it explodes on use, breaks when the sleeper leaves, or nobody can
	 * ever sleep in it (vanilla {@code BedRule}: {@code can_sleep}, {@code destroy_on_use}, {@code destroy_on_leave}).
	 */
	public static boolean unsafe(boolean neverSleep, boolean destroyOnUse, boolean destroyOnLeave) {
		return neverSleep || destroyOnUse || destroyOnLeave;
	}

	/** The head half's cell of a bed half at {@code x,y,z}: itself for the head, else one step towards {@code facing} (dx, dz). */
	public static BlockPos head(int x, int y, int z, boolean isHead, int facingDx, int facingDz) {
		return isHead ? new BlockPos(x, y, z) : new BlockPos(x + facingDx, y, z + facingDz);
	}

	/** Block-entity offsets (x,y,z triples from {@code min}) without the cells in {@code removed} (world {@link BlockPos#asLong}). */
	public static List<Integer> withoutCells(List<Integer> offsets, Set<Long> removed, int minX, int minY, int minZ) {
		if (removed.isEmpty()) {
			return offsets;
		}
		List<Integer> out = new ArrayList<>(offsets.size());
		for (int i = 0; i + 2 < offsets.size(); i += 3) {
			if (!removed.contains(BlockPos.asLong(minX + offsets.get(i), minY + offsets.get(i + 1), minZ + offsets.get(i + 2)))) {
				out.add(offsets.get(i));
				out.add(offsets.get(i + 1));
				out.add(offsets.get(i + 2));
			}
		}
		return out;
	}

	/** What the placement note says, or null when no bed was left out. */
	public static @Nullable String note(int beds, String dimension) {
		return beds == 0 ? null : beds + " bed" + (beds == 1 ? "" : "s") + " left out (beds explode in " + dimension + ")";
	}

	private BedSafety() {
	}
}
