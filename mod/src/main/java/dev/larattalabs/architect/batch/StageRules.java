package dev.larattalabs.architect.batch;

import dev.larattalabs.architect.api.Stage;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * The stage state machine of a site group (docs/CONTRACT.md phase 4d "Stages"), pure:
 * <pre>
 * PLANNED --approve--> APPROVED --first item starts--> PLACING --all items done--> PLACED | PARTIAL --undo--> UNDONE
 * PLANNED | APPROVED --skip--> SKIPPED
 * APPROVED --hold--> PLANNED   (phase 6a: a region stage whose land changed since planning waits for an approval again)
 * </pre>
 * A stage places only when every stage before it in the group is finished ({@link State#terminal}). Undoing a stage while a
 * later stage is placed (or partial) is refused unless forced; while a later stage is placing it is always refused.
 */
public final class StageRules {
	private StageRules() {
	}

	public static Stage.State approve(Stage.State s) {
		return switch (s) {
			case PLANNED, APPROVED -> Stage.State.APPROVED;
			default -> throw new IllegalStateException("only a planned stage can be approved (it is " + name(s) + ")");
		};
	}

	/** A region stage not started yet is held back (its land drifted): it waits for {@link #approve} again. */
	public static Stage.State hold(Stage.State s) {
		return switch (s) {
			case PLANNED, APPROVED -> Stage.State.PLANNED;
			default -> throw new IllegalStateException("only a stage that has not started placing can be held (it is " + name(s) + ")");
		};
	}

	public static Stage.State skip(Stage.State s) {
		return switch (s) {
			case PLANNED, APPROVED -> Stage.State.SKIPPED;
			default -> throw new IllegalStateException("only a stage that has not started placing can be skipped (it is " + name(s) + ")");
		};
	}

	/** Its first item starts placing. */
	public static Stage.State start(Stage.State s) {
		return switch (s) {
			case APPROVED, PLACING -> Stage.State.PLACING;
			default -> throw new IllegalStateException("a " + name(s) + " stage does not place");
		};
	}

	/** Every item of the stage is placed or failed: PLACED when all were placed, else PARTIAL. */
	public static Stage.State finish(int placed, int total) {
		return placed == total ? Stage.State.PLACED : Stage.State.PARTIAL;
	}

	/** The stage's batch was cancelled or stopped: not started = SKIPPED; placing = PARTIAL (or SKIPPED with nothing placed). */
	public static Stage.State cancelled(Stage.State s, int placed) {
		return switch (s) {
			case PLANNED, APPROVED -> Stage.State.SKIPPED;
			case PLACING -> placed > 0 ? Stage.State.PARTIAL : Stage.State.SKIPPED;
			default -> s;
		};
	}

	/** The index of the stage that places next (the first that is not finished), or -1. */
	public static int running(List<Stage.State> states) {
		for (int i = 0; i < states.size(); i++) {
			if (!states.get(i).terminal()) {
				return i;
			}
		}
		return -1;
	}

	/** Why undoing stage {@code i} is refused, or null. */
	public static @Nullable String undoRefusal(List<String> names, List<Stage.State> states, int i, boolean force) {
		Stage.State s = states.get(i);
		if (s != Stage.State.PLACED && s != Stage.State.PARTIAL) {
			return "only a placed or partial stage can be undone (" + names.get(i) + " is " + name(s) + ")";
		}
		for (int j = i + 1; j < states.size(); j++) {
			Stage.State later = states.get(j);
			if (later == Stage.State.PLACING) {
				return "stage " + names.get(j) + " (after " + names.get(i) + ") is placing; cancel its batch first";
			}
			if (!force && (later == Stage.State.PLACED || later == Stage.State.PARTIAL)) {
				return "stage " + names.get(j) + " (after " + names.get(i) + ") is placed and depends on it; undo it first, or force";
			}
		}
		return null;
	}

	/**
	 * The new stage order: {@code planned} lists every PLANNED stage exactly once and takes the planned stages' places; the
	 * others keep theirs. Throws {@link IllegalArgumentException} when it doesn't.
	 */
	public static List<String> reorder(List<String> names, List<Stage.State> states, List<String> planned) {
		List<String> slots = new ArrayList<>();
		for (int i = 0; i < names.size(); i++) {
			if (states.get(i) == Stage.State.PLANNED) {
				slots.add(names.get(i));
			}
		}
		Set<String> given = new HashSet<>(planned);
		if (given.size() != planned.size() || !given.equals(new HashSet<>(slots))) {
			throw new IllegalArgumentException("reorder lists every planned stage exactly once: " + slots + " (got " + planned + ")");
		}
		List<String> out = new ArrayList<>(names);
		int k = 0;
		for (int i = 0; i < names.size(); i++) {
			if (states.get(i) == Stage.State.PLANNED) {
				out.set(i, planned.get(k++));
			}
		}
		return out;
	}

	public static String name(Stage.State s) {
		return s.name().toLowerCase(java.util.Locale.ROOT);
	}
}
