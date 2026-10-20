package dev.larattalabs.architect.site.roads;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * 6c slice W item 2 (docs/CONTRACT.md "Phase 6c slice W" §4): a lantern post's foot may be a built cell the road's own owner
 * placed (a region's verge in packed mud, stone bricks or oak planks: all {@link RoadPlan#BUILT}); owned by another owner or
 * by nobody it gets none. With the owner's verge the count equals a natural (dirt: coarse dirt) verge's. The coordinator's
 * addition: a lamp fixture (the bible's) at its own spacing, turned to the road's travel.
 */
class RoadPlanTest {
	private static final int[] XS = {0, 60};
	private static final int[] YS = {64, 64};
	private static final int[] ZS = {0, 0};
	private static final RoadPlan.Owned NONE = (x, y, z) -> null;

	/** Flat dirt (top at y 63); the verge rows (z = +-2, beside a width-3 road) of kind {@code verge} at y 63. */
	private static RoadPlan.World world(int verge) {
		return (x, y, z) -> {
			if (y == 63 && Math.abs(z) == 2) {
				return verge;
			}
			return y <= 63 ? RoadPlan.DIRT : RoadPlan.AIR;
		};
	}

	private static int lanterns(RoadPlan.Plan p) {
		return p.lanterns().length / 3;
	}

	@Test
	void ownersBuiltVergeGetsPosts() {
		int natural = lanterns(RoadPlan.plan(XS, YS, ZS, 3, true, false, world(RoadPlan.DIRT), NONE, null, false, null, null));
		assertTrue(natural >= 4, "a coarse-dirt verge (DIRT) gets its posts: " + natural);
		// packed mud, stone bricks, oak planks: BUILT; the owner's own
		RoadPlan.Plan own = RoadPlan.plan(XS, YS, ZS, 3, true, false, world(RoadPlan.BUILT), NONE, null, false, (x, y, z) -> y == 63 && Math.abs(z) == 2, null);
		assertEquals(natural, lanterns(own), "the owner's built verge: the same count as a natural verge");
		for (int i = 0; i < own.lanterns().length; i += 3) {
			assertEquals(2, Math.abs(own.lanterns()[i + 2]), "on the verge row");
			assertEquals(65, own.lanterns()[i + 1], "the lantern on a post standing on the verge");
		}
		// another owner's verge, or nobody's (a player's block): no post
		assertEquals(0, lanterns(RoadPlan.plan(XS, YS, ZS, 3, true, false, world(RoadPlan.BUILT), NONE, null, false, (x, y, z) -> false, null)));
		assertEquals(0, lanterns(RoadPlan.plan(XS, YS, ZS, 3, true, false, world(RoadPlan.BUILT), NONE, null, false, null, null)));
		// without the 6c W arguments: 4e as before
		assertEquals(0, lanterns(RoadPlan.plan(XS, YS, ZS, 3, true, false, world(RoadPlan.BUILT), NONE)));
	}

	@Test
	void lampFixtureTurnedAndSpaced() {
		// a gibbet: 3 posts, an arm one cell along the travel, a hanging lantern under it (the light, index 4)
		RoadPlan.Lamp gibbet = new RoadPlan.Lamp(new int[] {0, 0, 0, 1, 1}, new int[] {0, 1, 2, 2, 1}, 4, 6, 12);
		RoadPlan.Plan p = RoadPlan.plan(XS, YS, ZS, 3, true, false, world(RoadPlan.DIRT), NONE, null, false, null, gibbet);
		RoadPlan.Plan d = RoadPlan.plan(XS, YS, ZS, 3, true, false, world(RoadPlan.DIRT), NONE, null, false, null, null);
		assertEquals(lanterns(d), lanterns(p), "the same spacing as 4e's");
		long cells = p.ops().stream().filter(o -> o.block() == RoadPlan.Block.LAMP).count();
		assertEquals(5L * lanterns(p), cells);
		assertTrue(p.ops().stream().filter(o -> o.block() == RoadPlan.Block.LAMP).allMatch(o -> o.lamp() % 4 == 0), "a road travelling east: no turn");
		for (int i = 0; i < p.lanterns().length; i += 3) {
			assertEquals(65, p.lanterns()[i + 1], "the hanging lantern under the arm (posts 64-66, arm 66)");
		}
		// travelling west: turned twice
		RoadPlan.Plan w = RoadPlan.plan(new int[] {60, 0}, YS, ZS, 3, true, false, world(RoadPlan.DIRT), NONE, null, false, null, gibbet);
		assertTrue(w.ops().stream().filter(o -> o.block() == RoadPlan.Block.LAMP).allMatch(o -> o.lamp() % 4 == 2));
		// a weaker light (a soul lantern: every 8): more lanterns
		RoadPlan.Lamp soul = new RoadPlan.Lamp(new int[] {0, 0}, new int[] {0, 1}, 1, 4, 8);
		assertTrue(lanterns(RoadPlan.plan(XS, YS, ZS, 3, true, false, world(RoadPlan.DIRT), NONE, null, false, null, soul)) > lanterns(d));
	}

	/** Flat dirt; the verge rows at y 63 of kind {@code north} (z = -2) and {@code south} (z = +2). */
	private static RoadPlan.World verges(int north, int south) {
		return (x, y, z) -> y == 63 && z == -2 ? north : y == 63 && z == 2 ? south : y <= 63 ? RoadPlan.DIRT : RoadPlan.AIR;
	}

	/**
	 * fix/lamp-path: a lantern post never stands on a dirt path (a lane's beside the road, ours or not, or a village's). Vanilla turns a
	 * dirt path under a solid block to dirt on the first shape update that reaches it (the farm hamlet's lane at the entrance), outside
	 * the journal, and the removal kept the dirt. The post takes the other side of the road; with a path on both, none.
	 */
	@Test
	void noPostOnADirtPath() {
		RoadPlan.Lamp gibbet = new RoadPlan.Lamp(new int[] {0, 0, 0, 1, 1}, new int[] {0, 1, 2, 2, 1}, 4, 6, 12);
		RoadPlan.OwnFoot ours = (x, y, z) -> true; // the lane is the road owner's own (a region's): still no post on it
		for (RoadPlan.Lamp lamp : new RoadPlan.Lamp[] {null, gibbet}) {
			int both = lanterns(RoadPlan.plan(XS, YS, ZS, 3, true, false, verges(RoadPlan.DIRT, RoadPlan.DIRT), NONE, null, false, ours, lamp));
			assertTrue(both >= 4, "dirt verges: posts (" + both + ")");
			for (int[] sides : new int[][] {{RoadPlan.PATH, RoadPlan.DIRT}, {RoadPlan.DIRT, RoadPlan.PATH}}) {
				RoadPlan.World w = verges(sides[0], sides[1]);
				RoadPlan.Plan p = RoadPlan.plan(XS, YS, ZS, 3, true, false, w, NONE, null, false, ours, lamp);
				assertEquals(both, lanterns(p), "a path on one side: every post on the other");
				for (RoadPlan.Op o : p.ops()) {
					if (o.block() == RoadPlan.Block.FENCE || o.block() == RoadPlan.Block.LANTERN || o.block() == RoadPlan.Block.LAMP) {
						assertTrue(w.at(o.x(), o.y() - 1, o.z()) != RoadPlan.PATH, "no lamp cell over the dirt path: " + o);
					}
				}
			}
			assertEquals(0, lanterns(RoadPlan.plan(XS, YS, ZS, 3, true, false, verges(RoadPlan.PATH, RoadPlan.PATH), NONE, null, false, ours, lamp)),
				"a path on both sides: no post");
		}
	}
}
