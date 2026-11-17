package dev.larattalabs.architect.txn;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.6 "Holds", R-8) Every open (or retiring, or quarantined) txn's resources, as a guard every writer
 * honours. A resource is a string ({@code site:<id>}, {@code pile:<owner>}, {@code box:<dim>@x,y,z}, {@code crate:<dim>@x,y,z},
 * {@code player:<uuid>}). Rebuilt from {@code txn.json} at load, before any recovery or legacy resolver runs. {@link #isEmpty} is the O(1)
 * fast path every writer takes when no txn is open.
 */
public final class Holds {
	private final Map<String, TxnEntry> byResource = new HashMap<>();
	/**
	 * (slice T2a) The held cells ({@code box:} and {@code crate:} resources) per dimension, keyed by {@link #pack}: the O(1) pre-filter every
	 * block write takes while any txn is open, before a resource string is built (holds can be indefinite, Noah's decision 4).
	 */
	private final Map<String, Map<Long, String>> cells = new HashMap<>();

	public boolean isEmpty() {
		return byResource.isEmpty();
	}

	void hold(TxnEntry t) {
		for (String r : t.resources) {
			byResource.put(r, t);
			Cell c = cell(r);
			if (c != null) {
				cells.computeIfAbsent(c.dim, k -> new HashMap<>()).put(pack(c.x, c.y, c.z), r);
			}
		}
	}

	void release(TxnEntry t) {
		for (String r : t.resources) {
			if (byResource.remove(r, t)) {
				Cell c = cell(r);
				Map<Long, String> m = c == null ? null : cells.get(c.dim);
				if (m != null) {
					m.remove(pack(c.x, c.y, c.z), r);
					if (m.isEmpty()) {
						cells.remove(c.dim);
					}
				}
			}
		}
	}

	void clear() {
		byResource.clear();
		cells.clear();
	}

	/** A held cell: its dimension key and position. */
	public record Cell(String dim, int x, int y, int z) {
	}

	/** The cell a {@code box:<dim>@x,y,z} or {@code crate:<dim>@x,y,z} resource names, or null for any other resource. */
	public static @Nullable Cell cell(String resource) {
		int colon = resource.indexOf(':');
		if (colon < 0) {
			return null;
		}
		String kind = resource.substring(0, colon);
		if (!kind.equals("box") && !kind.equals("crate")) {
			return null;
		}
		int at = resource.lastIndexOf('@');
		if (at < colon) {
			return null;
		}
		String[] p = resource.substring(at + 1).split(",");
		if (p.length != 3) {
			return null;
		}
		try {
			return new Cell(resource.substring(colon + 1, at), Integer.parseInt(p[0]), Integer.parseInt(p[1]), Integer.parseInt(p[2]));
		} catch (NumberFormatException e) {
			return null;
		}
	}

	/** The packing of {@code BlockPos.asLong} (26 bits x, 26 bits z, 12 bits y), so the game side keys a cell without building a string. */
	public static long pack(int x, int y, int z) {
		return ((long) x & 0x3FFFFFFL) << 38 | ((long) z & 0x3FFFFFFL) << 12 | (y & 0xFFFL);
	}

	/** The txn holding the cell {@code (x, y, z)} of dimension {@code dim} as a box or a crate, or null. O(1). */
	public @Nullable TxnEntry cellHolder(String dim, int x, int y, int z) {
		if (cells.isEmpty()) {
			return null;
		}
		Map<Long, String> m = cells.get(dim);
		String r = m == null ? null : m.get(pack(x, y, z));
		return r == null ? null : byResource.get(r);
	}

	/** The resource of the first held cell of {@code dim} inside the box (inclusive bounds), or null: the region commands' refusal. */
	public @Nullable String cellIn(String dim, int x0, int y0, int z0, int x1, int y1, int z1) {
		Map<Long, String> m = cells.get(dim);
		if (m == null) {
			return null;
		}
		for (String r : new ArrayList<>(m.values())) {
			Cell c = cell(r);
			if (c != null && c.x >= Math.min(x0, x1) && c.x <= Math.max(x0, x1) && c.y >= Math.min(y0, y1) && c.y <= Math.max(y0, y1)
				&& c.z >= Math.min(z0, z1) && c.z <= Math.max(z0, z1)) {
				return r;
			}
		}
		return null;
	}

	/** Whether any cell of {@code dim} is held. */
	public boolean anyCell(String dim) {
		return cells.containsKey(dim);
	}

	/** The txn holding {@code resource}, or null. */
	public @Nullable TxnEntry holder(String resource) {
		return byResource.isEmpty() ? null : byResource.get(resource);
	}

	/**
	 * (§3.12.10) Why a begin over {@code resources} is refused: {@code held(other) tx-<n>: <resource>} for the first resource another txn
	 * holds, or null when none is held.
	 */
	public @Nullable String refusal(Collection<String> resources) {
		if (byResource.isEmpty()) {
			return null;
		}
		for (String r : resources) {
			TxnEntry t = byResource.get(r);
			if (t != null) {
				return other(t, r);
			}
		}
		return null;
	}

	/** {@code held(other) tx-<n>: <where>}: another txn holds it; nothing changed, try later. */
	public static String other(TxnEntry t, String resource) {
		return "held(other) " + t.id + ": " + (t.heldAt != null ? t.heldAt : resource);
	}

	/** {@code held(decided) tx-<n>: <where>}: the caller's own decided txn is held; it finishes later ("under way"). */
	public static String decided(TxnEntry t) {
		return "held(decided) " + t.id + ": " + (t.heldAt != null ? t.heldAt : String.join(", ", t.resources));
	}

	public List<String> resources() {
		return List.copyOf(byResource.keySet());
	}
}
