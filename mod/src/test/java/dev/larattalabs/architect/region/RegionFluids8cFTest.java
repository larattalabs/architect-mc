package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.FluidsRemoval;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.api.RegionView;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (8cF, docs/CONTRACT.md "Phase 8c" slice 8cF) The frozen in-game shapes: a fluid op's 8c members read (open enums kept as given), a
 * flowing body's watch set holds its predicted cells, the rows' new members (why, box, kind, flow, on, flowing, washed, converted,
 * settleTicks, a capped removal's foreign positions) beside the old ones, the typed why derived from a record saved before 8c, the
 * fluidsWatch rows while a body writes or drains, RegionView's old constructor (no fluids removal), the kinds appended after
 * stagedTerrain, and flowingWater not advertised before the mod builds rivers (slice WU).
 */
class RegionFluids8cFTest {
	/** A river head (flow current, a predicted current outside its spill on purpose), its pool, and an H pond. */
	static final String IR = "{\"parts\":[{\"id\":\"river_r1\",\"stage\":\"fluids\",\"ops\":["
		+ "{\"op\":\"fluid\",\"id\":\"river_r1\",\"part\":\"river\",\"fluid\":\"water\",\"level\":70,\"cells\":[[0,0,69,70]],\"shell\":[[0,0,68,68]],"
		+ "\"spill\":[[1,0,70,70]],\"predicted\":[[1,70,0,1],[40,70,0,7]],\"settleTicks\":240,\"flow\":\"current\",\"kind\":\"river\","
		+ "\"wash\":[[1,0,70,70]],\"converted\":[[0,0,69,69]],\"after\":[\"river_r2\"]},"
		+ "{\"op\":\"fluid\",\"id\":\"river_r2\",\"part\":\"river\",\"fluid\":\"water\",\"level\":60,\"cells\":[[50,0,59,60]],\"settleTicks\":30,\"flow\":\"braided\",\"kind\":\"pool\"},"
		+ "{\"op\":\"fluid\",\"id\":\"fall_r1\",\"part\":\"fall\",\"fluid\":\"water\",\"level\":80,\"cells\":[[70,0,80,80]],\"settleTicks\":60,\"lip\":\"form\",\"kind\":\"header\",\"on\":{\"part\":\"isle\"}},"
		+ "{\"op\":\"fluid\",\"id\":\"w_pond\",\"part\":\"pond\",\"fluid\":\"water\",\"level\":63,\"cells\":[[9,9,63,63]],\"predicted\":[[30,63,30,1]],\"settleTicks\":30}]}]}";

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static List<RegionFluids.Body> bodies() {
		return RegionFluids.bodiesOf(JsonParser.parseString(IR).getAsJsonObject());
	}

	@Test
	void theMembersAreReadOpenEnumsKept() {
		List<RegionFluids.Body> b = bodies();
		assertEquals("current", b.get(0).flow);
		assertEquals("river", b.get(0).kind);
		assertEquals(1, b.get(0).wash.length);
		assertEquals(1, b.get(0).converted.length);
		assertEquals("braided", b.get(1).flow, "an unknown flow is kept, not refused");
		assertEquals("form", b.get(2).lip);
		assertEquals("isle", b.get(2).on);
		assertTrue(b.get(0).flowing() && b.get(1).flowing() && b.get(2).flowing());
		assertFalse(b.get(3).flowing(), "an H pond is no 8c body");
		assertNull(b.get(3).flow);
	}

	@Test
	void aFlowingBodysWatchSetHoldsItsPredictedCells() {
		List<RegionFluids.Body> b = bodies();
		assertTrue(b.get(0).watchSet().contains(BlockPos.asLong(40, 70, 0)), "a river's current is watched where it is predicted");
		assertFalse(b.get(3).watchSet().contains(BlockPos.asLong(30, 63, 30)), "an H body's watch set is as before (cells, shell, spill, watch, lining)");
		int[] box = b.get(0).watchBox();
		assertEquals(-2, box[0]);
		assertEquals(42, box[3]);
		assertEquals(66, box[1]);
		assertEquals(72, box[4]);
	}

	@Test
	void theRowsCarryTheNewMembersBesideTheOld() {
		RegionFluids.Regional st = new RegionFluids.Regional(bodies());
		for (RegionFluids.BodyState bs : st.states.values()) {
			bs.state = "settled";
		}
		RegionFluids.BodyState d = st.states.get("river_r2");
		d.state = "drained";
		d.reason = "unsettled: 3 cell(s) not as predicted after 2 x 30 ticks";
		RegionFluids.BodyState c = st.states.get("fall_r1");
		c.state = "drained";
		c.why = "foreign_water";
		c.reason = "foreign water";
		c.foreign.add(BlockPos.asLong(71, 79, 0));
		c.foreignCount = 5;
		JsonArray a = new JsonArray();
		RegionFluids.rows(a, 0, st);
		assertEquals(4, a.size());
		JsonObject r1 = a.get(0).getAsJsonObject();
		assertEquals("river", r1.get("part").getAsString());
		assertEquals("settled", r1.get("state").getAsString());
		assertFalse(r1.has("why"), "a settled body has no why");
		assertEquals("current", r1.get("flow").getAsString());
		assertEquals("river", r1.get("kind").getAsString());
		assertEquals(2, r1.get("flowing").getAsInt());
		assertEquals(1, r1.get("washed").getAsInt());
		assertEquals(1, r1.get("converted").getAsInt());
		assertEquals(240, r1.get("settleTicks").getAsInt());
		assertEquals(6, r1.getAsJsonArray("box").size());
		assertTrue(r1.has("sources") && r1.has("spill") && r1.has("escaped") && r1.has("at"), "the old members stay");
		assertEquals("census_drift", a.get(1).getAsJsonObject().get("why").getAsString(), "derived from the reason");
		JsonObject f = a.get(2).getAsJsonObject();
		assertEquals("foreign_water", f.get("why").getAsString());
		assertEquals("isle", f.get("on").getAsString());
		assertEquals(5, f.get("foreignCount").getAsInt());
		assertEquals(71, f.getAsJsonArray("foreign").get(0).getAsJsonArray().get(0).getAsInt());
		JsonObject pond = a.get(3).getAsJsonObject();
		assertFalse(pond.has("flow") || pond.has("flowing"), "an H body's row gains only why, box and settleTicks");
		assertTrue(pond.has("box"));
	}

	@Test
	void theWhyIsDerivedFromARecordSavedBefore8c() {
		RegionFluids.BodyState bs = new RegionFluids.BodyState();
		assertNull(RegionFluids.whyOf(bs));
		bs.state = "drained";
		bs.uncontained = true;
		assertEquals("uncontained", RegionFluids.whyOf(bs));
		bs.held = true;
		assertEquals("upstream", RegionFluids.whyOf(bs));
		bs.lotRemoved = true;
		assertEquals("lot_removed", RegionFluids.whyOf(bs));
		RegionFluids.BodyState e = new RegionFluids.BodyState();
		e.state = "drained";
		e.escaped = true;
		assertEquals("escaped", RegionFluids.whyOf(e));
		assertTrue(RegionFluids.WHYS.containsAll(List.of("foreign_water", "census_drift", "escaped", "uncontained", "upstream", "lot_removed", "wash", "bubble")));
	}

	@Test
	void theWatchRowsWhileWritingOrDraining() {
		RegionFluids.Regional st = new RegionFluids.Regional(bodies());
		JsonArray a = new JsonArray();
		RegionFluids.watchRows(a, 0, st);
		assertEquals(0, a.size(), "the gate: none yet");
		st.phase = "settling";
		st.states.get("w_pond").state = "settled";
		RegionFluids.watchRows(a, 0, st);
		assertEquals(3, a.size(), "every body not ended while the stage writes and settles");
		assertEquals("writing", a.get(0).getAsJsonObject().get("phase").getAsString());
		JsonArray b = new JsonArray();
		st.phase = "done";
		st.removal = "drained";
		st.states.get("river_r1").before.put(1L, "minecraft:air");
		RegionFluids.watchRows(b, 0, st);
		assertEquals(1, b.size(), "draining: the bodies written (a before state captured)");
		assertEquals("draining", b.get(0).getAsJsonObject().get("phase").getAsString());
	}

	@Test
	void theViewsOldConstructorHasNoFluidsRemoval() {
		RegionView v = new RegionView("rg1", "p1", "sha", "o", new JsonObject(), "g1", new BoundingBox(0, 60, 0, 15, 80, 15), RegionState.PLACED, List.of(),
			List.of(), 0, Map.of(), null, null, List.of(), 0L, null, List.of(), null, null, 0, null, List.of(), dev.larattalabs.architect.api.RemovalStop.NONE, null);
		assertNull(v.fluidsRemoval());
		FluidsRemoval f = new FluidsRemoval(null, 100, -5);
		assertEquals("draining", f.phase());
		assertEquals(0, f.ticksLeft());
	}

	@Test
	void theKindsAndTheFeature() {
		int i = IrStale.KINDS_FORMAT2.indexOf("stagedTerrain");
		assertEquals(List.of("stagedTerrain", "flowingWater", "volume:levels"), IrStale.KINDS_FORMAT2.subList(i, i + 3));
		assertEquals(RegionFluids.flowingBuild(), ApiRules.features(2, List.of("job.run", "region.plan", "region.flowingWater")).contains("flowingWater"));
		assertFalse(ApiRules.features(2, List.of("job.run", "region.plan")).contains("flowingWater"));
	}
}
