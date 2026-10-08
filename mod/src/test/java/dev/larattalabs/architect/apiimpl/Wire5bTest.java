package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Polish;
import dev.larattalabs.architect.api.PolishApply;
import dev.larattalabs.architect.api.PolishRequest;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The phase 5b wire: design.polish's spec, a polish design's record, the polish estimate. */
class Wire5bTest {
	@Test
	void polishMessageCarriesTheSpec() {
		PolishRequest r = new PolishRequest("inn", 2, List.of(0, 3), null, "make the porch less cluttered", 3, "claude-sonnet-5-5", 1.5, "steward_mc:x",
			new JsonObject(), new PolishApply(List.of(), false));
		JsonObject m = Wire5b.polishMessage(r);
		assertEquals("design.polish", m.get("type").getAsString());
		assertEquals("inn", m.get("entryId").getAsString());
		JsonObject s = m.getAsJsonObject("spec");
		assertEquals(2, s.get("fromVersion").getAsInt());
		assertEquals(3, s.get("maxSteps").getAsInt());
		assertEquals("[0,3]", s.getAsJsonObject("target").get("issues").toString());
		assertEquals("make the porch less cluttered", s.getAsJsonObject("target").get("notes").getAsString());
		assertEquals("all", s.getAsJsonObject("apply").get("sites").getAsString());
		assertEquals(false, s.getAsJsonObject("apply").get("preview").getAsBoolean());
		assertEquals("steward_mc:x", m.get("owner").getAsString());
		assertEquals(2, new PolishRequest("inn").maxSteps());
		assertThrows(IllegalArgumentException.class, () -> Wire5b.polishMessage(new PolishRequest("inn", null, null, null, "x".repeat(501), 2, null, null,
			null, new JsonObject(), null)));
	}

	@Test
	void polishRecordParses() {
		JsonObject p = JsonParser.parseString("""
			{"entryId":"inn","fromVersion":1,"installedVersion":2,"end":"polished","steps":[
			 {"n":1,"target":{"priority":"P1","part":"roof","view":"iso","what":"flat","fix":"pitch it"},"allowedParts":["roof"],"accepted":true,
			  "overall":6.5,"changedCells":120,"cost":{"usd":0.8,"inputTokens":10,"outputTokens":20,"cacheReadTokens":0,"cacheWriteTokens":0,"turns":3},
			  "ms":90000,"failure":null},
			 {"n":2,"target":null,"allowedParts":["porch","wing"],"accepted":false,"overall":null,"changedCells":0,"cost":{"usd":0.2},"ms":1000,
			  "failure":"scope_failed"}]}""").getAsJsonObject();
		Polish x = Wire5b.polish(p).orElseThrow();
		assertEquals(1, x.fromVersion());
		assertEquals(2, x.installedVersion());
		assertEquals(Polish.End.POLISHED, x.end());
		assertEquals(2, x.steps().size());
		assertEquals("roof", x.steps().get(0).target().part());
		assertTrue(x.steps().get(0).accepted());
		assertEquals(6.5, x.steps().get(0).overall());
		assertNull(x.steps().get(1).target());
		assertEquals("scope_failed", x.steps().get(1).failure());
		assertEquals(1.0, x.cost().usd(), 1e-9);
		assertEquals(Polish.End.NO_TARGET, Wire5b.end("no_target"));
		assertTrue(Wire5b.polish(null).isEmpty());
	}

	@Test
	void polishEstimateHasItsOwnFields() {
		var e = Wire5b.estimate(JsonParser.parseString("{\"usdLow\":0,\"usdHigh\":0,\"polishUsdLow\":0.5,\"polishUsdHigh\":2.4,\"polishMinutesLow\":2,"
			+ "\"polishMinutesHigh\":12,\"basis\":\"seeds\"}").getAsJsonObject());
		assertTrue(e.polish());
		assertEquals(2.4, e.polishUsdHigh(), 1e-9);
		assertEquals(12, e.polishMinutesHigh(), 1e-9);
	}
}
