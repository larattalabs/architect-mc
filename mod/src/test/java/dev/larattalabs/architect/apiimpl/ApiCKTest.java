package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ConnectorCheck;
import dev.larattalabs.architect.api.ConnectorRequest;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.Quote;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Sites;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (8b CK) Sites.checkConnector: the implementation overrides the stub; the feature follows placeConnector's; the survival quote is held
 * against maxBill as the realise's put-down holds it (the same over-cap test), a lot cap refused (a connector has no lots); within the cap it
 * fits with its quote.
 */
class ApiCKTest {
	private static final BlockPos A = new BlockPos(0, 70, 0), B = new BlockPos(0, 60, 9);
	private static final BoundingBox C = new BoundingBox(-16, -64, -16, 16, 319, 25);

	@BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	private static Quote quote(int planks) {
		JsonObject bom = new JsonObject();
		bom.addProperty("minecraft:oak_planks", planks);
		return new Quote("p", "sha", null, true, bom, new JsonObject(), Map.of(), true, List.of());
	}

	private static ConnectorRequest req() {
		return new ConnectorRequest("rope_bridge", A, B, null, null, Mode.AUTO, "ck.test");
	}

	@Test
	void theStubAndTheFeature() throws Exception {
		assertEquals(SitesImpl.class, SitesImpl.class.getMethod("checkConnector", ConnectorRequest.class).getDeclaringClass());
		assertTrue(Sites.class.getMethod("checkConnector", ConnectorRequest.class).isDefault());
		assertTrue(ApiRules.features(2, List.of("job.run", "region.plan", "region.planCheck")).contains("connectorCheck"));
		assertFalse(ApiRules.features(1, List.of()).contains("connectorCheck"));
	}

	@Test
	void theCapIsTheRealisesCap() {
		ConnectorCheck none = ConnectorPlace.capped(quote(12), req(), C, List.of(A, B), "fits");
		assertTrue(none.fits());
		assertNull(none.refusal());
		assertEquals(12, none.quote().bom().get("minecraft:oak_planks").getAsInt());
		assertTrue(ConnectorPlace.capped(quote(12), req().withMaxBill(Map.of("minecraft:oak_planks", 12), null), C, List.of(A, B), "fits").fits(), "at the cap");
		ConnectorCheck over = ConnectorPlace.capped(quote(12), req().withMaxBill(Map.of("minecraft:oak_planks", 11), null), C, List.of(A, B), "fits");
		assertFalse(over.fits());
		assertEquals(Reason.BILL_CAP, over.refusal().reason());
		assertTrue(over.refusal().message().contains("oak_planks 12 > 11"), over.refusal().message());
		assertEquals(dev.larattalabs.architect.region.Quotes.overCapOf(quote(12).bom(), Map.of("minecraft:oak_planks", 11)), List.of("oak_planks 12 > 11"),
			"the same over-cap test as the realise's put-down");
		ConnectorCheck lot = ConnectorPlace.capped(quote(12), req().withMaxBill(null, Map.of("lot1", Map.of())), C, List.of(A, B), "fits");
		assertFalse(lot.fits());
		assertEquals(Reason.BILL_CAP, lot.refusal().reason());
	}
}
