package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.region.IrStale;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * API 1.38.0 (placeholder; docs/CONTRACT.md "Phase 6c slice IRR" §7, S-IRR-2): the features {@code "farmIrrigation"} (an IRR helper's
 * {@code region.irrigation}) and {@code "designReserved"} (its {@code reserved}); {@link DesignRequest#reserved}, a typed nullable trailing
 * component with the 1.11.0 constructor kept, sent only when set and only to a helper that keeps it; its field limits; the versions.
 */
class ApiIrrTest {
	private static DesignRequest base() {
		return new DesignRequest("barn", "rustic", null, List.of(), new BlockSize(13, 12, 11), null, null, null, null, new JsonObject(), null, null, null,
			null, List.of(), null, false, null, null, null, null, null, null);
	}

	@Test
	void versionsAndFeatures() {
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.38.0") >= 0, ArchitectApi.VERSION);
		assertTrue(IrStale.semverCompare(IrStale.KIT_VERSION, "0.39.0") >= 0, IrStale.KIT_VERSION);
		Set<String> f = ApiRules.features(2, List.of("region.fluids", "region.irrigation", "reserved"));
		assertTrue(f.contains("farmIrrigation") && f.contains("designReserved") && f.contains("regionFluids"));
		assertFalse(ApiRules.features(2, List.of("region.fluids")).contains("farmIrrigation"), "an H helper has no irrigation");
	}

	@Test
	void reservedIsATrailingNullableComponent() {
		DesignRequest r = base();
		assertNull(r.reserved(), "the 1.11.0 constructor: no reserved");
		var res = new DesignRequest.Reserved("east", 11, 13, List.of(new BlockPos(3, 0, 4), new BlockPos(3, -1, 4)));
		DesignRequest w = r.withReserved(res);
		assertEquals(res, w.reserved());
		assertEquals(res, w.withProfile(List.of("door")).withBible("b", 1).withContext("ctx").critique(null).versionOf("e", null).reserved(), "every copy keeps it");
		assertNull(w.withReserved(null).reserved());
		JsonObject o = res.wire();
		assertEquals("east", o.get("front").getAsString());
		assertEquals("[11,13]", o.get("size").toString());
		assertEquals("[[3,0,4],[3,-1,4]]", o.get("cells").toString());
	}

	@Test
	void sentOnlyWhenSetAndOnlyToAHelperThatKeepsIt() {
		DesignRequest w = base().withReserved(new DesignRequest.Reserved("south", 9, 8, List.of(new BlockPos(4, 0, 4))));
		assertFalse(DesignsImpl.wire(base(), 2).has("reserved"), "a request without reserved is sent as before");
		assertTrue(DesignsImpl.wire(w, 2).has("reserved"));
		assertFalse(DesignsImpl.wire(w, 1).has("reserved"), "protocol 1 drops it with the other v2 fields");
		assertNotNull(DesignsImpl.refusalReserved(w, 2, Set.of("massing")), "a helper before IRR would ignore the cells: refused");
		assertNull(DesignsImpl.refusalReserved(w, 2, Set.of("reserved")));
		assertNull(DesignsImpl.refusalReserved(base(), 1, Set.of()));
	}

	@Test
	void fieldLimits() {
		assertNull(FieldLimits.design("", base().withReserved(new DesignRequest.Reserved("west", 9, 8, List.of()))));
		assertTrue(String.valueOf(FieldLimits.design("", base().withReserved(new DesignRequest.Reserved("up", 9, 8, List.of())))).contains("reserved.front"));
		assertTrue(String.valueOf(FieldLimits.design("", base().withReserved(new DesignRequest.Reserved("north", 0, 8, List.of())))).contains("reserved"));
	}
}
