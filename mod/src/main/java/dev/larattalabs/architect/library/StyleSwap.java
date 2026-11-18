package dev.larattalabs.architect.library;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;
import org.jspecify.annotations.Nullable;

/**
 * (PR P1, Preview on ghost) A design's blocks re-dressed in another Style, materials only: each block's role in the design's Style
 * (its wood, stone or roof row, read through {@link StyleRoles}), then the target Style's block for that role, in the same shape
 * (planks, log, stairs, slab, door, … of the target wood; stairs, slab, wall of the target stone or roof). A block that belongs to no row,
 * or whose shape the target lacks, is kept. Rows are tried in {@link StyleRoles#MAIN_FIELDS} order, so a block that could fill two takes
 * the first. Pure and deterministic; {@code StyleSwapTest}. Shapes and parts come only with a real variant job.
 */
public final class StyleSwap {
	private final StyleRoles table;
	private final Palettes.Inputs from;
	private final Palettes.Inputs to;
	private final Predicate<String> exists;
	private final Map<String, String> memo = new HashMap<>();

	/**
	 * @param from the design's main rows ({@link #inferMain} when it has no Style of its own)
	 * @param to the target Style's main rows ({@code table.mainOf(roles)})
	 * @param exists whether a block id exists (the registry on the client; any set in tests)
	 */
	public StyleSwap(StyleRoles table, Palettes.Inputs from, Palettes.Inputs to, Predicate<String> exists) {
		this.table = table;
		this.from = from;
		this.to = to;
		this.exists = exists;
	}

	/** The block id {@code b} becomes ({@code minecraft:}-qualified in, the same form out); {@code b} itself when it has no role. */
	public String swap(String b) {
		return memo.computeIfAbsent(b, this::compute);
	}

	private String compute(String b) {
		String q = StyleRoles.qualify(b);
		// wood, then stone, then roof, then accent (MAIN_FIELDS order)
		String w = table.woodOfBlock(q);
		if (w != null && w.equals(from.wood()) && to.wood() != null) {
			return woodTo(q, w, to.wood());
		}
		String fam = table.stoneFamilyOf(q);
		String fromFam = from.stone() == null ? null : table.stoneFamilyOf(StyleRoles.qualify(from.stone()));
		if (fam != null && fam.equals(fromFam) && to.stone() != null) {
			return shapeTo(q, StyleRoles.qualify(to.stone()));
		}
		if (from.roof() != null && to.roof() != null) {
			String roofWood = table.woodOfBlock("minecraft:" + from.roof() + "_planks") != null ? from.roof() : null;
			if (roofWood != null && roofWood.equals(w)) {
				String toWood = table.woodOfBlock("minecraft:" + to.roof() + "_planks") != null ? to.roof() : null;
				return toWood != null ? woodTo(q, w, toWood) : shapeTo(q, StyleRoles.qualify(to.roof()));
			}
			if (roofWood == null && table.fullOfBlock(q).equals(StyleRoles.qualify(from.roof()))) {
				return shapeTo(q, StyleRoles.qualify(to.roof()));
			}
		}
		if (w != null && w.equals(from.accent()) && to.accent() != null) {
			return woodTo(q, w, to.accent());
		}
		return q;
	}

	/** The same part of another wood: the wood's name swapped in the id, when the target has that block. */
	private String woodTo(String q, String wood, String toWood) {
		if (wood.equals(toWood)) {
			return q;
		}
		String c = q.replace(wood + "_", toWood + "_");
		if (c.equals(q)) {
			c = q.replace("_" + wood, "_" + toWood);
		}
		return !c.equals(q) && toWood.equals(table.woodOfBlock(c)) && exists.test(c) ? c : q;
	}

	/** {@code q}'s shape (full, stairs, slab, wall, …) of {@code toFull}, when the table or the registry has it. */
	private String shapeTo(String q, String toFull) {
		String full = table.fullOfBlock(q);
		String toBase = table.fullOfBlock(toFull);
		if (full.equals(q)) {
			return exists.test(toBase) ? toBase : q;
		}
		String suffix = suffix(q);
		if (suffix == null) {
			return q;
		}
		for (String v : table.variantsOf(toBase)) {
			if (v.endsWith(suffix) && exists.test(v)) {
				return v;
			}
		}
		// by name: polished_andesite -> polished_andesite_stairs; bricks -> brick_stairs
		String base = toBase.endsWith("s") && !toBase.endsWith("ss") ? toBase.substring(0, toBase.length() - 1) : toBase;
		for (String c : List.of(toBase + suffix, base + suffix)) {
			if (exists.test(c)) {
				return c;
			}
		}
		return q;
	}

	private static @Nullable String suffix(String q) {
		for (String s : List.of("_stairs", "_slab", "_wall", "_fence_gate", "_fence", "_button", "_pressure_plate")) {
			if (q.endsWith(s)) {
				return s;
			}
		}
		return null;
	}

	/**
	 * The main rows of a design without a Style of its own, from its blocks: the most used wood is its wood, the next most used wood (or a
	 * non-wood roof block family) its roof, the most used stone family its stone.
	 */
	public static Palettes.Inputs inferMain(StyleRoles table, Map<String, Integer> counts) {
		Map<String, Integer> woods = new HashMap<>();
		Map<String, Integer> stairsWoods = new HashMap<>();
		Map<String, Integer> stones = new HashMap<>();
		counts.forEach((b, n) -> {
			String q = StyleRoles.qualify(b);
			String w = table.woodOfBlock(q);
			if (w != null) {
				woods.merge(w, n, Integer::sum);
				if (q.endsWith("_stairs") || q.endsWith("_slab")) {
					stairsWoods.merge(w, n, Integer::sum);
				}
			}
			String f = table.stoneFamilyOf(q);
			if (f != null) {
				stones.merge(table.fullOfBlock(q), n, Integer::sum);
			}
		});
		String wood = top(woods, null);
		String roof = top(stairsWoods, wood);
		String stone = top(stones, null);
		return new Palettes.Inputs(wood, stone == null ? null : StyleRoles.shortOf(stone), roof, wood);
	}

	private static @Nullable String top(Map<String, Integer> m, @Nullable String not) {
		String best = null;
		int n = -1;
		for (var e : new java.util.TreeMap<>(m).entrySet()) {
			if (!e.getKey().equals(not) && e.getValue() > n) {
				best = e.getKey();
				n = e.getValue();
			}
		}
		return best;
	}
}
