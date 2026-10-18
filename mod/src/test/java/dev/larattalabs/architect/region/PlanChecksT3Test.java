package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.PlanBudget;
import dev.larattalabs.architect.api.PlanRequest;
import dev.larattalabs.architect.api.VoxelClass;
import dev.larattalabs.architect.region.volume.Arvx;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * (6c T3b, docs/CONTRACT.md "Phase 6c slice T3" §6 and Steward's S-T3-6): the plan check's two-plan flow runs only for a plan with
 * a tunnel part; the {@code load} option keeps the key's body unchanged at its default; the stale rule compares the guard cells'
 * classes (PLANT as AIR, MISSING now not judged) and names the tunnel and the cells.
 */
class PlanChecksT3Test {
	private static JsonObject plan(String json) {
		return JsonParser.parseString(json).getAsJsonObject();
	}

	@Test
	void onlyTunnelPartsAskForVolumes() {
		assertTrue(PlanChecks.hasTunnel(plan("{\"connectors\":[{\"id\":\"a\",\"kind\":\"road\"},{\"id\":\"t\",\"kind\":\"tunnel\"}]}")));
		assertFalse(PlanChecks.hasTunnel(plan("{\"connectors\":[{\"id\":\"a\",\"kind\":\"auto\"},{\"id\":\"b\",\"kind\":\"bridge\"}]}")));
		assertFalse(PlanChecks.hasTunnel(plan("{\"zones\":[{\"id\":\"z\",\"kind\":\"tunnel\"}]}")), "a zone is not a connector");
		assertFalse(PlanChecks.hasTunnel(plan("{}")));
	}

	@Test
	void loadKeepsTheDefaultKey() {
		BoundingBox c = new BoundingBox(0, -64, 0, 63, 320, 63);
		JsonObject p = plan("{\"connectors\":[]}");
		PlanBudget b = PlanBudget.defaults().resolved();
		JsonObject old = PlanChecks.body(new PlanRequest(p, null, c, Map.of(), null, null, null, null, null, new JsonObject()), b);
		JsonObject loaded = PlanChecks.body(new PlanRequest(p, null, c, Map.of(), null, null, null, null, null, new JsonObject(), LoadPolicy.LOADED_ONLY), b);
		JsonObject gen = PlanChecks.body(new PlanRequest(p, null, c, Map.of(), null, null, null, null, null, new JsonObject(), LoadPolicy.LOAD_BOUNDED(64)), b);
		assertEquals(old, loaded, "load \"loaded\" is the default: the same key body");
		assertFalse(old.has("load"));
		assertNotEquals(old, gen, "load \"generate\" is another body");
		assertTrue(gen.getAsJsonObject("load").get("generate").getAsBoolean());
	}

	/** A 1x1 column box at (0, z, 0) for z in 0..1, y 0..5: classes per cell, bottom up. */
	private static Arvx.Decoded vol(int[]... cols) {
		List<int[][]> columns = new ArrayList<>();
		for (int[] col : cols) {
			List<int[]> runs = new ArrayList<>();
			for (int cls : col) {
				runs.add(new int[] {cls, 1});
			}
			columns.add(runs.toArray(new int[0][]));
		}
		return new Arvx.Decoded(new int[] {0, 0, 0, 0, 5, cols.length - 1}, columns, List.of(), new int[0]);
	}

	private static final int AIR = VoxelClass.AIR.ordinal(), ROCK = VoxelClass.ROCK.ordinal(), PLANT = VoxelClass.PLANT.ordinal(), WATER = VoxelClass.WATER
		.ordinal(), MISSING = VoxelClass.MISSING.ordinal(), SOIL = VoxelClass.SOIL.ordinal();

	@Test
	void rockDiffNamesTheTunnelAndTheCells() {
		JsonArray runs = new JsonArray();
		for (int v : new int[] {0, 0, 0, 5, 0, 1, 0, 5}) {
			runs.add(v);
		}
		Arvx.Decoded before = vol(new int[] {ROCK, ROCK, ROCK, SOIL, AIR, AIR}, new int[] {ROCK, ROCK, ROCK, SOIL, AIR, AIR});
		assertNull(PlanChecks.rockDiff("t1", before, before, runs), "unchanged rock: no stale");
		Arvx.Decoded grass = vol(new int[] {ROCK, ROCK, ROCK, SOIL, PLANT, AIR}, new int[] {ROCK, ROCK, ROCK, SOIL, AIR, AIR});
		assertNull(PlanChecks.rockDiff("t1", before, grass, runs), "a flower grew: PLANT counts as AIR");
		Arvx.Decoded unloaded = vol(new int[] {MISSING, MISSING, MISSING, MISSING, MISSING, MISSING}, new int[] {ROCK, ROCK, ROCK, SOIL, AIR, AIR});
		assertNull(PlanChecks.rockDiff("t1", before, unloaded, runs), "a column missing now is not judged");
		Arvx.Decoded mined = vol(new int[] {ROCK, AIR, ROCK, SOIL, AIR, AIR}, new int[] {ROCK, ROCK, WATER, SOIL, AIR, AIR});
		String why = PlanChecks.rockDiff("t1", before, mined, runs);
		assertTrue(why != null && why.startsWith("tunnel t1:"), why);
		assertTrue(why.contains("2 cells") && why.contains("(0, 1, 0) ROCK->AIR") && why.contains("(0, 2, 1) ROCK->WATER"), why);
		JsonArray other = new JsonArray();
		for (int v : new int[] {0, 0, 4, 5}) {
			other.add(v);
		}
		assertNull(PlanChecks.rockDiff("t1", before, mined, other), "cells outside the guard runs are never compared");
	}

	@Test
	void rockDiffNamesAtMostSixteen() {
		int[] all = new int[6];
		java.util.Arrays.fill(all, ROCK);
		int[] none = new int[6];
		java.util.Arrays.fill(none, AIR);
		int[][] b = new int[4][], n = new int[4][];
		JsonArray runs = new JsonArray();
		for (int z = 0; z < 4; z++) {
			b[z] = all;
			n[z] = none;
			for (int v : new int[] {0, z, 0, 5}) {
				runs.add(v);
			}
		}
		String why = PlanChecks.rockDiff("t2", vol(b), vol(n), runs);
		assertTrue(why.contains("24 cells"), why);
		assertEquals(PlanChecks.ROCK_CELLS_NAMED, why.split(";").length, why);
	}
}
