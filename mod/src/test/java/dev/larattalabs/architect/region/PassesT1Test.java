package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Phase 6c slice T1 (docs/CONTRACT.md "Phase 6c slice T1" §1, §3, gate item 11): API 1.17.0 with no new records or methods; the
 * features {@code planPasses} and {@code reliefOp} with a T1 helper ({@code region.passes}); the {@code relief} kind (an IR using it
 * is refused PLAN_STALE by a game whose kit lacks it); the second plan's survey at resolution 1 for a program with passes.
 */
class PassesT1Test {
	@Test
	void version() {
		assertEquals("1.17.0", ArchitectApi.VERSION);
		assertEquals("0.20.0", IrStale.KIT_VERSION);
	}

	@Test
	void features() {
		Set<String> t1 = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.keepOut", "region.lightCover", "region.passes"));
		assertTrue(t1.contains("planPasses"));
		assertTrue(t1.contains("reliefOp"));
		Set<String> w = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.keepOut", "region.lightCover"));
		assertFalse(w.contains("planPasses"), "a W helper has no passes");
		assertFalse(w.contains("reliefOp"));
	}

	@Test
	void reliefKind() {
		assertEquals("relief", IrStale.KINDS_FORMAT2.get(IrStale.KINDS_FORMAT2.size() - 1), "appended at the end (rebase point)");
		assertNull(IrStale.reason(PlanStaleTest.ir(2, "0.20.0", "fields", "relief"), null));
		// a 0.18.0 game (W's kinds, before relief) refuses the plan by its kit version and the kind
		IrStale.Hello w = new IrStale.Hello("0.18.0", List.of(1, 2), IrStale.KINDS_FORMAT2.subList(0, IrStale.KINDS_FORMAT2.size() - 1));
		String why = IrStale.reason(PlanStaleTest.ir(2, "0.20.0", "fields", "relief"), w);
		assertTrue(why != null && why.contains("relief"), why);
	}

	@Test
	void secondSurveyResolution() {
		assertEquals(1, RegionsImpl.secondSurveyRes(true, 4, 512, 512), "passes on a 512x512 claim: resolution 1");
		assertEquals(1, RegionsImpl.secondSurveyRes(true, 4, 1024, 1024), "up to 1024x1024");
		assertEquals(4, RegionsImpl.secondSurveyRes(true, 4, 1025, 1024), "past 1024: coarse");
		assertEquals(4, RegionsImpl.secondSurveyRes(false, 4, 512, 512), "no passes: unchanged");
		assertEquals(1, RegionsImpl.secondSurveyRes(true, 1, 256, 256), "already resolution 1");
	}
}
