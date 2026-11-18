package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ApprovedRealise;
import dev.larattalabs.architect.api.ConnectorRequest;
import dev.larattalabs.architect.api.Mode;
import java.util.Map;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (8b, Steward's HARD ask) A survival connector is capped exactly as a realise is: {@link ConnectorRequest#maxBill},
 * {@link ConnectorRequest#maxBillPerLot} and {@link ConnectorRequest#ext} reach the {@link ApprovedRealise} that {@code placeConnector}
 * realises, so {@code Quotes.capRefusal} (put-down) and {@code BillCaps} (later draws) see them. Failing first: on main the realise was
 * built with no cap and an empty ext, so a survival connector skipped the caller's approved bound.
 */
class ApiCXCapTest {
	private static final BlockPos A = new BlockPos(0, 70, 0), B = new BlockPos(0, 60, 9);

	@Test
	void aSurvivalConnectorCarriesItsCapsAndExtIntoTheRealise() {
		JsonObject ext = new JsonObject();
		ext.addProperty("steward_mc:op", "op-7");
		ConnectorRequest r = new ConnectorRequest("rope_bridge", A, B, null, new JsonObject(), Mode.AUTO, "cx.cap").withMaxBill(Map.of("minecraft:oak_planks", 12),
			Map.of("lot1", Map.of("minecraft:rope", 1))).withExt(ext);
		ApprovedRealise ar = ConnectorPlace.approvedOf(r, "sha", Mode.CONSTRUCTION, null);
		assertEquals(Map.of("minecraft:oak_planks", 12), ar.maxBill(), "the caller's approved bound reaches the realise (on main: null, the cap skipped)");
		assertEquals(Map.of("lot1", Map.of("minecraft:rope", 1)), ar.maxBillPerLot(), "the lot caps too (a connector has none: the realise refuses unknown_lot)");
		assertEquals("op-7", ar.ext().get("steward_mc:op").getAsString(), "the caller's ext is kept on the region");
		assertEquals("cx.cap", ar.opKey());
		assertEquals(Mode.CONSTRUCTION, ar.mode());
	}

	@Test
	void noCapStaysNoCap() {
		ApprovedRealise ar = ConnectorPlace.approvedOf(new ConnectorRequest("ladder", A, B, null, null, Mode.AUTO, "cx.none"), "sha", Mode.INSTANT, null);
		assertNull(ar.maxBill());
		assertNull(ar.maxBillPerLot());
		assertTrue(ar.ext().entrySet().isEmpty());
	}

	@Test
	void theRequestNormalisesItsCapsAsARealiseDoes() {
		ConnectorRequest r = new ConnectorRequest("ladder", A, B, null, null, Mode.AUTO, "cx.n");
		assertThrows(IllegalArgumentException.class, () -> r.withMaxBill(Map.of("minecraft:stone", -1), null));
		assertEquals(java.util.List.of("a", "b"), java.util.List.copyOf(r.withMaxBill(Map.of("b", 1, "a", 2), null).maxBill().keySet()), "sorted by item id");
		assertTrue(r.ext().entrySet().isEmpty());
		assertNull(r.owner());
		assertNull(r.dimension());
		assertNull(r.actor());
	}
}
