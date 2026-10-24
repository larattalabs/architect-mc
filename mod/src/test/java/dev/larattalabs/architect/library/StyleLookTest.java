package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.BiblePin;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Style unification U3: what the Style screens paint and list. Swatches come from the checked-in colour table (every main-row choice and
 * every built-in role has one), families group the choices, the preview sheet paints every part with one of the Style's roles (falling
 * back to the nearest role, never a fixed block), and the catalogue puts each Style on its rail with what may be done with it.
 */
class StyleLookTest {
	@Test
	void everyChoiceAndEveryBuiltInRoleHasASwatch() {
		Palettes p = Palettes.FALLBACK;
		for (String field : Palettes.FIELDS) {
			for (String v : p.choices(field)) {
				String block = Swatches.blockOf(field, v);
				// poplar is the kit's own wood (no vanilla texture): the client falls back to the game's map colour
				if (!v.equals("poplar")) {
					assertNotNull(Swatches.rgb(block), field + " " + v + " -> " + block);
				}
			}
		}
		for (String n : p.presets().keySet()) {
			p.presetRoles(n).forEach((role, block) -> assertNotNull(Swatches.rgb(block), n + "." + role + " " + block));
		}
		assertEquals("minecraft:spruce_planks", Swatches.blockOf("wood", "spruce"));
		assertEquals("minecraft:dark_oak_planks", Swatches.blockOf("roof", "dark_oak"));
		assertEquals("minecraft:deepslate_tiles", Swatches.blockOf("roof", "deepslate_tiles"));
		assertEquals("minecraft:cobblestone", Swatches.blockOf("stone", "cobblestone"));
		assertEquals(0xA85A32, Swatches.rgb("acacia_planks"));
		assertNull(Swatches.rgb("minecraft:not_a_block"));
	}

	@Test
	void familiesGroupTheChoices() {
		assertEquals("Overworld woods", Swatches.family("wood", "spruce"));
		assertEquals("Nether woods", Swatches.family("accent", "warped"));
		assertEquals("Wood", Swatches.family("roof", "dark_oak"));
		assertEquals("Deepslate & tuff", Swatches.family("roof", "deepslate_tiles"));
		assertEquals("Copper", Swatches.family("roof", "cut_copper"));
		assertEquals("Stone & cobble", Swatches.family("stone", "mossy_stone_bricks"));
		assertEquals("Brick & clay", Swatches.family("stone", "mud_bricks"));
		assertEquals("Sandstone", Swatches.family("stone", "smooth_red_sandstone"));
		assertEquals("Ocean & end", Swatches.family("roof", "prismarine_bricks"));
		assertEquals("Nether", Swatches.family("stone", "polished_blackstone_bricks"));
		assertEquals("Lights", Swatches.blockFamily("minecraft:soul_lantern"));
		assertEquals("Glass", Swatches.blockFamily("minecraft:red_stained_glass_pane"));
		assertEquals("Ground & path", Swatches.blockFamily("minecraft:dirt_path"));
		assertEquals("Wood", Swatches.blockFamily("minecraft:stripped_cherry_log"));
		assertEquals("Spruce planks", Swatches.label("minecraft:spruce_planks"));
		// every family is short enough for the rail and no choice is left without one
		for (String field : Palettes.FIELDS) {
			Set<String> fams = new java.util.HashSet<>();
			for (String v : Palettes.FALLBACK.choices(field)) {
				fams.add(Swatches.family(field, v));
			}
			assertTrue(fams.size() >= 2 && fams.size() <= 10, field + " " + fams);
		}
		assertTrue(Swatches.blocks().size() > 400);
	}

	@Test
	void theSheetPaintsEveryPartWithARoleOfTheStyle() {
		Map<String, String> rustic = Palettes.FALLBACK.presetRoles("rustic");
		List<StyleSheet.Part> parts = StyleSheet.parts(rustic);
		for (StyleSheet.Part p : parts) {
			assertTrue(rustic.containsKey(p.role()), p.toString());
			assertEquals(rustic.get(p.role()), p.block());
			assertTrue(p.x() >= 0 && p.y() >= 0 && p.x() + p.w() <= StyleSheet.W && p.y() + p.h() <= StyleSheet.H, p.toString());
		}
		Set<String> painted = new java.util.HashSet<>();
		parts.forEach(p -> painted.add(p.part()));
		assertEquals(Set.of("path", "foundation", "wall", "wall_alt", "frame", "glass", "accent", "light", "trim", "roof"), painted);
		// no ground without a surface role: the sky and ground are the UI's, not a block
		assertFalse(painted.contains("surface"));
		// a Style without trim or glass: the nearest roles it has
		Map<String, String> bare = new HashMap<>(rustic);
		bare.remove("trim");
		bare.remove("glass");
		bare.remove("wall_alt");
		assertEquals("foundation", StyleSheet.roleFor("trim", bare));
		assertEquals("wall", StyleSheet.roleFor("glass", bare));
		for (StyleSheet.Part p : StyleSheet.parts(bare)) {
			assertTrue(bare.containsKey(p.role()), p.toString());
		}
		// a settlement Style's surface is the ground
		Map<String, String> town = new HashMap<>(rustic);
		town.put("surface", "minecraft:grass_block");
		assertTrue(StyleSheet.parts(town).stream().anyMatch(p -> p.part().equals("surface") && p.block().equals("minecraft:grass_block")));
		assertTrue(StyleSheet.parts(Map.of()).isEmpty());
	}

	static Bible style(String id, boolean builtin, String origin, String owner, BiblePin basedOn, boolean archived) {
		return new Bible(id, id.toUpperCase(), 2, List.of(1, 2), builtin, "building", Palettes.FALLBACK.presetRoles("rustic"), Optional.empty(), Optional
			.empty(), List.of(), Optional.ofNullable(owner), new com.google.gson.JsonObject(), 1, Bible.Restraint.DEFAULT, archived, Optional.empty(),
			List.of("cold"), List.of("chimney", "porch"), Optional.empty(), Optional.ofNullable(basedOn), origin);
	}

	@Test
	void theCatalogueRailsAndRights() {
		Bible mine = style("bib_alpine", false, "hand", null, new BiblePin("rustic", 1), false);
		Bible claude = style("bib_ash", false, "claude", "0b6c3d1e-1111-2222-3333-444455556666", null, false);
		Bible built = style("rustic", true, "builtin", null, null, false);
		Bible town = style("bib_town", false, "claude", "steward_mc:settlement/abc", null, false);
		Bible old = style("bib_old", false, "hand", null, null, true);
		assertEquals(StyleCatalog.YOURS, StyleCatalog.rail(mine));
		assertEquals(StyleCatalog.CLAUDE, StyleCatalog.rail(claude));
		assertEquals(StyleCatalog.BUILT_IN, StyleCatalog.rail(built));
		assertEquals(StyleCatalog.SETTLEMENTS, StyleCatalog.rail(town));
		List<StyleCatalog.Card> cards = StyleCatalog.cards(List.of(mine, claude, built, town, old), Map.of("bib_alpine", 3), null, id -> id.equals("rustic")
			? "Rustic" : null);
		assertEquals(List.of("bib_alpine", "bib_ash", "rustic", "bib_town"), cards.stream().map(StyleCatalog.Card::id).toList());
		assertTrue(cards.get(0).canEdit() && cards.get(1).canEdit());
		assertFalse(cards.get(2).canEdit(), "built-in: duplicate only");
		assertFalse(cards.get(3).canEdit(), "a mod's: duplicate only");
		assertEquals(List.of("Yours · made by hand · v2", "Based on Rustic v1", "Suggests: Chimney, Porch", "Used by 3 of your designs"), cards.get(0)
			.details());
		assertTrue(cards.get(3).details().get(0).startsWith("Steward's settlement Style"));
		assertEquals("Not used by your designs yet", cards.get(2).details().get(cards.get(2).details().size() - 1));
		// the archived one stays only while it is the picked one
		assertEquals(5, StyleCatalog.cards(List.of(mine, claude, built, town, old), Map.of(), "bib_old", id -> null).size());
		// the presets fill in for a helper that sent none
		List<Bible> all = StyleCatalog.withBuiltins(List.of(mine), Palettes.FALLBACK);
		assertEquals(1 + Palettes.FALLBACK.presets().size(), all.size());
		Bible med = all.stream().filter(b -> b.id().equals("medieval")).findFirst().orElseThrow();
		assertTrue(med.builtin() && !med.editable() && med.roles().get("wall").equals("minecraft:white_terracotta") && !med.tags().isEmpty());
		assertTrue(StyleCatalog.usage(List.of()).isEmpty());
	}
}
