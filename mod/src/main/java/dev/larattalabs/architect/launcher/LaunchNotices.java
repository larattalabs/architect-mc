package dev.larattalabs.architect.launcher;

import dev.larattalabs.architect.launcher.LauncherPlan.State;
import org.jspecify.annotations.Nullable;

/**
 * Which launcher state changes the player hears about (UI-2b; pure, unit-tested in {@code LaunchNoticesTest}). Before, every
 * transition into RUNNING toasted "Architect is ready", so a flapping link repeated it. Now:
 * <ul>
 * <li>"Architect is ready" toasts once a session, on the first successful start; later RUNNING transitions are silent;</li>
 * <li>a RUNNING that follows a short drop (under {@link #DEBOUNCE_MS}) is a reconnect blip: not even logged as news
 * ({@link #quiet});</li>
 * <li>a failure (NODE_MISSING, CRASHED) toasts, but the same failure again within {@link #REPEAT_MS} does not.</li>
 * </ul>
 * Not thread-safe: the launcher calls it from its {@code set}, one transition at a time.
 */
public final class LaunchNotices {
	public static final long DEBOUNCE_MS = 10_000;
	public static final long REPEAT_MS = 60_000;

	public enum Notice {
		NONE,
		READY,
		NODE_MISSING,
		CRASHED
	}

	private boolean readyShown;
	private long leftRunningAt = -1;
	private @Nullable State lastFailure;
	private long lastFailureAt;
	private boolean quiet;

	/** A transition {@code before -> now} at {@code ms}: the toast to show, if any. */
	public Notice on(@Nullable State before, State now, long ms) {
		quiet = false;
		if (before == State.RUNNING && now != State.RUNNING) {
			leftRunningAt = ms;
		}
		return switch (now) {
			case RUNNING -> {
				quiet = readyShown && leftRunningAt >= 0 && ms - leftRunningAt < DEBOUNCE_MS;
				if (readyShown) {
					yield Notice.NONE;
				}
				readyShown = true;
				yield Notice.READY;
			}
			case NODE_MISSING, CRASHED -> {
				boolean repeat = now == lastFailure && ms - lastFailureAt < REPEAT_MS;
				lastFailure = now;
				lastFailureAt = ms;
				yield repeat ? Notice.NONE : now == State.CRASHED ? Notice.CRASHED : Notice.NODE_MISSING;
			}
			default -> Notice.NONE;
		};
	}

	/** Whether the last {@link #on} was a reconnect blip back to RUNNING (the launcher logs it at debug only). */
	public boolean quiet() {
		return quiet;
	}

	public boolean readyShown() {
		return readyShown;
	}
}
