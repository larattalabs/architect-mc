package dev.larattalabs.architect.survival;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;

/**
 * What a block costs in survival (docs/CONTRACT.md phase 3 "Materials"): its item ({@code Block.asItem()}, given as
 * {@code asItem}), with the special cases of the contract and the <b>obtainability map</b>
 * ({@code data/architect_mc/survival_items.json}): blocks whose item survival can't get, or that have none, cost another
 * item, and creative-only blocks are refused. Pure: blocks and items are ids, block states are property maps.
 *
 * <ul>
 * <li>the upper half of a two-part block (doors, tall plants: {@code half=upper}) and a bed's head cost nothing: the
 * pair costs one item, charged on its lower half / foot;</li>
 * <li>a double slab costs 2 slabs; candles, sea pickles, turtle eggs, petals and leaf litter cost their count; snow
 * costs one snow layer per layer;</li>
 * <li>wall torches, wall signs, wall banners, wall heads and coral wall fans cost their standing item;</li>
 * <li>a potted plant costs a flower pot plus the plant;</li>
 * <li>blocks with no item ({@code minecraft:fire}...) cost nothing.</li>
 * </ul>
 */
public final class SurvivalItems {
	public static final String RESOURCE = "/data/architect_mc/survival_items.json";

	/** One item and how many of it. */
	public record Cost(String item, int count) {
	}

	private final Map<String, List<Cost>> costs;
	private final Set<String> creativeOnly;

	public SurvivalItems(Map<String, List<Cost>> costs, Set<String> creativeOnly) {
		this.costs = Map.copyOf(costs);
		this.creativeOnly = Set.copyOf(creativeOnly);
	}

	/** {@code {"costs": {block: item | [item, ...] | {item: n}}, "creativeOnly": [block, ...]}}. */
	public static SurvivalItems parse(JsonObject o) {
		Map<String, List<Cost>> costs = new LinkedHashMap<>();
		if (o.has("costs")) {
			for (var e : o.getAsJsonObject("costs").entrySet()) {
				List<Cost> list = new ArrayList<>();
				JsonElement v = e.getValue();
				if (v.isJsonPrimitive()) {
					list.add(new Cost(v.getAsString(), 1));
				} else if (v.isJsonArray()) {
					v.getAsJsonArray().forEach(x -> list.add(new Cost(x.getAsString(), 1)));
				} else if (v.isJsonObject()) {
					v.getAsJsonObject().entrySet().forEach(x -> list.add(new Cost(x.getKey(), x.getValue().getAsInt())));
				}
				costs.put(e.getKey(), List.copyOf(list));
			}
		}
		Set<String> creative = new LinkedHashSet<>();
		if (o.has("creativeOnly")) {
			o.getAsJsonArray("creativeOnly").forEach(x -> creative.add(x.getAsString()));
		}
		return new SurvivalItems(costs, creative);
	}

	private static volatile @Nullable SurvivalItems bundled;

	/** The map shipped in the jar ({@link #RESOURCE}); an empty map (no special cases) when it can't be read. */
	public static SurvivalItems bundled() {
		SurvivalItems b = bundled;
		if (b == null) {
			try (InputStream in = SurvivalItems.class.getResourceAsStream(RESOURCE)) {
				b = in == null ? new SurvivalItems(Map.of(), Set.of())
					: parse(JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject());
			} catch (IOException | RuntimeException e) {
				b = new SurvivalItems(Map.of(), Set.of());
			}
			bundled = b;
		}
		return b;
	}

	/** Whether survival can't build {@code block} at all (placement refuses the design). */
	public boolean creativeOnly(String block) {
		return creativeOnly.contains(block);
	}

	public Set<String> creativeOnlyBlocks() {
		return creativeOnly;
	}

	/**
	 * What one cell holding {@code block} with {@code props} costs. {@code asItem}: block id -> its item id, or null when the
	 * block has no item. Empty when it costs nothing. A creative-only block costs nothing here (placement refuses it first).
	 */
	public List<Cost> cost(String block, Map<String, String> props, Function<String, @Nullable String> asItem) {
		if (creativeOnly.contains(block)) {
			return List.of();
		}
		// the second cell of a pair: the pair is charged on its lower half / foot
		if ("upper".equals(props.get("half")) || "head".equals(props.get("part"))) {
			return List.of();
		}
		List<Cost> mapped = costs.get(block);
		if (mapped != null) {
			return mapped;
		}
		String path = path(block);
		String ns = block.substring(0, block.length() - path.length());
		if (path.startsWith("potted_")) {
			String plant = ns + switch (path.substring("potted_".length())) {
				case "azalea_bush" -> "azalea";
				case "flowering_azalea_bush" -> "flowering_azalea";
				default -> path.substring("potted_".length());
			};
			List<Cost> out = new ArrayList<>();
			out.add(new Cost(ns + "flower_pot", 1));
			String plantItem = asItem.apply(plant);
			out.add(new Cost(plantItem != null ? plantItem : plant, 1));
			return out;
		}
		String standing = standing(block);
		String item = asItem.apply(standing);
		if (item == null && !standing.equals(block)) {
			item = asItem.apply(block);
		}
		if (item == null || item.endsWith(":air")) {
			return List.of();
		}
		return List.of(new Cost(item, count(path, props)));
	}

	/** The standing block of a wall-mounted one ({@code minecraft:oak_wall_sign -> minecraft:oak_sign}), else the block itself. */
	static String standing(String block) {
		String[][] walls = {{"_wall_hanging_sign", "_hanging_sign"}, {"_wall_torch", "_torch"}, {"_wall_sign", "_sign"},
			{"_wall_banner", "_banner"}, {"_wall_head", "_head"}, {"_wall_skull", "_skull"}, {"_wall_fan", "_fan"}};
		if (block.endsWith(":wall_torch")) {
			return block.substring(0, block.length() - "wall_torch".length()) + "torch";
		}
		for (String[] w : walls) {
			if (block.endsWith(w[0])) {
				return block.substring(0, block.length() - w[0].length()) + w[1];
			}
		}
		return block;
	}

	/** How many items one cell of this block holds. */
	static int count(String path, Map<String, String> props) {
		if (path.endsWith("_slab") && "double".equals(props.get("type"))) {
			return 2;
		}
		for (String k : new String[] {"candles", "pickles", "eggs", "flower_amount", "segment_amount"}) {
			String v = props.get(k);
			if (v != null) {
				return parse(v);
			}
		}
		if (path.equals("snow") && props.containsKey("layers")) {
			return parse(props.get("layers"));
		}
		return 1;
	}

	private static int parse(String v) {
		try {
			return Math.max(1, Integer.parseInt(v));
		} catch (NumberFormatException e) {
			return 1;
		}
	}

	private static String path(String id) {
		int c = id.indexOf(':');
		return c < 0 ? id : id.substring(c + 1);
	}
}
