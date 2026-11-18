package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonObject;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (8b final check P2) A keyed check refused on ungenerated land is forgotten: the key no longer answers with the frozen check (so the
 * retry after the area is generated checks afresh), and its stored record loses the key (a restart does not bring it back). Other keys stay.
 */
class ForgetKeyedCheckTest {
	@Test
	void theRefusedKeyIsForgotten(@TempDir Path world) throws Exception {
		Path dir = PlanChecks.checks(world);
		Files.createDirectories(dir);
		JsonObject rec = new JsonObject();
		rec.addProperty("checkId", "ck1");
		rec.addProperty("opKey", "steward.cx.1");
		rec.addProperty("opHash", "h1");
		rec.addProperty("owner", "steward_mc:settlement/1");
		RegionStore.writeJson(dir.resolve("ck1.json"), rec);
		PlanChecks.testKeyed("steward_mc:settlement/1", "steward.cx.1", "h1", "ck1");
		PlanChecks.testKeyed("steward_mc:settlement/1", "steward.cx.2", "h2", "ck2");
		assertEquals("ck1", PlanChecks.testKeyedCheck("steward_mc:settlement/1", "steward.cx.1"));
		PlanChecks.forgetKeyedAt(world, "steward_mc:settlement/1", "steward.cx.1");
		assertNull(PlanChecks.testKeyedCheck("steward_mc:settlement/1", "steward.cx.1"), "the retry is not answered by the frozen check");
		JsonObject back = RegionStore.readJson(dir.resolve("ck1.json"));
		assertFalse(back.has("opKey") || back.has("opHash"), "a restart does not register it again");
		assertEquals("ck1", back.get("checkId").getAsString(), "the check record itself stays (its artifact may be pinned)");
		assertEquals("ck2", PlanChecks.testKeyedCheck("steward_mc:settlement/1", "steward.cx.2"), "other keys stay");
	}
}
