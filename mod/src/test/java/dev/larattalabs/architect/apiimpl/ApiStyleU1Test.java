package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.BiblePin;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.CritiqueSpec;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.GroupRequest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Style unification U1: DesignRequest.palette (materials only) on the wire and gated on the helper's palette.roles; the binary
 * compatibility Steward's review asked for (the 14-argument DesignRequest constructor it calls, every earlier canonical one, Bible's);
 * the Bible's optional Style fields.
 */
class ApiStyleU1Test {
	static final Map<String, String> ROLES = new LinkedHashMap<>();

	static {
		ROLES.put("wall", "minecraft:white_terracotta");
		ROLES.put("wall_alt", "minecraft:calcite");
		ROLES.put("trim", "minecraft:smooth_stone");
		ROLES.put("roof", "minecraft:spruce_planks");
		ROLES.put("floor", "minecraft:dark_oak_planks");
		ROLES.put("frame", "minecraft:dark_oak_log");
		ROLES.put("accent", "minecraft:spruce_planks");
		ROLES.put("light", "minecraft:lantern");
		ROLES.put("glass", "minecraft:glass_pane");
		ROLES.put("foundation", "minecraft:stone_bricks");
		ROLES.put("path", "minecraft:dirt_path");
	}

	/** Steward's call (steward-mc gateway/LotBrief.java, service/ChangeRequests.java): the 14-argument 1.1.0 constructor. */
	static DesignRequest steward() {
		return new DesignRequest("house", "rustic", null, List.of(), new BlockSize(13, 12, 13), "Lot House", null, null, "steward_mc:s1", new JsonObject(),
			null, null, null, null);
	}

	static Bible medieval() {
		return new Bible("medieval", "Medieval", 1, List.of(1), true, "building", ROLES, Optional.empty(), Optional.empty(), List.of(), Optional.empty(),
			new JsonObject(), 1, Bible.Restraint.DEFAULT, false, Optional.empty(), List.of("medieval"), List.of("chimney"), Optional.of("Daub"),
			Optional.empty(), "builtin");
	}

	@Test
	void everyEarlierConstructorStays() throws Exception {
		Class<?> s = String.class;
		Class<?> l = List.class;
		Class<?> o = JsonObject.class;
		Class<?> e = JsonElement.class;
		// the 14-argument constructor Steward calls (1.1.0)
		assertNotNull(DesignRequest.class.getConstructor(s, s, s, l, BlockSize.class, s, s, s, s, o, s, Double.class, s, s));
		// 1.2.0, 1.3.0, 1.6.0, 1.11.0, 1.37.0 (the canonical one before U1)
		assertNotNull(DesignRequest.class.getConstructor(s, s, s, l, BlockSize.class, s, s, s, s, o, s, Double.class, s, s, l, Integer.class));
		assertNotNull(DesignRequest.class.getConstructor(s, s, s, l, BlockSize.class, s, s, s, s, o, s, Double.class, s, s, l, Integer.class, boolean.class, s,
			Integer.class, e));
		assertNotNull(DesignRequest.class.getConstructor(s, s, s, l, BlockSize.class, s, s, s, s, o, s, Double.class, s, s, l, Integer.class, boolean.class, s,
			Integer.class, e, CritiqueSpec.class));
		assertNotNull(DesignRequest.class.getConstructor(s, s, s, l, BlockSize.class, s, s, s, s, o, s, Double.class, s, s, l, Integer.class, boolean.class, s,
			Integer.class, e, CritiqueSpec.class, s, s));
		assertNotNull(DesignRequest.class.getConstructor(s, s, s, l, BlockSize.class, s, s, s, s, o, s, Double.class, s, s, l, Integer.class, boolean.class, s,
			Integer.class, e, CritiqueSpec.class, s, s, DesignRequest.Reserved.class));
		// Bible: 1.2.0's 12 arguments and 1.6.0's 16 (the canonical one before U1)
		Class<?> op = Optional.class;
		assertNotNull(Bible.class.getConstructor(s, s, int.class, l, boolean.class, s, Map.class, op, op, l, op, o));
		assertNotNull(Bible.class.getConstructor(s, s, int.class, l, boolean.class, s, Map.class, op, op, l, op, o, int.class, Bible.Restraint.class,
			boolean.class, op));
		// the old ones carry no palette, and no Style fields
		assertNull(steward().palette());
		Bible old = new Bible("bib_x", "X", 2, List.of(1, 2), false, "building", ROLES, Optional.empty(), Optional.empty(), List.of(), Optional.empty(),
			new JsonObject());
		assertEquals("claude", old.origin());
		assertEquals(List.of(), old.tags());
		assertTrue(old.editable());
		assertFalse(medieval().editable());
	}

	@Test
	void withStyleIsMaterialsOnlyAndEveryWitherKeepsIt() {
		DesignRequest r = steward().withStyle(medieval());
		JsonObject p = r.palette().getAsJsonObject().getAsJsonObject("bible");
		assertEquals("medieval", p.get("id").getAsString());
		assertEquals(1, p.get("version").getAsInt());
		assertEquals("minecraft:white_terracotta", p.getAsJsonObject("roles").get("wall").getAsString());
		assertNull(r.bible(), "materials only: no bible set mode");
		for (DesignRequest c : List.of(r.withProfile(List.of("door")), r.withContext("a site"), r.critique(null), r.withReserved(null), r.versionOf("e", null),
			r.fromMassing("mas_x"), r.withBible(null, null))) {
			assertEquals(r.palette(), c.palette());
		}
		assertNull(r.withPalette(null).palette());
		assertEquals(new JsonPrimitive("rustic"), steward().withPalette(new JsonPrimitive("rustic")).palette());
	}

	@Test
	void theWireSendsThePaletteOnlyToAHelperWithPaletteRoles() {
		DesignRequest r = steward().withStyle(medieval());
		JsonObject w = DesignsImpl.wire(r, 2);
		assertEquals(r.palette(), w.get("palette"));
		assertFalse(DesignsImpl.wire(steward(), 2).has("palette"), "a request without a palette is sent exactly as before");
		assertFalse(DesignsImpl.wire(r, 1).has("palette"));
		Set<String> u1 = Set.of("bibles", "massing", "palette.roles");
		assertNull(DesignsImpl.refusalPalette(r, 2, u1));
		assertNull(DesignsImpl.refusalPalette(steward(), 2, Set.of()));
		assertTrue(DesignsImpl.refusalPalette(r, 2, Set.of("bibles")).contains("palette.roles"), "an older helper would drop it silently");
		assertTrue(DesignsImpl.refusalPalette(r, 1, u1).contains("palette.roles"));
		assertTrue(DesignsImpl.refusalPalette(r.withBible("bib_x", null), 2, u1).contains("not both"));
		assertTrue(DesignsImpl.refusalPalette(r.massing(true), 2, u1).contains("massing"));
		// a group's items take the group's bible: a palette never rides along
		GroupRequest.Item it = new GroupRequest.Item("a", r, GroupRequest.Role.ORDINARY, null, false, null);
		GroupRequest g = new GroupRequest("Set", "bib_x", null, null, new JsonObject(), null, null, List.of(it), false, null, null, null, null, null);
		JsonObject gw = Wire4b.group(g);
		assertFalse(gw.getAsJsonArray("items").get(0).getAsJsonObject().has("palette"));
	}

	@Test
	void bibleInfoReadsTheStyleFields() {
		JsonObject o = JsonParser.parseString("{\"id\":\"bib_alpine\",\"name\":\"Alpine\",\"version\":2,\"versions\":[1,2],\"builtin\":false,"
			+ "\"scope\":\"building\",\"roles\":{\"wall\":\"minecraft:spruce_planks\"},\"components\":[],\"tags\":[\"cold\"],"
			+ "\"suggestedFeatures\":[\"chimney\",\"porch\"],\"blurb\":\"Steep\",\"basedOn\":{\"id\":\"rustic\",\"version\":1},\"origin\":\"hand\"}")
			.getAsJsonObject();
		Bible b = Wire4b.bibleInfo(o);
		assertEquals(List.of("cold"), b.tags());
		assertEquals(List.of("chimney", "porch"), b.suggestedFeatures());
		assertEquals(Optional.of("Steep"), b.blurb());
		assertEquals(Optional.of(new BiblePin("rustic", 1)), b.basedOn());
		assertEquals("hand", b.origin());
		// a bible from before U1: no fields, a bible job's
		o.remove("origin");
		o.remove("tags");
		Bible old = Wire4b.bibleInfo(o);
		assertEquals("claude", old.origin());
		assertEquals(List.of(), old.tags());
		o.addProperty("builtin", true);
		assertEquals("builtin", Wire4b.bibleInfo(o).origin());
	}

	/** Steward's RC: no owner or a player UUID is the player's (editable); any other owner is a mod's (Duplicate-only). */
	@Test
	void ownership() {
		assertFalse(Bible.isModOwner(null));
		assertFalse(Bible.isModOwner("45ec2bed-0a65-3047-9f6e-8e67d21b1b92"));
		assertTrue(Bible.isModOwner("steward_mc:settlement/abc"));
		assertTrue(Bible.isModOwner("othermod:thing"));
		for (String o : new String[] {null, "45ec2bed-0a65-3047-9f6e-8e67d21b1b92", "steward_mc:settlement/abc", "othermod:thing"}) {
			Bible b = new Bible("bib_x", "X", 1, List.of(1), false, "building", ROLES, Optional.empty(), Optional.empty(), List.of(), Optional.ofNullable(o),
				new JsonObject());
			boolean player = o == null || o.contains("-") && !o.contains(":");
			assertEquals(player, b.editable(), String.valueOf(o));
			assertEquals(!player, b.modOwned(), String.valueOf(o));
		}
	}
}
