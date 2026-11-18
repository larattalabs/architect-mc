package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * (PR P1) Preview on ghost's swap, on 3 bundled designs x 4 Styles: wood blocks become the target wood in the same part, stairs stay
 * stairs and slabs slabs, blocks with no role are kept, and the swap is deterministic.
 */
class StyleSwapTest {
	static final StyleRoles T = StyleRoles.fallback();
	static final List<Palettes.Inputs> STYLES = List.of(new Palettes.Inputs("birch", "stone_bricks", "deepslate_tiles", "birch"),
		new Palettes.Inputs("dark_oak", "andesite", "dark_oak", "oak"), new Palettes.Inputs("oak", "cobblestone", "spruce", "oak"),
		new Palettes.Inputs("mangrove", "mud_bricks", "mangrove", "mangrove"));

	/** A stand-in registry: every block the Style table knows (its woods, stones and their shapes). */
	static boolean exists(String b) {
		Set<String> all = REG;
		return all.contains(b);
	}

	static final Set<String> REG = new HashSet<>();

	static {
		REG.addAll(T.woodBlocks());
		REG.addAll(T.stoneBlocks());
		for (String s : List.copyOf(REG)) {
			REG.addAll(T.variantsOf(s));
		}
		REG.addAll(List.of("minecraft:deepslate_tiles", "minecraft:deepslate_tile_stairs", "minecraft:deepslate_tile_slab"));
	}

	static Map<String, Integer> materials(String id) throws Exception {
		var o = JsonParser.parseString(Files.readString(Path.of("../kit/examples/" + id + "/" + id + ".blueprint.json"))).getAsJsonObject();
		Map<String, Integer> m = new LinkedHashMap<>();
		o.getAsJsonArray("materials").forEach(e -> m.put(e.getAsString(), 1));
		return m;
	}

	@Test
	void threeDesignsTimesFourStyles() throws Exception {
		for (String id : List.of("cabin", "tavern", "tower")) {
			Map<String, Integer> mats = materials(id);
			Palettes.Inputs from = StyleSwap.inferMain(T, mats);
			for (Palettes.Inputs to : STYLES) {
				StyleSwap s = new StyleSwap(T, from, to, StyleSwapTest::exists);
				int changed = 0;
				for (String b : mats.keySet()) {
					String r = s.swap(b);
					assertEquals(r, new StyleSwap(T, from, to, StyleSwapTest::exists).swap(b), "deterministic");
					for (String shape : List.of("_stairs", "_slab", "_door", "_fence", "_trapdoor")) {
						if (b.endsWith(shape)) {
							assertTrue(r.endsWith(shape), id + ": " + b + " -> " + r + " keeps its shape");
						}
					}
					if (from.wood() != null && from.wood().equals(T.woodOfBlock(b)) && !from.wood().equals(to.wood()) && !r.equals(b)) {
						assertEquals(to.wood(), T.woodOfBlock(r), id + ": " + b + " -> " + r);
					}
					if (!r.equals(StyleRoles.qualify(b))) {
						changed++;
					}
				}
				assertTrue(changed > 0, id + " in " + to + ": nothing changed");
				for (String kept : List.of("minecraft:glass_pane", "minecraft:lantern", "minecraft:chest", "minecraft:red_bed")) {
					if (mats.containsKey(kept)) {
						assertEquals(kept, s.swap(kept), "no role: kept");
					}
				}
			}
		}
	}

	@Test
	void theCabinsMainRowsAreInferred() throws Exception {
		Palettes.Inputs m = StyleSwap.inferMain(T, Map.of("minecraft:spruce_log", 40, "minecraft:spruce_planks", 60, "minecraft:dark_oak_stairs", 30,
			"minecraft:cobblestone", 20, "minecraft:glass_pane", 8));
		assertEquals("spruce", m.wood());
		assertEquals("dark_oak", m.roof());
		assertEquals("cobblestone", m.stone());
		StyleSwap s = new StyleSwap(T, m, STYLES.get(0), StyleSwapTest::exists);
		assertEquals("minecraft:birch_planks", s.swap("minecraft:spruce_planks"));
		assertEquals("minecraft:birch_log", s.swap("minecraft:spruce_log"));
		assertEquals("minecraft:stone_bricks", s.swap("minecraft:cobblestone"));
		assertEquals("minecraft:deepslate_tile_stairs", s.swap("minecraft:dark_oak_stairs"), "a wood roof onto a stone roof, as stairs");
		assertNotEquals("minecraft:glass_pane", s.swap("minecraft:spruce_planks"));
		assertEquals("minecraft:glass_pane", s.swap("minecraft:glass_pane"));
	}
}
