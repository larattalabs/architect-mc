package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (Slice FL, S-M5-17) The hold's index: a fill site's declared containers are held from its placement (no phase yet: nothing built), while
 * FILLING and FILLED, and not once UNLOCKED; a site without a fill or a removed site holds nothing. (The refusal itself is a mixin on
 * {@code HopperBlockEntity.canPlaceItemInContainer}: in game, fl-survival.)
 */
class FillHoldTest {
	@BeforeAll
	static void boot() {
		FillsFKTest.boot();
	}

	static final dev.larattalabs.architect.placement.Anchors.Bounds BOX = new dev.larattalabs.architect.placement.Anchors.Bounds(100, 64, 200, 105, 68, 203);

	static Site site(String id, String phase) {
		Site s = new Site(id, "fl_hall", "none", BOX, BOX, Map.of(), 0L, Site.OVERWORLD, BOX, Builder.JOURNAL_TARGET, null, null, null);
		if (phase == null) {
			return s;
		}
		JsonObject ext = s.ext();
		JsonObject o = new JsonObject();
		o.addProperty("phase", phase);
		ext.add(Fills.EXT_STATE, o);
		return s.withOwnership(s.owner(), ext);
	}

	@Test
	void heldFromPlacementUntilTheUnlock() {
		Fills.Spec spec = Fills.parse(FillsFKTest.entry(FillsFKBTest.HALL, true));
		Site fresh = site("a", null), filling = site("b", Fills.FILLING), filled = site("c", Fills.FILLED), open = site("d", Fills.UNLOCKED);
		Site plain = site("e", null);
		var idx = FillHold.index(List.of(fresh, filling, filled, open, plain), s -> s == plain ? null : spec);
		var set = idx.get(Site.OVERWORLD);
		// HALL declares (1,2,1) and (2,2,1): three held sites on the same box share the two cells
		assertEquals(2, set.size());
		assertTrue(set.contains(new BlockPos(101, 66, 201).asLong()));
		assertTrue(set.contains(new BlockPos(102, 66, 201).asLong()));
		assertTrue(FillHold.holds(fresh, spec), "placed, nothing built yet: held");
		assertTrue(FillHold.holds(filling, spec));
		assertTrue(FillHold.holds(filled, spec), "filled, the lock not yet released: held");
		assertFalse(FillHold.holds(open, spec), "unlocked: vanilla");
		assertFalse(FillHold.holds(plain, null), "no fill: vanilla");
		assertTrue(FillHold.index(List.of(open, plain), s -> s == plain ? null : spec).isEmpty(), "only unlocked or plain sites: an empty index");
		assertTrue(FillHold.index(List.of(), s -> spec).isEmpty(), "a removed site leaves the index");
	}

	@Test
	void theMixinGuardsTheOneInsertionGate() throws Exception {
		String mix = java.nio.file.Files.readString(java.nio.file.Path.of("src/main/resources/architect_mc.mixins.json"));
		assertTrue(mix.contains("\"HopperHoldMixin\""));
		String src = java.nio.file.Files.readString(java.nio.file.Path.of("src/main/java/dev/larattalabs/architect/mixin/HopperHoldMixin.java"));
		assertTrue(src.contains("method = \"canPlaceItemInContainer\""));
	}
}
