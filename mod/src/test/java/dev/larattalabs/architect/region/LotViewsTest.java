package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.BuildStatus;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** (8b BS) Lot boxes from the IR (pads too) and a lot's status without a site: pad planned, removed, failed, a removing region. */
class LotViewsTest {
	@Test
	void boxes() {
		var b = LotViews.boxesOf(JsonParser.parseString("{\"lots\":[{\"id\":\"a\",\"box\":{\"minX\":1,\"minY\":2,\"minZ\":3,\"maxX\":4,\"maxY\":5,\"maxZ\":6}},"
			+ "{\"id\":\"bad\",\"box\":{}}]}").getAsJsonObject());
		assertEquals(1, b.size());
		assertEquals(4, b.get("a").maxX());
	}

	@Test
	void statusWithoutASite() {
		RegionRec.Lot pad = new RegionRec.Lot();
		assertEquals(BuildStatus.PLANNED, LotViews.status("a", pad, 0, false, Map.of(), null).state());
		assertEquals(BuildStatus.REMOVING, LotViews.status("a", pad, 0, true, Map.of(), null).state());
		RegionRec.Lot gone = new RegionRec.Lot();
		gone.state = "removed";
		assertEquals(BuildStatus.REMOVED, LotViews.status("a", gone, 1, false, Map.of(), null).state());
		RegionRec.Lot q = new RegionRec.Lot();
		q.state = "queued";
		assertEquals(BuildStatus.PLANNED, LotViews.status("a", q, 0, false, Map.of(), null).state(), "queued, its item not found: planned");
	}
}
