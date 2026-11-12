package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (7b slice LP) The link pass's Java half (docs/CONTRACT.md "Slice LP as built"): which IRs run it ({@code portLinks}, never an IR v2
 * or a plan without links: change 4), the lots it reads entries for, the helper's input (a lot without an entry is left out, so the
 * kit names it in NO_LINK), the feature linkPass, NO_LINK last among the Reasons.
 */
class ApiLPTest {
	private static JsonObject ir(String json) {
		return JsonParser.parseString(json).getAsJsonObject();
	}

	private static final String LINKED = "{\"format\":1,\"stages\":[\"lots\",\"site_links\"],\"portLinks\":[{\"id\":\"ab\",\"kind\":\"branch_walk\","
		+ "\"from\":{\"lot\":\"hut_b\",\"port\":\"walk_w\",\"facing\":\"west\"},\"to\":{\"lot\":\"hut_a\",\"port\":\"walk_w\",\"facing\":\"west\"}}]}";

	@Test
	void onlyAPlanWithPortLinksRunsThePass() {
		assertTrue(RegionLinks.needs(ir(LINKED)));
		assertFalse(RegionLinks.needs(ir("{\"format\":1,\"stages\":[\"lots\"]}")), "a plan without links: no pass (change 4)");
		assertFalse(RegionLinks.needs(ir("{\"format\":1,\"portLinks\":[]}")));
		JsonObject v2 = ir(LINKED);
		v2.add("linked", ir("{\"lots\":{}}"));
		assertFalse(RegionLinks.needs(v2), "IR v2 is never linked again");
		assertFalse(RegionLinks.needs(null));
	}

	@Test
	void theLotsItReadsAndTheInput() {
		assertEquals(List.of("hut_a", "hut_b"), List.copyOf(RegionLinks.lots(ir(LINKED))));
		// no entry bound (or none the library holds): left out of the input, so the kit answers NO_LINK naming the lot
		JsonObject in = RegionLinks.input(ir(LINKED), Map.of("hut_a", "no_such_entry_lp"));
		assertEquals(0, in.getAsJsonObject("lots").size());
		assertEquals(0, RegionLinks.input(ir(LINKED), Map.of()).getAsJsonObject("lots").size());
	}

	@Test
	void theFeatureAndTheReason() {
		assertTrue(ApiRules.features(2, List.of("region.link")).contains("linkPass"));
		assertFalse(ApiRules.features(1, List.of("region.link")).contains("linkPass"));
		assertFalse(ApiRules.features(2, List.of("region.plan", "region.siteLots")).contains("linkPass"));
		// NO_LINK was appended right after SITE_UNFIT (7bF); later reasons are appended after it (M5 GP: PROGRAM_REFUSED)
		assertEquals(Reason.SITE_UNFIT.ordinal() + 1, Reason.NO_LINK.ordinal(), "NO_LINK keeps its place after SITE_UNFIT (7bF)");
	}

	@Test
	void theDevCounters() {
		RegionLinks.devBypass(true);
		assertTrue(RegionLinks.devStats().get("bypass").getAsBoolean());
		RegionLinks.devBypass(false);
		assertFalse(RegionLinks.devStats().get("bypass").getAsBoolean());
		assertTrue(RegionLinks.devStats().get("calls").getAsInt() >= 0);
	}

	@Test
	void sha256OfTheIrText() {
		assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", RegionLinks.sha256(""));
	}
}
