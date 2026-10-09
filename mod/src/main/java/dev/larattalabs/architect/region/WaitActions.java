package dev.larattalabs.architect.region;

import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.WaitAction;
import java.util.List;
import java.util.Locale;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * What a caller can do about what a region waits for (docs/CONTRACT.md phase 6b §6.2, Steward S8):
 * <pre>
 * NOT_LOADED           MOVE_CLOSER (target: the waiting item's chunk centre nearest the player, at the player's height)
 * NOT_GENERATED        PREPARE (detail: the prepare's size and time estimate)
 * SIDECAR_UNAVAILABLE  START_SIDECAR
 * DRIFTED (held)       APPROVE_STAGE (detail: the stage), REPLAN
 * anything else        none
 * </pre>
 * Pure.
 */
public final class WaitActions {
	/** Chunks per second assumed for the estimate when no prepare ran this session (a governed prepare on an M-class Mac). */
	public static final double DEFAULT_RATE = 4.0;

	private WaitActions() {
	}

	/** The facts the actions need. {@code item}: the waiting item's box {x0, z0, x1, z1} (null: none); {@code player}: x, y, z. */
	public record Context(@Nullable Reason reason, int @Nullable [] item, int @Nullable [] player, @Nullable String heldStage, int chunksToGenerate,
		double chunksPerSecond) {
	}

	public static List<WaitAction> of(Context c) {
		if (c.reason() == null) {
			return List.of();
		}
		return switch (c.reason()) {
			case NOT_LOADED -> {
				BlockPos t = target(c.item(), c.player());
				yield List.of(new WaitAction(WaitAction.Kind.MOVE_CLOSER, t == null ? "Walk closer to the region" : "Walk to " + t.getX() + ", " + t.getZ(), t,
					null));
			}
			case NOT_GENERATED -> {
				String est = estimate(c.chunksToGenerate(), c.chunksPerSecond());
				yield List.of(new WaitAction(WaitAction.Kind.PREPARE, "Prepare " + est, null, est));
			}
			case SIDECAR_UNAVAILABLE -> List.of(new WaitAction(WaitAction.Kind.START_SIDECAR, "Start the helper", null, null));
			case DRIFTED -> List.of(new WaitAction(WaitAction.Kind.APPROVE_STAGE, c.heldStage() == null ? "Approve the held stage" : "Approve stage "
				+ c.heldStage() + " (build on the changed land)", null, c.heldStage()), new WaitAction(WaitAction.Kind.REPLAN,
					"Replan (remove the region and plan again)", null, null));
			default -> List.of();
		};
	}

	/** The chunk centre of the item's box nearest the player (or the box's centre chunk), at the player's y (64 without one). */
	static @Nullable BlockPos target(int @Nullable [] item, int @Nullable [] player) {
		if (item == null) {
			return null;
		}
		int y = player == null ? 64 : player[1];
		if (player == null) {
			int cx = (item[0] + item[2]) / 2 >> 4;
			int cz = (item[1] + item[3]) / 2 >> 4;
			return new BlockPos(cx * 16 + 8, y, cz * 16 + 8);
		}
		int bestX = 0;
		int bestZ = 0;
		long best = Long.MAX_VALUE;
		for (int cx = item[0] >> 4; cx <= item[2] >> 4; cx++) {
			for (int cz = item[1] >> 4; cz <= item[3] >> 4; cz++) {
				long dx = cx * 16L + 8 - player[0];
				long dz = cz * 16L + 8 - player[2];
				long d = dx * dx + dz * dz;
				if (d < best) {
					best = d;
					bestX = cx * 16 + 8;
					bestZ = cz * 16 + 8;
				}
			}
		}
		return new BlockPos(bestX, y, bestZ);
	}

	/** "412 chunks (~2 min)". */
	public static String estimate(int chunks, double perSecond) {
		double s = chunks / Math.max(0.1, perSecond);
		String t = s < 90 ? Math.max(1, Math.round(s)) + " s" : s < 5400 ? Math.round(s / 60) + " min" : String.format(Locale.ROOT, "%.1f h", s / 3600);
		return chunks + " chunk" + (chunks == 1 ? "" : "s") + " (~" + t + ")";
	}
}
