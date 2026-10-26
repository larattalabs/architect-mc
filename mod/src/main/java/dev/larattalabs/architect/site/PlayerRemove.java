package dev.larattalabs.architect.site;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * Slice SAFETY: a player's own removals. {@link #remove} is the one path Library &gt; Placed &gt; Remove and the "Undo last
 * placement" key share (it was the Library's own until SAFETY); {@link #record} / {@link #latestOwn} track the sites a
 * player placed this session ({@link LastPlaced}). Server thread.
 */
public final class PlayerRemove {
	private PlayerRemove() {
	}

	/** Clears the session's records when a world's server starts and stops. */
	public static void init() {
		ServerLifecycleEvents.SERVER_STARTING.register(s -> clear());
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> clear());
	}

	private static void clear() {
		LastPlaced.INSTANCE.clear();
		RemoveTokens.INSTANCE.clear();
	}

	/** A placement by the player itself (the ghost's Enter, {@code /architect place}): the undo key's candidates. */
	public static void record(@Nullable String player, Site placed) {
		if (player != null && placed.owner() == null && placed.member() == null) {
			LastPlaced.INSTANCE.record(player, placed.id(), placed.placedAt());
		}
	}

	/**
	 * The player's newest placement this session that still stands as it was placed and that no mod owns (an owned site is
	 * never the undo key's), or null.
	 */
	public static @Nullable Site latestOwn(String player) {
		LastPlaced.Entry e = LastPlaced.INSTANCE.latest(player, x -> {
			Site s = Sites.get(x.site());
			return s != null && s.placedAt() == x.placedAt() && s.owner() == null;
		});
		return e == null ? null : Sites.get(e.site());
	}

	/**
	 * Removes {@code s} as Library &gt; Placed &gt; Remove does, answering the player's line: a plain message, {@code "!"} + why
	 * not, or {@code "?"} + the question when another site covers some of its cells and {@code covered} is null (ask: keep
	 * them or remove both).
	 */
	public static String remove(ServerLevel level, Site s, boolean force, Sites.@Nullable Covered covered) {
		try {
			ServerLevel sl = Sites.levelOf(level.getServer(), s);
			if (covered == null) {
				java.util.List<String> over = SiteJournal.coveringSites(s.id());
				if (!over.isEmpty()) {
					int n = SiteJournal.siteJson(s.id()).get("covered").getAsInt();
					return "?" + n + " cell" + (n == 1 ? "" : "s") + " of this site " + (n == 1 ? "is" : "are") + " under " + String.join(", ", over.stream()
						.map(Sites::describe).toList()) + "; they stay until " + (over.size() == 1 ? "it is" : "they are") + " removed";
				}
			}
			if (Sites.removeLarge(sl == null ? level : sl, s.id(), force, covered == null ? Sites.Covered.KEEP : covered) != null) {
				return "Removing " + s.id() + " over ticks (a large site)";
			}
			Sites.Removed gone = Sites.removeDetailed(sl == null ? level : sl, s.id(), force, covered == null ? Sites.Covered.KEEP : covered);
			String both = gone.cascaded().isEmpty() ? "" : " (with " + String.join(", ", gone.cascaded()) + ")";
			return gone.site().construction() != null ? "Deconstructed " + gone.site().id() + both + "; refunds dropped where its crate stood, the terrain "
				+ "is back" : "Removed " + gone.site().id() + both + "; the terrain is back" + (gone.handedDown().isEmpty() ? ""
					: " (covered cells stay until " + String.join(", ", gone.handedDown().keySet()) + " goes)");
		} catch (Sites.SiteException ex) {
			return "!" + ex.getMessage();
		}
	}
}
