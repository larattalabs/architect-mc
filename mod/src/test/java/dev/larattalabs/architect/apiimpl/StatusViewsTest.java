package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.BuildStatus;
import java.util.List;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (8b BS, S-8b-8) The typed homes of the ext keys Steward reads, and a batch item's status from its typed wait: no text parsing, every
 * {@code waitsOn} a typed id.
 */
class StatusViewsTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	private static JsonObject j(String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	@Test
	void extKeys() {
		JsonObject ext = j("{\"architect_mc:part\":\"street_1\",\"architect_mc:lot\":\"cottage_2\",\"architect_mc:revision\":{\"rid\":3},\"architect_mc:region\":\"rg4\"}");
		assertEquals("street_1", StatusViews.part(ext));
		assertEquals("cottage_2", StatusViews.str(ext, StatusViews.EXT_LOT));
		assertEquals(3, StatusViews.rid(ext));
		assertEquals(0, StatusViews.rid(new JsonObject()));
		assertEquals("wall_a", StatusViews.part(j("{\"architect_mc:waitsFor\":{\"part\":\"wall_a\"}}")), "the wait's part when the ext has none");
	}

	@Test
	void anItemsTypedWait() {
		BuildStatus t = StatusViews.item("lot:a", "WAITING", "SITE_BUSY", null, j("{\"architect_mc:waitsFor\":{\"target\":\"x1\",\"part\":\"relief_1\",\"kind\":\"terrain\","
			+ "\"say\":\"the plaza waits for the land\"}}"));
		assertEquals(List.of(BuildStatus.WAITING, BuildStatus.TERRAIN, "relief_1"), List.of(t.state(), t.reason(), t.waitsOn()));
		BuildStatus st = StatusViews.item("road:r2", "WAITING", "SITE_BUSY", null, j("{\"architect_mc:waitsFor\":{\"target\":\"lot:gate\",\"part\":\"wall\","
			+ "\"waiter\":\"street\",\"say\":\"the street waits for the town wall to be built\"}}"));
		assertEquals(List.of(BuildStatus.STAGE, "lot:gate"), List.of(st.reason(), st.waitsOn()), "the target it waits for, never the say");
		BuildStatus cap = StatusViews.item("mech:gate", "WAITING", "BILL_CAP", null, j("{\"architect_mc:revision\":{\"rid\":2},\"architect_mc:waitsFor\":{\"kind\":\"bill_cap\","
			+ "\"missing\":{\"minecraft:iron_ingot\":4},\"say\":\"Main gatehouse's portcullis waits bill_cap\"}}"));
		assertEquals(List.of(BuildStatus.BILL_CAP, "mech:gate", 2, 1), List.of(cap.reason(), cap.waitsOn(), cap.revision(), cap.needs().size()));
		assertEquals(4, cap.needs().get(0).count(), "the over-cap items in needs");
		BuildStatus bill = StatusViews.item("mech:gate", "WAITING", "SITE_BUSY", null, j("{\"architect_mc:waitsFor\":{\"kind\":\"bill\",\"missing\":{\"minecraft:stone\":9}}}"));
		assertEquals(BuildStatus.MATERIALS, bill.reason());
		assertEquals(BuildStatus.PLAYER_IN_BOX, StatusViews.item("lot:a", "WAITING", "PLAYER_IN_BOX", null, new JsonObject()).reason());
		assertEquals(BuildStatus.OCCUPIED, StatusViews.item("lot:a", "WAITING", "OCCUPIED", null, new JsonObject()).reason());
		assertEquals(BuildStatus.NOT_LOADED, StatusViews.item("lot:a", "WAITING", "NOT_LOADED", null, new JsonObject()).reason());
		assertEquals(BuildStatus.PLANNED, StatusViews.item("lot:a", "QUEUED", null, null, null).state());
		assertEquals(BuildStatus.BUILT, StatusViews.item("lot:a", "PLACED", null, "s9", null).state());
		assertEquals("failed:NO_ROOM", StatusViews.item("lot:a", "FAILED", "NO_ROOM", null, null).reason());
	}

	@Test
	void besideAndLand() {
		var b = StatusViews.beside(j("{\"architect_mc:beside\":{\"region\":\"rg1\",\"dangling\":true,\"gateRemoved\":\"rg7\"}}"));
		assertEquals(new dev.larattalabs.architect.api.BesideNote("rg1", true, "rg7"), b);
		assertNull(StatusViews.beside(new JsonObject()));
		var l = StatusViews.land(j("{\"architect_mc:land\":{\"v\":2,\"standingRemoved\":null,\"outside\":{\"runs\":[[5,1,2,1],[9,2,3,7]]},\"inside\":{\"runs\":[]}}}"));
		assertEquals(2, l.version());
		assertEquals(List.of(new dev.larattalabs.architect.api.RegionLand.Run(1, 2, 5)), l.outside(), "a run [x0,z,x1,z], ordered; a malformed one left out");
		assertNull(l.standingRemoved());
		assertNull(StatusViews.land(new JsonObject()));
	}
}
