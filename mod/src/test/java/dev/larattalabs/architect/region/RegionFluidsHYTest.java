package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (6c HY §3, §4, §12) The fluids stage's reading of a course: the course members of a fluid op (after, plan joins beside natural joins,
 * lining, grate), the write order (downstream first, ties in plan order, unknown ids and cycles never stall it), the upstream closure
 * (transitive, across parts, upstream first), an H-only IR unchanged (plan order, no closure), the versions, kinds and features.
 */
class RegionFluidsHYTest {
	/** A course of three reaches (r1 the head) listed head first, a pond that overflows into r1, and an H pond on its own. */
	static final String IR = "{\"parts\":["
		+ "{\"id\":\"s_r1\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"s_r1\",\"part\":\"s\",\"fluid\":\"water\",\"level\":70,\"cells\":[[0,0,69,70]],"
		+ "\"joins\":[[5,5,60,61],{\"body\":\"s_r2\",\"cells\":[[3,0,67,67]]}],\"after\":[\"s_r2\"],\"lining\":[[2,1,70,70]],\"settleTicks\":50}]},"
		+ "{\"id\":\"s_r2\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"s_r2\",\"part\":\"s\",\"fluid\":\"water\",\"level\":67,\"cells\":[[3,0,66,67]],"
		+ "\"joins\":[{\"body\":\"s_r3\",\"cells\":[[6,0,66,66]]}],\"after\":[\"s_r3\"],\"grate\":[[3,0,67,67]],\"settleTicks\":40}]},"
		+ "{\"id\":\"s_r3\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"s_r3\",\"part\":\"s\",\"fluid\":\"water\",\"level\":66,\"cells\":[[6,0,65,66]],\"settleTicks\":30}]},"
		+ "{\"id\":\"w_feed\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"w_feed\",\"part\":\"feed\",\"fluid\":\"water\",\"level\":72,\"cells\":[[0,3,72,72]],"
		+ "\"joins\":[{\"body\":\"s_r1\",\"cells\":[[0,1,70,70]]}],\"after\":[\"s_r1\"],\"settleTicks\":50}]},"
		+ "{\"id\":\"pond\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"pond\",\"part\":\"pond\",\"fluid\":\"water\",\"level\":63,\"cells\":[[20,20,63,63]],\"joins\":[],\"settleTicks\":30}]}]}";

	static List<RegionFluids.Body> bodies() {
		return RegionFluids.bodiesOf(JsonParser.parseString(IR).getAsJsonObject());
	}

	@Test
	void theCourseMembers() {
		List<RegionFluids.Body> b = bodies();
		RegionFluids.Body r1 = b.get(0);
		assertEquals(List.of("s_r2"), r1.after);
		assertArrayEquals(new long[] {BlockPos.asLong(5, 60, 5), BlockPos.asLong(5, 61, 5)}, r1.joins, "a natural join stays a run");
		assertEquals(1, r1.planJoins.size());
		assertEquals("s_r2", r1.planJoins.get(0).body());
		assertArrayEquals(new long[] {BlockPos.asLong(3, 67, 0)}, r1.planJoins.get(0).cells());
		assertArrayEquals(new long[] {BlockPos.asLong(2, 70, 1)}, r1.lining);
		assertTrue(r1.watchSet().contains(BlockPos.asLong(4, 72, 3)), "the lining is in the watch set (grown by 2)");
		assertArrayEquals(new long[] {BlockPos.asLong(3, 67, 0)}, b.get(1).grate);
		assertTrue(r1.course() && b.get(1).course() && !b.get(2).course() && b.get(3).course() && !b.get(4).course());
		assertFalse(b.get(4).course(), "an H pond");
	}

	@Test
	void writeOrderDownstreamFirst() {
		List<String> ids = RegionFluids.writeOrder(bodies()).stream().map(x -> x.id).toList();
		assertEquals(List.of("s_r3", "s_r2", "s_r1", "w_feed", "pond"), ids);
		RegionFluids.Regional st = new RegionFluids.Regional(bodies());
		assertTrue(st.ordered);
		// an H-only IR: plan order, not ordered
		String h = "{\"parts\":[{\"id\":\"a\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"a\",\"fluid\":\"water\",\"level\":1,\"cells\":[[0,0,1,1]]}]},"
			+ "{\"id\":\"b\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"b\",\"fluid\":\"water\",\"level\":1,\"cells\":[[5,5,1,1]]}]}]}";
		RegionFluids.Regional hs = new RegionFluids.Regional(RegionFluids.bodiesOf(JsonParser.parseString(h).getAsJsonObject()));
		assertFalse(hs.ordered);
		assertEquals(List.of("a", "b"), hs.order.stream().map(x -> x.id).toList());
		assertTrue(RegionFluids.upstreamOf(hs, hs.bodies.get(0)).isEmpty() && RegionFluids.upstreamOf(hs, hs.bodies.get(1)).isEmpty());
	}

	@Test
	void writeOrderNeverStalls() {
		// a cycle and an unknown id: every body still gets a place, the rest in plan order
		String c = "{\"parts\":[{\"id\":\"a\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"a\",\"fluid\":\"water\",\"level\":1,\"cells\":[[0,0,1,1]],\"after\":[\"b\",\"nope\"]}]},"
			+ "{\"id\":\"b\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"b\",\"fluid\":\"water\",\"level\":1,\"cells\":[[5,5,1,1]],\"after\":[\"a\"]}]},"
			+ "{\"id\":\"c\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"c\",\"fluid\":\"water\",\"level\":1,\"cells\":[[9,9,1,1]]}]}]}";
		List<String> ids = RegionFluids.writeOrder(RegionFluids.bodiesOf(JsonParser.parseString(c).getAsJsonObject())).stream().map(x -> x.id).toList();
		assertEquals(List.of("c", "a", "b"), ids);
	}

	@Test
	void theUpstreamClosureCrossesParts() {
		RegionFluids.Regional st = new RegionFluids.Regional(bodies());
		// r2 fails: r1 and the pond that overflows into r1 (another part) drain, upstream first; r3 (downstream) and the H pond stand
		assertEquals(List.of("w_feed", "s_r1"), RegionFluids.upstreamOf(st, st.body("s_r2")).stream().map(x -> x.id).toList());
		assertEquals(List.of("w_feed", "s_r1", "s_r2"), RegionFluids.upstreamOf(st, st.body("s_r3")).stream().map(x -> x.id).toList());
		assertTrue(RegionFluids.upstreamOf(st, st.body("w_feed")).isEmpty(), "nothing lands in the feed");
		assertTrue(RegionFluids.upstreamOf(st, st.body("pond")).isEmpty());
		assertNull(st.body("nope"));
	}

	@Test
	void versionsKindsAndFeatures() {
		// (at least: a later slice moves the API and kit on; CU 1.37.0)
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.36.0") >= 0, ArchitectApi.VERSION);
		assertTrue(IrStale.semverCompare(IrStale.KIT_VERSION, "0.37.0") >= 0, IrStale.KIT_VERSION);
		assertEquals("courses", IrStale.KINDS_FORMAT2.get(IrStale.KINDS_FORMAT2.indexOf("survival") - 1), "appended at the end (6c RS's survival, then 6c F3-c's coralDecor, after it)");
		assertEquals(IrStale.KINDS_FORMAT2.indexOf("volume:fluids") + 1, IrStale.KINDS_FORMAT2.indexOf("courses"), "appended after volume:fluids");
		assertTrue(ApiRules.features(2, List.of("region.hydrology", "region.courses", "region.waterGates")).containsAll(List.of("hydrologyPass", "regionCourses", "waterGates")));
		assertFalse(ApiRules.features(2, List.of("region.fluids")).contains("regionCourses"), "an H helper has no courses");
		// a course IR needs `courses`: a 0.37.0 helper (or this mod's list without it) refuses it PLAN_STALE
		assertNull(IrStale.reason(PlanStaleTest.ir(2, IrStale.KIT_VERSION, "fluid", "courses"), null));
	}

}
