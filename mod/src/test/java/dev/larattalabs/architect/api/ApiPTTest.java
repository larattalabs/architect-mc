package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.region.IrStale;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * API 1.24.0 placeholder (docs/CONTRACT.md "Phase 6c slice PT" §9): the new Sites methods are defaults that throw "needs Architect
 * API 1.24.0"; PLAYER_BUILD is appended after P0's ARTIFACT_STALE, ARTIFACT_UNAPPROVED; BuildKind and BuildState are in contract order (PROVISIONAL appended);
 * Refusal, ArchitectRefused and RegionView keep their old constructors with no builds; every request record keeps its old
 * constructors (consent null) and its with* methods carry the consent; the features are builds and playerPlaced.
 */
class ApiPTTest {
	@BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	@Test
	void versionsAndEnums() {
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.24.0") >= 0, ArchitectApi.VERSION);
		assertTrue(IrStale.semverCompare(IrStale.KIT_VERSION, "0.26.0") >= 0, IrStale.KIT_VERSION);
		assertEquals(Reason.ARTIFACT_UNAPPROVED.ordinal() + 1, Reason.PLAYER_BUILD.ordinal(), "appended after P0's ARTIFACT_*");
		assertEquals(Reason.PLAYER_BUILD.ordinal() + 1, Reason.ADOPT_REFUSED.ordinal(), "PT2 appends ADOPT_REFUSED after PLAYER_BUILD");
		assertEquals(List.of("HOUSE", "BARN", "FARM", "WALL", "TOWER", "PATH", "OTHER"), java.util.Arrays.stream(BuildKind.values()).map(Enum::name).toList());
		assertEquals(List.of("ACTIVE", "CLAIMED", "RELEASED", "PROVISIONAL", "ADOPTED"), java.util.Arrays.stream(BuildState.values()).map(Enum::name)
			.toList()); // PT2 appends ADOPTED
	}

	@Test
	void sitesDefaultsThrow() throws Exception {
		Sites old = (Sites) Proxy.newProxyInstance(Sites.class.getClassLoader(), new Class<?>[] {Sites.class}, (p, m, a) -> {
			if (m.isDefault()) {
				return java.lang.reflect.InvocationHandler.invokeDefault(p, m, a);
			}
			throw new AssertionError(m.getName());
		});
		List<Runnable> calls = List.of(() -> old.playerPlaced(Level.OVERWORLD, BlockPos.ZERO), () -> old.playerPlaced(Level.OVERWORLD, new BoundingBox(0, 0, 0,
			1, 1, 1)), () -> old.builds(null, null), () -> old.build("build-1"), () -> old.claimBuild(Level.OVERWORLD, new BoundingBox(0, 0, 0, 1, 1, 1), null),
			() -> old.releaseBuild("build-1", null));
		for (Runnable r : calls) {
			var e = assertThrows(UnsupportedOperationException.class, r::run);
			assertTrue(e.getMessage().contains("1.24.0"), e.getMessage());
		}
	}

	@Test
	void oldConstructorsKeepNoBuilds() {
		Refusal r = new Refusal(Reason.OTHER, "x");
		assertEquals(List.of(), r.builds());
		assertEquals(List.of(), new ArchitectRefused(Reason.OTHER, "x").builds());
		assertEquals(List.of(), new ArchitectRefused(Reason.OTHER, "x", "d").builds());
		BuildHit h = new BuildHit("build-12", BuildKind.HOUSE, 41, List.of(new BlockHit(new BlockPos(-120, 64, 33), "minecraft:oak_log")));
		assertEquals(List.of(h), new ArchitectRefused(Reason.PLAYER_BUILD, "x", "", List.of(h)).builds());
		RegionView v = new RegionView("rg1", "p", "s", null, new JsonObject(), "g", new BoundingBox(0, 0, 0, 1, 1, 1), RegionState.PLACED, List.of(),
			List.of(), 0, Map.of(), null, null, List.of(), 0L, "RAISE");
		assertEquals(List.of(), v.buildHits());
	}

	@Test
	void requestsKeepTheirConstructorsAndCarryConsent() {
		BuildConsent c = new BuildConsent(Set.of("build-1"), UUID.randomUUID());
		PlaceRequest p = new PlaceRequest("cabin", null, BlockPos.ZERO, null, null, null, new JsonObject(), false, null, null, null);
		assertNull(p.consent());
		assertEquals(c, p.withConsent(c).consent());
		assertEquals(c, p.withConsent(c).withOverlap(OverlapPolicy.LAYER).withPathStyle("stone").consent(), "the with* methods keep it");
		RoadRequest rr = new RoadRequest(null, List.of(BlockPos.ZERO, BlockPos.ZERO), 3, null, null, false, false, Mode.AUTO, null, new JsonObject(), null,
			false, true);
		assertNull(rr.consent());
		assertEquals(c, rr.withConsent(c).withPartial(false).consent());
		assertNull(CellsRequest.of(null, "a:b", List.of()).consent());
		assertNull(new DeltaRequest("s1").consent());
		assertEquals(c, new DeltaRequest("s1").withConsent(c).consent());
		assertNull(new RealiseRequest("p", Mode.AUTO, null, Map.of(), null, true, null, false, new JsonObject()).consent());
		assertNull(new BrushRequest("gate:x", Level.OVERWORLD, BrushKind.RAISE, null, BlockPos.ZERO, 4, 2, null, null, null, null, 7).consent());
		assertNull(FitOptions.DEFAULT.consent());
		assertEquals(c, FitOptions.DEFAULT.withConsent(c).withSetback(2).withOwner("a:b").consent());
		assertEquals(Set.of("build-1"), new BuildConsent(Set.of("build-1"), null).buildIds());
	}

	@Test
	void features() {
		assertTrue(ApiRules.JAVA_FEATURES.contains("builds"));
		assertTrue(ApiRules.features(0, List.of()).contains("playerPlaced"), "tracking on (the world rule's default)");
		assertTrue(ApiRules.features(2, List.of("plan.feature.build")).contains("plan.feature.build"));
	}

	@Test
	void buildViewFootprintIsACopy() {
		int[] fp = {0, 1, 2};
		Build b = new Build("build-1", Level.OVERWORLD, new BoundingBox(0, 0, 0, 1, 1, 1), fp, List.of(), BuildKind.OTHER, 0.5f, 3, Map.of(UUID.randomUUID(), 3),
			BuildState.ACTIVE, 1);
		fp[0] = 9;
		assertEquals(0, b.footprint()[0]);
		b.footprint()[1] = 9;
		assertEquals(1, b.footprint()[1]);
		assertEquals(b, new Build("build-1", Level.OVERWORLD, new BoundingBox(0, 0, 0, 1, 1, 1), new int[] {0, 1, 2}, List.of(), BuildKind.OTHER, 0.5f, 3, b
			.placers(), BuildState.ACTIVE, 1));
	}
}
