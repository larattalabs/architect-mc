package dev.larattalabs.architect.placement;

import java.util.Locale;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Slice SAFETY: when Enter has to be pressed twice to place (pure, unit-tested in {@code PlaceConfirmTest}). A placement is
 * <b>big</b> when it would replace blocks that are not terrain (a player's wall, planks, glass: not the grass, dirt, stone or
 * trees the site clears by design) or when it writes at least the threshold of blocks (the client config's
 * {@code confirmBlocks}, default {@value #DEFAULT_THRESHOLD}). A big placement arms on the first Enter (lab-ui {@code ConfirmArm},
 * the placement HUD shows "Press Enter again to place 2,340 blocks (4)") and places on the second. A refusal's own second press
 * (Shift+Enter after a block-entity refusal, Enter for Place on top) already is that confirm, so the two never stack.
 */
public final class PlaceConfirm {
	/** The default block count from which a placement asks for a second Enter. */
	public static final int DEFAULT_THRESHOLD = 1000;
	/** How long the armed confirm waits for the second Enter (lab-ui's default window). */
	public static final long WINDOW_MS = 5_000;

	/** What one Enter does. */
	public enum Step {
		/** Send it to the server now (small and clean, a refusal-to-be, or a refusal's own second press). */
		PLACE,
		/** Arm (or, when armed, confirm) the two-press confirm. */
		CONFIRM
	}

	private PlaceConfirm() {
	}

	/** The configured threshold made sane: at least 1 (missing or broken values are the default). */
	public static int threshold(int configured) {
		return configured < 1 ? DEFAULT_THRESHOLD : configured;
	}

	/** Whether a placement of {@code blocks} that replaces {@code replaced} non-terrain blocks needs a second Enter. */
	public static boolean big(int blocks, int replaced, int threshold) {
		return replaced > 0 || blocks >= threshold(threshold);
	}

	/**
	 * What an Enter does. {@code refused}: the ghost's own checks refuse it now (it goes to the server, which says why and may
	 * arm force or Place on top); {@code layerArmed} / {@code shift && forceArmed}: this Enter is a refusal's deliberate second
	 * press, already a confirm.
	 */
	public static Step enter(boolean big, boolean refused, boolean layerArmed, boolean forceArmed, boolean shift) {
		if (!big || refused || layerArmed || shift && forceArmed) {
			return Step.PLACE;
		}
		return Step.CONFIRM;
	}

	/**
	 * Whether a world cell a placement writes over (or its entrance approach clears) counts as replaced: solid ({@link
	 * GhostModel.Conflict#OBSTRUCTED}) and neither natural terrain nor a tree ({@link TerrainFit#flags}).
	 */
	public static boolean replaces(int worldFlags) {
		return (worldFlags & (TerrainFit.FILLABLE | TerrainFit.NATURAL | TerrainFit.TREE | TerrainFit.BLOCK_ENTITY)) == 0;
	}

	/** The blocks a design writes: its template's non-air cells. */
	public static int blocks(BlockState[] states) {
		int n = 0;
		for (BlockState s : states) {
			if (s != null && !s.isAir()) {
				n++;
			}
		}
		return n;
	}

	/** {@link #blocks(BlockState[])} of a loaded design's template. */
	public static int blocks(TemplateGrid g) {
		return blocks(g.states());
	}

	/** 2340 -> "2,340" (the same in every locale). */
	public static String count(int n) {
		return String.format(Locale.ROOT, "%,d", n);
	}

	/** The armed HUD line: "Press Enter again to place 2,340 blocks (4)" (with what it replaces, when it does). */
	public static String prompt(boolean move, int blocks, int replaced, int secondsLeft) {
		String what = count(blocks) + " block" + (blocks == 1 ? "" : "s");
		String over = replaced > 0 ? ", replacing " + count(replaced) + " that " + (replaced == 1 ? "isn't" : "aren't") + " terrain" : "";
		return "Press Enter again to " + (move ? "move it here: " : "place ") + what + over + " (" + secondsLeft + ")";
	}

	/** Why a ready ghost needs two Enters, for the "Ready" line before it is armed. */
	public static String readyLine(boolean move, int blocks, int replaced) {
		return "Ready: Enter twice " + (move ? "moves it here" : "places it") + " (" + (replaced > 0 ? "replaces " + count(replaced) + " block"
			+ (replaced == 1 ? "" : "s") + " that " + (replaced == 1 ? "isn't" : "aren't") + " terrain" : count(blocks) + " blocks") + ")";
	}
}
