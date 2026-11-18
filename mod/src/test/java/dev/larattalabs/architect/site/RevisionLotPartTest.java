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
 * (8b review P2) A revision-added lot maps to its part through the revision's own IR: its waiting item (it carries its lot, no part) counts
 * in that part, so the part never reads built while the lot still waits.
 */
class RevisionLotPartTest {
	private static JsonObject j(String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	@Test
	void aRevisionLotCountsInItsPart() {
		JsonObject base = j("{\"lots\":[{\"id\":\"cottage_1\",\"part\":\"v_pads\"}],\"survival\":{\"groups\":[\"village\"],\"parts\":{\"v_pads\":0}}}");
		JsonObject rev = j("{\"lots\":[{\"id\":\"cottage_9\",\"part\":\"g_pads\",\"rid\":1}],\"survival\":{\"groups\":[\"growth\"],\"parts\":{\"g_pads\":0}}}");
		Map<String, String> lp = RegionTargets.lotParts(List.of(base, rev));
		assertEquals("village", lp.get("cottage_1"));
		assertEquals("growth", lp.get("cottage_9"), "the revision's lot, under the revision IR's own group");
		QItem i = new QItem("lot:cottage_9", "rv1", List.of(), "bp", "minecraft:overworld", 0, 0, 0, 0, false, j("{\"architect_mc:lot\":\"cottage_9\","
			+ "\"architect_mc:waitsFor\":{\"target\":\"t\",\"part\":\"relief\",\"kind\":\"terrain\"}}"), null, true, true);
		i.status = QItem.Status.WAITING;
		i.reason = "SITE_BUSY";
		assertEquals(BuildStatus.TERRAIN, RegionTargets.itemStatuses(List.of(i), lp).get("growth").reason());
	}
}
