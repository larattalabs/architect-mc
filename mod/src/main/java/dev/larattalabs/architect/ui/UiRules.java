package dev.larattalabs.architect.ui;

import org.jspecify.annotations.Nullable;

/**
 * Pure interaction rules of the client screens. No game or
 * sidecar classes: the client maps its state in, so each rule is unit-tested ({@code UiRulesTest}).
 */
public final class UiRules {
	private UiRules() {
	}

	// ------------------------------------------------------------------ C6 pause

	/**
	 * Whether Architect screens pause a singleplayer game (contract C6). Everyday play (a jar in a normal
	 * launcher) pauses, like vanilla menus, so a Hardcore world is never left running behind a screen. A dev
	 * run ({@code gradlew runClient}) or a client with the DevBridge on keeps the world running for QA.
	 * {@code override} ({@code ARCHITECT_PAUSE=0|1}) wins over both. Multiplayer never pauses (vanilla
	 * ignores {@code isPauseScreen} there).
	 */
	public static boolean screensPause(boolean devRun, boolean devBridge, @Nullable Boolean override) {
		if (override != null) {
			return override;
		}
		return !(devRun || devBridge);
	}

	// ------------------------------------------------------------------ Enter

	public enum EnterAction {
		SEND, NEWLINE
	}

	/**
	 * The one Enter rule of every Architect text input. Single-line inputs (console, decision answer, the
	 * agent card's message line): Enter sends, Ctrl+Enter sends too, Shift+Enter inserts a new line where
	 * the input takes several lines. Multi-line inputs (goal thread, notes, plan editor, design notes):
	 * Enter inserts a new line and Ctrl+Enter sends.
	 */
	public static EnterAction enter(boolean multiline, boolean ctrl, boolean shift) {
		if (multiline) {
			return ctrl ? EnterAction.SEND : EnterAction.NEWLINE;
		}
		return shift && !ctrl ? EnterAction.NEWLINE : EnterAction.SEND;
	}

	/** Key hints for the rule above, as (key, verb) pairs. */
	public static String[] enterHints(boolean multiline) {
		return multiline ? new String[] {"Ctrl+Enter", "send", "Enter", "new line"} : new String[] {"Enter", "send", "Shift+Enter", "new line"};
	}

	// ------------------------------------------------------------------ two-press confirms

	/** A second press within {@code windowMs} of arming confirms (agent Stop, card answers, console goals). */
	public static boolean secondPress(long armedAt, long now, long windowMs) {
		return armedAt > 0 && now >= armedAt && now - armedAt <= windowMs;
	}

	/** The least time between arming a confirm and the key press that confirms it (merge / reject in the diff). */
	public static final long KEY_CONFIRM_MS = 300;

	/**
	 * A confirm by key (Enter on "Confirm merge", X / Enter on "Confirm reject") counts only for a fresh
	 * press (not an OS key repeat, see {@link KeyRepeat}) at least {@link #KEY_CONFIRM_MS} after the confirm
	 * was armed, so a held or double-tapped Ctrl+Enter never merges.
	 */
	public static boolean keyConfirmReady(long armedAt, long now, boolean repeat) {
		return !repeat && armedAt > 0 && now - armedAt >= KEY_CONFIRM_MS;
	}

	/**
	 * Key-repeat tracking for screens (as the decision screen does it): a key pressed again without a
	 * release in between is an OS key repeat, and a key already down when the screen opened is ignored
	 * until released. Only physical presses count ({@code physical} = the key is down right now); a
	 * synthetic press (the DevBridge's {@code dev.key}) is never a repeat.
	 */
	public static final class KeyRepeat {
		private final java.util.Set<Integer> down = new java.util.HashSet<>();

		/** A key physically down when the screen opened (the key that opened it, a held Enter). */
		public void heldAtOpen(int key) {
			down.add(key);
		}

		/** Records a press; true when it is a repeat (or a key held since the screen opened). */
		public boolean press(int key, boolean physical) {
			if (!physical) {
				return false;
			}
			return !down.add(key);
		}

		public void release(int key) {
			down.remove(key);
		}

		/** Forgets every key (a screen re-initialised: releases may have gone to another screen meanwhile). */
		public void reset() {
			down.clear();
		}
	}
}
