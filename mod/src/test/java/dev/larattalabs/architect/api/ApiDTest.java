package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.region.BesideCheck;
import dev.larattalabs.architect.region.IrStale;
import dev.larattalabs.architect.region.RegionKeys;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * API 1.27.0 placeholder (docs/CONTRACT.md "Phase 6c slice D" §1, §3): RegionPlanRequest and RegionView gain a trailing beside (their old
 * constructors leave it null), the plan opKey body names beside only when it is set, the features districtsPass and besideRegion, and
 * the seam rule (BesideCheck, the kit's kit/lib/region/beside.mjs in Java) on S7's golden IR.
 */
class ApiDTest {
	@BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	@Test
	void versionsAndRecords() throws Exception {
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.27.0") >= 0, ArchitectApi.VERSION);
		assertTrue(IrStale.semverCompare(IrStale.KIT_VERSION, "0.28.0") >= 0, IrStale.KIT_VERSION);
		var pc = RegionPlanRequest.class.getRecordComponents();
		assertEquals("beside", pc[pc.length - 1].getName());
		var vc = RegionView.class.getRecordComponents();
		assertEquals("beside", vc[vc.length - 1].getName());
		assertEquals("buildHits", vc[vc.length - 2].getName());
		// the 1.14.0 (opKey) and 1.24.0 constructors, by descriptor
		RegionPlanRequest.class.getConstructor(String.class, JsonObject.class, net.minecraft.server.level.ServerLevel.class, BoundingBox.class, Long.class, String.class,
			Integer.class, LoadPolicy.class, String.class, JsonObject.class, String.class);
		RegionView.class.getConstructor(String.class, String.class, String.class, String.class, JsonObject.class, String.class, BoundingBox.class, RegionState.class,
			List.class, List.class, long.class, Map.class, Refusal.class, PrepareView.class, List.class, long.class, String.class, List.class);
		RegionPlanRequest old = new RegionPlanRequest("districts", null, null, new BoundingBox(0, 0, 0, 1, 1, 1), null, null, null, null, null, null, "k");
		assertNull(old.beside());
		assertEquals("rg1", new RegionPlanRequest("districts", null, null, new BoundingBox(0, 0, 0, 1, 1, 1), null, null, null, null, null, null, "k", "rg1").beside());
		RegionView v = new RegionView("rg2", "p", "s", null, null, "g", new BoundingBox(0, 0, 0, 1, 1, 1), RegionState.PLACED, List.of(), List.of(), 0, Map.of(), null, null,
			List.of(), 0L, null, List.of());
		assertNull(v.beside());
	}

	@Test
	void opKeyBodyNamesBesideOnlyWhenSet() {
		RegionPlanRequest a = new RegionPlanRequest("districts", null, null, new BoundingBox(0, 0, 0, 1, 1, 1), null, null, null, null, "o", null, "k");
		assertFalse(RegionKeys.planBody(a).has("beside"), "a key recorded before 1.27.0 keeps its body");
		RegionPlanRequest b = new RegionPlanRequest("districts", null, null, new BoundingBox(0, 0, 0, 1, 1, 1), null, null, null, null, "o", null, "k", "rg1");
		assertEquals("rg1", RegionKeys.planBody(b).get("beside").getAsString());
		assertFalse(RegionKeys.hash(RegionKeys.planBody(a)).equals(RegionKeys.hash(RegionKeys.planBody(b))));
	}

	@Test
	void features() {
		assertTrue(ApiRules.features(2, List.of("region.districts", "region.beside")).containsAll(List.of("districtsPass", "besideRegion")));
		assertFalse(ApiRules.features(2, List.of("region.route")).contains("districtsPass"));
	}

	/** S7's golden IR (scenarios/goldens/s7): its street runs north-south at x 1557 from z -3122; its claim is [1480, -3128, 1591, -3017]. */
	private static JsonObject s7() throws Exception {
		Path p = Path.of("..", "scenarios", "goldens", "s7", "ir.json");
		return JsonParser.parseString(Files.readString(p)).getAsJsonObject();
	}

	@Test
	void seamRuleOnS7() throws Exception {
		JsonObject ir = s7();
		int[] standing = {1480, -3128, 1591, -3017};
		// north of the claim, overlapping its margin rows only: allowed (the past-end cell of the street, z -3123, lies in it)
		assertNull(BesideCheck.seamProblem(standing, ir, new int[] {1520, -3220, 1600, -3123}));
		// no overlap at all
		assertNull(BesideCheck.seamProblem(standing, ir, new int[] {1520, -3300, 1600, -3129}));
		// over the street's first cell
		assertTrue(BesideCheck.seamProblem(standing, ir, new int[] {1520, -3220, 1600, -3122}).contains("meets the standing region's"));
		// deeper than 16
		assertTrue(BesideCheck.seamProblem(standing, ir, new int[] {1400, -3220, 1600, -3100}).contains("columns deep"));
		// the beside data: the graph, and the footprint near the claim
		JsonObject d = BesideCheck.besideData("rg1", standing, ir, new int[] {1520, -3220, 1600, -3123});
		assertEquals("rg1", d.get("id").getAsString());
		assertEquals(ir.getAsJsonObject("graph").getAsJsonArray("nodes").size(), d.getAsJsonObject("graph").getAsJsonArray("nodes").size());
		JsonArray keep = d.getAsJsonArray("keep");
		assertTrue(keep.size() > 0);
		assertTrue(d.getAsJsonArray("lots").size() > 0);
	}
}
