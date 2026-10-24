package dev.larattalabs.architect.library;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * (Style unification U3) What the Style screens paint a block with, and how they group materials. Colours are the {@code colors}
 * member of the checked-in palettes ({@code palettes-fallback.json}, tools/gen-palettes.mjs: the side face's average from the game's
 * textures, kit/lib/colors.mjs), so a swatch or a preview sheet is the role's own block, never a stand-in. Families group the four
 * main rows' choices and the role candidates for the pickers' rails. Pure.
 */
public final class Swatches {
	private static volatile @Nullable Map<String, Integer> colors;

	private Swatches() {
	}

	/** Block id ({@code minecraft:}-qualified or short) -> RGB, from the checked-in table; empty when the resource is missing. */
	public static Map<String, Integer> table() {
		Map<String, Integer> m = colors;
		if (m == null) {
			m = parse(Palettes.fallbackJson());
			colors = m;
		}
		return m;
	}

	/** The colour table of a palettes JSON ({@code colors}: id -> "#rrggbb"). */
	static Map<String, Integer> parse(@Nullable JsonElement json) {
		Map<String, Integer> out = new LinkedHashMap<>();
		if (json != null && json.isJsonObject() && json.getAsJsonObject().has("colors") && json.getAsJsonObject().get("colors").isJsonObject()) {
			for (var e : json.getAsJsonObject().getAsJsonObject("colors").entrySet()) {
				Integer rgb = hex(e.getValue().isJsonPrimitive() ? e.getValue().getAsString() : null);
				if (rgb != null) {
					out.put(StyleRoles.qualify(e.getKey()), rgb);
				}
			}
		}
		return Collections.unmodifiableMap(out);
	}

	static @Nullable Integer hex(@Nullable String s) {
		if (s == null || !s.matches("#[0-9a-fA-F]{6}")) {
			return null;
		}
		return Integer.parseInt(s.substring(1), 16);
	}

	/** A block's RGB, or null when the table has none (the client then asks the game: the block's map colour). */
	public static @Nullable Integer rgb(@Nullable String block) {
		if (block == null || block.isBlank()) {
			return null;
		}
		return table().get(StyleRoles.qualify(block));
	}

	/**
	 * The block a main row's value is shown as: a wood as its planks (wood, accent, and a wooden roof), a stone or roof block as
	 * itself. {@code value} is the short name the rows store.
	 */
	public static String blockOf(String field, String value) {
		String v = StyleRoles.shortOf(value);
		boolean wood = "wood".equals(field) || "accent".equals(field) || "roof".equals(field) && table().containsKey("minecraft:" + v + "_planks");
		if (wood) {
			String planks = "minecraft:" + v + "_planks";
			if (table().containsKey(planks) || !table().containsKey("minecraft:" + v)) {
				return planks;
			}
		}
		return "minecraft:" + v;
	}

	/** The rail family of a main row's choice ("Overworld woods", "Deepslate & tuff", "Copper", ...). */
	public static String family(String field, String value) {
		String v = StyleRoles.shortOf(value);
		if ("wood".equals(field) || "accent".equals(field)) {
			return woodFamily(v);
		}
		if ("roof".equals(field) && table().containsKey("minecraft:" + v + "_planks")) {
			return "Wood";
		}
		return stoneFamily(v);
	}

	private static String woodFamily(String v) {
		return v.equals("crimson") || v.equals("warped") ? "Nether woods" : v.equals("bamboo") ? "Bamboo" : "Overworld woods";
	}

	/** A stone (or any non-wood block's) display family, by name; order of the checks matters (mud_bricks is brick, not mud). */
	static String stoneFamily(String v) {
		if (v.contains("copper")) {
			return "Copper";
		}
		if (v.contains("deepslate") || v.contains("tuff")) {
			return "Deepslate & tuff";
		}
		if (v.contains("blackstone") || v.contains("nether") || v.contains("basalt")) {
			return "Nether";
		}
		if (v.contains("prismarine") || v.contains("end_stone") || v.contains("purpur")) {
			return "Ocean & end";
		}
		if (v.contains("sandstone")) {
			return "Sandstone";
		}
		if (v.contains("brick") && !v.contains("stone_brick") || v.contains("terracotta") || v.contains("mud")) {
			return "Brick & clay";
		}
		if (v.contains("quartz") || v.contains("resin") || v.contains("calcite")) {
			return "Quartz & pale";
		}
		if (v.contains("andesite") || v.contains("diorite") || v.contains("granite")) {
			return "Andesite, diorite, granite";
		}
		return "Stone & cobble";
	}

	/** The family of any block (the role picker's rail): its wood, its stone family, or what it is for. */
	public static String blockFamily(String block) {
		String v = StyleRoles.shortOf(block);
		if (v.matches(".*(lantern|torch|froglight|glowstone|shroomlight|sea_lantern|redstone_lamp|end_rod)")) {
			return "Lights";
		}
		if (v.contains("glass")) {
			return "Glass";
		}
		if (v.matches("(dirt_path|gravel|coarse_dirt|packed_mud|mud|rooted_dirt|podzol|moss_block|clay|snow_block|hay_block)")) {
			return "Ground & path";
		}
		if (v.endsWith("_wool") || v.endsWith("_concrete")) {
			return "Wool & concrete";
		}
		for (String w : List.of("oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak", "bamboo", "crimson",
			"warped", "poplar")) {
			if (v.startsWith(w + "_") || v.startsWith("stripped_" + w + "_")) {
				return "Wood";
			}
		}
		return stoneFamily(v);
	}

	/** Every block the table colours (the role picker's candidates), sorted. */
	public static List<String> blocks() {
		List<String> l = new ArrayList<>(table().keySet());
		Collections.sort(l);
		return l;
	}

	/** "Spruce planks" for {@code minecraft:spruce_planks}. */
	public static String label(String block) {
		String v = StyleRoles.shortOf(block).replace('_', ' ');
		return v.isEmpty() ? v : v.substring(0, 1).toUpperCase(Locale.ROOT) + v.substring(1);
	}
}
