package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/** API 1.9.0 (docs/CONTRACT.md phase 6b §6): old constructors, appended constants, default-throwing methods. */
class Api19Test {
	@Test
	void version() {
		assertEquals("1.10.0", ArchitectApi.VERSION);
	}

	@Test
	void placeRequestPathStyle() {
		net.minecraft.core.BlockPos at = new net.minecraft.core.BlockPos(1, 2, 3);
		net.minecraft.world.level.block.Rotation none = net.minecraft.world.level.block.Rotation.NONE;
		// the 1.4.0 and 1.5.0 constructors and of(): no path style (the design's own approach)
		assertNull(new PlaceRequest("b", null, at, none, Mode.AUTO, null, new JsonObject(), false, null).pathStyle());
		assertNull(new PlaceRequest("b", null, at, none, Mode.AUTO, null, new JsonObject(), false, null, OverlapPolicy.LAYER).pathStyle());
		PlaceRequest r = PlaceRequest.of("b", null, at, none);
		assertNull(r.pathStyle());
		PlaceRequest s = r.withPathStyle(" Stone_Bricks ");
		assertEquals("minecraft:stone_bricks", s.pathStyle());
		assertEquals("minecraft:mud_bricks", r.withPathStyle("minecraft:mud_bricks").pathStyle());
		assertNull(r.withPathStyle("  ").pathStyle());
		assertNull(s.withPathStyle(null).pathStyle());
		// withOverlap keeps the style, withPathStyle the policy
		assertEquals("minecraft:stone_bricks", s.withOverlap(OverlapPolicy.LAYER).pathStyle());
		assertEquals(OverlapPolicy.LAYER, s.withOverlap(OverlapPolicy.LAYER).withPathStyle("x:y").overlap());
		assertEquals("b", s.blueprintId());
		assertEquals(at, s.origin());
	}

	@Test
	void regionPlanOldConstructor() {
		RegionPlan p = new RegionPlan("p1", "mega_bench", "ps", "irs", "ss", 7L, List.of(), List.of("ground"), Map.of(), new RegionBudget(1, 2, 3, 4, 5, 6),
			List.of("n"));
		assertNull(p.report());
		assertNull(p.previews());
		assertEquals(1, p.irFormat());
		RegionPlan q = new RegionPlan("p1", "x", "", "", "", 0, List.of(), List.of(), Map.of(), new RegionBudget(0, 0, 0, 0, 0, 0), List.of(),
			new CheckReport(true, 0, 0, List.of()), null, 2);
		assertEquals(2, q.irFormat());
		assertTrue(q.report().ok());
	}

	@Test
	void regionViewOldConstructor() {
		RegionView v = new RegionView("rg1", "p1", "irs", null, new JsonObject(), "g1", new BoundingBox(0, 0, 0, 1, 1, 1), RegionState.PLACING, List.of(),
			List.of(), 0, Map.of(), null, null);
		assertEquals(List.of(), v.actions());
		RegionView w = new RegionView("rg1", "p1", "irs", null, new JsonObject(), "g1", new BoundingBox(0, 0, 0, 1, 1, 1), RegionState.PLACING, List.of(),
			List.of(), 0, Map.of(), new Refusal(Reason.SIDECAR_UNAVAILABLE, "x"), null, List.of(new WaitAction(WaitAction.Kind.START_SIDECAR, "Start", null,
				null)));
		assertEquals(WaitAction.Kind.START_SIDECAR, w.actions().get(0).kind());
	}

	@Test
	void enumsAppended() {
		Reason[] r = Reason.values();
		// the 1.9.0 tail, at its ordinals (later versions append after it)
		int t = Reason.PLAYER_BLOCKS.ordinal();
		assertEquals(Reason.REGION_LIMIT, r[t - 2]);
		assertEquals(Reason.NO_TEMPLATE, r[t - 1]);
		assertEquals(34, t);
		assertEquals(Design.Kind.REGION, Design.Kind.values()[4]);
		// the 1.9.0 kinds first (1.10.0 appends RETRY)
		assertEquals(List.of("MOVE_CLOSER", "PREPARE", "START_SIDECAR", "APPROVE_STAGE", "REPLAN"), java.util.Arrays.stream(WaitAction.Kind.values()).map(
			Enum::name).toList().subList(0, 5));
	}

	@Test
	void designKindAndOldConstructor() {
		JsonObject req = new JsonObject();
		req.addProperty("kind", "region");
		Design d = new Design("d1", Design.Status.DONE, "", Optional.empty(), Cost.NONE, Optional.empty(), req, Optional.empty(), 0, 0, Optional.empty(),
			Optional.empty(), Optional.empty(), Optional.empty(), Optional.empty());
		assertEquals(Design.Kind.REGION, d.kind());
		assertTrue(d.result().isEmpty());
	}

	@Test
	void newMethodsDefaultThrow() {
		Regions old = new Regions() {
			public java.util.concurrent.CompletableFuture<RegionPlan> plan(RegionPlanRequest r) {
				return null;
			}

			public java.util.concurrent.CompletableFuture<PrepareView> prepare(PrepareRequest r) {
				return null;
			}

			public void cancelPrepare(String id) {
			}

			public java.util.concurrent.CompletableFuture<String> realise(RealiseRequest r) {
				return null;
			}

			public java.util.concurrent.CompletableFuture<RemoveResult> remove(String id, RemoveOptions o) {
				return null;
			}

			public Optional<RegionView> get(String id) {
				return Optional.empty();
			}

			public List<RegionView> list(String owner) {
				return List.of();
			}
		};
		var e = assertThrows(UnsupportedOperationException.class, () -> old.check("p"));
		assertTrue(e.getMessage().endsWith("needs Architect API 1.9.0"));
		assertThrows(UnsupportedOperationException.class, () -> old.previews("p", Set.of(), List.of()));
		assertThrows(UnsupportedOperationException.class, () -> old.nudge("r", WaitAction.Kind.PREPARE));
		assertThrows(UnsupportedOperationException.class, () -> old.design(null));
		Survey s = (level, area, res, load) -> null;
		assertThrows(UnsupportedOperationException.class, () -> s.volume(null, null, LoadPolicy.LOADED_ONLY));
	}

	@Test
	void volumeCountsEveryClass() {
		Volume v = new Volume("s", new BoundingBox(0, 0, 0, 0, 0, 0), "local:s", Map.of(VoxelClass.ROCK, 3L), 0, new Volume.Stats(1, 0, 0, 0, 0, 0));
		assertEquals(VoxelClass.values().length, v.counts().size());
		assertEquals(3L, v.count(VoxelClass.ROCK));
		assertEquals(0L, v.count(VoxelClass.AIR));
	}
}
