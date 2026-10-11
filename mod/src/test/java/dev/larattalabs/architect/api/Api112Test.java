package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.util.BitSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

/** API 1.12.0 (docs/CONTRACT.md phase 6c slice 0c §1): old constructors kept, constants appended, new methods default-throwing. */
class Api112Test {
	@Test
	void version() {
		assertEquals("1.12.0", ArchitectApi.VERSION);
	}

	@Test
	void reasonsAppendedLast() {
		Reason[] r = Reason.values();
		assertEquals(Reason.FIELD_LIMIT, r[r.length - 1]);
		assertEquals(Reason.PROTECTED, r[r.length - 2]);
		assertTrue(Reason.PROTECTED.ordinal() > Reason.PLAYER_BLOCKS.ordinal());
	}

	@Test
	void oldConstructors() {
		FitOptions f = new FitOptions(FitOptions.CentreOn.BOX, 2, false, null, Mode.AUTO, false, null);
		assertNull(f.owner());
		assertEquals("test:a", f.withOwner("test:a").owner());
		assertEquals("test:a", f.withOwner("test:a").withSetback(3).withCentreOn(FitOptions.CentreOn.ENTRANCE).withApproachIntoStreet(true).withLevel(null)
			.owner(), "every with* keeps the owner");
		assertNull(FitOptions.DEFAULT.owner());
		BoundingBox box = new BoundingBox(0, 0, 0, 4, 4, 4);
		Verdict v = new Verdict(List.of(), List.of(), false, Map.of(), Optional.empty(), Optional.empty(), List.of(), 3);
		assertEquals(List.of(), v.spans());
		Verdict v14 = new Verdict(List.of(), List.of(), false, Map.of(), Optional.empty(), Optional.empty());
		assertEquals(List.of(), v14.spans());
		LotFit lf = new LotFit(BlockPos.ZERO, Rotation.NONE, box, Optional.empty(), v);
		assertSame(box, lf.recommendedLot());
		PlaceResult pr = new PlaceResult(true, Optional.of("s1"), List.of(), List.of("n"));
		assertEquals(List.of(), pr.skipped());
		RoadRequest rr = new RoadRequest(null, List.of(BlockPos.ZERO, new BlockPos(5, 0, 0)), 3, null, null, false, false, Mode.AUTO, null, new JsonObject(),
			null, false);
		assertFalse(rr.partial());
		assertTrue(rr.withPartial(true).partial());
		int[] height = {1, 2, 3, 4};
		Sample s = new Sample(0, 0, 1, 1, 1, 2, 2, height, height, new int[] {-1, -1, -1, -1}, List.of(), new int[4], new BitSet(), new BitSet(),
			new BitSet(), new BitSet(), 1, 1, new int[] {-1}, List.of(), List.of(), 0);
		assertArrayEquals(height, s.ground(), "the old constructor copies height");
		Volume vol = new Volume("s", box, "local:s", Map.of(), 0, new Volume.Stats(0, 0, 0, 0, 0, 0));
		assertEquals(0, vol.ground().length);
		assertEquals(Sample.MISSING, vol.groundAt(0, 0));
		Volume vg = new Volume("s", new BoundingBox(10, 0, 20, 11, 5, 22), "local:s", Map.of(), 0, new Volume.Stats(0, 0, 0, 0, 0, 0), new int[] {1, 2, 3,
			4, 5, 6});
		assertEquals(4, vg.groundAt(11, 21), "index i + j * width");
	}

	@Test
	void lotSizeAt() {
		LotSize ls = new LotSize(7, 10, 3, 5);
		BoundingBox lot = new BoundingBox(100, 64, 200, 119, 80, 229); // 20 x 30
		assertEquals(new BoundingBox(106, 64, 200, 112, 80, 209), ls.at(lot, Direction.NORTH));
		assertEquals(new BoundingBox(106, 64, 220, 112, 80, 229), ls.at(lot, Direction.SOUTH));
		assertEquals(new BoundingBox(100, 64, 211, 109, 80, 217), ls.at(lot, Direction.WEST));
		assertEquals(new BoundingBox(110, 64, 211, 119, 80, 217), ls.at(lot, Direction.EAST));
		assertThrows(IllegalArgumentException.class, () -> ls.at(lot, Direction.UP));
	}

	@Test
	void protectedAreaNormalisesCorners() {
		ProtectedArea a = new ProtectedArea("test:a", "a1", null, 10, 5, -2, -7, null);
		assertEquals(-2, a.x0());
		assertEquals(10, a.x1());
		assertEquals(-7, a.z0());
		assertEquals(5, a.z1());
		assertEquals("", a.label());
		assertTrue(a.contains(0, 0));
		assertFalse(a.contains(11, 0));
		assertTrue(a.intersects(10, 5, 20, 20));
		assertFalse(a.intersects(11, 5, 20, 20));
	}

	@Test
	void newSitesMethodsDefaultThrow() {
		Sites old = new Sites() {
			public List<SiteView> list() {
				return List.of();
			}

			public List<SiteView> list(@Nullable String owner) {
				return List.of();
			}

			public Optional<SiteView> get(String siteId) {
				return Optional.empty();
			}

			public CompletableFuture<PlaceResult> place(PlaceRequest r) {
				return null;
			}

			public CompletableFuture<RemoveResult> remove(String siteId, RemoveOptions o) {
				return null;
			}

			public Verdict check(PlaceRequest r) {
				return null;
			}

			public SurvivalInfo survival() {
				return null;
			}
		};
		var e = assertThrows(UnsupportedOperationException.class, () -> old.protect(null));
		assertTrue(e.getMessage().endsWith("needs Architect API 1.12.0"));
		assertThrows(UnsupportedOperationException.class, () -> old.unprotect("a:b", "x"));
		assertThrows(UnsupportedOperationException.class, () -> old.protectedAreas(null));
		assertThrows(UnsupportedOperationException.class, () -> old.minLotSize("x", FitOptions.DEFAULT));
		assertThrows(UnsupportedOperationException.class, () -> old.minLotSize(new MassingRef("m", 1), FitOptions.DEFAULT));
	}
}
