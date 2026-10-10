package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The unchanged 1.8.0 apitest jar turns a RegionPlan into JSON with a plain Gson ({@code rplan}); 1.9.0 plans carry previews
 * by default, so the record must stay serializable by reflection.
 */
class GsonPlanTest {
	@Test
	void planWithPreviewsSerializes() {
		RegionPreviews pv = new RegionPreviews(Map.of(PreviewView.TOP, List.of(Path.of("/tmp/p/top.png"))), new JsonObject());
		RegionPlan p = new RegionPlan("p", "x", "", "", "", 0, List.of(), List.of(), Map.of(), new RegionBudget(0, 0, 0, 0, 0, 0), List.of(),
			new CheckReport(true, 0, 0, List.of(new CheckReport.Finding("M5", "warning", null, null, 1, List.of(new net.minecraft.core.BlockPos(1, 2, 3)),
				"dark"))), pv, 2);
		String s = assertDoesNotThrow(() -> new Gson().toJson(p));
		com.google.gson.JsonObject o = com.google.gson.JsonParser.parseString(s).getAsJsonObject();
		org.junit.jupiter.api.Assertions.assertEquals("/tmp/p/top.png", o.getAsJsonObject("previews").getAsJsonObject("images").getAsJsonArray("top").get(0)
			.getAsString());
		org.junit.jupiter.api.Assertions.assertEquals(pv, new Gson().fromJson(o.get("previews"), RegionPreviews.class), "round trip");
	}
}
