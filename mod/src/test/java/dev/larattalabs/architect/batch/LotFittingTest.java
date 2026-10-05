package dev.larattalabs.architect.batch;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.placement.Anchor;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Approach;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.BlueprintTransform;
import java.util.List;
import org.junit.jupiter.api.Test;

/** fitToLot's geometry (docs/CONTRACT.md phase 4d "Lot fitting"): every street side, every template front (so every rotation). */
class LotFittingTest {
	/** The kit cabin's shape: 11x12x12, entrance at (5.5, 1, 8.5), approach length 4; {@code front} varies. */
	private static Blueprint cabin(String front) {
		return Blueprint.fromJson(JsonParser.parseString("""
			{"id":"cabin","size":{"x":11,"y":12,"z":12},"groundY":1,"front":"%s",
			 "anchors":{"entrance":{"x":5.5,"y":1,"z":8.5},"spawn":{"x":5.5,"y":1,"z":6.5}},
			 "approach":{"length":4,"width":3}}""".formatted(front)).getAsJsonObject());
	}

	/** An asymmetric design (entrance off centre) to catch axis mix-ups. */
	private static Blueprint offCentre(String front) {
		return Blueprint.fromJson(JsonParser.parseString("""
			{"id":"shed","size":{"x":9,"y":6,"z":5},"groundY":2,"front":"%s",
			 "anchors":{"entrance":{"x":2.5,"y":2,"z":4.5}},
			 "approach":{"length":3,"width":3}}""".formatted(front)).getAsJsonObject());
	}

	private static final Anchors.Bounds LOT = new Anchors.Bounds(100, 70, 200, 123, 90, 223); // 24 x 24, ground at y 70

	private static final List<String> SIDES = List.of("north", "east", "south", "west");

	/** The world (x, z) cell of the entrance anchor for a fit. */
	private static int[] entranceCell(Blueprint bp, LotFitting.Fit f) {
		Anchor e = BlueprintTransform.worldAnchors(bp, f.turns(), f.ox(), f.oy(), f.oz()).get(Blueprint.ENTRANCE);
		return new int[] {(int) Math.floor(e.x()), (int) Math.floor(e.z())};
	}

	/** The row index along the street axis of approach row {@code i} (1 = just outside the front face). */
	private static int approachRow(LotFitting.Fit f, String side, int i) {
		int[] out = Approach.outward(side);
		return switch (side) {
			case "north" -> f.box().minZ() + out[1] * i;
			case "south" -> f.box().maxZ() + out[1] * i;
			case "west" -> f.box().minX() + out[0] * i;
			default -> f.box().maxX() + out[0] * i;
		};
	}

	private static int streetEdge(String side) {
		return switch (side) {
			case "north" -> LOT.minZ();
			case "south" -> LOT.maxZ();
			case "west" -> LOT.minX();
			default -> LOT.maxX();
		};
	}

	@Test
	void everySideAndFrontFacesTheStreetWithTheApproachEndingOnTheLotEdge() {
		for (Blueprint bp : List.of(cabin("south"), cabin("north"), cabin("east"), cabin("west"), offCentre("south"), offCentre("west"))) {
			for (String side : SIDES) {
				LotFitting.Fit f = LotFitting.fit(bp, LOT, side, false, null, false);
				String at = bp.id() + " front " + bp.front() + " street " + side;
				assertTrue(f.fits(), at + ": " + f.why());
				assertEquals(side, BlueprintTransform.rotateDirection(bp.front(), f.turns()), at + ": entrance faces the street");
				int len = bp.approach().length();
				assertEquals(len, f.setback(), at);
				// the approach's last row is the lot's street-edge row, and every row is inside the lot
				assertEquals(streetEdge(side), approachRow(f, side, len), at + ": last approach row on the lot edge");
				for (int i = 1; i <= len; i++) {
					int r = approachRow(f, side, i);
					boolean alongZ = side.equals("north") || side.equals("south");
					assertTrue(alongZ ? r >= LOT.minZ() && r <= LOT.maxZ() : r >= LOT.minX() && r <= LOT.maxX(), at + ": approach row " + i + " in the lot");
				}
				// inside the lot, at the lot's ground
				assertTrue(f.box().minX() >= LOT.minX() && f.box().maxX() <= LOT.maxX() && f.box().minZ() >= LOT.minZ() && f.box().maxZ() <= LOT.maxZ(), at);
				assertEquals(LOT.minY() - bp.groundY(), f.oy(), at);
				// the entrance column on the lot's centre column across the street
				int[] e = entranceCell(bp, f);
				boolean alongX = side.equals("north") || side.equals("south");
				assertEquals(alongX ? (LOT.minX() + LOT.maxX()) / 2 : (LOT.minZ() + LOT.maxZ()) / 2, alongX ? e[0] : e[1], at + ": entrance centred");
				// the rotated footprint
				assertEquals(BlueprintTransform.rotatedSizeX(bp.sizeX(), bp.sizeZ(), f.turns()), f.box().maxX() - f.box().minX() + 1, at);
				assertEquals(BlueprintTransform.rotatedSizeZ(bp.sizeX(), bp.sizeZ(), f.turns()), f.box().maxZ() - f.box().minZ() + 1, at);
			}
		}
	}

	@Test
	void approachIntoStreetPutsTheFrontFaceOnTheEdge() {
		Blueprint bp = cabin("south");
		for (String side : SIDES) {
			LotFitting.Fit f = LotFitting.fit(bp, LOT, side, false, null, true);
			assertTrue(f.fits());
			assertEquals(0, f.setback());
			assertEquals(streetEdge(side), approachRow(f, side, 0), side + ": front face on the lot edge");
			// row 1 is outside the lot (in the street)
			int r = approachRow(f, side, 1);
			assertTrue(side.equals("north") ? r < LOT.minZ() : side.equals("south") ? r > LOT.maxZ() : side.equals("west") ? r < LOT.minX() : r > LOT.maxX());
		}
	}

	@Test
	void explicitSetbackAndBoxCentring() {
		Blueprint bp = offCentre("south");
		LotFitting.Fit f = LotFitting.fit(bp, LOT, "north", true, 1, false);
		assertEquals(LOT.minZ() + 1, f.box().minZ());
		int w = f.box().maxX() - f.box().minX() + 1;
		assertEquals(LOT.minX() + (24 - w) / 2, f.box().minX(), "footprint centred");
	}

	@Test
	void anEntranceNearTheSideIsClampedIntoTheLot() {
		// a lot just wide enough: centring the off-centre entrance would push the box out sideways
		Blueprint bp = offCentre("south"); // 9 wide, entrance column 2
		Anchors.Bounds narrow = new Anchors.Bounds(0, 64, 0, 9, 80, 20); // 10 wide
		LotFitting.Fit f = LotFitting.fit(bp, narrow, "south", false, null, false);
		assertTrue(f.fits());
		assertTrue(f.box().minX() >= 0 && f.box().maxX() <= 9, "clamped inside: " + f.box());
	}

	@Test
	void tooSmallLotsRefuse() {
		Blueprint bp = cabin("south");
		LotFitting.Fit narrow = LotFitting.fit(bp, new Anchors.Bounds(0, 64, 0, 9, 80, 40), "south", false, null, false);
		assertFalse(narrow.fits());
		assertTrue(narrow.why().contains("wide"), narrow.why());
		// deep enough for the footprint (12) but not with the setback (4)
		LotFitting.Fit shallow = LotFitting.fit(bp, new Anchors.Bounds(0, 64, 0, 30, 80, 14), "north", false, null, false);
		assertFalse(shallow.fits());
		assertTrue(shallow.why().contains("setback"), shallow.why());
		// the same lot fits with the approach into the street
		assertTrue(LotFitting.fit(bp, new Anchors.Bounds(0, 64, 0, 30, 80, 14), "north", false, null, true).fits());
	}

	@Test
	void overlapMarginIsTheApproachPlusItsExtension() {
		assertEquals(4 + Approach.EXTEND, LotFitting.frontMargin(cabin("south")));
		Blueprint none = Blueprint.fromJson(JsonParser.parseString("""
			{"id":"slab","size":{"x":3,"y":1,"z":3},"approach":false}""").getAsJsonObject());
		assertEquals(0, LotFitting.frontMargin(none));
	}
}
