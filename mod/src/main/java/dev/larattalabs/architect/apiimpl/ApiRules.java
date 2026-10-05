package dev.larattalabs.architect.apiimpl;

import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.placement.Occupancy;
import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/** The pure rules behind the public API (docs/CONTRACT.md phase 4a), tested without a game. Internal. */
public final class ApiRules {
	/** The largest area (per side, in columns) a survey samples at resolution 1. */
	public static final int SURVEY_FULL_MAX = 256;
	/** The coarse survey resolution. */
	public static final int SURVEY_COARSE = 4;
	/** A namespaced ext key: {@code <modid>:<key>}. */
	public static final Pattern EXT_KEY = Pattern.compile("[a-z0-9_.-]+:[^\\s]+");

	private ApiRules() {
	}

	/** The reason of an occupancy refusal: a player in the box wins over every other entity. */
	public static Reason occupancyReason(List<Occupancy.Kind> kinds) {
		return kinds.contains(Occupancy.Kind.PLAYER) ? Reason.PLAYER_IN_BOX : Reason.OCCUPIED;
	}

	/** Whether a placement in {@code mode} becomes a construction site, given the world's survival toggle. */
	public static boolean construction(Mode mode, boolean survivalOn) {
		return switch (mode) {
			case AUTO -> survivalOn;
			case INSTANT -> false;
			case CONSTRUCTION -> true;
		};
	}

	/**
	 * The actor rule: INSTANT in a survival-toggle world needs an actor with permission level 2 (no free builds by an entity
	 * or a mod on its own). Null = allowed; else the NOT_ALLOWED message.
	 */
	public static @Nullable String modeRefusal(Mode mode, boolean survivalOn, boolean hasActor, boolean actorHasPermission2) {
		if (mode != Mode.INSTANT || !survivalOn) {
			return null;
		}
		if (!hasActor) {
			return "Instant placement in a survival world needs a player with permission level 2 (cheats or op) as the actor; no actor was given";
		}
		if (!actorHasPermission2) {
			return "Instant placement in a survival world needs permission level 2 (cheats or op); the actor does not have it";
		}
		return null;
	}

	/**
	 * The owner rule of an API remove: a site whose owner differs from the requester (null = the player) needs force.
	 * Null = allowed; else the refusal.
	 */
	public static @Nullable String removeRefusal(String siteId, @Nullable String owner, @Nullable String requester, boolean force) {
		if (force || Objects.equals(owner, requester)) {
			return null;
		}
		return siteId + " is owned by " + (owner == null ? "the player" : owner) + ", not " + (requester == null ? "the player" : requester)
			+ "; pass force to remove it anyway";
	}

	/** Whether a site with {@code owner} belongs to the {@code filter} of {@code Sites.list(owner)} (null: the player's own). */
	public static boolean ownerMatches(@Nullable String owner, @Nullable String filter) {
		return Objects.equals(owner, filter);
	}

	public static boolean extKeyValid(@Nullable String key) {
		return key != null && EXT_KEY.matcher(key).matches();
	}

	/** The resolution a survey uses: 1 when asked for and the area is at most 256x256 columns, else 4. */
	public static int surveyResolution(int requested, int widthBlocks, int depthBlocks) {
		return requested == 1 && widthBlocks <= SURVEY_FULL_MAX && depthBlocks <= SURVEY_FULL_MAX ? 1 : SURVEY_COARSE;
	}

	/** Sample columns along a side of {@code blocks} at {@code resolution}. */
	public static int surveyColumns(int blocks, int resolution) {
		return (blocks + resolution - 1) / resolution;
	}
}
