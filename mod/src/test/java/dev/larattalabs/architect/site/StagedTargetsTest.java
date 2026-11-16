package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.region.Packed;
import dev.larattalabs.architect.survival.SurvivalWorld;
import java.util.List;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (8a ST, docs/CONTRACT.md "Phase 8a" §3, §6) Staged terrain targets: a tile's class 3 cells split into their group's own target (every
 * cell held, none in the free pass or its free count), apart from the group's paid and held target and ahead of it; the run slabs; a
 * part's floating anchors from the IR; the world setting {@code terrainPerTick} (default 16, clamped 1-64, kept across the toggle's
 * rewrite); the feature advertised only while staged terrain is built.
 */
class StagedTargetsTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	private static Packed.Tile tile(long[] pos, byte[] cls, int[] group) {
		int n = pos.length;
		return new Packed.Tile(pos, new int[n], new byte[n], new boolean[n], List.of(Blocks.STONE.defaultBlockState()), List.of("minecraft:stone"), "sha", cls,
			group);
	}

	@Test
	void stagedCellsAreTheirGroupsOwnHeldTarget() {
		assertTrue(Packed.stagedBuild(), "ST builds staged terrain (no -Darchitect.stagedTerrain=false in the test JVM)");
		assertFalse(Packed.freePass(Packed.STAGED), "a staged cell is no longer the free pass");
		long[] pos = {BlockPos.asLong(0, 64, 0), BlockPos.asLong(1, 64, 0), BlockPos.asLong(2, 64, 0), BlockPos.asLong(3, 64, 0), BlockPos.asLong(4, 64, 0)};
		// group 0 (town): a pad's staged cut and fill, a paid street cell and a held cell; group 1 (relief): staged only; one free cell
		byte[] cls = {Packed.STAGED, Packed.PAID, Packed.STAGED, Packed.FREE, Packed.STAGED};
		int[] grp = {0, 0, 0, 0, 1};
		Value v = WorldJournal.value(Blocks.STONE.defaultBlockState());
		Value[] vals = {v, v, v, v, v};
		InfraPlace.Check c = new InfraPlace.Check(List.of(), List.of(), pos, vals, null, List.of(), null);
		RegionTargets.Split s = RegionTargets.split(tile(pos, cls, grp), c, List.of("town", "relief"));
		assertArrayEquals(new long[] {pos[3]}, s.freePos(), "only the FREE cell is the free pass");
		assertEquals(java.util.Map.of("town", 1L), s.freeOf(), "staged cells are not counted as free cells");
		assertEquals(3, s.groups().size());
		RegionTargets.Group g0 = s.groups().get(0), g1 = s.groups().get(1), g2 = s.groups().get(2);
		assertTrue(g0.staged() && g0.part().equals("town") && g0.pos().length == 2 && g0.held().cardinality() == 2, "town's staged target first, all held");
		assertTrue(!g1.staged() && g1.part().equals("town") && g1.pos().length == 1 && g1.held().isEmpty(), "then town's paid target");
		assertTrue(g2.staged() && g2.part().equals("relief") && g2.held().cardinality() == 1, "relief's staged target");
	}

	@Test
	void runsAreSlabsOfTheOrder() {
		assertArrayEquals(new int[] {1}, RegionTargets.terrainRuns(1));
		assertArrayEquals(new int[] {4096}, RegionTargets.terrainRuns(4096));
		assertArrayEquals(new int[] {4096, 8192, 9000}, RegionTargets.terrainRuns(9000));
	}

	@Test
	void floatingAnchorsByPart() {
		var ir = JsonParser.parseString("{\"anchors\":{\"isl_isle\":[10,90,20]},\"floating\":[{\"anchor\":\"isl_isle\",\"parts\":[\"isle_rock\"]}],"
			+ "\"survival\":{\"groups\":[\"isle\",\"hamlet\"],\"parts\":{\"isle_rock\":0,\"huts\":1}}}").getAsJsonObject();
		assertEquals(List.of(new BlockPos(10, 90, 20)), RegionTargets.floatingOf(ir, "isle"));
		assertTrue(RegionTargets.floatingOf(ir, "hamlet").isEmpty());
		assertTrue(RegionTargets.floatingOf(null, "isle").isEmpty());
	}

	@Test
	void terrainPerTickSetting() {
		SurvivalWorld.Settings d = SurvivalWorld.Settings.fromJson(JsonParser.parseString("{}").getAsJsonObject(), true);
		assertEquals(16, d.terrainPerTick());
		assertEquals(16, SurvivalWorld.DEFAULT_TERRAIN_PER_TICK);
		assertEquals(64, SurvivalWorld.Settings.fromJson(JsonParser.parseString("{\"terrainPerTick\":500}").getAsJsonObject(), true).terrainPerTick());
		assertEquals(1, SurvivalWorld.Settings.fromJson(JsonParser.parseString("{\"terrainPerTick\":0}").getAsJsonObject(), true).terrainPerTick());
		SurvivalWorld.Settings s = SurvivalWorld.Settings.fromJson(JsonParser.parseString("{\"terrainPerTick\":8}").getAsJsonObject(), true);
		assertEquals(s, SurvivalWorld.Settings.fromJson(s.toJson(), false), "it round-trips through the file");
		assertEquals(16, new SurvivalWorld.Settings(true, 4, 4).terrainPerTick(), "the old constructors take the default");
		assertEquals(16, SurvivalWorld.terrainPerTick(), "no world: the default");
	}

	@Test
	void theFeatureIsAdvertisedOnlyWhileStagedTerrainIsBuilt() {
		assertEquals(Packed.stagedBuild(), ApiRules.features(2, List.of("job.run", "region.survival", "region.terrainConstruction")).contains(
			"terrainConstruction"));
		assertFalse(ApiRules.features(2, List.of("job.run", "region.survival")).contains("terrainConstruction"), "an older helper's kit stages nothing");
		assertFalse(ApiRules.features(1, List.of("region.terrainConstruction")).contains("terrainConstruction"));
	}
}
