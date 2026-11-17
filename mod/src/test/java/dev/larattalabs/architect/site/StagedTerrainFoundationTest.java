package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.PartBuild;
import dev.larattalabs.architect.api.Quote;
import dev.larattalabs.architect.api.RegionBuild;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.region.IrStale;
import dev.larattalabs.architect.region.Packed;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (8aF, docs/CONTRACT.md "Phase 8a" §3, §6) The foundation of staged terrain: ARTL v2's class 3 ({@link Packed#STAGED}) decodes and is
 * written in the free pass until slice ST; {@code stagedTerrain} is a known IR kind (an older mod's list refuses it PLAN_STALE); the
 * feature follows the helper; the API records' new members default through their old constructors; the typed wait's kind is stable.
 */
class StagedTerrainFoundationTest {
	/** One section, one state, cells at positions 1 and 2 with the given classes (groups 0 and 1). */
	private static byte[] artl(int c1, int c2) {
		ByteArrayOutputStream o = new ByteArrayOutputStream();
		o.writeBytes("ARTL".getBytes(StandardCharsets.US_ASCII));
		o.write(2);
		o.write(0);
		o.write(0);
		o.write(0);
		o.write(1); // sections
		o.write(0);
		o.write(8); // sy 4
		o.write(0);
		o.write(1); // palette
		byte[] id = "minecraft:stone".getBytes(StandardCharsets.UTF_8);
		o.write(id.length);
		o.writeBytes(id);
		o.write(2); // cells
		o.write(0x01);
		o.write(0x00);
		o.write(0x02);
		o.write(0x00);
		o.write(c1);
		o.write(c2);
		o.write(0);
		o.write(0);
		o.write(1);
		o.write(0);
		return o.toByteArray();
	}

	@Test
	void classThreeIsStagedAndATargetFromST() {
		Packed.Tile t = Packed.decode(artl(Packed.STAGED, Packed.FREE));
		assertArrayEquals(new byte[] {Packed.STAGED, Packed.FREE}, t.cls());
		assertEquals(!Packed.stagedBuild(), Packed.freePass(Packed.STAGED), "(8a ST) a staged cell is the free pass only with staged terrain off");
		assertTrue(Packed.freePass(Packed.FREE));
		assertFalse(Packed.freePass(Packed.HELD));
		assertFalse(Packed.freePass(Packed.PAID));
		assertThrows(IllegalArgumentException.class, () -> Packed.decode(artl(4, 0)), "a class past STAGED is malformed");
	}

	@Test
	void stagedTerrainIsAKnownKindAndAnOlderListRefusesIt() {
		assertTrue(IrStale.KINDS_FORMAT2.contains("stagedTerrain"));
		JsonObject ir = new JsonObject();
		ir.addProperty("format", 2);
		JsonArray req = new JsonArray();
		req.add("survival");
		req.add("stagedTerrain");
		ir.add("requires", req);
		assertNull(IrStale.reason(ir, null));
		// a helper (or a mod) whose kinds lack it: PLAN_STALE
		List<String> older = IrStale.KINDS_FORMAT2.stream().filter(k -> !k.equals("stagedTerrain")).toList();
		String why = IrStale.reason(ir, new IrStale.Hello(null, List.of(1, 2), older));
		assertNotNull(why);
		assertTrue(why.contains("stagedTerrain"), why);
	}

	@Test
	void theFeatureFollowsTheHelper() {
		assertEquals(Packed.stagedBuild(), ApiRules.features(2, List.of("job.run", "region.plan", "region.survival", "region.terrainConstruction")).contains("terrainConstruction"));
		assertFalse(ApiRules.features(2, List.of("job.run", "region.plan", "region.survival")).contains("terrainConstruction"));
		assertFalse(ApiRules.JAVA_FEATURES.contains("terrainConstruction"));
	}

	@Test
	void theOldConstructorsDefaultTheTerrainMembers() {
		PartBuild p = new PartBuild("blend", "waiting", List.of("c1"), 10, 0, 240);
		assertEquals(0, p.terrainCells());
		assertEquals(0, p.terrainBuilt());
		assertEquals(new PartBuild("blend", "waiting", List.of("c1"), 10, 0, 240, 0, 0), p);
		RegionBuild r = new RegionBuild(false, false, 0, Map.of(), List.of(p));
		assertEquals(0, r.terrainPerTick());
		assertEquals(16, new RegionBuild(false, false, 0, Map.of(), List.of(p), 16).terrainPerTick());
		Quote q = new Quote("p", null, null, true, new JsonObject(), new JsonObject(), Map.of(), true, List.of(), Map.of());
		assertTrue(q.terrainCells().isEmpty());
		Quote q2 = new Quote("p", null, null, true, new JsonObject(), new JsonObject(), Map.of(), true, List.of(), Map.of(), Map.of("blend", 240L));
		assertEquals(Map.of("blend", 240L), q2.terrainCells());
	}

	@Test
	void theTerrainWaitKindIsStable() {
		assertEquals("terrain", RegionTargets.WAIT_KIND_TERRAIN);
	}
}
