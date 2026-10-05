package dev.larattalabs.architect.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.world.AutoWorldSpec;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The per-world toggle's default and file, and the dev world's game mode switch. */
class SurvivalWorldTest {
	@Test
	void defaultsByGameMode() {
		assertTrue(SurvivalWorld.defaultOn("survival", false));
		assertTrue(SurvivalWorld.defaultOn("survival", true));
		assertFalse(SurvivalWorld.defaultOn("creative", false));
		assertFalse(SurvivalWorld.defaultOn("adventure", false));
	}

	@Test
	void settingsFile() {
		SurvivalWorld.Settings s = SurvivalWorld.Settings.fromJson(JsonParser.parseString("{\"survival\":false,\"blocksPerTick\":200}").getAsJsonObject(), true);
		assertFalse(s.survival());
		assertEquals(64, s.blocksPerTick());
		SurvivalWorld.Settings d = SurvivalWorld.Settings.fromJson(JsonParser.parseString("{}").getAsJsonObject(), true);
		assertTrue(d.survival());
		assertEquals(4, d.blocksPerTick());
		assertEquals(d, SurvivalWorld.Settings.fromJson(d.toJson(), false));
	}

	@Test
	void autoWorldMode() {
		AutoWorldSpec c = AutoWorldSpec.from(Map.<String, String>of()::get);
		assertEquals(AutoWorldSpec.Mode.CREATIVE, c.mode());
		assertTrue(c.cheats());
		AutoWorldSpec s = AutoWorldSpec.from(Map.of("ARCHITECT_AUTOWORLD_MODE", "survival")::get);
		assertEquals(AutoWorldSpec.Mode.SURVIVAL, s.mode());
		assertTrue(s.cheats());
		AutoWorldSpec h = AutoWorldSpec.from(Map.of("ARCHITECT_AUTOWORLD_MODE", "Hardcore")::get);
		assertEquals(AutoWorldSpec.Mode.HARDCORE, h.mode());
		assertFalse(h.cheats(), "a hardcore dev world has no cheats unless asked");
		assertTrue(AutoWorldSpec.from(Map.of("ARCHITECT_AUTOWORLD_MODE", "hardcore", "ARCHITECT_AUTOWORLD_CHEATS", "1")::get).cheats());
		assertThrows(IllegalArgumentException.class, () -> AutoWorldSpec.from(Map.of("ARCHITECT_AUTOWORLD_MODE", "spectator")::get));
	}
}
