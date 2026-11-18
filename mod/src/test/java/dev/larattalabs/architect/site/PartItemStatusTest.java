package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.BuildStatus;
import dev.larattalabs.architect.batch.QItem;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (8b review P2) A part's status counts its region items not yet put down: a lot item waiting on terrain makes its part wait on terrain; a
 * road item's stage wait, a tile's (two parts); a part only a queued item names appears (planned), never missing.
 */
class PartItemStatusTest {
	private static QItem item(String key, String ext, QItem.Status st, String reason) {
		QItem i = new QItem(key, "s", List.of(), "bp", "minecraft:overworld", 0, 0, 0, 0, false, JsonParser.parseString(ext).getAsJsonObject(), null, true, true);
		i.status = st;
		i.reason = reason;
		return i;
	}

	@Test
	void itemsCountInTheirParts() {
		QItem lot = item("lot:cottage_1", "{\"architect_mc:lot\":\"cottage_1\",\"architect_mc:waitsFor\":{\"target\":\"t\",\"part\":\"relief_1\",\"kind\":\"terrain\"}}",
			QItem.Status.WAITING, "SITE_BUSY");
		QItem road = item("road:street_1", "{\"architect_mc:part\":\"street_1\",\"architect_mc:waitsFor\":{\"target\":\"lot:gate\",\"part\":\"wall\"}}", QItem.Status.WAITING,
			"SITE_BUSY");
		QItem tile = item("tile:a", "{\"architect_mc:parts\":[\"plaza\",\"verges\"]}", QItem.Status.QUEUED, null);
		Map<String, BuildStatus> m = RegionTargets.itemStatuses(List.of(lot, road, tile), Map.of("cottage_1", "village"));
		assertEquals(BuildStatus.TERRAIN, m.get("village").reason(), "the lot's part waits on its terrain");
		assertEquals("relief_1", m.get("village").waitsOn());
		assertEquals(BuildStatus.STAGE, m.get("street_1").reason());
		assertEquals(BuildStatus.PLANNED, m.get("plaza").state(), "a part only a queued item names appears");
		assertEquals(BuildStatus.PLANNED, m.get("verges").state());
	}

	@Test
	void theWinnerOfAPartsItems() {
		QItem a = item("tile:a", "{\"architect_mc:part\":\"p\"}", QItem.Status.QUEUED, null);
		QItem b = item("tile:b", "{\"architect_mc:part\":\"p\",\"architect_mc:waitsFor\":{\"kind\":\"bill_cap\",\"missing\":{}}}", QItem.Status.WAITING, "SITE_BUSY");
		assertEquals(BuildStatus.BILL_CAP, RegionTargets.itemStatuses(List.of(a, b), Map.of()).get("p").reason());
		JsonObject none = new JsonObject();
		assertEquals(0, RegionTargets.itemStatuses(List.of(item("x", none.toString(), QItem.Status.QUEUED, null)), Map.of()).size(), "an item naming no part");
	}
}
