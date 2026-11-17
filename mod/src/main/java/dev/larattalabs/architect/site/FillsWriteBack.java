package dev.larattalabs.architect.site;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.jspecify.annotations.Nullable;

/**
 * (slice T2, the Fills custody residual) A custody write-back's plan, pure, so a retry after a crash writes each slot once and pays the
 * rest once.
 * <p>Before: the custody released in memory, the declared slots written, and what had no free slot <b>dropped</b> as items. A crash with
 * the chunk (and its drops) saved and the ledger not left the custody held: the retry found the slots occupied, skipped them and dropped the
 * whole custody again (a second copy of the slots and of the drop). Now:
 * <ul>
 * <li>each cell's writes are recorded in a receipt in its own chunk ({@code wb:<key>@x,y,z|slot=item*n;...}), in the same snapshot as the
 * slots: a retry deducts a cell whose receipt is there instead of writing it again;</li>
 * <li>what has no slot enters the pile's stock under the keyed credit {@code wb:<custody key>#<n>} (the n-th write-back of that key), in the
 * same ledger write as the custody's release: never an item entity. Provided items with no slot are destroyed, as before (FK-b).</li>
 * </ul>
 * The ledger is published only over durable chunks (the barrier's order), so a ledger with the custody released never stands over a chunk
 * that lost its slots.
 */
public final class FillsWriteBack {
	private FillsWriteBack() {
	}

	/** One container cell now: present, its slot count, which slots are occupied, and the receipt of this write-back if its chunk holds one. */
	public record Cell(boolean present, int size, java.util.Set<Integer> occupied, @Nullable Map<Integer, Fills.Stack> receipt) {
	}

	/** Per cell the slots to write (slot to stack), what was already written (by receipts), what enters the stock and what is destroyed. */
	public record Plan(List<Map<Integer, Fills.Stack>> writes, Map<String, Integer> already, Map<String, Integer> stock, Map<String, Integer> destroyed) {
	}

	/**
	 * The plan for {@code held} (the custody released, provided items included) over the declared containers {@code decls} (their stacks),
	 * {@code providedFits} per cell (a swapped block takes no provided item back) and the cells as they are now.
	 */
	public static Plan plan(Map<String, Integer> held, List<List<Fills.Stack>> decls, List<Boolean> providedFits, List<Cell> cells) {
		Map<String, Integer> left = new TreeMap<>(held);
		Map<String, Integer> already = new TreeMap<>();
		List<Map<Integer, Fills.Stack>> writes = new ArrayList<>();
		// (fix round, GPT P1-1) every receipt first: what reached any cell before a crash comes off the custody before any new write is
		// planned, so a cell written then (its chunk saved) is never paid again by a cell that is free only now
		for (int i = 0; i < decls.size(); i++) {
			Cell c = i < cells.size() ? cells.get(i) : null;
			if (c == null || c.receipt() == null) {
				continue;
			}
			for (Fills.Stack st : c.receipt().values()) {
				int n = Math.min(st.count(), left.getOrDefault(st.item(), 0));
				if (n > 0) {
					left.merge(st.item(), -n, Integer::sum);
					already.merge(st.item(), n, Integer::sum);
				}
			}
		}
		for (int i = 0; i < decls.size(); i++) {
			Map<Integer, Fills.Stack> w = new LinkedHashMap<>();
			writes.add(w);
			Cell c = i < cells.size() ? cells.get(i) : null;
			if (c == null || c.receipt() != null || !c.present()) {
				continue;
			}
			boolean fits = i < providedFits.size() && providedFits.get(i);
			for (Fills.Stack st : decls.get(i)) {
				int n = Math.min(st.count(), left.getOrDefault(st.item(), 0));
				if (n <= 0 || st.provided() && !fits || st.slot() >= c.size() || c.occupied().contains(st.slot()) || w.containsKey(st.slot())) {
					continue;
				}
				w.put(st.slot(), new Fills.Stack(st.slot(), st.item(), n, st.provided()));
				left.merge(st.item(), -n, Integer::sum);
			}
		}
		left.values().removeIf(v -> v <= 0);
		return new Plan(writes, already, Fills.part(left, false), Fills.part(left, true));
	}

	/** The receipt of cell {@code (x, y, z)}'s writes under write-back key {@code wb}. */
	public static String receipt(String wb, int x, int y, int z, Map<Integer, Fills.Stack> writes) {
		StringBuilder b = new StringBuilder(prefix(wb, x, y, z));
		String sep = "";
		for (Fills.Stack st : writes.values()) {
			b.append(sep).append(st.slot()).append('=').append(st.item()).append('*').append(st.count()).append(st.provided() ? "*p" : "");
			sep = ";";
		}
		return b.toString();
	}

	static String prefix(String wb, int x, int y, int z) {
		return wb + "@" + x + "," + y + "," + z + "|";
	}

	/** The writes the receipt list {@code receipts} records for the cell under {@code wb}, or null when none is there. */
	public static @Nullable Map<Integer, Fills.Stack> parse(List<String> receipts, String wb, int x, int y, int z) {
		String p = prefix(wb, x, y, z);
		for (String r : receipts) {
			if (!r.startsWith(p)) {
				continue;
			}
			Map<Integer, Fills.Stack> m = new LinkedHashMap<>();
			String body = r.substring(p.length());
			for (String part : body.isEmpty() ? new String[0] : body.split(";")) {
				int eq = part.indexOf('=');
				String[] it = part.substring(eq + 1).split("\\*");
				int slot = Integer.parseInt(part.substring(0, eq));
				m.put(slot, new Fills.Stack(slot, it[0], Integer.parseInt(it[1]), it.length > 2 && it[2].equals("p")));
			}
			return m;
		}
		return null;
	}

	/** The n-th write-back key of custody key {@code key}: {@code wb:<key>#<n>}, n the count of earlier ones credited. */
	public static String key(String key, java.util.Set<String> credited) {
		String p = "wb:" + key + "#";
		int n = 0;
		for (String k : credited) {
			if (k.startsWith(p)) {
				n++;
			}
		}
		return p + n;
	}
}
