package dev.larattalabs.architect.world;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import org.junit.jupiter.api.Test;

/** (nightly 2026-10-25) dev.world.open's budget: 10 s to open an existing world, 120 s to create one; the request's overrides. */
class AutoWorldOpenBudgetTest {
	@Test
	void createGetsTheLongBudget() {
		assertEquals(10_000, AutoWorldSpec.openBudgetMs(true));
		assertEquals(120_000, AutoWorldSpec.openBudgetMs(false));
		// spawn selection alone took ~9 s under the nightly's load: a create's budget is well over the open's
		assertTrue(AutoWorldSpec.OPEN_CREATE_MS >= 10 * AutoWorldSpec.OPEN_EXISTING_MS);
	}

	@Test
	void overridesFromTheRequest() {
		Map<String, String> req = Map.of("name", "G6B Seed Base Srv", "preset", "normal", "seed", "2026100906", "cheats", "true");
		Map<String, String> o = AutoWorldSpec.overrides(req::get);
		assertEquals(Map.of("ARCHITECT_AUTOWORLD_NAME", "G6B Seed Base Srv", "ARCHITECT_AUTOWORLD_PRESET", "normal", "ARCHITECT_AUTOWORLD_SEED",
			"2026100906", "ARCHITECT_AUTOWORLD_CHEATS", "1"), o);
		assertEquals("0", AutoWorldSpec.overrides(Map.of("cheats", "false")::get).get("ARCHITECT_AUTOWORLD_CHEATS"));
		assertEquals("1", AutoWorldSpec.overrides(Map.of("cheats", "1")::get).get("ARCHITECT_AUTOWORLD_CHEATS"));
		assertEquals(Map.of(), AutoWorldSpec.overrides(k -> null));
		AutoWorldSpec s = AutoWorldSpec.from(k -> o.get(k));
		assertEquals("G6B Seed Base Srv", s.name());
		assertEquals(2026100906L, s.seed());
	}
}
