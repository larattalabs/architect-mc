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

	/** 26.3's {@code InputConstants.KEY_*} codes (SDL scancodes, not GLFW; {@code PlacingKeysTest} holds them equal). */
	public static final int ESCAPE = 41;
	public static final int ENTER = 40;
	public static final int BACKSPACE = 42;
	public static final int DELETE = 76;
	public static final int RIGHT = 79;
	public static final int LEFT = 80;
	public static final int DOWN = 81;
	public static final int UP = 82;
	public static final int PAGE_UP = 75;
	public static final int PAGE_DOWN = 78;
	public static final int NUMPAD_ENTER = 88;
	public static final int SLASH = 56;
	public static final int R = 21;
	public static final int L = 15;
	public static final int F = 9;
	public static final int H = 11;
	/**
	 * (PR2) Where mouse-button bindings live in the code space {@link #resolve} compares: {@code MOUSE + button}. Far above every keyboard
	 * scancode, so a mouse binding never matches a key press (Mouse 4 is button 3, and scancode 3 must stay a key).
	 */
	public static final int MOUSE = 0x10000;

	public enum Action {
		CONFIRM("confirm", ENTER, EnumSet.allOf(Context.class)),
		CANCEL("cancel", BACKSPACE, EnumSet.allOf(Context.class)),
		ROTATE("rotate", R, EnumSet.of(Context.PLACE)),
		REDIRECT("redirect", R, EnumSet.of(Context.MASSING)),
		FORWARD("nudge_forward", UP, EnumSet.of(Context.PLACE)),
		BACK("nudge_back", DOWN, EnumSet.of(Context.PLACE)),
		LEFT_("nudge_left", LEFT, EnumSet.of(Context.PLACE)),
		RIGHT_("nudge_right", RIGHT, EnumSet.of(Context.PLACE)),
		RAISE("raise", PAGE_UP, EnumSet.of(Context.PLACE, Context.PLOT)),
		LOWER("lower", PAGE_DOWN, EnumSet.of(Context.PLACE, Context.PLOT)),
		LOCK("lock", L, EnumSet.of(Context.PLACE)),
		FIT("fit", F, EnumSet.of(Context.PLOT)),
		LEGEND("legend", H, EnumSet.of(Context.PLACE));

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

	/**
	 * (PR2) The code {@link #resolve} compares for a binding or a press: a keyboard key's own code, a mouse button's {@link #mouse} code,
	 * -1 for anything else (a scancode-only binding, unbound).
	 */
	public static int code(boolean keyboard, boolean mouse, int value) {
		if (value < 0) {
			return -1;
		}
		return keyboard ? value : mouse ? mouse(value) : -1;
	}

	/** (PR2) A mouse button's code (0 left, 1 right, 2 middle, 3 Mouse 4, 4 Mouse 5). */
	public static int mouse(int button) {
		return MOUSE + button;
	}

	/** The defaults (for tests, and the bindings before Keys registers). */
	public static int defaults(Action a) {
		return a.defaultKey;
	}

	// ------------------------------------------------------------------ (PR3) keycap labels, fitted by measured width

	/** The ellipsis a fitted label ends with. */
	public static final String ELLIPSIS = "…";

	/**
	 * (PR3) A key's name as a keycap shows it: punctuation whose glyph is only a pixel or two in the Minecraft font is spelled out, so
	 * a keycap never looks empty. Long names ("Mouse Button 4", a localized name) stay whole; {@link #fit} cuts them by width where
	 * the room is known (before PR3 they were cut at 9 characters).
	 */
	public static String readable(String s) {
		return switch (s) {
			case "`" -> "Backtick";
			case "'" -> "Quote";
			case "´" -> "Accent";
			case "," -> "Comma";
			case "." -> "Period";
			case ";" -> "Semicolon";
			case ":" -> "Colon";
			case "|" -> "Bar";
			default -> s;
		};
	}

	/**
	 * (PR3) {@code s} when it is at most {@code max} wide, else its longest prefix (whole code points, trailing spaces dropped) that
	 * fits with {@link #ELLIPSIS} after it. Never empty for a non-empty {@code s}: when not even one character fits with the ellipsis,
	 * the first character alone.
	 */
	public static String fit(String s, int max, ToIntFunction<String> width) {
		if (s == null || s.isEmpty() || width.applyAsInt(s) <= max) {
			return s == null ? "" : s;
		}
		String best = null;
		int end = s.offsetByCodePoints(0, 1);
		while (end < s.length()) {
			String cand = s.substring(0, end).stripTrailing() + ELLIPSIS;
			if (cand.length() > ELLIPSIS.length() && width.applyAsInt(cand) <= max) {
				best = cand;
			} else if (best != null) {
				break;
			}
			end = s.offsetByCodePoints(end, 1);
		}
		return best != null ? best : s.substring(0, s.offsetByCodePoints(0, 1));
	}

	/**
	 * (PR3) A "key, verb, key, verb…" hint row fitted to {@code inner} as a whole (v0.84 review: each pair fitting alone still let the row
	 * overflow): when the row (lab-ui UiBits.hintsWidth: keycap max(12, label + {@code capPad}), 3 px, the verb, 9 px between pairs) is
	 * wider than {@code inner}, every key is cut to one shared width cap, the widest that lets the row fit, so the longest keys are cut
	 * first and short ones stay whole. A row that cannot fit even with one-character keys gets those. A new array; the verbs are kept.
	 */
	public static String[] fitHints(String[] keyThenVerb, int inner, int capPad, ToIntFunction<String> width) {
		String[] o = keyThenVerb.clone();
		if (hintsWidth(o, capPad, width) <= inner) {
			return o;
		}
		int lo = 0, hi = 0, best = 0;
		for (int i = 0; i + 1 < o.length; i += 2) {
			hi = Math.max(hi, width.applyAsInt(o[i]));
		}
		while (lo <= hi) {
			int mid = (lo + hi) >>> 1;
			if (hintsWidth(capKeys(keyThenVerb, mid, width), capPad, width) <= inner) {
				best = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return capKeys(keyThenVerb, best, width);
	}

	/**
	 * (PR3) A hint row that wraps (one pair per row at worst): each key fitted so its own pair fits {@code inner} alone, as
	 * {@link #fitHints} did before v0.84. A new array; the verbs are kept.
	 */
	public static String[] fitEachPair(String[] keyThenVerb, int inner, int capPad, ToIntFunction<String> width) {
		String[] o = keyThenVerb.clone();
		for (int i = 0; i + 1 < o.length; i += 2) {
			o[i] = fit(o[i], inner - capPad - 3 - width.applyAsInt(o[i + 1]), width);
		}
		return o;
	}

	/** (v0.84 review, pure) A hint row's width as lab-ui's UiBits.hintsWidth draws it, with keycap padding {@code capPad}. */
	public static int hintsWidth(String[] keyThenVerb, int capPad, ToIntFunction<String> width) {
		int w = 0;
		for (int i = 0; i + 1 < keyThenVerb.length; i += 2) {
			w += Math.max(12, width.applyAsInt(keyThenVerb[i]) + capPad) + 3 + width.applyAsInt(keyThenVerb[i + 1]) + 9;
		}
		return Math.max(0, w - 9);
	}

	private static String[] capKeys(String[] keyThenVerb, int cap, ToIntFunction<String> width) {
		String[] o = keyThenVerb.clone();
		for (int i = 0; i + 1 < o.length; i += 2) {
			o[i] = fit(o[i], cap, width);
		}
		return o;
	}
}
