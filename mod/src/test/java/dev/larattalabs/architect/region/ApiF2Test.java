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
 * Phase 6c slice F2 (docs/CONTRACT.md "Phase 6c slice F2" §1, gate items 10 and 11): no new records or methods; the features
 * {@code scatterOp} and {@code stampOp} with an F2 helper ({@code region.scatter}); the {@code scatter} and {@code stamp} kinds,
 * appended after T1's {@code relief} (an IR using them is refused PLAN_STALE by a game whose kit lacks them). The version numbers are
 * placeholders until the coordinator assigns them at merge, so this asserts them as "at least".
 */
class ApiF2Test {
	@Test
	void version() {
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.19.0") >= 0, ArchitectApi.VERSION);
		assertTrue(IrStale.semverCompare(IrStale.KIT_VERSION, "0.21.0") >= 0, IrStale.KIT_VERSION);
	}

	@Test
	void features() {
		Set<String> f2 = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.passes", "region.scatter"));
		assertTrue(f2.contains("scatterOp"));
		assertTrue(f2.contains("stampOp"));
		assertFalse(f2.contains("region.scatter"), "the wire name is not a feature");
		Set<String> t1 = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.passes"));
		assertFalse(t1.contains("scatterOp"), "a T1 helper has no scatter");
		assertFalse(t1.contains("stampOp"));
		assertFalse(ApiRules.features(1, List.of("region.scatter")).contains("stampOp"), "protocol 1 carries no helper features");
	}

	@Test
	void kinds() {
		int ri = IrStale.KINDS_FORMAT2.indexOf("relief");
		assertEquals(ri + 1, IrStale.KINDS_FORMAT2.indexOf("scatter"), "appended after relief (rebase point)");
		assertEquals(ri + 2, IrStale.KINDS_FORMAT2.indexOf("stamp"));
		assertNull(IrStale.reason(PlanStaleTest.ir(2, IrStale.KIT_VERSION, "blobs:side", "fields", "scatter", "stamp"), null));
		// a T1 game (kit 0.20.0, its kinds end at relief) refuses the plan by its kit version and the kinds
		IrStale.Hello t1 = new IrStale.Hello("0.20.0", List.of(1, 2), IrStale.KINDS_FORMAT2.subList(0, ri + 1));
		String why = IrStale.reason(PlanStaleTest.ir(2, IrStale.KIT_VERSION, "blobs:side", "scatter", "stamp"), t1);
		assertTrue(why != null && why.contains("scatter") && why.contains("stamp") && why.contains("0.20.0"), why);
	}
}
