package dev.larattalabs.architect.client.hud;

import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.function.ToIntFunction;

/**
 * (PR A4) The placing, plot and massing keys as rebindable actions (Controls &gt; "Architect: while placing"). Pure: the defaults (today's
 * keys), which context uses which action, the fixed keys that stay (Esc cancels while placing; Shift+/ is the legend's "?" alias;
 * numpad Enter confirms; Delete cancels a massing), and the Shift rule: vanilla mappings carry no modifiers, so Shift stays a fixed
 * modifier on the rebound key (rotate back, force, height by 4, fit back). {@link #resolve} maps a press to an action given the
 * current bindings; {@link Keys} registers the mappings and passes their bound codes.
 * <p>
 * These act only while placing, marking a plot or reviewing a massing (the keyboard mixin consumes them only then), so a binding that
 * equals a vanilla key (L advancements, F swap hands) or a movement key is harmless outside those modes.
 */
public final class PlacingKeys {
	/** Where a press happens. */
	public enum Context {
		PLACE, PLOT, MASSING
	}

	/** GLFW key codes. */
	public static final int ESCAPE = 256;
	public static final int ENTER = 257;
	public static final int BACKSPACE = 259;
	public static final int DELETE = 261;
	public static final int RIGHT = 262;
	public static final int LEFT = 263;
	public static final int DOWN = 264;
	public static final int UP = 265;
	public static final int PAGE_UP = 266;
	public static final int PAGE_DOWN = 267;
	public static final int NUMPAD_ENTER = 335;
	public static final int SLASH = 47;

	public enum Action {
		CONFIRM("confirm", ENTER, EnumSet.allOf(Context.class)),
		CANCEL("cancel", BACKSPACE, EnumSet.allOf(Context.class)),
		ROTATE("rotate", 'R', EnumSet.of(Context.PLACE)),
		REDIRECT("redirect", 'R', EnumSet.of(Context.MASSING)),
		FORWARD("nudge_forward", UP, EnumSet.of(Context.PLACE)),
		BACK("nudge_back", DOWN, EnumSet.of(Context.PLACE)),
		LEFT_("nudge_left", LEFT, EnumSet.of(Context.PLACE)),
		RIGHT_("nudge_right", RIGHT, EnumSet.of(Context.PLACE)),
		RAISE("raise", PAGE_UP, EnumSet.of(Context.PLACE, Context.PLOT)),
		LOWER("lower", PAGE_DOWN, EnumSet.of(Context.PLACE, Context.PLOT)),
		LOCK("lock", 'L', EnumSet.of(Context.PLACE)),
		FIT("fit", 'F', EnumSet.of(Context.PLOT)),
		LEGEND("legend", 'H', EnumSet.of(Context.PLACE));

		/** The mapping's name: {@code key.architect_mc.placing.<id>}. */
		public final String id;
		public final int defaultKey;
		public final Set<Context> contexts;

		Action(String id, int defaultKey, Set<Context> contexts) {
			this.id = id;
			this.defaultKey = defaultKey;
			this.contexts = contexts;
		}

		public String translationKey() {
			return "key.architect_mc.placing." + id;
		}
	}

	/** Actions with a Shift variant (rotate back, force, height by 4, fit back). */
	public static final Set<Action> SHIFTED = EnumSet.of(Action.ROTATE, Action.CONFIRM, Action.RAISE, Action.LOWER, Action.FIT);

	private PlacingKeys() {
	}

	/** The actions a context uses, in mapping order. */
	public static List<Action> of(Context c) {
		return java.util.Arrays.stream(Action.values()).filter(a -> a.contexts.contains(c)).toList();
	}

	/**
	 * The action a press means in {@code ctx}, or null when it is not one of ours (the key then passes to vanilla). {@code bound} gives each
	 * action's currently bound key code (-1 when unbound). Fixed keys: Esc is always cancel, numpad Enter always confirm, Delete cancels a
	 * massing, Shift+/ toggles the legend (plain / is chat). Mappings are tried in order, so the first action bound to the key wins.
	 */
	public static Action resolve(Context ctx, int key, boolean shift, ToIntFunction<Action> bound) {
		if (key == ESCAPE) {
			return Action.CANCEL;
		}
		if (key == NUMPAD_ENTER) {
			return Action.CONFIRM;
		}
		if (ctx == Context.MASSING && key == DELETE) {
			return Action.CANCEL;
		}
		if (ctx == Context.PLACE && key == SLASH) {
			return shift ? Action.LEGEND : null;
		}
		for (Action a : of(ctx)) {
			if (bound.applyAsInt(a) == key) {
				return a;
			}
		}
		return null;
	}

	/**
	 * True when the placing keys listen at all: placing or marking a plot, no screen open, not an API preview. Otherwise no key is ours,
	 * so Esc passes through and opens the pause menu as before.
	 */
	public static boolean listening(boolean placing, boolean marking, boolean screenOpen, boolean preview) {
		return (placing || marking) && !screenOpen && !preview;
	}

	/** The defaults (for tests, and the bindings before Keys registers). */
	public static int defaults(Action a) {
		return a.defaultKey;
	}
}
