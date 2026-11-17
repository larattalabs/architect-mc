package dev.larattalabs.architect.library;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The Library's "Placed here" list, grouped (slice UI, LEFTOVERS A-placed; UI audit 2 F4): the player's own sites first, then one group
 * per composite placement, per region, and last one read-only group per mod that owns sites ("Managed by Steward"). Before it was
 * every site in one flat list with raw ids, coordinates and group ids. Pure (no Minecraft types); the screen maps each {@code Site} to a
 * {@link Row}. Tested in {@code PlacedGroupsTest}.
 */
public final class PlacedGroups {
	private PlacedGroups() {
	}

	/** What a group is. */
	public enum Kind {
		/** Placed by the player through Architect (no owner, no composite, no region). */
		YOURS,
		/** The modules of one composite placement (one undo). */
		COMPOSITE,
		/** The buildings of one Architect region (a town or district). */
		REGION,
		/** Sites another mod placed and looks after: shown, never removed or moved from here. */
		MANAGED
	}

	/**
	 * One site as the list needs it. {@code owner}: the owning mod's id ("steward_mc:settlement/3" or a bare id), null for the
	 * player's; {@code composite}: the composite entry the site is a module of (its blueprint id before "__"), else null;
	 * {@code region}: the region id from its ext, else null.
	 */
	public record Row(String id, String name, @Nullable String owner, @Nullable String composite, @Nullable String region) {
	}

	/** A group: its key, kind, heading, whether its sites may be changed here, and its rows (in the order given). */
	public record Group(String key, Kind kind, String title, boolean readOnly, List<Row> rows) {
	}

	/** The mod part of an owner ("steward_mc" of "steward_mc:settlement/3"). */
	public static String ownerMod(String owner) {
		int c = owner.indexOf(':');
		return c > 0 ? owner.substring(0, c) : owner;
	}

	/** A mod id as a player reads it: "steward_mc" -> "Steward", "agentcraft" -> "Agentcraft". */
	public static String modName(String mod) {
		String m = mod.endsWith("_mc") ? mod.substring(0, mod.length() - 3) : mod;
		m = m.replace('_', ' ').trim();
		return m.isEmpty() ? mod : m.substring(0, 1).toUpperCase(Locale.ROOT) + m.substring(1);
	}

	/** The composite entry a module blueprint id belongs to ({@code <composite>__<module>}), else null. */
	public static @Nullable String compositeOf(String blueprint, String sep) {
		int i = blueprint.indexOf(sep);
		return i > 0 ? blueprint.substring(0, i) : null;
	}

	/**
	 * Groups {@code rows}: an owned site goes to its mod's MANAGED group whatever else it is; else a module to its COMPOSITE group,
	 * else a region's building to its REGION group, else YOURS. Order: YOURS, the composites, the regions (each in first-seen order),
	 * then MANAGED by mod name. Empty groups are left out. {@code nameOf} names a composite entry for its heading.
	 */
	public static List<Group> group(List<Row> rows, java.util.function.Function<String, String> nameOf) {
		List<Row> yours = new ArrayList<>();
		Map<String, List<Row>> comps = new LinkedHashMap<>();
		Map<String, List<Row>> regions = new LinkedHashMap<>();
		Map<String, List<Row>> managed = new java.util.TreeMap<>();
		for (Row r : rows) {
			if (r.owner() != null && !r.owner().isBlank()) {
				managed.computeIfAbsent(modName(ownerMod(r.owner())), k -> new ArrayList<>()).add(r);
			} else if (r.composite() != null) {
				comps.computeIfAbsent(r.composite(), k -> new ArrayList<>()).add(r);
			} else if (r.region() != null) {
				regions.computeIfAbsent(r.region(), k -> new ArrayList<>()).add(r);
			} else {
				yours.add(r);
			}
		}
		List<Group> out = new ArrayList<>();
		if (!yours.isEmpty()) {
			out.add(new Group("yours", Kind.YOURS, "Placed by you", false, List.copyOf(yours)));
		}
		for (var e : comps.entrySet()) {
			out.add(new Group("composite:" + e.getKey(), Kind.COMPOSITE, nameOf.apply(e.getKey()) + " (one building in parts)", false, List.copyOf(e.getValue())));
		}
		int n = 0;
		for (var e : regions.entrySet()) {
			n++;
			out.add(new Group("region:" + e.getKey(), Kind.REGION, regions.size() > 1 ? "Town plan " + n : "Town plan", false, List.copyOf(e.getValue())));
		}
		for (var e : managed.entrySet()) {
			out.add(new Group("managed:" + e.getKey(), Kind.MANAGED, "Managed by " + e.getKey(), true, List.copyOf(e.getValue())));
		}
		return out;
	}

	/** Why a managed site can't be removed or moved here (the disabled reason). */
	public static String managedReason(String modName) {
		return "Managed by " + modName + ": change or undo it from " + modName + "'s screens";
	}
}
